import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { PNG } from 'pngjs';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createHtmlDraftRoutes } from '../../src/api/routes/html-drafts.js';
import { createProcessDiagramRoutes } from '../../src/api/routes/process-diagrams.js';
import type { Agent } from '../../src/types.js';
import type {
  DraftPresentation,
  DraftScreenshot,
} from '../../src/services/html-drafts.js';
import type { ProcessDiagramVersion } from '../../src/services/process-diagrams.js';

interface ErrorBody {
  error: string;
}

const SESSION = 'session=test';
const sessionValid = (cookie: string | undefined): boolean =>
  cookie === SESSION;

function pngBase64(width: number, height = 10): string {
  return PNG.sync.write(new PNG({ width, height })).toString('base64');
}

function errorOf(res: request.Response): string {
  return (res.body as ErrorBody).error;
}

function diagram(): Record<string, unknown> {
  return {
    lanes: [{ id: 'user', name: 'User' }],
    nodes: [
      { id: 'start', type: 'start', label: 'Begin', lane: 'user' },
      { id: 'done', type: 'end', label: 'Finish', lane: 'user' },
    ],
    flows: [{ from: 'start', to: 'done' }],
  };
}

describe('HTML draft REST routes', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let projectId: string;
  let ticketId: string;
  let agentId: string;
  let apiKey: string;
  let app: express.Express;
  let drafts: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    const agent = service.createAgent('designer');
    agentId = agent.id;
    apiKey = agent.apiKey;
    projectId = service.createProject('Design').id;
    ticketId = service.createTicket(projectId, 'Screen').id;
    app = express();
    app.use(express.json({ limit: '12mb' }));
    app.use('/api/projects/:id', createHtmlDraftRoutes(service, sessionValid));
    drafts = `/api/projects/${projectId}/tickets/${ticketId}/drafts`;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  async function createDraft(): Promise<DraftPresentation> {
    const res = await request(app)
      .post(drafts)
      .set('X-Api-Key', apiKey)
      .send({ title: 'Screen', html: '<p>Hello</p>' });
    expect(res.status).toBe(201);
    return res.body as DraftPresentation;
  }

  it('lists drafts for sessions and agents without returning HTML source', async () => {
    const draft = await createDraft();
    const res = await request(app).get(drafts).set('Cookie', SESSION);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const list = res.body as DraftPresentation[];
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(draft.id);
    expect(list[0]?.html).toBeUndefined();
    const agentRes = await request(app).get(drafts).set('X-Api-Key', apiKey);
    expect(agentRes.status).toBe(200);
  });

  it('returns 404 when listing drafts of an unknown ticket', async () => {
    const res = await request(app)
      .get(`/api/projects/${projectId}/tickets/missing/drafts`)
      .set('Cookie', SESSION);
    expect(res.status).toBe(404);
    expect(errorOf(res)).toBe('Ticket not found');
  });

  it('saves new versions with optimistic locking', async () => {
    const draft = await createDraft();
    expect(draft.version).toBe(1);
    expect(draft.agentId).toBe(agentId);
    expect(draft.reviewStatus).toBe('pending');
    const next = await request(app)
      .post(drafts)
      .set('X-Api-Key', apiKey)
      .send({
        title: 'Screen',
        html: '<p>v2</p>',
        draft_id: draft.id,
        expected_version: 1,
      });
    expect(next.status).toBe(201);
    expect((next.body as DraftPresentation).version).toBe(2);
    const stale = await request(app)
      .post(drafts)
      .set('X-Api-Key', apiKey)
      .send({
        title: 'Screen',
        html: '<p>v3</p>',
        draft_id: draft.id,
        expected_version: 1,
      });
    expect(stale.status).toBe(409);
    expect(errorOf(stale)).toContain('Draft changed');
  });

  it('rejects malformed save bodies and requires an agent key', async () => {
    const bad = await request(app)
      .post(drafts)
      .set('X-Api-Key', apiKey)
      .send({ title: 'No html' });
    expect(bad.status).toBe(400);
    expect(errorOf(bad)).toContain('Invalid request body');
    const anonymous = await request(app)
      .post(drafts)
      .set('Cookie', SESSION)
      .send({ title: 'x', html: 'y' });
    expect(anonymous.status).toBe(401);
  });

  it('refuses writes when the authenticated agent has no identity', async () => {
    const draft = await createDraft();
    vi.spyOn(service, 'getAgentByApiKey').mockReturnValue({
      id: '',
    } as Agent);
    const res = await request(app)
      .post(drafts)
      .set('X-Api-Key', apiKey)
      .send({ title: 'Screen', html: '<p>x</p>' });
    expect(res.status).toBe(500);
    expect(errorOf(res)).toBe('Agent authentication required');
    const base = `${drafts}/${draft.id}/versions/1`;
    const shot = await request(app)
      .post(base + '/screenshots')
      .set('X-Api-Key', apiKey)
      .send({
        png_base64: pngBase64(390),
        width: 390,
        height: 800,
        theme: 'light',
      });
    expect(shot.status).toBe(500);
    expect(errorOf(shot)).toBe('Agent authentication required');
    vi.spyOn(service, 'getAgentByApiKey').mockReturnValue({
      id: undefined,
    } as unknown as Agent);
    const review = await request(app)
      .post(base + '/review')
      .set('X-Api-Key', apiKey)
      .send({
        status: 'needs_changes',
        findings: 'x',
        screenshot_ids: ['a'],
        visually_inspected: true,
      });
    expect(review.status).toBe(500);
    expect(errorOf(review)).toBe('Agent authentication required');
  });

  it('returns 404/400 for unknown or invalid draft versions', async () => {
    const draft = await createDraft();
    const missing = await request(app)
      .get(`${drafts}/${draft.id}/versions/9`)
      .set('Cookie', SESSION);
    expect(missing.status).toBe(404);
    expect(errorOf(missing)).toBe('Draft version not found');
    const invalid = await request(app)
      .get(`${drafts}/${draft.id}/versions/abc/content`)
      .set('Cookie', SESSION);
    expect(invalid.status).toBe(400);
    expect(errorOf(invalid)).toBe('Invalid draft version');
  });

  it('renders sanitized preview content in light and dark theme', async () => {
    const res = await request(app)
      .post(drafts)
      .set('X-Api-Key', apiKey)
      .send({
        title: 'Form',
        html: '<script>alert(1)</script><p>Body</p><input type="file"><input type="email"><input placeholder="Name"><button type="submit">Go</button>',
      });
    const draft = res.body as DraftPresentation;
    const base = `${drafts}/${draft.id}/versions/1/content`;
    const light = await request(app).get(base).set('Cookie', SESSION);
    expect(light.status).toBe(200);
    expect(light.headers['content-type']).toContain('text/html');
    expect(light.text).toContain('color-scheme:light');
    expect(light.text).toContain('background:#ffffff');
    expect(light.text).toContain('<p>Body</p>');
    expect(light.text).not.toContain('<script>');
    expect(light.text).toContain('type="text"');
    expect(light.text).toContain('<input placeholder="Name" disabled type="text" />');
    expect(light.text).toContain('type="email"');
    expect(light.text).toContain('type="button"');
    expect(light.headers['x-content-type-options']).toBe('nosniff');
    expect(light.headers['referrer-policy']).toBe('no-referrer');
    const dark = await request(app)
      .get(base + '?theme=dark')
      .set('Cookie', SESSION);
    expect(dark.text).toContain('color-scheme:dark');
    expect(dark.text).toContain('background:#1c1c1e');
    expect(dark.text).toContain('color:#f5f5f7');
  });

  it('renders an empty body for stored versions without HTML source', async () => {
    db.saveHtmlDraft({
      id: 'legacy',
      ticketId,
      version: 1,
      title: 'Legacy',
      agentId,
      createdAt: new Date().toISOString(),
      review: null,
      approvedAt: null,
    } as unknown as Parameters<AgentboardDB['saveHtmlDraft']>[0]);
    const res = await request(app)
      .get(`${drafts}/legacy/versions/1/content`)
      .set('Cookie', SESSION);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<body></body>');
  });

  it('uploads, serves and reviews screenshots', async () => {
    const draft = await createDraft();
    const base = `${drafts}/${draft.id}/versions/1`;
    const upload = await request(app)
      .post(base + '/screenshots')
      .set('X-Api-Key', apiKey)
      .send({
        png_base64: pngBase64(390),
        width: 390,
        height: 800,
        theme: 'dark',
      });
    expect(upload.status).toBe(201);
    const shot = upload.body as DraftScreenshot;
    expect(shot).toMatchObject({
      width: 390,
      height: 800,
      theme: 'dark',
      agentId,
    });
    const image = await request(app)
      .get(`${base}/screenshots/${shot.id}`)
      .set('Cookie', SESSION)
      .buffer(true);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');
    expect((image.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
    const missing = await request(app)
      .get(`${base}/screenshots/nope`)
      .set('Cookie', SESSION)
      .buffer(true);
    expect(missing.status).toBe(404);
    expect(missing.headers['content-type']).toMatch(/^application\/json/);
    expect(missing.body).toEqual({ error: 'Screenshot not found' });
    const review = await request(app)
      .post(base + '/review')
      .set('X-Api-Key', apiKey)
      .send({
        status: 'needs_changes',
        findings: 'Text clipped on mobile',
        screenshot_ids: [shot.id],
        visually_inspected: true,
      });
    expect(review.status).toBe(200);
    const reviewed = review.body as DraftPresentation;
    expect(reviewed.reviewStatus).toBe('needs_changes');
    expect(reviewed.review?.findings).toBe('Text clipped on mobile');
  });

  it('maps screenshot and review validation errors to 400', async () => {
    const draft = await createDraft();
    const base = `${drafts}/${draft.id}/versions/1`;
    const badShot = await request(app)
      .post(base + '/screenshots')
      .set('X-Api-Key', apiKey)
      .send({ width: 390 });
    expect(badShot.status).toBe(400);
    expect(errorOf(badShot)).toContain('Invalid request body');
    const badReview = await request(app)
      .post(base + '/review')
      .set('X-Api-Key', apiKey)
      .send({
        status: 'passed',
        findings: 'ok',
        screenshot_ids: [],
        visually_inspected: false,
      });
    expect(badReview.status).toBe(400);
    expect(errorOf(badReview)).toContain('Invalid request body');
  });

  it('refuses approval of outdated versions with 409', async () => {
    const draft = await createDraft();
    service.htmlDrafts.save(
      projectId,
      ticketId,
      'Screen',
      '<p>v2</p>',
      agentId,
      draft.id,
      1,
    );
    const res = await request(app)
      .post(`${drafts}/${draft.id}/versions/1/approve`)
      .set('Cookie', SESSION)
      .send({});
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe('Only the latest version can be approved');
    const notJson = await request(app)
      .post(`${drafts}/${draft.id}/versions/2/approve`)
      .set('Cookie', SESSION)
      .type('form')
      .send('a=1');
    expect(notJson.status).toBe(403);
  });
});

describe('process diagram REST routes', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let projectId: string;
  let ticketId: string;
  let apiKey: string;
  let path: string;

  function makeApp(withJson: boolean): express.Express {
    const app = express();
    if (withJson) app.use(express.json());
    app.use(
      '/api/projects/:id',
      createProcessDiagramRoutes(service, sessionValid),
    );
    return app;
  }

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    const agent = service.createAgent('planner');
    apiKey = agent.apiKey;
    projectId = service.createProject('Flows').id;
    ticketId = service.createTicket(projectId, 'Login').id;
    path = `/api/projects/${projectId}/tickets/${ticketId}/process-diagrams`;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('returns 404 when listing diagrams of an unknown ticket', async () => {
    const res = await request(makeApp(true))
      .get(`/api/projects/${projectId}/tickets/missing/process-diagrams`)
      .set('Cookie', SESSION);
    expect(res.status).toBe(404);
    expect(errorOf(res)).toBe('Ticket not found');
  });

  it('saves new versions via diagram_id and expected_version', async () => {
    const app = makeApp(true);
    const first = await request(app)
      .post(path)
      .set('X-Api-Key', apiKey)
      .send({ title: 'Login', ...diagram() });
    expect(first.status).toBe(201);
    const one = first.body as ProcessDiagramVersion;
    const second = await request(app)
      .post(path)
      .set('X-Api-Key', apiKey)
      .send({
        title: 'Login v2',
        ...diagram(),
        diagram_id: one.id,
        expected_version: 1,
      });
    expect(second.status).toBe(201);
    const two = second.body as ProcessDiagramVersion;
    expect(two.id).toBe(one.id);
    expect(two.version).toBe(2);
    expect(two.title).toBe('Login v2');
  });

  it('treats a missing request body as an empty diagram (400)', async () => {
    const res = await request(makeApp(false))
      .post(path)
      .set('X-Api-Key', apiKey);
    expect(res.status).toBe(400);
    expect(errorOf(res)).toContain('title must be nonempty');
  });

  it('refuses saves when the authenticated agent has no identity', async () => {
    vi.spyOn(service, 'getAgentByApiKey').mockReturnValue({
      id: '',
    } as Agent);
    const res = await request(makeApp(true))
      .post(path)
      .set('X-Api-Key', apiKey)
      .send({ title: 'Login', ...diagram() });
    expect(res.status).toBe(500);
    expect(errorOf(res)).toBe('Agent authentication required');
    expect(service.processDiagrams.list(projectId, ticketId)).toHaveLength(0);
  });
});
