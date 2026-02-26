import { Router } from 'express';
import type { Request, Response } from 'express';
import type { BoardService } from '../../services/board.service.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { handleServiceError } from './helpers.js';

// ---------------------------------------------------------------------------
// Ticket + Comment routes (nested under /api/projects/:id)
// ---------------------------------------------------------------------------

export function createTicketRoutes(service: BoardService): Router {
  const router: Router = Router({ mergeParams: true });
  const auth = createAuthMiddleware(service);

  // POST /api/projects/:id/tickets
  router.post('/tickets', auth, (req: Request, res: Response): void => {
    try {
      const projectId = String(req.params['id'] ?? '');
      const { title, description, column } = req.body as {
        title?: unknown;
        description?: unknown;
        column?: unknown;
      };
      const agentId = (req as AuthenticatedRequest).agentId ?? null;

      const ticket = service.createTicket(
        projectId,
        title as string,
        typeof description === 'string' ? description : undefined,
        column as string | undefined,
        agentId,
      );
      res.status(201).json(ticket);
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // GET /api/projects/:id/tickets
  router.get('/tickets', (req: Request, res: Response): void => {
    try {
      const projectId = String(req.params['id'] ?? '');
      res.json(service.getTicketsByProject(projectId));
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // GET /api/projects/:id/tickets/:ticketId
  router.get('/tickets/:ticketId', (req: Request, res: Response): void => {
    try {
      const projectId = String(req.params['id'] ?? '');
      const ticketId = String(req.params['ticketId'] ?? '');

      // Optional agent detection for viewing indicator (no auth required)
      const apiKey = req.headers['x-api-key'];
      const agent = typeof apiKey === 'string' ? service.getAgentByApiKey(apiKey) : undefined;

      res.json(service.getTicket(projectId, ticketId, agent?.id ?? null));
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // PATCH /api/projects/:id/tickets/:ticketId
  router.patch('/tickets/:ticketId', auth, (req: Request, res: Response): void => {
    try {
      const projectId = String(req.params['id'] ?? '');
      const ticketId = String(req.params['ticketId'] ?? '');
      const { title, description, column } = req.body as {
        title?: unknown;
        description?: unknown;
        column?: unknown;
      };
      const agentId = (req as AuthenticatedRequest).agentId ?? null;

      const updates: { title?: string; description?: string; column?: string } = {};
      if (title !== undefined) updates.title = title as string;
      if (description !== undefined) updates.description = description as string;
      if (column !== undefined) updates.column = column as string;

      const ticket = service.updateTicket(projectId, ticketId, updates, agentId);
      res.json(ticket);
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // PATCH /api/projects/:id/tickets/:ticketId/move
  router.patch('/tickets/:ticketId/move', auth, (req: Request, res: Response): void => {
    try {
      const projectId = String(req.params['id'] ?? '');
      const ticketId = String(req.params['ticketId'] ?? '');
      const { column } = req.body as { column?: unknown };
      const agentId = (req as AuthenticatedRequest).agentId ?? null;

      const ticket = service.moveTicket(projectId, ticketId, column as string, agentId);
      res.json(ticket);
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // DELETE /api/projects/:id/tickets/:ticketId
  router.delete('/tickets/:ticketId', auth, (req: Request, res: Response): void => {
    try {
      const projectId = String(req.params['id'] ?? '');
      const ticketId = String(req.params['ticketId'] ?? '');
      service.deleteTicket(projectId, ticketId);
      res.status(204).end();
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // POST /api/projects/:id/tickets/:ticketId/comments
  router.post('/tickets/:ticketId/comments', auth, (req: Request, res: Response): void => {
    try {
      const projectId = String(req.params['id'] ?? '');
      const ticketId = String(req.params['ticketId'] ?? '');
      const { body } = req.body as { body?: unknown };
      const agentId = (req as AuthenticatedRequest).agentId ?? '';

      const comment = service.createComment(projectId, ticketId, agentId, body as string);
      res.status(201).json(comment);
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // GET /api/projects/:id/tickets/:ticketId/comments
  router.get('/tickets/:ticketId/comments', (req: Request, res: Response): void => {
    try {
      const projectId = String(req.params['id'] ?? '');
      const ticketId = String(req.params['ticketId'] ?? '');
      res.json(service.getCommentsByTicket(projectId, ticketId));
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // GET /api/projects/:id/tickets/:ticketId/revisions
  router.get('/tickets/:ticketId/revisions', (req: Request, res: Response): void => {
    try {
      const projectId = String(req.params['id'] ?? '');
      const ticketId = String(req.params['ticketId'] ?? '');
      res.json(service.getRevisionsByTicket(projectId, ticketId));
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Human action routes (no auth required)
// ---------------------------------------------------------------------------

export function createHumanTicketRoutes(service: BoardService): Router {
  const router: Router = Router({ mergeParams: true });

  // POST /api/projects/:id/tickets/:ticketId/open
  router.post('/tickets/:ticketId/open', (req: Request, res: Response): void => {
    try {
      const projectId = String(req.params['id'] ?? '');
      const ticketId = String(req.params['ticketId'] ?? '');
      res.json(service.openTicket(projectId, ticketId));
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // POST /api/projects/:id/tickets/:ticketId/close
  router.post('/tickets/:ticketId/close', (req: Request, res: Response): void => {
    try {
      const projectId = String(req.params['id'] ?? '');
      const ticketId = String(req.params['ticketId'] ?? '');
      res.json(service.closeTicket(projectId, ticketId));
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  return router;
}
