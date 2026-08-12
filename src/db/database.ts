// ---------------------------------------------------------------------------
// Agentboard – data-access layer (better-sqlite3)
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

import type {
  Agent,
  AgentPublic,
  Project,
  Ticket,
  Comment,
  Activity,
  ActivityAction,
  AuditEntry,
  TicketRevision,
  Column,
  ColumnDef,
  TicketListOptions,
  PaginatedResult,
} from '../types.js';
import { DEFAULT_COLUMNS, LEGACY_COLUMNS } from '../types.js';

// ---------------------------------------------------------------------------
// Row interfaces – mirror the exact snake_case column names returned by SQLite
// ---------------------------------------------------------------------------

interface AgentRow {
  id: string;
  name: string;
  api_key: string;
  created_at: string;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  columns: string | null;
  created_at: string;
}

interface TicketRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  column_name: string;
  position: number;
  group_name: string | null;
  blocked_reason: string | null;
  agent_id: string | null;
  assignee_id: string | null;
  comment_count: number;
  depends_on: string | null;
  created_at: string;
  updated_at: string;
}

// Shared SELECT for tickets: comment count + comma-joined dependency ids.
const TICKET_SELECT = `SELECT t.*,
  (SELECT COUNT(*) FROM comments c WHERE c.ticket_id = t.id) AS comment_count,
  (SELECT GROUP_CONCAT(d.depends_on_id) FROM ticket_dependencies d WHERE d.ticket_id = t.id) AS depends_on
  FROM tickets t`;

interface CommentRow {
  id: string;
  ticket_id: string;
  agent_id: string;
  body: string;
  created_at: string;
}

interface ActivityRow {
  id: string;
  agent_id: string | null;
  ticket_id: string | null;
  project_id: string | null;
  action: string;
  details: string;
  timestamp: string;
}

interface AuditRow {
  id: string;
  agent_id: string | null;
  method: string;
  path: string;
  status_code: number;
  request_body: string;
  timestamp: string;
}

interface RevisionRow {
  id: string;
  ticket_id: string;
  agent_id: string | null;
  field: string;
  old_value: string;
  new_value: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Database class
// ---------------------------------------------------------------------------

export class AgentboardDB {
  private db: DatabaseType;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? 'agentboard.db';
    this.db = new Database(resolvedPath);

    // Enable WAL mode & foreign keys
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    // Migrations for existing databases (before schema exec, which only
    // creates missing tables/indexes and cannot add columns)
    this.migrate();

    // Bootstrap schema
    const schemaFile = fileURLToPath(
      new URL('./schema.sql', import.meta.url),
    );
    const schema = fs.readFileSync(schemaFile, 'utf-8');
    this.db.exec(schema);
  }

  private migrate(): void {
    const hasTickets = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tickets'")
      .get();
    if (hasTickets) {
      const columns = this.db.prepare('PRAGMA table_info(tickets)').all() as { name: string }[];
      if (!columns.some((c) => c.name === 'group_name')) {
        this.db.exec('ALTER TABLE tickets ADD COLUMN group_name TEXT');
      }
      if (!columns.some((c) => c.name === 'blocked_reason')) {
        this.db.exec('ALTER TABLE tickets ADD COLUMN blocked_reason TEXT');
      }
    }

    const hasProjects = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
      .get();
    if (hasProjects) {
      const columns = this.db.prepare('PRAGMA table_info(projects)').all() as { name: string }[];
      if (!columns.some((c) => c.name === 'columns')) {
        this.db.exec('ALTER TABLE projects ADD COLUMN columns TEXT');
        // Projects created before per-project columns keep the old 5-column set
        // so their existing tickets (e.g. in "ready") stay valid.
        this.db
          .prepare('UPDATE projects SET columns = ? WHERE columns IS NULL')
          .run(JSON.stringify(LEGACY_COLUMNS));
      }
    }
  }

  /** Cleanly close the database connection. */
  close(): void {
    this.db.close();
  }

  // -----------------------------------------------------------------------
  // Row  ->  Domain mappers
  // -----------------------------------------------------------------------

