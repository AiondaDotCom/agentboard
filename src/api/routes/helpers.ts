// ---------------------------------------------------------------------------
// Shared route helpers
// ---------------------------------------------------------------------------

import type { Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.js';
import { NotFoundError, ValidationError, DuplicateError, ConflictError } from '../../services/errors.js';

/** Read a route param defensively (missing params become ''). */
export function routeParam(req: { params: Record<string, unknown> }, name: string): string {
  return String(req.params[name] ?? '');
}

/** Agent id set by the auth middleware, or null for unauthenticated requests. */
export function agentIdOf(req: AuthenticatedRequest): string | null {
  return req.agentId ?? null;
}

/** Map service-layer errors to appropriate HTTP status codes. */
export function handleServiceError(res: Response, err: unknown): void {
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof DuplicateError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unknown error';
  res.status(500).json({ error: message });
}
