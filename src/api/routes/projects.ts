import { Router } from 'express';
import type { Request, Response } from 'express';
import type { BoardService } from '../../services/board.service.js';
import { createAdminAuthMiddleware } from '../middleware/auth.js';
import { handleServiceError } from './helpers.js';

export function createProjectRoutes(service: BoardService): Router {
  const router: Router = Router();
  const adminAuth = createAdminAuthMiddleware(service);

  // POST /api/projects - Create a new project (admin auth required)
  router.post('/', adminAuth, (req: Request, res: Response): void => {
    try {
      const { name, description } = req.body as { name?: unknown; description?: unknown };
      const project = service.createProject(
        name as string,
        typeof description === 'string' ? description : undefined,
      );
      res.status(201).json(project);
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // GET /api/projects - List all projects (no auth)
  router.get('/', (_req: Request, res: Response): void => {
    res.json(service.getAllProjects());
  });

  // GET /api/projects/:id - Get a single project (no auth)
  router.get('/:id', (req: Request, res: Response): void => {
    try {
      res.json(service.getProject(String(req.params['id'] ?? '')));
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // DELETE /api/projects/:id - Delete a project (admin auth required)
  router.delete('/:id', adminAuth, (req: Request, res: Response): void => {
    try {
      service.deleteProject(String(req.params['id'] ?? ''));
      res.status(204).end();
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  return router;
}
