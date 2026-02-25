// ---------------------------------------------------------------------------
// Authentication middleware
// ---------------------------------------------------------------------------

import type { Request, Response, NextFunction } from 'express';

/**
 * Minimal interface so both AgentboardDB and BoardService can be used.
 */
export interface AuthProvider {
  getAgentByApiKey(apiKey: string): { id: string } | undefined;
  getOrCreateAdminKey(): string;
}

export interface AuthenticatedRequest extends Request {
  agentId?: string;
}

/**
 * Validates X-Api-Key header against registered agents.
 * Sets req.agentId on success.
 */
export function createAuthMiddleware(provider: AuthProvider): (req: AuthenticatedRequest, res: Response, next: NextFunction) => void {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey !== 'string' || apiKey.length === 0) {
      res.status(401).json({ error: 'Missing X-Api-Key header' });
      return;
    }
    const agent = provider.getAgentByApiKey(apiKey);
    if (!agent) {
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }
    req.agentId = agent.id;
    next();
  };
}

/**
 * Admin auth middleware. Accepts either a static key string or an AuthProvider
 * (reads the key dynamically so key rotation works immediately).
 */
export function createAdminAuthMiddleware(keyOrProvider: string | AuthProvider): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.headers['x-admin-key'];
    if (typeof key !== 'string' || key.length === 0) {
      res.status(401).json({ error: 'Missing X-Admin-Key header' });
      return;
    }

    const expected = typeof keyOrProvider === 'string'
      ? keyOrProvider
      : keyOrProvider.getOrCreateAdminKey();

    if (key !== expected) {
      res.status(403).json({ error: 'Invalid admin key' });
      return;
    }
    next();
  };
}
