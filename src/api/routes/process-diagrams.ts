import { Router, type RequestHandler } from 'express';
import type { BoardService } from '../../services/board.service.js';
import { createAuthMiddleware, type AuthenticatedRequest } from '../middleware/auth.js';
import { handleServiceError, routeParam } from './helpers.js';

// Humans read diagrams with their browser session; agents read and write with their API key.
export function createProcessDiagramRoutes(
  service: BoardService,
  sessionValid: (cookie: string | undefined) => boolean,
): Router {
  const router = Router({ mergeParams: true });
  const agentAuth = createAuthMiddleware(service);
  const readAuth: RequestHandler = (req, res, next) => {
    if (sessionValid(req.headers.cookie)) {
      next();
      return;
    }
    agentAuth(req, res, next);
  };
  const path = '/tickets/:ticketId/process-diagrams';
  router.use(path, (req, res, next) => {
    void req;
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get(path, readAuth, (req, res) => {
    try {
      res.json(service.processDiagrams.list(routeParam(req, 'id'), routeParam(req, 'ticketId')));
    } catch (e) {
      handleServiceError(res, e);
    }
  });
  router.get(path + '/:diagramId/versions/:version', readAuth, (req, res) => {
    try {
      res.json(service.processDiagrams.get(routeParam(req, 'id'), routeParam(req, 'ticketId'), routeParam(req, 'diagramId'), Number(req.params['version'])));
    } catch (e) {
      handleServiceError(res, e);
    }
  });
  router.post(path, agentAuth, (req, res) => {
    try {
      const agentId = (req as AuthenticatedRequest).agentId;
      if (agentId === undefined || agentId === '') throw new Error('Agent authentication required');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const id = typeof b['diagram_id'] === 'string' ? b['diagram_id'] : undefined;
      const expected = typeof b['expected_version'] === 'number' ? b['expected_version'] : undefined;
      res.status(201).json(service.processDiagrams.save(routeParam(req, 'id'), routeParam(req, 'ticketId'), b['title'], b, agentId, id, expected));
    } catch (e) {
      handleServiceError(res, e);
    }
  });
  return router;
}
