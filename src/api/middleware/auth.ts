import type { Request, Response, NextFunction } from 'express';
import type { AgentboardDB } from '../../db/database.js';

export interface AuthenticatedRequest extends Request {
  agentId?: string;
}

export function createAuthMiddleware(db: AgentboardDB): (req: AuthenticatedRequest, res: Response, next: NextFunction) => void {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      res.status(401).json({ error: 'Missing X-Api-Key header' });
      return;
    }
    const agent = db.getAgentByApiKey(apiKey);
    if (!agent) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }
    req.agentId = agent.id;
    next();
  };
}

/**
 * Admin auth middleware. Accepts either a static key string or a DB instance
 * (reads the key dynamically from the settings table so key rotation works immediately).
 */
export function createAdminAuthMiddleware(adminKeyOrDb: string | AgentboardDB): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.headers['x-admin-key'];
    if (typeof key !== 'string' || key.length === 0) {
      res.status(401).json({ error: 'Missing X-Admin-Key header' });
      return;
    }

    const expected = typeof adminKeyOrDb === 'string'
      ? adminKeyOrDb
      : adminKeyOrDb.getOrCreateAdminKey();

    if (key !== expected) {
      res.status(403).json({ error: 'Invalid admin key' });
      return;
    }
    next();
  };
}
