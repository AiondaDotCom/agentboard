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
} from '../types.js';

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
  created_at: string;
}

interface TicketRow {
  id: string;
  project_id: string;
  title: string;
  description: string;
  column_name: string;
  position: number;
  agent_id: string | null;
  created_at: string;
  updated_at: string;
}

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
  ticket_id: string;
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

    // Bootstrap schema
    const schemaFile = fileURLToPath(
      new URL('./schema.sql', import.meta.url),
    );
    const schema = fs.readFileSync(schemaFile, 'utf-8');
    this.db.exec(schema);
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
    return {
      id: row.id,
      name: row.name,
      description: row.description,
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
      agentId: row.agent_id,
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

  createProject(name: string, description?: string): Project {
    const id = uuidv4();
    const desc = description ?? '';

    const stmt = this.db.prepare(
      'INSERT INTO projects (id, name, description) VALUES (?, ?, ?)',
    );
    stmt.run(id, name, desc);

    const row = this.db
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow;

    return this.mapProjectRow(row);
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
  ): Ticket {
    const id = uuidv4();
    const desc = description ?? '';
    const col = column ?? 'backlog';
    const agent = agentId ?? null;

    // Determine next position in the target column
    const maxPos = this.db
      .prepare(
        'SELECT COALESCE(MAX(position), -1) AS max_pos FROM tickets WHERE project_id = ? AND column_name = ?',
      )
      .get(projectId, col) as { max_pos: number };

    const position = maxPos.max_pos + 1;

    const stmt = this.db.prepare(
      'INSERT INTO tickets (id, project_id, title, description, column_name, position, agent_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    stmt.run(id, projectId, title, desc, col, position, agent);

    const row = this.db
      .prepare('SELECT * FROM tickets WHERE id = ?')
      .get(id) as TicketRow;

    return this.mapTicketRow(row);
  }

  getTicket(projectId: string, ticketId: string): Ticket | undefined {
    const row = this.db
      .prepare('SELECT * FROM tickets WHERE id = ? AND project_id = ?')
      .get(ticketId, projectId) as TicketRow | undefined;

    return row !== undefined ? this.mapTicketRow(row) : undefined;
  }

  getTicketsByProject(projectId: string): Ticket[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM tickets WHERE project_id = ? ORDER BY column_name, position ASC',
      )
      .all(projectId) as TicketRow[];

    return rows.map((r) => this.mapTicketRow(r));
  }

  updateTicket(
    projectId: string,
    ticketId: string,
    updates: {
      title?: string;
      description?: string;
      column?: Column;
      agentId?: string | null;
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
    const newAgentId =
      'agentId' in updates ? (updates.agentId ?? null) : existing.agentId;

    // Log revisions for each changed field BEFORE applying the update
    const actor = actorId !== undefined ? actorId : null;
    if (newTitle !== existing.title) {
      this.logRevision(ticketId, actor, 'title', existing.title, newTitle);
    }
    if (newDescription !== existing.description) {
      this.logRevision(ticketId, actor, 'description', existing.description, newDescription);
    }
    if (newColumn !== existing.column) {
      this.logRevision(ticketId, actor, 'column', existing.column, newColumn);
    }
    if (newAgentId !== existing.agentId) {
      this.logRevision(ticketId, actor, 'agentId', existing.agentId ?? '', newAgentId ?? '');
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
         SET title = ?, description = ?, column_name = ?, position = ?, agent_id = ?, updated_at = datetime('now')
         WHERE id = ? AND project_id = ?`,
      )
      .run(
        newTitle,
        newDescription,
        newColumn,
        newPosition,
        newAgentId,
        ticketId,
        projectId,
      );

    return this.getTicket(projectId, ticketId);
  }

  moveTicket(
    projectId: string,
    ticketId: string,
    column: Column,
    actorId?: string | null,
  ): Ticket | undefined {
    return this.updateTicket(projectId, ticketId, { column }, actorId);
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
    ticketId: string,
    action: ActivityAction,
    details: string,
  ): Activity {
    const id = uuidv4();

    this.db
      .prepare(
        'INSERT INTO activity_log (id, agent_id, ticket_id, action, details) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, agentId, ticketId, action, details);

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
         INNER JOIN tickets t ON t.id = a.ticket_id
         WHERE t.project_id = ?
         ORDER BY a.timestamp DESC`,
      )
      .all(projectId) as ActivityRow[];

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
}
