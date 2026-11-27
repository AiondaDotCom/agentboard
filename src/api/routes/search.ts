import { Router } from 'express';
import type { Request, Response } from 'express';
import type { BoardService } from '../../services/board.service.js';

/** GET /api/search?q=...&limit=... – cross-project ticket search (board UI). */
export function createSearchRoutes(service: BoardService): Router {
  const router: Router = Router();

  router.get('/', (req: Request, res: Response): void => {
    res.json(service.searchTickets(req.query['q'], req.query['limit']));
  });

  return router;
}
