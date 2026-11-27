import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { ValidationError } from '../../services/errors.js';
import type { BoardService } from '../../services/board.service.js';
import {
  createAuthMiddleware,
  type AuthenticatedRequest,
} from '../middleware/auth.js';
import { handleServiceError, routeParam } from './helpers.js';
import { PREVIEW_CSP, staticHtml } from '../../services/html-drafts.js';

function actor(req: AuthenticatedRequest): string {
  if (req.agentId === undefined || req.agentId === '')
    throw new Error('Agent authentication required');
  return req.agentId;
}

function body<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ValidationError('Invalid request body: ' + result.error.message);
  return result.data;
}
const saveSchema = z.object({
  title: z.string(),
  html: z.string(),
  draft_id: z.string().optional(),
  expected_version: z.number().int().positive().optional(),
});
const screenshotSchema = z.object({
  png_base64: z.string(),
  width: z.number().int(),
  height: z.number().int(),
  theme: z.enum(['light', 'dark']),
});
const reviewSchema = z.object({
  status: z.enum(['passed', 'needs_changes']),
  findings: z.string(),
  screenshot_ids: z.array(z.string()),
  visually_inspected: z.literal(true),
});

export function createHtmlDraftRoutes(
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
  const sessionOnly: RequestHandler = (req, res, next) => {
    if (!sessionValid(req.headers.cookie)) {
      res.status(401).json({ error: 'Human browser session required' });
      return;
    }
    if (
      req.is('application/json') !== 'application/json' ||
      req.headers['sec-fetch-site'] === 'cross-site'
    ) {
      res.status(403).json({ error: 'Cross-site action refused' });
      return;
    }
    next();
  };
  const target = (req: Parameters<RequestHandler>[0]) =>
    [
      routeParam(req, 'id'),
      routeParam(req, 'ticketId'),
      routeParam(req, 'draftId'),
      Number(req.params['version']),
    ] as const;
  router.use('/tickets/:ticketId/drafts', (req, res, next) => {
    void req;
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/tickets/:ticketId/drafts', readAuth, (req, res) => {
    try {
      res.json(
        service.htmlDrafts.list(
          routeParam(req, 'id'),
          routeParam(req, 'ticketId'),
        ),
      );
    } catch (e) {
      handleServiceError(res, e);
    }
  });
  router.post('/tickets/:ticketId/drafts', agentAuth, (req, res) => {
    try {
      const b = body(saveSchema, req.body);
      res
        .status(201)
        .json(
          service.htmlDrafts.save(
            routeParam(req, 'id'),
            routeParam(req, 'ticketId'),
            b.title,
            b.html,
            actor(req as AuthenticatedRequest),
            b.draft_id,
            b.expected_version,
          ),
        );
    } catch (e) {
      handleServiceError(res, e);
    }
  });
  const base = '/tickets/:ticketId/drafts/:draftId/versions/:version';
  router.get(base, readAuth, (req, res) => {
    try {
      res.json(service.htmlDrafts.get(...target(req)));
    } catch (e) {
      handleServiceError(res, e);
    }
  });
  router.get(base + '/content', readAuth, (req, res) => {
    try {
      const draft = service.htmlDrafts.get(...target(req));
      const dark = req.query['theme'] === 'dark';
      res.setHeader('Content-Security-Policy', PREVIEW_CSP);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res
        .type('html')
        .send(
          `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>:root{color-scheme:${dark ? 'dark' : 'light'};min-height:100%;background:${dark ? '#1c1c1e' : '#ffffff'}}body{margin:0;background:${dark ? '#1c1c1e' : '#ffffff'};color:${dark ? '#f5f5f7' : '#1c1c1e'};font-family:system-ui}</style></head><body>${staticHtml(draft.html ?? '')}</body></html>`,
        );
    } catch (e) {
      handleServiceError(res, e);
    }
  });
  router.post(base + '/screenshots', agentAuth, (req, res) => {
    try {
      res
        .status(201)
        .json(
          service.htmlDrafts.screenshot(
            ...target(req),
            body(screenshotSchema, req.body),
            actor(req as AuthenticatedRequest),
          ),
        );
    } catch (e) {
      handleServiceError(res, e);
    }
  });
  router.get(base + '/screenshots/:screenshotId', readAuth, (req, res) => {
    try {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // Look up first: a missing screenshot must answer as JSON, not as image/png.
      const png = service.htmlDrafts.image(
        ...target(req),
        routeParam(req, 'screenshotId'),
      );
      res.type('png').send(png);
    } catch (e) {
      handleServiceError(res, e);
    }
  });
  router.post(base + '/review', agentAuth, (req, res) => {
    try {
      const b = body(reviewSchema, req.body);
      res.json(
        service.htmlDrafts.review(
          ...target(req),
          b.status,
          b.findings,
          b.screenshot_ids,
          b.visually_inspected,
          actor(req as AuthenticatedRequest),
        ),
      );
    } catch (e) {
      handleServiceError(res, e);
    }
  });
  router.post(base + '/approve', sessionOnly, (req, res) => {
    try {
      res.json(service.htmlDrafts.approve(...target(req)));
    } catch (e) {
      handleServiceError(res, e);
    }
  });
  return router;
}
