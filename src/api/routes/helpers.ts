// ---------------------------------------------------------------------------
// Shared route helpers
// ---------------------------------------------------------------------------

import type { Response } from 'express';
import { NotFoundError, ValidationError, DuplicateError } from '../../services/errors.js';

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
  const message = err instanceof Error ? err.message : 'Unknown error';
  res.status(500).json({ error: message });
}
