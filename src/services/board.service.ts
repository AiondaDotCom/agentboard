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
import { isValidColumn } from '../types.js';
import type {
  Agent,
  AgentPublic,
  Project,
  Ticket,
  Comment,
  Activity,
  AuditEntry,
  TicketRevision,
  Column,
  TicketListOptions,
  PaginatedResult,
} from '../types.js';
import { NotFoundError, ValidationError, DuplicateError } from './errors.js';

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

  createProject(name: string, description?: string, actorId?: string | null): Project {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ValidationError('Missing or invalid "name" field');
    }
    const project = this.db.createProject(name.trim(), description ?? '');
    pubsub.publish(EVENTS.PROJECT_CHANGED, { projectChanged: project });
    this.audit(actorId ?? null, 'CREATE', `project '${project.name}'`);
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
  ): Ticket {
    this.requireProject(projectId);

    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new ValidationError('Missing or invalid "title" field');
    }

    const col = column ?? 'backlog';
    if (!isValidColumn(col)) {
      throw new ValidationError(`Invalid column value: "${col}"`);
    }

    const ticket = this.db.createTicket(
      projectId,
      title.trim(),
      description ?? '',
      col,
      agentId ?? null,
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
    this.requireProject(projectId);
    if (options?.column && !isValidColumn(options.column)) {
      throw new ValidationError(`Invalid column "${options.column}". Valid: backlog, ready, in_progress, in_review, done`);
    }
    const result = this.db.getTicketsByProject(projectId, options);
    if (actorId) {
      const project = this.db.getProject(projectId);
      const filterInfo = options?.column ? ` (column=${options.column})` : '';
      this.audit(actorId, 'LIST', `tickets in '${project?.name ?? projectId}'${filterInfo}`, `${result.total} total, page ${result.page}/${result.total_pages}`);
      this.logAndPublishActivity(actorId, projectId, null, 'tickets_listed', `Listed ${result.data.length} of ${result.total} tickets${filterInfo}`);
    }
    return result;
  }

  updateTicket(
    projectId: string,
    ticketId: string,
    updates: { title?: string; description?: string; column?: string },
    actorId?: string | null,
  ): Ticket {
    const resolved = this.requireTicket(projectId, ticketId);

    if (updates.title !== undefined && (typeof updates.title !== 'string' || updates.title.trim().length === 0)) {
      throw new ValidationError('Invalid "title" field');
    }
    if (updates.description !== undefined && typeof updates.description !== 'string') {
      throw new ValidationError('Invalid "description" field');
    }
    if (updates.column !== undefined && !isValidColumn(updates.column)) {
      throw new ValidationError(`Invalid column value: "${updates.column}"`);
    }

    const cleanUpdates: { title?: string; description?: string; column?: Column } = {};
    if (typeof updates.title === 'string') cleanUpdates.title = updates.title.trim();
    if (typeof updates.description === 'string') cleanUpdates.description = updates.description;
    if (isValidColumn(updates.column)) cleanUpdates.column = updates.column;

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
    const resolved = this.requireTicket(projectId, ticketId);

    if (!isValidColumn(column)) {
      throw new ValidationError(`Invalid or missing column value: "${column}"`);
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

    const ticket = this.db.assignTicket(projectId, resolved.id, assigneeId, actorId ?? null);
    if (!ticket) throw new NotFoundError('Ticket not found');

    this.logAndPublishActivity(
      actorId ?? null, projectId, ticket.id,
      'ticket_assigned', `Assigned to ${assignee.name}`,
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
    const resolved = this.requireTicket(projectId, ticketId);

    const ticket = this.db.moveTicket(projectId, resolved.id, 'done', null);
    if (!ticket) throw new NotFoundError('Ticket not found');

    this.db.logActivity(null, ticket.id, 'ticket_moved', 'Human closed \u2192 done');

    pubsub.publish(EVENTS.TICKET_MOVED, {
      ticketMoved: ticket,
      projectId: ticket.projectId,
    });

    return ticket;
  }

  openTicket(projectId: string, ticketId: string): Ticket {
    const resolved = this.requireTicket(projectId, ticketId);

    const ticket = this.db.moveTicket(projectId, resolved.id, 'backlog', null);
    if (!ticket) throw new NotFoundError('Ticket not found');

    this.db.logActivity(null, ticket.id, 'ticket_moved', 'Human reopened \u2192 backlog');

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
}
