import { Router } from 'express';
import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type { AgentboardDB } from '../../db/database.js';
import { createAdminAuthMiddleware } from '../middleware/auth.js';

export function createAgentRoutes(db: AgentboardDB, adminApiKey?: string): Router {
  const router: Router = Router();
  const adminAuth = createAdminAuthMiddleware(adminApiKey ?? db);

  // POST /api/agents - Register a new agent (admin auth required)
  router.post('/', adminAuth, (req: Request, res: Response): void => {
    const { name } = req.body as { name?: unknown };

    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'Missing or invalid "name" field' });
      return;
    }

    try {
      const agent = db.createAgent(name.trim());
      res.status(201).json(agent);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message.includes('UNIQUE')) {
        res.status(409).json({ error: `Agent name "${name}" is already taken` });
        return;
      }
      res.status(500).json({ error: message });
    }
  });

  // GET /api/agents - List all agents (public, no apiKey exposed)
  router.get('/', (_req: Request, res: Response): void => {
    const agents = db.getAllAgents();
    res.json(agents);
  });

  // DELETE /api/agents/:id - Delete an agent (admin auth required)
  router.delete('/:id', adminAuth, (req: Request, res: Response): void => {
    const agentId = String(req.params['id'] ?? '');
    const agent = db.getAgentById(agentId);
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    try {
      db.deleteAgent(agentId);
      res.status(204).end();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  });

  // POST /api/agents/admin-key/rotate - Generate a new admin key (admin auth required)
  router.post('/admin-key/rotate', adminAuth, (_req: Request, res: Response): void => {
    const newKey = `admin-${uuidv4()}`;
    db.setSetting('admin_api_key', newKey);
    res.json({ adminKey: newKey });
  });

  return router;
}
