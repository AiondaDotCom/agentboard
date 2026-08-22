import { Router } from 'express';
import type { Request, Response } from 'express';
import type { BoardService } from '../../services/board.service.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { createAuthMiddleware } from '../middleware/auth.js';
import { handleServiceError, agentIdOf } from './helpers.js';

// ---------------------------------------------------------------------------
// Batch route – execute many board operations in one request
// ---------------------------------------------------------------------------

export function createBatchRoutes(service: BoardService): Router {
  const router: Router = Router();
  const auth = createAuthMiddleware(service);

  // POST /api/batch  { operations: [{op, args}, ...] }
  // Always 200 with per-operation results – individual failures are reported
  // inline ({ok: false, error}), only an invalid envelope fails the request.
  router.post('/', auth, (req: Request, res: Response): void => {
    try {
      const { operations } = req.body as { operations?: unknown };
      const agentId = agentIdOf(req as AuthenticatedRequest);
      res.json({ results: service.executeBatch(operations, agentId) });
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  return router;
}
