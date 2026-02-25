import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AgentboardDB } from '../../db/database.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { isValidColumn } from '../../types.js';
import { pubsub, EVENTS } from '../../graphql/pubsub.js';

// ---------------------------------------------------------------------------
// Ticket + Comment routes (nested under /api/projects/:id)
// ---------------------------------------------------------------------------

export function createTicketRoutes(db: AgentboardDB): Router {
  const router: Router = Router({ mergeParams: true });
  const auth = createAuthMiddleware(db);

  // POST /api/projects/:id/tickets
  router.post('/tickets', auth, (req: Request, res: Response): void => {
    const projectId = String(req.params['id'] ?? '');
    const project = db.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const { title, description, column } = req.body as {
      title?: unknown;
      description?: unknown;
      column?: unknown;
    };

    if (typeof title !== 'string' || title.trim().length === 0) {
      res.status(400).json({ error: 'Missing or invalid "title" field' });
      return;
    }

    const desc = typeof description === 'string' ? description : '';
    const col = column !== undefined ? column : 'backlog';
    if (!isValidColumn(col)) {
      res.status(400).json({ error: `Invalid column value: "${String(col)}"` });
      return;
    }

    const agentId = (req as AuthenticatedRequest).agentId ?? null;

    try {
      const ticket = db.createTicket(projectId, title.trim(), desc, col, agentId);
      db.logActivity(agentId, ticket.id, 'ticket_created', `Created ticket "${ticket.title}"`);
      pubsub.publish(EVENTS.TICKET_CREATED, { ticketCreated: ticket, projectId: ticket.projectId });
      res.status(201).json(ticket);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // GET /api/projects/:id/tickets
  router.get('/tickets', (req: Request, res: Response): void => {
    const projectId = String(req.params['id'] ?? '');
    const project = db.getProject(projectId);
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    const tickets = db.getTicketsByProject(projectId);
    res.json(tickets);
  });

  // GET /api/projects/:id/tickets/:ticketId
  router.get('/tickets/:ticketId', (req: Request, res: Response): void => {
    const projectId = String(req.params['id'] ?? '');
    const ticketId = String(req.params['ticketId'] ?? '');

    const ticket = db.getTicket(projectId, ticketId);
    if (!ticket) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    res.json(ticket);
  });

  // PATCH /api/projects/:id/tickets/:ticketId
  router.patch('/tickets/:ticketId', auth, (req: Request, res: Response): void => {
    const projectId = String(req.params['id'] ?? '');
    const ticketId = String(req.params['ticketId'] ?? '');

    const existing = db.getTicket(projectId, ticketId);
    if (!existing) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    const { title, description, column } = req.body as {
      title?: unknown;
      description?: unknown;
      column?: unknown;
    };

    if (title !== undefined && (typeof title !== 'string' || title.trim().length === 0)) {
      res.status(400).json({ error: 'Invalid "title" field' });
      return;
    }

    if (description !== undefined && typeof description !== 'string') {
      res.status(400).json({ error: 'Invalid "description" field' });
      return;
    }

    if (column !== undefined && !isValidColumn(column)) {
      res.status(400).json({ error: `Invalid column value: "${String(column)}"` });
      return;
    }

    const agentId = (req as AuthenticatedRequest).agentId ?? null;

    try {
      const updates: { title?: string; description?: string; column?: typeof column & string } = {};
      if (typeof title === 'string') updates.title = title.trim();
      if (typeof description === 'string') updates.description = description;
      if (isValidColumn(column)) updates.column = column;

      const ticket = db.updateTicket(projectId, ticketId, updates, agentId);
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      db.logActivity(agentId, ticket.id, 'ticket_updated', 'Updated ticket');
      pubsub.publish(EVENTS.TICKET_UPDATED, { ticketUpdated: ticket, projectId: ticket.projectId });
      res.json(ticket);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // PATCH /api/projects/:id/tickets/:ticketId/move
  router.patch('/tickets/:ticketId/move', auth, (req: Request, res: Response): void => {
    const projectId = String(req.params['id'] ?? '');
    const ticketId = String(req.params['ticketId'] ?? '');

    const existing = db.getTicket(projectId, ticketId);
    if (!existing) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    const { column } = req.body as { column?: unknown };

    if (!isValidColumn(column)) {
      res.status(400).json({ error: `Invalid or missing column value: "${String(column)}"` });
      return;
    }

    const agentId = (req as AuthenticatedRequest).agentId ?? null;

    try {
      const ticket = db.moveTicket(projectId, ticketId, column, agentId);
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      db.logActivity(agentId, ticket.id, 'ticket_moved', `Moved to ${column}`);
      pubsub.publish(EVENTS.TICKET_MOVED, { ticketMoved: ticket, projectId: ticket.projectId });
      res.json(ticket);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // DELETE /api/projects/:id/tickets/:ticketId
  router.delete('/tickets/:ticketId', auth, (req: Request, res: Response): void => {
    const projectId = String(req.params['id'] ?? '');
    const ticketId = String(req.params['ticketId'] ?? '');

    const existing = db.getTicket(projectId, ticketId);
    if (!existing) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    try {
      db.deleteTicket(projectId, ticketId);
      res.status(204).end();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // POST /api/projects/:id/tickets/:ticketId/comments
  router.post('/tickets/:ticketId/comments', auth, (req: Request, res: Response): void => {
    const projectId = String(req.params['id'] ?? '');
    const ticketId = String(req.params['ticketId'] ?? '');

    const existing = db.getTicket(projectId, ticketId);
    if (!existing) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    const { body } = req.body as { body?: unknown };

    if (typeof body !== 'string' || body.trim().length === 0) {
      res.status(400).json({ error: 'Missing or invalid "body" field' });
      return;
    }

    const agentId = (req as AuthenticatedRequest).agentId ?? '';

    try {
      const comment = db.createComment(ticketId, agentId, body.trim());
      const activity = db.logActivity(agentId, ticketId, 'comment_added', `Comment: ${body.trim()}`);
      pubsub.publish(EVENTS.ACTIVITY_ADDED, { activityAdded: activity, projectId });
      res.status(201).json(comment);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // GET /api/projects/:id/tickets/:ticketId/comments
  router.get('/tickets/:ticketId/comments', (req: Request, res: Response): void => {
    const projectId = String(req.params['id'] ?? '');
    const ticketId = String(req.params['ticketId'] ?? '');

    const existing = db.getTicket(projectId, ticketId);
    if (!existing) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    const comments = db.getCommentsByTicket(ticketId);
    res.json(comments);
  });

  // GET /api/projects/:id/tickets/:ticketId/revisions
  router.get('/tickets/:ticketId/revisions', (req: Request, res: Response): void => {
    const projectId = String(req.params['id'] ?? '');
    const ticketId = String(req.params['ticketId'] ?? '');

    const existing = db.getTicket(projectId, ticketId);
    if (!existing) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    const revisions = db.getRevisionsByTicket(ticketId);
    res.json(revisions);
  });

  return router;
}

// ---------------------------------------------------------------------------
// Human action routes (no auth required)
// ---------------------------------------------------------------------------

export function createHumanTicketRoutes(db: AgentboardDB): Router {
  const router: Router = Router({ mergeParams: true });

  // POST /api/projects/:id/tickets/:ticketId/open
  router.post('/tickets/:ticketId/open', (req: Request, res: Response): void => {
    const projectId = String(req.params['id'] ?? '');
    const ticketId = String(req.params['ticketId'] ?? '');

    const existing = db.getTicket(projectId, ticketId);
    if (!existing) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    try {
      const ticket = db.moveTicket(projectId, ticketId, 'backlog', null);
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      db.logActivity(null, ticket.id, 'ticket_moved', 'Human reopened → backlog');
      pubsub.publish(EVENTS.TICKET_MOVED, { ticketMoved: ticket, projectId: ticket.projectId });
      res.json(ticket);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // POST /api/projects/:id/tickets/:ticketId/close
  router.post('/tickets/:ticketId/close', (req: Request, res: Response): void => {
    const projectId = String(req.params['id'] ?? '');
    const ticketId = String(req.params['ticketId'] ?? '');

    const existing = db.getTicket(projectId, ticketId);
    if (!existing) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }

    try {
      const ticket = db.moveTicket(projectId, ticketId, 'done', null);
      if (!ticket) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      db.logActivity(null, ticket.id, 'ticket_moved', 'Human closed → done');
      pubsub.publish(EVENTS.TICKET_MOVED, { ticketMoved: ticket, projectId: ticket.projectId });
      res.json(ticket);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  return router;
}
