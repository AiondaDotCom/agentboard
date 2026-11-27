import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import { PNG } from 'pngjs';
import express from 'express';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createHtmlDraftRoutes } from '../../src/api/routes/html-drafts.js';
import {
  staticHtml,
  VISUAL_REVIEW_INSTRUCTIONS,
} from '../../src/services/html-drafts.js';
import { MCP_INSTRUCTIONS, registerMcpTools } from '../../src/mcp-server.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

describe('versioned HTML drafts', () => {
  let db: AgentboardDB,
    service: BoardService,
    projectId: string,
    ticketId: string,
    agentId: string,
    apiKey: string,
    app: express.Express;
  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    const agent = service.createAgent('designer');
    agentId = agent.id;
    apiKey = agent.apiKey;
    projectId = service.createProject('Design').id;
    ticketId = service.createTicket(projectId, 'Folder editor').id;
    app = express();
    app.use(express.json({ limit: '12mb' }));
    app.use(
      '/api/projects/:id',
      createHtmlDraftRoutes(service, (cookie) => cookie === 'session=test'),
    );
  });
  afterEach(() => db.close());
  const png = (width: number): string => {
    return PNG.sync.write(new PNG({ width, height: 800 })).toString('base64');
  };
  it('keeps immutable source versions and resets review and human approval on changes', () => {
    const one = service.htmlDrafts.save(
      projectId,
      ticketId,
      'Create',
      '<h1>First</h1>',
      agentId,
    );
    const ids = [390, 1280].flatMap((width) =>
      (['light', 'dark'] as const).map(
        (theme) =>
          service.htmlDrafts.screenshot(
            projectId,
            ticketId,
            one.id,
            1,
            { png_base64: png(width), width, height: 800, theme },
            agentId,
          ).id,
      ),
    );
    expect(
      service.htmlDrafts.review(
        projectId,
        ticketId,
        one.id,
        1,
        'passed',
        'Read all four screenshots',
        ids,
        true,
        agentId,
      ).reviewStatus,
    ).toBe('passed');
    service.htmlDrafts.approve(projectId, ticketId, one.id, 1);
    const two = service.htmlDrafts.save(
      projectId,
      ticketId,
      'Create',
      '<h1>Second</h1>',
      agentId,
      one.id,
      1,
    );
    expect(two.version).toBe(2);
    expect(two.reviewStatus).toBe('pending');
    expect(two.approvedAt).toBeNull();
    expect(two.screenshots).toEqual([]);
    expect(service.htmlDrafts.get(projectId, ticketId, one.id, 1).html).toBe(
      '<h1>First</h1>',
    );
    expect(
      service.htmlDrafts.get(projectId, ticketId, one.id, 1).reviewStatus,
    ).toBe('passed');
    expect(() =>
      service.htmlDrafts.review(
        projectId,
        ticketId,
        one.id,
        2,
        'passed',
        'old screenshots',
        ids,
        true,
        agentId,
      ),
    ).toThrow('this version');
    expect(() =>
      service.htmlDrafts.review(
        projectId,
        ticketId,
        one.id,
        1,
        'passed',
        'old review',
        ids,
        true,
        agentId,
      ),
    ).toThrow('latest');
    expect(() =>
      service.htmlDrafts.approve(projectId, ticketId, one.id, 1),
    ).toThrow('latest');
    expect(() =>
      service.htmlDrafts.save(
        projectId,
        ticketId,
        'Create',
        'stale',
        agentId,
        one.id,
        1,
      ),
    ).toThrow('changed');
  });
  it('requires real attachments and an explicit assertion; incomplete coverage cannot pass', () => {
    const d = service.htmlDrafts.save(
      projectId,
      ticketId,
      'Draft',
      '<p>Example</p>',
      agentId,
    );
    expect(() =>
      service.htmlDrafts.review(
        projectId,
        ticketId,
        d.id,
        1,
        'passed',
        'fine',
        [],
        true,
        agentId,
      ),
    ).toThrow('screenshot');
    expect(() =>
      service.htmlDrafts.screenshot(
        projectId,
        ticketId,
        d.id,
        1,
        { png_base64: 'not-a-png', width: 390, height: 800, theme: 'light' },
        agentId,
      ),
    ).toThrow();
    const shot = service.htmlDrafts.screenshot(
      projectId,
      ticketId,
      d.id,
      1,
      { png_base64: png(390), width: 390, height: 800, theme: 'light' },
      agentId,
    );
    expect(() =>
      service.htmlDrafts.review(
        projectId,
        ticketId,
        d.id,
        1,
        'passed',
        'fine',
        [shot.id],
        true,
        agentId,
      ),
    ).toThrow('BOTH');
    expect(() =>
      service.htmlDrafts.review(
        projectId,
        ticketId,
        d.id,
        1,
        'needs_changes',
        'bad',
        [shot.id],
        false,
        agentId,
      ),
    ).toThrow('confirmed');
    expect(
      service.htmlDrafts.review(
        projectId,
        ticketId,
        d.id,
        1,
        'needs_changes',
        'Text clipped',
        [shot.id],
        true,
        agentId,
      ).reviewStatus,
    ).toBe('needs_changes');
  });
  it('enforces ticket ownership, authorization and a separate human-only approval route', async () => {
    const d = service.htmlDrafts.save(
      projectId,
      ticketId,
      'Draft',
      '<p>Example</p>',
      agentId,
    );
    const base = `/api/projects/${projectId}/tickets/${ticketId}/drafts/${d.id}/versions/1`;
    expect((await request(app).get(base)).status).toBe(401);
    expect((await request(app).get(base).set('X-Api-Key', apiKey)).status).toBe(
      200,
    );
    expect(
      (
        await request(app)
          .post(base + '/approve')
          .set('X-Api-Key', apiKey)
          .send({})
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post(base + '/approve')
          .set('Cookie', 'session=test')
          .set('Sec-Fetch-Site', 'cross-site')
          .send({})
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(base + '/approve')
          .set('Cookie', 'session=test')
          .send({})
      ).status,
    ).toBe(200);
    const other = service.createTicket(projectId, 'Other');
    expect(() => service.htmlDrafts.get(projectId, other.id, d.id, 1)).toThrow(
      'not found',
    );
    expect(() =>
      service.htmlDrafts.save(projectId, other.id, 'x', 'x', agentId, d.id, 1),
    ).toThrow('not found');
    const html = await request(app)
      .get(base + '/content')
      .set('Cookie', 'session=test');
    expect(html.headers['content-security-policy']).toContain(
      "script-src 'none'",
    );
    expect(html.headers['content-security-policy']).toContain('sandbox');
    expect(html.headers['cache-control']).toBe('no-store');
    service.deleteTicket(projectId, ticketId, agentId);
    expect(db.getHtmlDraft(d.id, 1)).toBeUndefined();
  });
  it('removes scripts, navigation, external images and event handlers while retaining static layout', () => {
    const result = staticHtml(
      '<meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test"><script>alert(1)</script><iframe src="https://evil.test"></iframe><a href="https://evil.test">Link</a><img src="https://evil.test" onerror="alert(1)"><div style="padding:12px"><style>p{color:red}</style><p>Text</p></div>',
    );
    expect(result).not.toMatch(/script|iframe|https:|onerror|http-equiv|<base/);
    expect(result).toContain('padding:12px');
    expect(result).toContain('<style>p{color:red}</style>');
  });
  it('advertises the workflow in MCP initialization, tools and batch results', () => {
    expect(MCP_INSTRUCTIONS).toContain(VISUAL_REVIEW_INSTRUCTIONS);
    const mcp = new McpServer({ name: 'test', version: '1' });
    registerMcpTools(mcp, service, agentId, 'designer');
    const result = service.executeBatch(
      [
        {
          op: 'save_html_draft',
          args: {
            project_id: projectId,
            ticket_id: ticketId,
            title: 'Screen',
            html: '<p>Screen</p>',
          },
        },
        {
          op: 'list_html_drafts',
          args: { project_id: projectId, ticket_id: ticketId },
        },
      ],
      agentId,
    );
    expect(result.every((r) => r.ok)).toBe(true);
    expect(result[0]?.result).toMatchObject({
      version: 1,
      reviewStatus: 'pending',
      instructions: VISUAL_REVIEW_INSTRUCTIONS,
    });
    expect(result[0]?.result).toHaveProperty('captureUrls');
  });
});
