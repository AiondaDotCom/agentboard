// ---------------------------------------------------------------------------
// Agentboard – Business / Service layer
//
// ALL business operations go through this class.
// Both REST routes and MCP tools call these methods.
// This is the ONLY layer that touches the database directly.
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from 'uuid';
import type { AgentboardDB } from '../db/database.js';
import { pubsub, EVENTS } from '../graphql/pubsub.js';
import { BATCH_OPS, COLUMN_ID_RE, DEFAULT_COLUMNS, DEFAULT_PRIORITY, MAX_BATCH_OPS, PRIORITIES, WORK_TYPES, WORK_TYPE_FILTERS } from '../types.js';
import type {
  Agent,
  AgentPublic,
  BatchOp,
  BatchOperation,
  BatchOperationResult,
  Project,
  Ticket,
  Comment,
  Activity,
  AuditEntry,
  TicketRevision,
  Column,
  ColumnDef,
  TicketListOptions,
  PaginatedResult,
  Priority,
  WorkType,
  WorkTypeFilter,
} from '../types.js';
import { NotFoundError, ValidationError, DuplicateError, ConflictError } from './errors.js';

const MAX_COLUMNS = 20;

export class BoardService {
  constructor(private db: AgentboardDB) {}

  // -------------------------------------------------------------------------
  // Business audit logging (DORA/BaFin compliant)
  // Logs WHO did WHAT on WHICH resource, at the business level.
  // -------------------------------------------------------------------------

