import type { Request, Response, NextFunction } from 'express';
import type { AgentboardDB } from '../../db/database.js';
import type { AuthenticatedRequest } from './auth.js';
import { pubsub, EVENTS } from '../../graphql/pubsub.js';

export function createAuditMiddleware(db: AgentboardDB): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method;
    const path = req.originalUrl;
    const requestBody = method !== 'GET' ? JSON.stringify(req.body as Record<string, unknown>) : '';

    res.on('finish', () => {
      const agentId = (req as AuthenticatedRequest).agentId ?? null;
      try {
        const entry = db.logAudit(agentId, method, path, res.statusCode, requestBody);
        pubsub.publish(EVENTS.AUDIT_ADDED, {
          auditAdded: {
            id: entry.id,
            agentId: entry.agentId,
            method: entry.method,
            path: entry.path,
            statusCode: entry.statusCode,
            requestBody: entry.requestBody,
            timestamp: entry.timestamp,
          },
        });
      } catch {
        // Don't let audit logging break the response
      }
    });

    next();
  };
}
