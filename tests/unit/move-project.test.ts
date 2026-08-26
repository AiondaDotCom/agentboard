import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import express from 'express';
import request from 'supertest';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createTicketRoutes, createHumanTicketRoutes } from '../../src/api/routes/tickets.js';
import { registerMcpTools } from '../../src/mcp-server.js';
import { EVENTS, pubsub } from '../../src/graphql/pubsub.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/services/errors.js';

// ---------------------------------------------------------------------------
// DB layer: cross-project move + incoming dependency lookup
// ---------------------------------------------------------------------------

describe('Move ticket to another project – DB layer', () => {
  let db: AgentboardDB;
  let source: string;
  let target: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    source = db.createProject('src').id;
    target = db.createProject('dst').id;
  });

  afterEach(() => {
    db.close();
  });

  it('moves the ticket, keeps its id and appends it to the target column', () => {
    db.createTicket(target, 'existing', '', 'backlog');
    const t = db.createTicket(source, 'travelling', 'body', 'in_progress');

    const moved = db.moveTicketToProject(source, t.id, target, 'backlog');

    expect(moved?.id).toBe(t.id);
    expect(moved?.projectId).toBe(target);
    expect(moved?.column).toBe('backlog');
    expect(moved?.position).toBe(1);
    expect(moved?.description).toBe('body');
    expect(db.getTicket(source, t.id)).toBeUndefined();
  });

  it('returns undefined for an unknown ticket', () => {
    expect(db.moveTicketToProject(source, 'nope', target, 'backlog')).toBeUndefined();
  });

  it('logs project, column and dependency revisions', () => {
    const dep = db.createTicket(source, 'dep');
    const t = db.createTicket(source, 'main', '', 'in_progress');
    db.setTicketDependencies(t.id, [dep.id]);
    const actor = db.createAgent('mover').id;

    db.moveTicketToProject(source, t.id, target, 'backlog', actor);

    const revisions = db.getRevisionsByTicket(t.id);
    expect(revisions.find((r) => r.field === 'project')).toMatchObject({
      oldValue: source, newValue: target, agentId: actor,
    });
    expect(revisions.find((r) => r.field === 'column')).toMatchObject({
      oldValue: 'in_progress', newValue: 'backlog',
    });
    expect(revisions.find((r) => r.field === 'depends_on')).toMatchObject({
      oldValue: dep.id, newValue: '',
    });
    expect(db.getTicket(target, t.id)?.dependsOn).toEqual([]);
  });

  it('logs no column revision when the column id is identical in both projects', () => {
    const t = db.createTicket(source, 'a', '', 'backlog');

    db.moveTicketToProject(source, t.id, target, 'backlog');

    const fields = db.getRevisionsByTicket(t.id).map((r) => r.field);
    expect(fields).toEqual(['project']);
  });

  it('getDependentTickets returns the tickets pointing at a ticket', () => {
    const dep = db.createTicket(source, 'dep');
    const a = db.createTicket(source, 'a');
    const b = db.createTicket(source, 'b');
    db.setTicketDependencies(a.id, [dep.id]);
    db.setTicketDependencies(b.id, [dep.id]);

    expect(db.getDependentTickets(dep.id).map((t) => t.title).sort()).toEqual(['a', 'b']);
    expect(db.getDependentTickets(a.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Service layer: validation, dependency + group rules, events
// ---------------------------------------------------------------------------

describe('Move ticket to another project – service layer', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let source: string;
  let target: string;
  let agentId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    source = service.createProject('src').id;
    target = service.createProject('dst', '', null, [
      { id: 'inbox', title: 'Inbox' },
      { id: 'shipped', title: 'Shipped' },
    ]).id;
    agentId = db.createAgent('bot').id;
  });

  afterEach(() => {
    db.close();
  });

  it('moves the ticket into the target project\'s first column by default', () => {
    const t = service.createTicket(source, 'a', '', 'in_progress', agentId);

    const moved = service.moveTicketToProject(source, t.id, target, undefined, agentId);

    expect(moved.projectId).toBe(target);
    expect(moved.column).toBe('inbox');
  });

  it('accepts an explicit column of the target project', () => {
    const t = service.createTicket(source, 'a');

    const moved = service.moveTicketToProject(source, t.id, target, 'shipped');

    expect(moved.column).toBe('shipped');
  });

  it('accepts a short ticket id', () => {
    const t = service.createTicket(source, 'a');

    const moved = service.moveTicketToProject(source, t.id.slice(0, 8), target);

    expect(moved.id).toBe(t.id);
  });

  it('keeps comments and revision history attached to the ticket', () => {
    const t = service.createTicket(source, 'a', '', undefined, agentId);
    service.createComment(source, t.id, agentId, 'hello');

    service.moveTicketToProject(source, t.id, target, undefined, agentId);

    expect(service.getCommentsByTicket(target, t.id).map((c) => c.body)).toEqual(['hello']);
    expect(service.getRevisionsByTicket(target, t.id).some((r) => r.field === 'project')).toBe(true);
  });

  it('rejects a missing or non-string target project id', () => {
    const t = service.createTicket(source, 'a');

    expect(() => service.moveTicketToProject(source, t.id, undefined)).toThrow(ValidationError);
    expect(() => service.moveTicketToProject(source, t.id, '   ')).toThrow(ValidationError);
    expect(() => service.moveTicketToProject(source, t.id, 42)).toThrow(ValidationError);
  });

  it('rejects an unknown source project, ticket or target project', () => {
    const t = service.createTicket(source, 'a');

    expect(() => service.moveTicketToProject('nope', t.id, target)).toThrow(NotFoundError);
    expect(() => service.moveTicketToProject(source, 'nope', target)).toThrow(NotFoundError);
    expect(() => service.moveTicketToProject(source, t.id, 'nope')).toThrow(NotFoundError);
  });

  it('rejects moving a ticket into the project it already lives in', () => {
    const t = service.createTicket(source, 'a');

    expect(() => service.moveTicketToProject(source, t.id, source))
      .toThrow(/already in project "src"/);
  });

  it('rejects a column that does not exist in the target project', () => {
    const t = service.createTicket(source, 'a');

    expect(() => service.moveTicketToProject(source, t.id, target, 'in_progress'))
      .toThrow(/Valid columns: inbox, shipped/);
  });

  it('drops the ticket\'s own dependencies', () => {
    const dep = service.createTicket(source, 'dep');
    const t = service.createTicket(source, 'a');
    service.updateTicket(source, t.id, { dependsOn: [dep.id] });

    const moved = service.moveTicketToProject(source, t.id, target);

    expect(moved.dependsOn).toEqual([]);
  });

  it('refuses the move while other tickets still depend on the ticket', () => {
    const t = service.createTicket(source, 'base');
    const a = service.createTicket(source, 'a');
    service.updateTicket(source, a.id, { dependsOn: [t.id] });

    expect(() => service.moveTicketToProject(source, t.id, target))
      .toThrow(ConflictError);
    expect(() => service.moveTicketToProject(source, t.id, target))
      .toThrow(/1 ticket in "src" still depends on it/);

    const b = service.createTicket(source, 'b');
    service.updateTicket(source, b.id, { dependsOn: [t.id] });
    expect(() => service.moveTicketToProject(source, t.id, target))
      .toThrow(/2 tickets in "src" still depend on it/);
  });

  it('refuses moving an assigned ticket into a group claimed by another agent', () => {
    const other = db.createAgent('other').id;
    const claimed = service.createTicket(target, 'claimed', '', 'inbox', null, 'menu');
    service.assignTicket(target, claimed.id, other);

    const t = service.createTicket(source, 'a', '', undefined, null, 'menu');
    service.assignTicket(source, t.id, agentId);

    expect(() => service.moveTicketToProject(source, t.id, target)).toThrow(ConflictError);
  });

  it('allows a grouped ticket into a claimed group while it is unassigned', () => {
    const other = db.createAgent('other').id;
    const claimed = service.createTicket(target, 'claimed', '', 'inbox', null, 'menu');
    service.assignTicket(target, claimed.id, other);

    const t = service.createTicket(source, 'a', '', undefined, null, 'menu');

    expect(service.moveTicketToProject(source, t.id, target).group).toBe('menu');
  });

  it('allows the claiming agent to bring another ticket of the group along', () => {
    const claimed = service.createTicket(target, 'claimed', '', 'inbox', null, 'menu');
    service.assignTicket(target, claimed.id, agentId);

    const t = service.createTicket(source, 'a', '', undefined, null, 'menu');
    service.assignTicket(source, t.id, agentId);

    expect(service.moveTicketToProject(source, t.id, target).assigneeId).toBe(agentId);
  });

  it('moves a grouped ticket into a project where the group is free', () => {
    const t = service.createTicket(source, 'a', '', undefined, null, 'menu');
    service.assignTicket(source, t.id, agentId);

    expect(service.moveTicketToProject(source, t.id, target).group).toBe('menu');
  });

  it('publishes a delete event on the source board and a create event on the target', async () => {
    const t = service.createTicket(source, 'a');
    const deleted = pubsub.subscribe(EVENTS.TICKET_DELETED);
    const created = pubsub.subscribe(EVENTS.TICKET_CREATED);

    service.moveTicketToProject(source, t.id, target);

    const del = await deleted.next();
    expect(del.value).toMatchObject({ projectId: source });
    const add = await created.next();
    expect(add.value).toMatchObject({ projectId: target });
    await deleted.return!();
    await created.return!();
  });

  it('logs the move in the activity feed of both projects', () => {
    const t = service.createTicket(source, 'a');

    service.moveTicketToProject(source, t.id, target, undefined, agentId);

    expect(service.getActivitiesByProject(source).some((a) => /to project "dst"/.test(a.details))).toBe(true);
    expect(service.getActivitiesByProject(target).some((a) => /from project "src"/.test(a.details))).toBe(true);
  });

  it('works without an actor (human action) and writes an audit entry', () => {
    const t = service.createTicket(source, 'a');

    service.moveTicketToProject(source, t.id, target);

    expect(service.getAllAuditEntries().some((e) => e.method === 'MOVE' && /'src' → 'dst'/.test(e.requestBody))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REST layer
// ---------------------------------------------------------------------------

describe('Move ticket to another project – REST', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let app: express.Express;
  let source: string;
  let target: string;
  let apiKey: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    app = express();
    app.use(express.json());
    app.use('/api/projects/:id', createTicketRoutes(service));
    app.use('/api/projects/:id', createHumanTicketRoutes(service));

    source = service.createProject('src').id;
    target = service.createProject('dst').id;
    apiKey = db.createAgent('bot').apiKey;
  });

  afterEach(() => {
    db.close();
  });

  it('PATCH .../project moves the ticket (agent, authenticated)', async () => {
    const t = service.createTicket(source, 'a');

    const res = await request(app)
      .patch(`/api/projects/${source}/tickets/${t.id}/project`)
      .set('X-Api-Key', apiKey)
      .send({ target_project_id: target, column: 'in_review' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ projectId: target, column: 'in_review' });
  });

  it('PATCH .../project requires authentication', async () => {
    const t = service.createTicket(source, 'a');

    const res = await request(app)
      .patch(`/api/projects/${source}/tickets/${t.id}/project`)
      .send({ target_project_id: target });

    expect(res.status).toBe(401);
  });

  it('PATCH .../project reports validation, not-found and conflict errors', async () => {
    const t = service.createTicket(source, 'a');
    const blocker = service.createTicket(source, 'b');
    service.updateTicket(source, blocker.id, { dependsOn: [t.id] });

    const bad = await request(app)
      .patch(`/api/projects/${source}/tickets/${t.id}/project`)
      .set('X-Api-Key', apiKey)
      .send({});
    expect(bad.status).toBe(400);

    const missing = await request(app)
      .patch(`/api/projects/${source}/tickets/${t.id}/project`)
      .set('X-Api-Key', apiKey)
      .send({ target_project_id: 'nope' });
    expect(missing.status).toBe(404);

    const conflict = await request(app)
      .patch(`/api/projects/${source}/tickets/${t.id}/project`)
      .set('X-Api-Key', apiKey)
      .send({ target_project_id: target });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toMatch(/still depends on it/);
  });

  it('POST .../project moves the ticket without auth (human action)', async () => {
    const t = service.createTicket(source, 'a');

    const res = await request(app)
      .post(`/api/projects/${source}/tickets/${t.id}/project`)
      .send({ target_project_id: target });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ projectId: target, column: 'backlog' });
  });

  it('POST .../project honours an explicit column and maps errors', async () => {
    const t = service.createTicket(source, 'a');

    const ok = await request(app)
      .post(`/api/projects/${source}/tickets/${t.id}/project`)
      .send({ target_project_id: target, column: 'done' });
    expect(ok.body.column).toBe('done');

    const bad = await request(app)
      .post(`/api/projects/${target}/tickets/${t.id}/project`)
      .send({ target_project_id: target });
    expect(bad.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// MCP tool
// ---------------------------------------------------------------------------

describe('Move ticket to another project – MCP tool', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let tools: Map<string, (args: Record<string, unknown>) => Promise<{ content: [{ text: string }]; isError?: boolean }>>;
  let source: string;
  let target: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    const agentId = db.createAgent('mcp-bot').id;
    source = service.createProject('src').id;
    target = service.createProject('dst').id;

    tools = new Map();
    const fakeMcp = {
      tool: (name: string, _d: string, _s: unknown, handler: never) => { tools.set(name, handler); },
    } as unknown as McpServer;
    registerMcpTools(fakeMcp, service, agentId, 'mcp-bot');
  });

  afterEach(() => {
    db.close();
  });

  it('move_ticket_to_project moves the ticket', async () => {
    const t = service.createTicket(source, 'a');

    const res = await tools.get('move_ticket_to_project')!({
      project_id: source, ticket_id: t.id, target_project_id: target, column: 'in_review',
    });

    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toMatchObject({ projectId: target, column: 'in_review' });
  });

  it('move_ticket_to_project reports errors as tool errors', async () => {
    const t = service.createTicket(source, 'a');

    const res = await tools.get('move_ticket_to_project')!({
      project_id: source, ticket_id: t.id, target_project_id: 'nope',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Target project not found/);
  });
});