  private audit(agentId: string | null, action: string, resource: string, details?: string): void {
    const entry = this.db.logAudit(agentId, action, resource, 200, details ?? '');
    pubsub.publish(EVENTS.AUDIT_ADDED, {
      auditAdded: {
        id: entry.id,
        agentId: entry.agentId,
        method: entry.method,
        path: entry.path,
        statusCode: entry.statusCode,
        requestBody: entry.requestBody,
        timestamp: entry.timestamp,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Settings / Admin key
  // -------------------------------------------------------------------------

  getOrCreateAdminKey(): string {
    return this.db.getOrCreateAdminKey();
  }

  rotateAdminKey(): string {
    const newKey = `admin-${uuidv4()}`;
    this.db.setSetting('admin_api_key', newKey);
    return newKey;
  }

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------

  createAgent(name: string, actorId?: string | null): Agent {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ValidationError('Missing or invalid "name" field');
    }
    try {
      const agent = this.db.createAgent(name.trim());
      pubsub.publish(EVENTS.AGENT_CHANGED, { agentChanged: agent });
      this.audit(actorId ?? null, 'CREATE', `agent '${agent.name}'`);
      return agent;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('UNIQUE')) {
        throw new DuplicateError(`Agent name "${name}" is already taken`);
      }
      throw err;
    }
  }

  getAllAgents(actorId?: string | null): AgentPublic[] {
    const agents = this.db.getAllAgents();
    if (actorId) this.audit(actorId, 'LIST', 'agents', `${agents.length} agents`);
    return agents;
  }

  getAllAgentsWithKeys(): Agent[] {
    return this.db.getAllAgentsWithKeys();
  }

  getAgentById(id: string): AgentPublic {
    const agent = this.db.getAgentById(id);
    if (!agent) throw new NotFoundError('Agent not found');
    return agent;
  }

  getAgentByApiKey(apiKey: string): Agent | undefined {
    return this.db.getAgentByApiKey(apiKey);
  }

  deleteAgent(id: string): void {
    const agent = this.db.getAgentById(id);
    if (!agent) throw new NotFoundError('Agent not found');
    this.db.deleteAgent(id);
    pubsub.publish(EVENTS.AGENT_CHANGED, { agentChanged: agent });
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  createProject(
    name: string,
    description?: string,
    actorId?: string | null,
    columns?: unknown,
  ): Project {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ValidationError('Missing or invalid "name" field');
    }
    const cols = columns !== undefined ? this.validateColumnsInput(columns) : DEFAULT_COLUMNS;
    const project = this.db.createProject(name.trim(), description ?? '', cols);
    pubsub.publish(EVENTS.PROJECT_CHANGED, { projectChanged: project });
    this.audit(actorId ?? null, 'CREATE', `project '${project.name}'`);
    return project;
  }

  /**
   * Update project metadata and/or its board columns.
   * Columns can only be removed while no ticket is still in them.
   */
  updateProject(
    id: string,
    updates: { name?: string; description?: string; columns?: unknown },
    actorId?: string | null,
  ): Project {
    const existing = this.requireProject(id);

    if (updates.name !== undefined && (typeof updates.name !== 'string' || updates.name.trim().length === 0)) {
      throw new ValidationError('Invalid "name" field');
    }
    if (updates.description !== undefined && typeof updates.description !== 'string') {
      throw new ValidationError('Invalid "description" field');
    }

    const cleanUpdates: { name?: string; description?: string; columns?: ColumnDef[] } = {};
    if (typeof updates.name === 'string') cleanUpdates.name = updates.name.trim();
    if (typeof updates.description === 'string') cleanUpdates.description = updates.description;

    if (updates.columns !== undefined) {
      const cols = this.validateColumnsInput(updates.columns);
      const newIds = new Set(cols.map((c) => c.id));

      // Tickets must never end up in a column that no longer exists.
      const tickets = this.db.getTicketsByProject(id, { per_page: 100000 }).data;
      const stranded = new Map<string, number>();
      for (const t of tickets) {
        if (!newIds.has(t.column)) {
          stranded.set(t.column, (stranded.get(t.column) ?? 0) + 1);
        }
      }
      if (stranded.size > 0) {
        const detail = [...stranded.entries()].map(([col, n]) => `"${col}" (${n} ticket${n !== 1 ? 's' : ''})`).join(', ');
        throw new ValidationError(
          `Cannot remove column(s) still containing tickets: ${detail}. Move those tickets to another column first.`,
        );
      }
      cleanUpdates.columns = cols;
    }

    const project = this.db.updateProject(existing.id, cleanUpdates);
    if (!project) throw new NotFoundError('Project not found');

    pubsub.publish(EVENTS.PROJECT_CHANGED, { projectChanged: project });
    this.audit(actorId ?? null, 'UPDATE', `project '${project.name}'`, JSON.stringify({
      ...cleanUpdates,
      columns: cleanUpdates.columns?.map((c) => c.id),
    }));
    return project;
  }

  getAllProjects(actorId?: string | null): Project[] {
    const projects = this.db.getAllProjects();
    if (actorId) this.audit(actorId, 'LIST', 'projects', `${projects.length} projects`);
    return projects;
  }

  getProject(id: string, actorId?: string | null): Project {
    const project = this.db.getProject(id);
    if (!project) throw new NotFoundError('Project not found');
    if (actorId) {
      this.audit(actorId, 'READ', `project '${project.name}'`);
      this.logAndPublishActivity(actorId, id, null, 'project_read', `Read project '${project.name}'`);
    }
    return project;
  }

  deleteProject(id: string, actorId?: string | null): void {
    const project = this.db.getProject(id);
    if (!project) throw new NotFoundError('Project not found');
    this.db.deleteProject(id);
    pubsub.publish(EVENTS.PROJECT_CHANGED, { projectChanged: project });
    this.audit(actorId ?? null, 'DELETE', `project '${project.name}'`);
  }

  // -------------------------------------------------------------------------
  // Tickets
  // -------------------------------------------------------------------------

  createTicket(
    projectId: string,
    title: string,
    description?: string,
    column?: string,
    agentId?: string | null,
    group?: string | null,
    blockedReason?: string | null,
    dependsOn?: unknown,
    priority?: unknown,
    workType?: unknown,
  ): Ticket {
    const project = this.requireProject(projectId);

    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new ValidationError('Missing or invalid "title" field');
    }

    const col = column ?? project.columns[0]!.id;
    this.requireValidColumn(project, col);

    if (group !== undefined && group !== null && typeof group !== 'string') {
      throw new ValidationError('Invalid "group" field');
    }
    const groupName = typeof group === 'string' && group.trim().length > 0 ? group.trim() : null;

    if (blockedReason !== undefined && blockedReason !== null && typeof blockedReason !== 'string') {
      throw new ValidationError('Invalid "blocked_reason" field');
    }
    const reason = typeof blockedReason === 'string' && blockedReason.trim().length > 0
      ? blockedReason.trim()
      : null;

    let deps: string[] = [];
    if (dependsOn !== undefined) {
      deps = this.resolveDependencies(projectId, null, dependsOn);
      this.assertDependenciesAllowColumn(project, deps, col, title.trim());
    }

    const prio = priority === undefined || priority === null
      ? DEFAULT_PRIORITY
      : this.validatePriority(priority);

    const work = workType === undefined ? null : this.validateWorkType(workType);

    const ticket = this.db.createTicket(
      projectId,
      title.trim(),
      description ?? '',
      col,
      agentId ?? null,
      groupName,
      reason,
      deps,
      prio,
      work,
    );

    this.db.logActivity(
      agentId ?? null,
      ticket.id,
      'ticket_created',
      `Created ticket "${ticket.title}"`,
    );

    pubsub.publish(EVENTS.TICKET_CREATED, {
      ticketCreated: ticket,
      projectId: ticket.projectId,
    });

    this.audit(agentId ?? null, 'CREATE', `ticket '${ticket.title}'`, `in project ${projectId}`);
    return ticket;
  }

  getTicket(projectId: string, ticketId: string, viewerAgentId?: string | null): Ticket {
    const ticket = this.db.getTicket(projectId, ticketId);
    if (!ticket) throw new NotFoundError('Ticket not found');
    if (viewerAgentId) {
      this.notifyTicketView(projectId, ticket.id, viewerAgentId);
      this.audit(viewerAgentId, 'READ', `ticket '${ticket.title}'`, `in project ${projectId}`);
      this.logAndPublishActivity(viewerAgentId, projectId, ticket.id, 'ticket_read', `Read ticket "${ticket.title}"`);
    }
    return ticket;
  }

  getTicketsByProject(projectId: string, actorId?: string | null, options?: TicketListOptions): PaginatedResult<Ticket> {
    const project = this.requireProject(projectId);
    if (options?.column) {
      this.requireValidColumn(project, options.column);
    }
    if (options?.work_type !== undefined) {
      this.validateWorkTypeFilter(options.work_type);
    }
    const result = this.db.getTicketsByProject(projectId, options);
    if (actorId) {
      const project = this.db.getProject(projectId);
      const filters = [
        options?.column ? `column=${options.column}` : '',
        options?.work_type ? `work_type=${options.work_type}` : '',
      ].filter(Boolean);
      const filterInfo = filters.length > 0 ? ` (${filters.join(', ')})` : '';
      this.audit(actorId, 'LIST', `tickets in '${project?.name ?? projectId}'${filterInfo}`, `${result.total} total, page ${result.page}/${result.total_pages}`);
      this.logAndPublishActivity(actorId, projectId, null, 'tickets_listed', `Listed ${result.data.length} of ${result.total} tickets${filterInfo}`);
    }
    return result;
  }

  updateTicket(
    projectId: string,
    ticketId: string,
    updates: {
      title?: string;
      description?: string;
      column?: string;
      group?: string | null;
      blockedReason?: string | null;
      dependsOn?: unknown;
      priority?: unknown;
      workType?: unknown;
    },
    actorId?: string | null,
  ): Ticket {
    const project = this.requireProject(projectId);
    const resolved = this.requireTicket(projectId, ticketId);

    if (updates.title !== undefined && (typeof updates.title !== 'string' || updates.title.trim().length === 0)) {
      throw new ValidationError('Invalid "title" field');
    }
    if (updates.description !== undefined && typeof updates.description !== 'string') {
      throw new ValidationError('Invalid "description" field');
    }
    if (updates.column !== undefined) {
      this.requireValidColumn(project, updates.column);
    }
    if ('group' in updates && updates.group !== null && typeof updates.group !== 'string') {
      throw new ValidationError('Invalid "group" field');
    }
    if ('blockedReason' in updates && updates.blockedReason !== null && typeof updates.blockedReason !== 'string') {
      throw new ValidationError('Invalid "blocked_reason" field');
    }

    const cleanUpdates: {
      title?: string;
      description?: string;
      column?: Column;
      group?: string | null;
      blockedReason?: string | null;
      dependsOn?: string[];
      priority?: Priority;
      workType?: WorkType | null;
    } = {};
    if (typeof updates.title === 'string') cleanUpdates.title = updates.title.trim();
    if (typeof updates.description === 'string') cleanUpdates.description = updates.description;
    if (typeof updates.column === 'string') cleanUpdates.column = updates.column;
    if ('blockedReason' in updates) {
      const r = typeof updates.blockedReason === 'string' ? updates.blockedReason.trim() : null;
      cleanUpdates.blockedReason = r && r.length > 0 ? r : null;
    }
    if (updates.dependsOn !== undefined) {
      const deps = this.resolveDependencies(projectId, resolved.id, updates.dependsOn);
      this.assertNoDependencyCycle(projectId, resolved.id, deps);
      cleanUpdates.dependsOn = deps;
    }
    if (updates.priority !== undefined) {
      cleanUpdates.priority = this.validatePriority(updates.priority);
    }
    if ('workType' in updates) {
      cleanUpdates.workType = this.validateWorkType(updates.workType);
    }

    // Dependency gate: moving to any column but the first requires all
    // dependencies to be finished.
    if (cleanUpdates.column !== undefined && cleanUpdates.column !== resolved.column) {
      const effectiveDeps = cleanUpdates.dependsOn ?? resolved.dependsOn;
      this.assertDependenciesAllowColumn(project, effectiveDeps, cleanUpdates.column, resolved.title);
    }

    if ('group' in updates) {
      const g = typeof updates.group === 'string' ? updates.group.trim() : null;
      cleanUpdates.group = g && g.length > 0 ? g : null;

      // Moving a ticket into a group that is claimed by another agent is only
      // allowed if the ticket is unassigned or assigned to that same agent.
      if (cleanUpdates.group && cleanUpdates.group !== resolved.group) {
        const claimer = this.findGroupClaimer(projectId, cleanUpdates.group, resolved.id);
        if (claimer && resolved.assigneeId && resolved.assigneeId !== claimer.id) {
          throw new ConflictError(
            `Group "${cleanUpdates.group}" is claimed by agent "${claimer.name}" – ticket is assigned to a different agent`,
          );
        }
      }
    }

    const ticket = this.db.updateTicket(projectId, resolved.id, cleanUpdates, actorId ?? null);
    if (!ticket) throw new NotFoundError('Ticket not found');

    this.db.logActivity(actorId ?? null, ticket.id, 'ticket_updated', 'Updated ticket');

    pubsub.publish(EVENTS.TICKET_UPDATED, {
      ticketUpdated: ticket,
      projectId: ticket.projectId,
    });

    this.audit(actorId ?? null, 'UPDATE', `ticket '${ticket.title}'`, JSON.stringify(cleanUpdates));
    return ticket;
  }

  moveTicket(
    projectId: string,
    ticketId: string,
    column: string,
    actorId?: string | null,
  ): Ticket {
    const project = this.requireProject(projectId);
    const resolved = this.requireTicket(projectId, ticketId);

    this.requireValidColumn(project, column);
    if (column !== resolved.column) {
      this.assertDependenciesAllowColumn(project, resolved.dependsOn, column, resolved.title);
    }

    const ticket = this.db.moveTicket(projectId, resolved.id, column, actorId ?? null);
    if (!ticket) throw new NotFoundError('Ticket not found');

    this.db.logActivity(actorId ?? null, ticket.id, 'ticket_moved', `Moved to ${column}`);

    pubsub.publish(EVENTS.TICKET_MOVED, {
      ticketMoved: ticket,
      projectId: ticket.projectId,
    });

    this.audit(actorId ?? null, 'MOVE', `ticket '${ticket.title}'`, `→ ${column}`);
    return ticket;
  }

  deleteTicket(projectId: string, ticketId: string, actorId?: string | null): void {
    const ticket = this.requireTicket(projectId, ticketId);
    this.db.deleteTicket(projectId, ticket.id);
    pubsub.publish(EVENTS.TICKET_DELETED, {
      ticketDeleted: ticket,
      projectId,
    });
    this.audit(actorId ?? null, 'DELETE', `ticket '${ticket.title}'`);
  }

  assignTicket(
    projectId: string,
    ticketId: string,
    assigneeId: string,
    actorId?: string | null,
  ): Ticket {
    const resolved = this.requireTicket(projectId, ticketId);

    // Validate assignee exists
    const assignee = this.db.getAgentById(assigneeId);
    if (!assignee) throw new NotFoundError('Agent not found');

    // Group claim rule: assigning any ticket of a group claims the whole group.
    // A group counts as claimed while any of its tickets (outside "done") has
    // an assignee. Only that agent may take further tickets of the group.
    if (resolved.group) {
      const claimer = this.findGroupClaimer(projectId, resolved.group, resolved.id);
      if (claimer && claimer.id !== assigneeId) {
        throw new ConflictError(
          `Group "${resolved.group}" is claimed by agent "${claimer.name}" – pick a ticket from a free group instead`,
        );
      }
    }

    const ticket = this.db.assignTicket(projectId, resolved.id, assigneeId, actorId ?? null);
    if (!ticket) throw new NotFoundError('Ticket not found');

    this.logAndPublishActivity(
      actorId ?? null, projectId, ticket.id,
      'ticket_assigned',
      ticket.group ? `Assigned to ${assignee.name} (claims group "${ticket.group}")` : `Assigned to ${assignee.name}`,
    );

    pubsub.publish(EVENTS.TICKET_UPDATED, {
      ticketUpdated: ticket,
      projectId: ticket.projectId,
    });

    this.audit(actorId ?? null, 'ASSIGN', `ticket '${ticket.title}'`, `→ ${assignee.name}`);
    return ticket;
  }

  unassignTicket(
    projectId: string,
    ticketId: string,
    actorId?: string | null,
  ): Ticket {
    const resolved = this.requireTicket(projectId, ticketId);

    const ticket = this.db.assignTicket(projectId, resolved.id, null, actorId ?? null);
    if (!ticket) throw new NotFoundError('Ticket not found');

    this.logAndPublishActivity(
      actorId ?? null, projectId, ticket.id,
      'ticket_unassigned', 'Unassigned ticket',
    );

    pubsub.publish(EVENTS.TICKET_UPDATED, {
      ticketUpdated: ticket,
      projectId: ticket.projectId,
    });

    this.audit(actorId ?? null, 'UNASSIGN', `ticket '${ticket.title}'`);
    return ticket;
  }

  closeTicket(projectId: string, ticketId: string): Ticket {
    const project = this.requireProject(projectId);
    const resolved = this.requireTicket(projectId, ticketId);
    const doneColumn = project.columns[project.columns.length - 1]!.id;

    if (doneColumn !== resolved.column) {
      this.assertDependenciesAllowColumn(project, resolved.dependsOn, doneColumn, resolved.title);
    }

    const ticket = this.db.moveTicket(projectId, resolved.id, doneColumn, null);
    if (!ticket) throw new NotFoundError('Ticket not found');

    this.db.logActivity(null, ticket.id, 'ticket_moved', `Human closed \u2192 ${doneColumn}`);

    pubsub.publish(EVENTS.TICKET_MOVED, {
      ticketMoved: ticket,
      projectId: ticket.projectId,
    });

    return ticket;
  }

  openTicket(projectId: string, ticketId: string): Ticket {
    const project = this.requireProject(projectId);
    const resolved = this.requireTicket(projectId, ticketId);
    const firstColumn = project.columns[0]!.id;

    const ticket = this.db.moveTicket(projectId, resolved.id, firstColumn, null);
    if (!ticket) throw new NotFoundError('Ticket not found');

    this.db.logActivity(null, ticket.id, 'ticket_moved', `Human reopened \u2192 ${firstColumn}`);

    pubsub.publish(EVENTS.TICKET_MOVED, {
      ticketMoved: ticket,
      projectId: ticket.projectId,
    });

    return ticket;
  }

  // -------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------

  createComment(
    projectId: string,
    ticketId: string,
    agentId: string,
    body: string,
  ): Comment {
    const resolved = this.requireTicket(projectId, ticketId);

    if (typeof body !== 'string' || body.trim().length === 0) {
      throw new ValidationError('Missing or invalid "body" field');
    }

    const comment = this.db.createComment(resolved.id, agentId, body.trim());

    const activity = this.db.logActivity(
      agentId,
      resolved.id,
      'comment_added',
      `Comment: ${body.trim()}`,
    );

    pubsub.publish(EVENTS.ACTIVITY_ADDED, {
      activityAdded: activity,
      projectId,
    });

    pubsub.publish(EVENTS.COMMENT_ADDED, {
      commentAdded: comment,
      projectId,
    });

    this.audit(agentId, 'COMMENT', `ticket '${resolved.id}'`, body.trim());
    return comment;
  }

  getCommentsByTicket(projectId: string, ticketId: string, viewerAgentId?: string | null): Comment[] {
    const resolved = this.requireTicket(projectId, ticketId);
    if (viewerAgentId) {
      this.notifyTicketView(projectId, resolved.id, viewerAgentId);
      this.audit(viewerAgentId, 'READ', `comments on ticket '${resolved.id}'`);
      this.logAndPublishActivity(viewerAgentId, projectId, resolved.id, 'comments_read', 'Read comments');
    }
    return this.db.getCommentsByTicket(resolved.id);
  }

  // -------------------------------------------------------------------------
  // Revisions
  // -------------------------------------------------------------------------

  getRevisionsByTicket(projectId: string, ticketId: string, viewerAgentId?: string | null): TicketRevision[] {
    const resolved = this.requireTicket(projectId, ticketId);
    if (viewerAgentId) {
      this.notifyTicketView(projectId, resolved.id, viewerAgentId);
      this.audit(viewerAgentId, 'READ', `history of ticket '${resolved.id}'`);
      this.logAndPublishActivity(viewerAgentId, projectId, resolved.id, 'history_read', 'Read ticket history');
    }
    return this.db.getRevisionsByTicket(resolved.id);
  }

  // -------------------------------------------------------------------------
  // Activity
  // -------------------------------------------------------------------------

  getActivitiesByProject(projectId: string): Activity[] {
    this.requireProject(projectId);
    return this.db.getActivitiesByProject(projectId);
  }

  // -------------------------------------------------------------------------
  // Audit (read-only queries – actual logging stays in HTTP middleware)
  // -------------------------------------------------------------------------

  getAllAuditEntries(limit?: number): AuditEntry[] {
    return this.db.getAllAuditEntries(limit);
  }

  getAuditEntriesByAgent(agentId: string, limit?: number): AuditEntry[] {
    return this.db.getAuditEntriesByAgent(agentId, limit);
  }

  // -------------------------------------------------------------------------
  // Batch execution
  //
  // Executes many board operations in one call (one round-trip for agents).
  // Operations run sequentially in array order; each result is reported
  // individually – a failed operation does NOT roll back the others, so the
  // caller can see exactly which operations succeeded.
  // -------------------------------------------------------------------------

  executeBatch(operations: unknown, actorId?: string | null): BatchOperationResult[] {
    const ops = this.validateBatchInput(operations);

    const results: BatchOperationResult[] = ops.map(({ op, args }) => {
      try {
        return { op, ok: true, result: this.dispatchBatchOp(op, args, actorId ?? null) };
      } catch (e) {
        return { op, ok: false, error: e instanceof Error ? e.message : 'Failed' };
      }
    });

    const failed = results.filter((r) => !r.ok).length;
    this.audit(
      actorId ?? null,
      'BATCH',
      `${ops.length} operation${ops.length !== 1 ? 's' : ''}`,
      `${ops.length - failed} ok, ${failed} failed: ${ops.map((o) => o.op).join(', ')}`,
    );
    return results;
  }

  /** Validates the batch envelope. Throws ValidationError before anything runs. */
  private validateBatchInput(operations: unknown): BatchOperation[] {
    if (!Array.isArray(operations) || operations.length === 0 || operations.length > MAX_BATCH_OPS) {
      throw new ValidationError(
        `"operations" must be an array of 1-${MAX_BATCH_OPS} entries like {"op": "update_ticket", "args": {...}}`,
      );
    }
    return operations.map((entry, i) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new ValidationError(`Operation #${i} must be an object with "op" and "args"`);
      }
      const { op, args } = entry as { op?: unknown; args?: unknown };
      if (typeof op !== 'string' || !(BATCH_OPS as readonly string[]).includes(op)) {
        throw new ValidationError(
          `Operation #${i} has unknown "op" "${String(op)}". Supported operations: ${BATCH_OPS.join(', ')}`,
        );
      }
      if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
        throw new ValidationError(`Operation #${i} ("${op}"): "args" must be an object`);
      }
      return { op: op as BatchOp, args: (args ?? {}) as Record<string, unknown> };
    });
  }

  /** Routes one batch operation to the matching service method (snake_case args, like MCP/REST). */
  private dispatchBatchOp(op: BatchOp, args: Record<string, unknown>, actorId: string | null): unknown {
    const str = (key: string): string => String(args[key] ?? '');
    const optStr = (key: string): string | undefined =>
      typeof args[key] === 'string' ? (args[key] as string) : undefined;

    switch (op) {
      case 'list_projects':
        return this.getAllProjects(actorId);
      case 'get_project':
        return this.getProject(str('project_id'), actorId);
      case 'create_project':
        return this.createProject(args['name'] as string, optStr('description'), actorId, args['columns']);
      case 'update_project': {
        const updates: { name?: string; description?: string; columns?: unknown } = {};
        if (args['name'] !== undefined) updates.name = args['name'] as string;
        if (args['description'] !== undefined) updates.description = args['description'] as string;
        if (args['columns'] !== undefined) updates.columns = args['columns'];
        return this.updateProject(str('project_id'), updates, actorId);
      }
      case 'delete_project':
        this.deleteProject(str('project_id'), actorId);
        return { deleted: true };
      case 'list_tickets':
        return this.getTicketsByProject(str('project_id'), actorId, {
          column: optStr('column'),
          work_type: optStr('work_type') as WorkTypeFilter | undefined,
          page: args['page'] as number | undefined,
          per_page: args['per_page'] as number | undefined,
        });
      case 'get_ticket':
        return this.getTicket(str('project_id'), str('ticket_id'), actorId);
      case 'create_ticket':
        return this.createTicket(
          str('project_id'),
          args['title'] as string,
          optStr('description'),
          optStr('column'),
          actorId,
          args['group'] as string | null | undefined,
          args['blocked_reason'] as string | null | undefined,
          args['depends_on'],
          args['priority'],
          args['work_type'],
        );
      case 'update_ticket': {
        const updates: {
          title?: string; description?: string; column?: string; group?: string | null;
          blockedReason?: string | null; dependsOn?: unknown; priority?: unknown;
          workType?: unknown;
        } = {};
        if (args['title'] !== undefined) updates.title = args['title'] as string;
        if (args['description'] !== undefined) updates.description = args['description'] as string;
        if (args['column'] !== undefined) updates.column = args['column'] as string;
        if (args['group'] !== undefined) updates.group = args['group'] as string | null;
        if (args['blocked_reason'] !== undefined) updates.blockedReason = args['blocked_reason'] as string | null;
        if (args['depends_on'] !== undefined) updates.dependsOn = args['depends_on'];
        if (args['priority'] !== undefined) updates.priority = args['priority'];
        if (args['work_type'] !== undefined) updates.workType = args['work_type'];
        return this.updateTicket(str('project_id'), str('ticket_id'), updates, actorId);
      }
      case 'move_ticket':
        return this.moveTicket(str('project_id'), str('ticket_id'), args['column'] as string, actorId);
      case 'assign_ticket': {
        const assigneeId = args['assignee_id'];
        if (typeof assigneeId === 'string' && assigneeId.length > 0) {
          return this.assignTicket(str('project_id'), str('ticket_id'), assigneeId, actorId);
        }
        return this.unassignTicket(str('project_id'), str('ticket_id'), actorId);
      }
      case 'delete_ticket':
        this.deleteTicket(str('project_id'), str('ticket_id'), actorId);
        return { deleted: true };
      case 'add_comment':
        return this.createComment(str('project_id'), str('ticket_id'), actorId as string, args['body'] as string);
      case 'get_comments':
        return this.getCommentsByTicket(str('project_id'), str('ticket_id'), actorId);
      case 'get_ticket_history':
        return this.getRevisionsByTicket(str('project_id'), str('ticket_id'), actorId);
      case 'list_agents':
        return this.getAllAgents(actorId);
    }
  }

  // -------------------------------------------------------------------------
  // Activity helper: log + publish in one call
  // -------------------------------------------------------------------------

  private logAndPublishActivity(
    agentId: string | null,
    projectId: string,
    ticketId: string | null,
    action: import('../types.js').ActivityAction,
    details: string,
  ): void {
    const activity = this.db.logActivity(agentId, ticketId, action, details, projectId);
    pubsub.publish(EVENTS.ACTIVITY_ADDED, { activityAdded: activity, projectId });
  }

  // -------------------------------------------------------------------------
  // View notifications (fire-and-forget, for frontend "agent is reading" indicator)
  // -------------------------------------------------------------------------

  notifyTicketView(projectId: string, ticketId: string, agentId: string): void {
    const agent = this.db.getAgentById(agentId);
    if (!agent) return;
    pubsub.publish(EVENTS.TICKET_VIEWED, {
      ticketViewed: { ticketId, projectId, agentId, agentName: agent.name },
      projectId,
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private requireProject(projectId: string): Project {
    const project = this.db.getProject(projectId);
    if (!project) throw new NotFoundError('Project not found');
    return project;
  }

  private requireTicket(projectId: string, ticketId: string): Ticket {
    const ticket = this.db.getTicket(projectId, ticketId);
    if (!ticket) throw new NotFoundError('Ticket not found');
    return ticket;
  }

  /**
   * Returns the agent currently claiming a group, or null if the group is free.
   * A group is claimed while any of its tickets outside the last (finished)
   * column has an assignee. The ticket being operated on (excludeTicketId) is
   * ignored so re-assigning it does not conflict with itself.
   */
  private findGroupClaimer(
    projectId: string,
    group: string,
    excludeTicketId?: string,
  ): AgentPublic | null {
    const project = this.db.getProject(projectId);
    const doneColumn = project ? project.columns[project.columns.length - 1]!.id : 'done';
    const groupTickets = this.db.getTicketsByGroup(projectId, group);
    for (const t of groupTickets) {
      if (t.id === excludeTicketId) continue;
      if (t.column === doneColumn) continue;
      if (t.assigneeId) {
        return this.db.getAgentById(t.assigneeId) ?? null;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Column configuration & dependency helpers
  // -------------------------------------------------------------------------

  /** Throws unless the value is one of the known priority levels. */
  private validatePriority(value: unknown): Priority {
    if (typeof value !== 'string' || !(PRIORITIES as readonly string[]).includes(value)) {
      throw new ValidationError(
        `Invalid "priority" value "${String(value)}". Valid priorities: ${PRIORITIES.join(', ')}`,
      );
    }
    return value as Priority;
  }

  /**
   * Normalises a work type: null / '' clear the classification, anything else
   * must be a known work type.
   */
  private validateWorkType(value: unknown): WorkType | null {
    if (value === null) return null;
    if (typeof value === 'string' && value.trim().length === 0) return null;
    if (typeof value !== 'string' || !(WORK_TYPES as readonly string[]).includes(value)) {
      throw new ValidationError(
        `Invalid "work_type" value "${String(value)}". Valid work types: ${WORK_TYPES.join(', ')} (or empty to clear)`,
      );
    }
    return value as WorkType;
  }

  /** Throws unless the value is a usable work_type list filter. */
  private validateWorkTypeFilter(value: unknown): WorkTypeFilter {
    if (typeof value !== 'string' || !(WORK_TYPE_FILTERS as readonly string[]).includes(value)) {
      throw new ValidationError(
        `Invalid "work_type" filter "${String(value)}". Valid filters: ${WORK_TYPE_FILTERS.join(', ')}`,
      );
    }
    return value as WorkTypeFilter;
  }

  /** Throws unless columnId exists in the project's configured columns. */
  private requireValidColumn(project: Project, columnId: string): void {
    if (typeof columnId !== 'string' || !project.columns.some((c) => c.id === columnId)) {
      const valid = project.columns.map((c) => c.id).join(', ');
      throw new ValidationError(
        `Invalid column "${String(columnId)}" for project "${project.name}". Valid columns: ${valid}`,
      );
    }
  }

  /**
   * Validates a raw columns config (array of {id, title}).
   * Rules: 2-${MAX_COLUMNS} columns, ids are lowercase slugs, unique.
   * Convention: first column = inbox for new tickets, last = finished.
   */
  private validateColumnsInput(value: unknown): ColumnDef[] {
    if (!Array.isArray(value) || value.length < 2 || value.length > MAX_COLUMNS) {
      throw new ValidationError(`"columns" must be an array of 2-${MAX_COLUMNS} entries like {"id": "in_progress", "title": "In Progress"}`);
    }
    const result: ColumnDef[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== 'object' || entry === null) {
        throw new ValidationError('Each column must be an object with "id" and "title"');
      }
      const { id, title } = entry as { id?: unknown; title?: unknown };
      if (typeof id !== 'string' || !COLUMN_ID_RE.test(id)) {
        throw new ValidationError(`Invalid column id "${String(id)}" – use a lowercase slug (a-z, 0-9, _, -), max 32 chars`);
      }
      if (typeof title !== 'string' || title.trim().length === 0 || title.trim().length > 50) {
        throw new ValidationError(`Invalid title for column "${id}" – must be 1-50 characters`);
      }
      if (seen.has(id)) {
        throw new ValidationError(`Duplicate column id "${id}"`);
      }
      seen.add(id);
      result.push({ id, title: title.trim() });
    }
    return result;
  }

  /**
   * Validates and resolves a raw depends_on value to full ticket ids.
   * Every dependency must be an existing ticket of the same project;
   * self-dependencies are rejected; duplicates are removed.
   */
  private resolveDependencies(projectId: string, ticketId: string | null, value: unknown): string[] {
    if (!Array.isArray(value)) {
      throw new ValidationError('"depends_on" must be an array of ticket ids');
    }
    const resolved: string[] = [];
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        throw new ValidationError('"depends_on" must contain only non-empty ticket id strings');
      }
      const dep = this.db.getTicket(projectId, entry.trim());
      if (!dep) {
        throw new NotFoundError(`Dependency ticket "${entry}" not found in this project`);
      }
      if (ticketId && dep.id === ticketId) {
        throw new ValidationError('A ticket cannot depend on itself');
      }
      if (!resolved.includes(dep.id)) resolved.push(dep.id);
    }
    return resolved;
  }

  /**
   * Rejects dependency chains that loop back to the ticket being updated
   * (A→B→A would deadlock both tickets in the first column forever).
   */
  private assertNoDependencyCycle(projectId: string, ticketId: string, newDeps: string[]): void {
    const visited = new Set<string>();
    const stack = [...newDeps];
    while (stack.length > 0) {
      const currentId = stack.pop()!;
      if (currentId === ticketId) {
        throw new ValidationError('Dependency cycle detected – a ticket cannot (transitively) depend on itself');
      }
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      const current = this.db.getTicket(projectId, currentId);
      if (current) stack.push(...current.dependsOn);
    }
  }

  /**
   * Dependency gate: a ticket with unfinished dependencies may only live in
   * the FIRST column of its board. Any move to another column is refused with
   * an explanation of exactly which tickets are still open and where they are.
   */
  private assertDependenciesAllowColumn(
    project: Project,
    dependsOn: string[],
    targetColumn: string,
    ticketTitle: string,
  ): void {
    if (dependsOn.length === 0) return;
    const firstColumn = project.columns[0]!.id;
    const doneColumn = project.columns[project.columns.length - 1]!.id;
    if (targetColumn === firstColumn) return;

    const open = dependsOn
      .map((id) => this.db.getTicket(project.id, id))
      .filter((t): t is Ticket => t !== undefined && t.column !== doneColumn);

    if (open.length === 0) return;

    const list = open
      .map((t) => `#${t.id.slice(0, 8)} "${t.title}" (in ${t.column})`)
      .join(', ');
    throw new ConflictError(
      `Cannot move ticket "${ticketTitle}" to "${targetColumn}": it depends on ${open.length} unfinished ticket${open.length !== 1 ? 's' : ''}: ${list}. ` +
      `Finish those first (move them to "${doneColumn}"), or remove the dependency, or leave this ticket in "${firstColumn}".`,
    );
  }
}
