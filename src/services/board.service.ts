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
} from '../types.js';
import { NotFoundError, ValidationError, DuplicateError } from './errors.js';

export class BoardService {
  constructor(private db: AgentboardDB) {}

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

  createAgent(name: string): Agent {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ValidationError('Missing or invalid "name" field');
    }
    try {
      return this.db.createAgent(name.trim());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '';
      if (message.includes('UNIQUE')) {
        throw new DuplicateError(`Agent name "${name}" is already taken`);
      }
      throw err;
    }
  }

  getAllAgents(): AgentPublic[] {
    return this.db.getAllAgents();
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
  }

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  createProject(name: string, description?: string): Project {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new ValidationError('Missing or invalid "name" field');
    }
    return this.db.createProject(name.trim(), description ?? '');
  }

  getAllProjects(): Project[] {
    return this.db.getAllProjects();
  }

  getProject(id: string): Project {
    const project = this.db.getProject(id);
    if (!project) throw new NotFoundError('Project not found');
    return project;
  }

  deleteProject(id: string): void {
    const project = this.db.getProject(id);
    if (!project) throw new NotFoundError('Project not found');
    this.db.deleteProject(id);
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

    return ticket;
  }

  getTicket(projectId: string, ticketId: string): Ticket {
    const ticket = this.db.getTicket(projectId, ticketId);
    if (!ticket) throw new NotFoundError('Ticket not found');
    return ticket;
  }

  getTicketsByProject(projectId: string): Ticket[] {
    this.requireProject(projectId);
    return this.db.getTicketsByProject(projectId);
  }

  updateTicket(
    projectId: string,
    ticketId: string,
    updates: { title?: string; description?: string; column?: string },
    actorId?: string | null,
  ): Ticket {
    this.requireTicket(projectId, ticketId);

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

    const ticket = this.db.updateTicket(projectId, ticketId, cleanUpdates, actorId ?? null);
    if (!ticket) throw new NotFoundError('Ticket not found');

    this.db.logActivity(actorId ?? null, ticket.id, 'ticket_updated', 'Updated ticket');

    pubsub.publish(EVENTS.TICKET_UPDATED, {
      ticketUpdated: ticket,
      projectId: ticket.projectId,
    });

    return ticket;
  }

  moveTicket(
    projectId: string,
    ticketId: string,
    column: string,
    actorId?: string | null,
  ): Ticket {
    this.requireTicket(projectId, ticketId);

    if (!isValidColumn(column)) {
      throw new ValidationError(`Invalid or missing column value: "${column}"`);
    }

    const ticket = this.db.moveTicket(projectId, ticketId, column, actorId ?? null);
    if (!ticket) throw new NotFoundError('Ticket not found');

    this.db.logActivity(actorId ?? null, ticket.id, 'ticket_moved', `Moved to ${column}`);

    pubsub.publish(EVENTS.TICKET_MOVED, {
      ticketMoved: ticket,
      projectId: ticket.projectId,
    });

    return ticket;
  }

  deleteTicket(projectId: string, ticketId: string): void {
    this.requireTicket(projectId, ticketId);
    this.db.deleteTicket(projectId, ticketId);
  }

  closeTicket(projectId: string, ticketId: string): Ticket {
    this.requireTicket(projectId, ticketId);

    const ticket = this.db.moveTicket(projectId, ticketId, 'done', null);
    if (!ticket) throw new NotFoundError('Ticket not found');

    this.db.logActivity(null, ticket.id, 'ticket_moved', 'Human closed \u2192 done');

    pubsub.publish(EVENTS.TICKET_MOVED, {
      ticketMoved: ticket,
      projectId: ticket.projectId,
    });

    return ticket;
  }

  openTicket(projectId: string, ticketId: string): Ticket {
    this.requireTicket(projectId, ticketId);

    const ticket = this.db.moveTicket(projectId, ticketId, 'backlog', null);
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
    this.requireTicket(projectId, ticketId);

    if (typeof body !== 'string' || body.trim().length === 0) {
      throw new ValidationError('Missing or invalid "body" field');
    }

    const comment = this.db.createComment(ticketId, agentId, body.trim());

    const activity = this.db.logActivity(
      agentId,
      ticketId,
      'comment_added',
      `Comment: ${body.trim()}`,
    );

    pubsub.publish(EVENTS.ACTIVITY_ADDED, {
      activityAdded: activity,
      projectId,
    });

    return comment;
  }

  getCommentsByTicket(projectId: string, ticketId: string): Comment[] {
    this.requireTicket(projectId, ticketId);
    return this.db.getCommentsByTicket(ticketId);
  }

  // -------------------------------------------------------------------------
  // Revisions
  // -------------------------------------------------------------------------

  getRevisionsByTicket(projectId: string, ticketId: string): TicketRevision[] {
    this.requireTicket(projectId, ticketId);
    return this.db.getRevisionsByTicket(ticketId);
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
