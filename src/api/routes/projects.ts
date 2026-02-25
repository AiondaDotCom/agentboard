import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AgentboardDB } from '../../db/database.js';
import { createAdminAuthMiddleware } from '../middleware/auth.js';

export function createProjectRoutes(db: AgentboardDB, adminApiKey?: string): Router {
  const router: Router = Router();
  const adminAuth = createAdminAuthMiddleware(adminApiKey ?? db);

  // POST /api/projects - Create a new project (admin auth required)
  router.post('/', adminAuth, (req: Request, res: Response): void => {
    const { name, description } = req.body as {
      name?: unknown;
      description?: unknown;
    };

    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Missing or invalid "name" field' });
      return;
    }

    const desc =
      typeof description === 'string' ? description : '';

    try {
      const project = db.createProject(name.trim(), desc);
      res.status(201).json(project);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // GET /api/projects - List all projects (no auth)
  router.get('/', (_req: Request, res: Response): void => {
    const projects = db.getAllProjects();
    res.json(projects);
  });

  // GET /api/projects/:id - Get a single project (no auth)
  router.get('/:id', (req: Request, res: Response): void => {
    const project = db.getProject(String(req.params['id'] ?? ''));
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }
    res.json(project);
  });

  // DELETE /api/projects/:id - Delete a project (admin auth required)
  router.delete('/:id', adminAuth, (req: Request, res: Response): void => {
    const project = db.getProject(String(req.params['id'] ?? ''));
    if (!project) {
      res.status(404).json({ error: 'Project not found' });
      return;
    }

    try {
      db.deleteProject(project.id);
      res.status(204).end();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  return router;
}