  private mapAgentRow(row: AgentRow): Agent {
    return {
      id: row.id,
      name: row.name,
      apiKey: row.api_key,
      createdAt: row.created_at,
    };
  }

  private mapAgentPublicRow(row: AgentRow): AgentPublic {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
    };
  }

  private mapProjectRow(row: ProjectRow): Project {
    let columns: ColumnDef[] = DEFAULT_COLUMNS;
    if (row.columns) {
      try {
        const parsed = JSON.parse(row.columns) as ColumnDef[];
        if (Array.isArray(parsed) && parsed.length > 0) columns = parsed;
      } catch {
        // fall through to default
      }
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      columns,
      createdAt: row.created_at,
    };
  }

  private mapTicketRow(row: TicketRow): Ticket {
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      column: row.column_name as Column,
      position: row.position,
      group: row.group_name ?? null,
      blockedReason: row.blocked_reason ?? null,
      dependsOn: row.depends_on ? row.depends_on.split(',') : [],
      agentId: row.agent_id,
      assigneeId: row.assignee_id ?? null,
      commentCount: row.comment_count ?? 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapCommentRow(row: CommentRow): Comment {
    return {
      id: row.id,
      ticketId: row.ticket_id,
      agentId: row.agent_id,
      body: row.body,
      createdAt: row.created_at,
    };
  }

  private mapActivityRow(row: ActivityRow): Activity {
    return {
      id: row.id,
      agentId: row.agent_id,
      ticketId: row.ticket_id,
      action: row.action as ActivityAction,
      details: row.details,
      timestamp: row.timestamp,
    };
  }

  private mapAuditRow(row: AuditRow): AuditEntry {
    return {
      id: row.id,
      agentId: row.agent_id,
      method: row.method,
      path: row.path,
      statusCode: row.status_code,
      requestBody: row.request_body,
      timestamp: row.timestamp,
    };
  }

  private mapRevisionRow(row: RevisionRow): TicketRevision {
    return {
      id: row.id,
      ticketId: row.ticket_id,
      agentId: row.agent_id,
      field: row.field,
      oldValue: row.old_value,
      newValue: row.new_value,
      timestamp: row.timestamp,
    };
  }

  // -----------------------------------------------------------------------
  // Settings (key-value store for persistent config)
  // -----------------------------------------------------------------------

  getSetting(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key) as { value: string } | undefined;

    return row?.value;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
      .run(key, value);
  }

  /**
   * Returns the admin API key. If none exists yet, generates one and stores it.
   */
  getOrCreateAdminKey(): string {
    const existing = this.getSetting('admin_api_key');
    if (existing !== undefined) {
      return existing;
    }
    const key = `admin-${uuidv4()}`;
    this.setSetting('admin_api_key', key);
    return key;
  }

  // -----------------------------------------------------------------------
  // Agents
  // -----------------------------------------------------------------------

  createAgent(name: string): Agent {
    const id = uuidv4();
    const apiKey = `ab-${uuidv4()}`;

    const stmt = this.db.prepare(
      'INSERT INTO agents (id, name, api_key) VALUES (?, ?, ?)',
    );
    stmt.run(id, name, apiKey);

    const row = this.db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get(id) as AgentRow;

    return this.mapAgentRow(row);
  }

  getAgentByApiKey(apiKey: string): Agent | undefined {
    const row = this.db
      .prepare('SELECT * FROM agents WHERE api_key = ?')
      .get(apiKey) as AgentRow | undefined;

    return row !== undefined ? this.mapAgentRow(row) : undefined;
  }

  getAgentById(id: string): AgentPublic | undefined {
    const row = this.db
      .prepare('SELECT * FROM agents WHERE id = ?')
      .get(id) as AgentRow | undefined;

    return row !== undefined ? this.mapAgentPublicRow(row) : undefined;
  }

  getAllAgents(): AgentPublic[] {
    const rows = this.db
      .prepare('SELECT * FROM agents ORDER BY created_at ASC')
      .all() as AgentRow[];

    return rows.map((r) => this.mapAgentPublicRow(r));
  }

  getAllAgentsWithKeys(): Agent[] {
    const rows = this.db
      .prepare('SELECT * FROM agents ORDER BY created_at ASC')
      .all() as AgentRow[];

    return rows.map((r) => this.mapAgentRow(r));
  }

  deleteAgent(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM agents WHERE id = ?')
      .run(id);

    return result.changes > 0;
  }

  // -----------------------------------------------------------------------
  // Projects
  // -----------------------------------------------------------------------

  createProject(name: string, description?: string, columns?: ColumnDef[]): Project {
    const id = uuidv4();
    const desc = description ?? '';
    const cols = columns ?? DEFAULT_COLUMNS;

    const stmt = this.db.prepare(
      'INSERT INTO projects (id, name, description, columns) VALUES (?, ?, ?, ?)',
    );
    stmt.run(id, name, desc, JSON.stringify(cols));

    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow;

    return this.mapProjectRow(row);
  }

  updateProject(
    id: string,
    updates: { name?: string; description?: string; columns?: ColumnDef[] },
  ): Project | undefined {
    const existing = this.getProject(id);
    if (!existing) return undefined;

    const newName = updates.name ?? existing.name;
    const newDescription = updates.description ?? existing.description;
    const newColumns = updates.columns ?? existing.columns;

    this.db
      .prepare('UPDATE projects SET name = ?, description = ?, columns = ? WHERE id = ?')
      .run(newName, newDescription, JSON.stringify(newColumns), id);

    return this.getProject(id);
  }

  getProject(id: string): Project | undefined {
    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined;

    return row !== undefined ? this.mapProjectRow(row) : undefined;
  }

  getAllProjects(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM projects ORDER BY created_at ASC')
      .all() as ProjectRow[];

    return rows.map((r) => this.mapProjectRow(r));
  }

  deleteProject(id: string): boolean {
    const result = this.db
      .prepare('DELETE FROM projects WHERE id = ?')
      .run(id);

    return result.changes > 0;
  }

  // -----------------------------------------------------------------------
  // Tickets
  // -----------------------------------------------------------------------

  createTicket(
    projectId: string,
    title: string,
    description?: string,
    column?: Column,
    agentId?: string | null,
    group?: string | null,
    blockedReason?: string | null,
    dependsOn?: string[],
  ): Ticket {
    const id = uuidv4();
    const desc = description ?? '';
    const col = column ?? 'backlog';
    const agent = agentId ?? null;
    const groupName = group ?? null;

    // Determine next position in the target column
    const maxPos = this.db
      .prepare(
        'SELECT COALESCE(MAX(position), -1) AS max_pos FROM tickets WHERE project_id = ? AND column_name = ?',
      )
      .get(projectId, col) as { max_pos: number };

    const position = maxPos.max_pos + 1;

    const stmt = this.db.prepare(
      'INSERT INTO tickets (id, project_id, title, description, column_name, position, agent_id, group_name, blocked_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    stmt.run(id, projectId, title, desc, col, position, agent, groupName, blockedReason ?? null);

    if (dependsOn && dependsOn.length > 0) {
      this.setTicketDependencies(id, dependsOn);
    }

    const row = this.db
      .prepare(`${TICKET_SELECT} WHERE t.id = ?`)
      .get(id) as TicketRow;

    return this.mapTicketRow(row);
  }

  /** Replace the full dependency list of a ticket. */
  setTicketDependencies(ticketId: string, dependsOn: string[]): void {
    this.db.prepare('DELETE FROM ticket_dependencies WHERE ticket_id = ?').run(ticketId);
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO ticket_dependencies (ticket_id, depends_on_id) VALUES (?, ?)',
    );
    for (const depId of dependsOn) {
      insert.run(ticketId, depId);
    }
  }

  getTicket(projectId: string, ticketId: string): Ticket | undefined {
    // Strip leading '#' (frontend short-ID format)
    const cleanId = ticketId.replace(/^#/, '');

    // Try exact match first
    let row = this.db
      .prepare(`${TICKET_SELECT} WHERE t.id = ? AND t.project_id = ?`)
      .get(cleanId, projectId) as TicketRow | undefined;

    // Fallback: prefix match for short IDs (e.g. "df69fbfa" → first 8 chars of UUID)
    if (!row && cleanId.length < 36) {
      const rows = this.db
        .prepare(`${TICKET_SELECT} WHERE t.id LIKE ? AND t.project_id = ?`)
        .all(cleanId + '%', projectId) as TicketRow[];
      if (rows.length === 1) row = rows[0];
    }

    return row !== undefined ? this.mapTicketRow(row) : undefined;
  }

  getTicketsByProject(projectId: string, options?: TicketListOptions): PaginatedResult<Ticket> {
    const column = options?.column;
    const page = Math.max(1, options?.page ?? 1);
    const perPage = Math.max(1, options?.per_page ?? 50);
    const offset = (page - 1) * perPage;

    const whereClauses = ['t.project_id = ?'];
    const params: (string | number)[] = [projectId];

    if (column) {
      whereClauses.push('t.column_name = ?');
      params.push(column);
    }

    const where = whereClauses.join(' AND ');

    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM tickets t WHERE ${where}`)
      .get(...params) as { cnt: number };
    const total = countRow.cnt;

    const rows = this.db
      .prepare(
        `${TICKET_SELECT} WHERE ${where} ORDER BY t.column_name, t.position ASC LIMIT ? OFFSET ?`,
      )
      .all(...params, perPage, offset) as TicketRow[];

    return {
      data: rows.map((r) => this.mapTicketRow(r)),
      total,
      page,
      per_page: perPage,
      total_pages: Math.ceil(total / perPage),
    };
  }

  updateTicket(
    projectId: string,
    ticketId: string,
    updates: {
      title?: string;
      description?: string;
      column?: Column;
      group?: string | null;
      agentId?: string | null;
      blockedReason?: string | null;
      dependsOn?: string[];
    },
    actorId?: string | null,
  ): Ticket | undefined {
    const existing = this.getTicket(projectId, ticketId);
    if (existing === undefined) {
      return undefined;
    }

    const newTitle = updates.title ?? existing.title;
    const newDescription = updates.description ?? existing.description;
    const newColumn = updates.column ?? existing.column;
    const newGroup = 'group' in updates ? (updates.group ?? null) : existing.group;
    const newAgentId =
      'agentId' in updates ? (updates.agentId ?? null) : existing.agentId;
    const newBlockedReason =
      'blockedReason' in updates ? (updates.blockedReason ?? null) : existing.blockedReason;
    const newDependsOn = updates.dependsOn ?? existing.dependsOn;

    // Log revisions for each changed field BEFORE applying the update
    const actor = actorId !== undefined ? actorId : null;
    if (newTitle !== existing.title) {
      this.logRevision(existing.id, actor, 'title', existing.title, newTitle);
    }
    if (newDescription !== existing.description) {
      this.logRevision(existing.id, actor, 'description', existing.description, newDescription);
    }
    if (newColumn !== existing.column) {
      this.logRevision(existing.id, actor, 'column', existing.column, newColumn);
    }
    if (newGroup !== existing.group) {
      this.logRevision(existing.id, actor, 'group', existing.group ?? '', newGroup ?? '');
    }
    if (newAgentId !== existing.agentId) {
      this.logRevision(existing.id, actor, 'agentId', existing.agentId ?? '', newAgentId ?? '');
    }
    if (newBlockedReason !== existing.blockedReason) {
      this.logRevision(existing.id, actor, 'blocked_reason', existing.blockedReason ?? '', newBlockedReason ?? '');
    }
    if (updates.dependsOn && newDependsOn.join(',') !== existing.dependsOn.join(',')) {
      this.logRevision(existing.id, actor, 'depends_on', existing.dependsOn.join(', '), newDependsOn.join(', '));
    }

    // If column changed, compute new position at the end of target column
    let newPosition = existing.position;
    if (newColumn !== existing.column) {
      const maxPos = this.db
        .prepare(
          'SELECT COALESCE(MAX(position), -1) AS max_pos FROM tickets WHERE project_id = ? AND column_name = ?',
        )
        .get(projectId, newColumn) as { max_pos: number };
      newPosition = maxPos.max_pos + 1;
    }

    this.db
      .prepare(
        `UPDATE tickets
         SET title = ?, description = ?, column_name = ?, position = ?, group_name = ?, agent_id = ?, blocked_reason = ?, updated_at = datetime('now')
         WHERE id = ? AND project_id = ?`,
      )
      .run(
        newTitle,
        newDescription,
        newColumn,
        newPosition,
        newGroup,
        newAgentId,
        newBlockedReason,
        existing.id,
        projectId,
      );

    if (updates.dependsOn) {
      this.setTicketDependencies(existing.id, newDependsOn);
    }

    return this.getTicket(projectId, existing.id);
  }

  moveTicket(
    projectId: string,
    ticketId: string,
    column: Column,
    actorId?: string | null,
  ): Ticket | undefined {
    return this.updateTicket(projectId, ticketId, { column }, actorId);
  }

  /** All tickets of a group within a project (any column). */
  getTicketsByGroup(projectId: string, group: string): Ticket[] {
    const rows = this.db
      .prepare(
        `${TICKET_SELECT} WHERE t.project_id = ? AND t.group_name = ? ORDER BY t.position ASC`,
      )
      .all(projectId, group) as TicketRow[];

    return rows.map((r) => this.mapTicketRow(r));
  }

  assignTicket(
    projectId: string,
    ticketId: string,
    assigneeId: string | null,
    actorId?: string | null,
  ): Ticket | undefined {
    const existing = this.getTicket(projectId, ticketId);
    if (!existing) return undefined;

    const actor = actorId !== undefined ? actorId : null;
    if (assigneeId !== existing.assigneeId) {
      this.logRevision(existing.id, actor, 'assigneeId', existing.assigneeId ?? '', assigneeId ?? '');
    }

    this.db
      .prepare(`UPDATE tickets SET assignee_id = ?, updated_at = datetime('now') WHERE id = ? AND project_id = ?`)
      .run(assigneeId, existing.id, projectId);

    return this.getTicket(projectId, existing.id);
  }

  deleteTicket(projectId: string, ticketId: string): boolean {
    const result = this.db
      .prepare('DELETE FROM tickets WHERE id = ? AND project_id = ?')
      .run(ticketId, projectId);

    return result.changes > 0;
  }

  // -----------------------------------------------------------------------
  // Comments
  // -----------------------------------------------------------------------

  createComment(ticketId: string, agentId: string, body: string): Comment {
    const id = uuidv4();

    this.db
      .prepare(
        'INSERT INTO comments (id, ticket_id, agent_id, body) VALUES (?, ?, ?, ?)',
      )
      .run(id, ticketId, agentId, body);

    const row = this.db
      .prepare('SELECT * FROM comments WHERE id = ?')
      .get(id) as CommentRow;

    return this.mapCommentRow(row);
  }

  getCommentsByTicket(ticketId: string): Comment[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM comments WHERE ticket_id = ? ORDER BY created_at ASC',
      )
      .all(ticketId) as CommentRow[];

    return rows.map((r) => this.mapCommentRow(r));
  }

  // -----------------------------------------------------------------------
  // Activity log
  // -----------------------------------------------------------------------

  logActivity(
    agentId: string | null,
    ticketId: string | null,
    action: ActivityAction,
    details: string,
    projectId?: string | null,
  ): Activity {
    const id = uuidv4();

    this.db
      .prepare(
        'INSERT INTO activity_log (id, agent_id, ticket_id, project_id, action, details) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, agentId, ticketId, projectId ?? null, action, details);

    const row = this.db
      .prepare('SELECT * FROM activity_log WHERE id = ?')
      .get(id) as ActivityRow;

    return this.mapActivityRow(row);
  }

  getActivitiesByProject(projectId: string): Activity[] {
    const rows = this.db
      .prepare(
        `SELECT a.*
         FROM activity_log a
         LEFT JOIN tickets t ON t.id = a.ticket_id
         WHERE t.project_id = ? OR a.project_id = ?
         ORDER BY a.timestamp DESC`,
      )
      .all(projectId, projectId) as ActivityRow[];

    return rows.map((r) => this.mapActivityRow(r));
  }

  // -----------------------------------------------------------------------
  // Audit log (every API call)
  // -----------------------------------------------------------------------

  logAudit(agentId: string | null, method: string, path: string, statusCode: number, requestBody: string): AuditEntry {
    const id = uuidv4();

    this.db
      .prepare(
        'INSERT INTO audit_log (id, agent_id, method, path, status_code, request_body) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, agentId, method, path, statusCode, requestBody);

    const row = this.db
      .prepare('SELECT * FROM audit_log WHERE id = ?')
      .get(id) as AuditRow;

    return this.mapAuditRow(row);
  }

  getAllAuditEntries(limit: number = 100): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?')
      .all(limit) as AuditRow[];

    return rows.map((r) => this.mapAuditRow(r));
  }

  getAuditEntriesByAgent(agentId: string, limit: number = 100): AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_log WHERE agent_id = ? ORDER BY timestamp DESC LIMIT ?')
      .all(agentId, limit) as AuditRow[];

    return rows.map((r) => this.mapAuditRow(r));
  }

  // -----------------------------------------------------------------------
  // Ticket revisions (tamper-proof audit trail)
  // -----------------------------------------------------------------------

  logRevision(
    ticketId: string,
    agentId: string | null,
    field: string,
    oldValue: string,
    newValue: string,
  ): TicketRevision {
    const id = uuidv4();

    this.db
      .prepare(
        'INSERT INTO ticket_revisions (id, ticket_id, agent_id, field, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, ticketId, agentId, field, oldValue, newValue);

    const row = this.db
      .prepare('SELECT * FROM ticket_revisions WHERE id = ?')
      .get(id) as RevisionRow;

    return this.mapRevisionRow(row);
  }

  getRevisionsByTicket(ticketId: string): TicketRevision[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM ticket_revisions WHERE ticket_id = ? ORDER BY timestamp ASC',
      )
      .all(ticketId) as RevisionRow[];

    return rows.map((r) => this.mapRevisionRow(r));
  }

  // ---------------------------------------------------------------------------
  // Sessions (persistent across restarts)
  // ---------------------------------------------------------------------------

  createSession(token: string): void {
    this.db.prepare('INSERT INTO sessions (token) VALUES (?)').run(token);
  }

  hasSession(token: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM sessions WHERE token = ?').get(token);
    return !!row;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  // ---------------------------------------------------------------------------
  // MCP Sessions (persistent session_id → agent_id mapping)
  // ---------------------------------------------------------------------------

  createMcpSession(sessionId: string, agentId: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO mcp_sessions (session_id, agent_id) VALUES (?, ?)')
      .run(sessionId, agentId);
  }

  getMcpSessionAgentId(sessionId: string): string | undefined {
    const row = this.db
      .prepare('SELECT agent_id FROM mcp_sessions WHERE session_id = ?')
      .get(sessionId) as { agent_id: string } | undefined;
    return row?.agent_id;
  }

  touchMcpSession(sessionId: string): void {
    this.db
      .prepare("UPDATE mcp_sessions SET last_used_at = datetime('now') WHERE session_id = ?")
      .run(sessionId);
  }

  deleteMcpSession(sessionId: string): void {
    this.db
      .prepare('DELETE FROM mcp_sessions WHERE session_id = ?')
      .run(sessionId);
  }

  pruneOldMcpSessions(maxAgeDays: number = 30): number {
    const result = this.db
      .prepare("DELETE FROM mcp_sessions WHERE last_used_at < datetime('now', ?)")
      .run(`-${maxAgeDays} days`);
    return result.changes;
  }
}
