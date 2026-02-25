import type { Request, Response, NextFunction } from 'express';
import type { AgentboardDB } from '../../db/database.js';
import type { AuthenticatedRequest } from './auth.js';

export function createAuditMiddleware(db: AgentboardDB): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method;
    const path = req.originalUrl;
    const requestBody = method !== 'GET' ? JSON.stringify(req.body as Record<string, unknown>) : '';

    res.on('finish', () => {
      const agentId = (req as AuthenticatedRequest).agentId ?? null;
      try {
        db.logAudit(agentId, method, path, res.statusCode, requestBody);
      } catch {
        // Don't let audit logging break the response
      }
    });

    next();
  };
}
