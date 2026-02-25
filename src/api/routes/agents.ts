import { Router } from 'express';
import type { Request, Response } from 'express';
import type { BoardService } from '../../services/board.service.js';
import { createAdminAuthMiddleware } from '../middleware/auth.js';
import { handleServiceError } from './helpers.js';

export function createAgentRoutes(service: BoardService): Router {
  const router: Router = Router();
  const adminAuth = createAdminAuthMiddleware(service);

  // POST /api/agents - Register a new agent (admin auth required)
  router.post('/', adminAuth, (req: Request, res: Response): void => {
    try {
      const { name } = req.body as { name?: unknown };
      const agent = service.createAgent(name as string);
      res.status(201).json(agent);
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // GET /api/agents - List all agents (public, no apiKey exposed)
  router.get('/', (_req: Request, res: Response): void => {
    res.json(service.getAllAgents());
  });

  // DELETE /api/agents/:id - Delete an agent (admin auth required)
  router.delete('/:id', adminAuth, (req: Request, res: Response): void => {
    try {
      service.deleteAgent(String(req.params['id'] ?? ''));
      res.status(204).end();
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // POST /api/agents/admin-key/rotate - Generate a new admin key
  router.post('/admin-key/rotate', adminAuth, (_req: Request, res: Response): void => {
    const adminKey = service.rotateAdminKey();
    res.json({ adminKey });
  });

  return router;
}
