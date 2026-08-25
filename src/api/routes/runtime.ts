import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { RuntimeReport } from '../../types.js';
import type { BoardService } from '../../services/board.service.js';
import { handleServiceError } from './helpers.js';

function keysEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createRuntimeRoutes(service: BoardService): Router {
  const router = Router();

  router.get('/', (request: Request, res: Response): void => {
    void request;
    res.json(service.getRuntimeStatus());
  });

  router.post('/', (req: Request<Record<string, never>, unknown, Partial<Omit<RuntimeReport, 'reportedAt'>>>, res: Response): void => {
    const key = req.headers['x-api-key'];
    if (typeof key !== 'string' || key.length === 0) {
      res.status(401).json({ error: 'Missing X-Api-Key header' });
      return;
    }
    if (!keysEqual(key, service.getOrCreateRuntimeApiKey())) {
      res.status(403).json({ error: 'Invalid runtime API key' });
      return;
    }
    try {
      res.json(service.reportRuntime(req.body));
    } catch (err) {
      handleServiceError(res, err);
    }
  });

  return router;
}
