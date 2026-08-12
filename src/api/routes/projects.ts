import { Router } from 'express';
import type { Request, Response } from 'express';
import type { BoardService } from '../../services/board.service.js';
import { createAdminAuthMiddleware } from '../middleware/auth.js';
import { handleServiceError, routeParam } from './helpers.js';

export function createProjectRoutes(service: BoardService): Router {
  const router: Router = Router();
  const adminAuth = createAdminAuthMiddleware(service);

  // POST /api/projects - Create a new project (admin auth required)
  router.post('/', adminAuth, (req: Request, res: Response): void => {
    try {
      const { name, description, columns } = req.body as { name?: unknown; description?: unknown; columns?: unknown };
      const project = service.createProject(
        name as string,
        typeof description === 'string' ? description : undefined,
        null,
        columns,
      );
      res.status(201).json(project);
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // PATCH /api/projects/:id - Update name/description/columns (admin auth required)
  router.patch('/:id', adminAuth, (req: Request, res: Response): void => {
    try {
      const { name, description, columns } = req.body as { name?: unknown; description?: unknown; columns?: unknown };
      const updates: { name?: string; description?: string; columns?: unknown } = {};
      if (name !== undefined) updates.name = name as string;
      if (description !== undefined) updates.description = description as string;
      if (columns !== undefined) updates.columns = columns;
      const project = service.updateProject(routeParam(req, 'id'), updates);
      res.json(project);
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // PUT /api/projects/:id/columns - Human action from the board UI (no auth,
  // consistent with the other human routes like ticket open/close)
  router.put('/:id/columns', (req: Request, res: Response): void => {
    try {
      const { columns } = req.body as { columns?: unknown };
      const project = service.updateProject(routeParam(req, 'id'), { columns });
      res.json(project);
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
      res.json(service.getProject(routeParam(req, 'id')));
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  // DELETE /api/projects/:id - Delete a project (admin auth required)
  router.delete('/:id', adminAuth, (req: Request, res: Response): void => {
    try {
      service.deleteProject(routeParam(req, 'id'));
      res.status(204).end();
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  return router;
}
