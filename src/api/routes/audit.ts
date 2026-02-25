import { Router } from 'express';
import type { Request, Response } from 'express';
import type { AgentboardDB } from '../../db/database.js';

export function createAuditRoutes(db: AgentboardDB): Router {
  const router: Router = Router();

  // GET /api/audit - Get all audit entries (no auth, read-only for human)
  router.get('/', (req: Request, res: Response): void => {
    const limitParam = req.query['limit'];
    const limit = typeof limitParam === 'string' ? parseInt(limitParam, 10) : 100;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 100;

    const entries = db.getAllAuditEntries(safeLimit);
    res.json(entries);
  });

  // GET /api/audit/agent/:agentId - Get audit entries for a specific agent
  router.get('/agent/:agentId', (req: Request, res: Response): void => {
    const agentId = String(req.params['agentId'] ?? '');
    const limitParam = req.query['limit'];
    const limit = typeof limitParam === 'string' ? parseInt(limitParam, 10) : 100;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 100;

    const entries = db.getAuditEntriesByAgent(agentId, safeLimit);
    res.json(entries);
  });

  return router;
}
