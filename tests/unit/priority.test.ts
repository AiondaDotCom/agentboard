import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createTicketRoutes } from '../../src/api/routes/tickets.js';
import { registerMcpTools } from '../../src/mcp-server.js';
import { ValidationError } from '../../src/services/errors.js';
import { PRIORITIES, DEFAULT_PRIORITY } from '../../src/types.js';

// ---------------------------------------------------------------------------
// DB layer: priority column, default, revisions, migration
// ---------------------------------------------------------------------------

describe('Ticket priority – DB layer', () => {
  let db: AgentboardDB;
  let projectId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    projectId = db.createProject('p').id;
  });

  afterEach(() => {
    db.close();
  });

  it('defaults to medium when no priority is given', () => {
    const t = db.createTicket(projectId, 'a');
    expect(t.priority).toBe('medium');
  });

  it('creates a ticket with an explicit priority', () => {
    const t = db.createTicket(projectId, 'a', '', 'backlog', null, null, null, [], 'critical');
    expect(t.priority).toBe('critical');
    expect(db.getTicket(projectId, t.id)?.priority).toBe('critical');
  });

  it('updates the priority and logs a revision', () => {
    const t = db.createTicket(projectId, 'a');
    const updated = db.updateTicket(projectId, t.id, { priority: 'high' });
    expect(updated?.priority).toBe('high');

    const revisions = db.getRevisionsByTicket(t.id).filter((r) => r.field === 'priority');
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ oldValue: 'medium', newValue: 'high' });
  });

  it('leaves priority unchanged and logs no revision when not part of the updates', () => {
    const t = db.createTicket(projectId, 'a', '', 'backlog', null, null, null, [], 'low');
    const updated = db.updateTicket(projectId, t.id, { title: 'b' });
    expect(updated?.priority).toBe('low');
    expect(db.getRevisionsByTicket(t.id).filter((r) => r.field === 'priority')).toHaveLength(0);
  });

  it('migrates an existing database without priority column', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-test-'));
    const dbPath = path.join(dir, 'old.db');

    // Simulate a pre-priority database: tickets table without priority
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        column_name TEXT NOT NULL DEFAULT 'backlog',
        position INTEGER NOT NULL DEFAULT 0,
        group_name TEXT,
        blocked_reason TEXT,
        agent_id TEXT,
        assignee_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tickets (id, project_id, title) VALUES ('t1', 'p1', 'legacy');
    `);
    raw.close();

    const migrated = new AgentboardDB(dbPath);
    expect(migrated.getTicket('p1', 't1')?.priority).toBe('medium');

    // Re-opening (column already present) must not fail
    migrated.close();
    const reopened = new AgentboardDB(dbPath);
    expect(reopened.getTicket('p1', 't1')?.priority).toBe('medium');
    reopened.close();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Service layer: validation + defaults
// ---------------------------------------------------------------------------

describe('Ticket priority – service layer', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let projectId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    projectId = db.createProject('p').id;
  });

  afterEach(() => {
    db.close();
  });

  it('exposes the known priority levels with medium as default', () => {
    expect(PRIORITIES).toEqual(['low', 'medium', 'high', 'critical']);
    expect(DEFAULT_PRIORITY).toBe('medium');
  });

  it('defaults to medium when priority is omitted or null', () => {
    expect(service.createTicket(projectId, 'a').priority).toBe('medium');
    expect(
      service.createTicket(projectId, 'b', '', 'backlog', null, null, null, undefined, null).priority,
    ).toBe('medium');
  });

  it('accepts every valid priority on create', () => {
    for (const p of PRIORITIES) {
      const t = service.createTicket(projectId, `t-${p}`, '', 'backlog', null, null, null, undefined, p);
      expect(t.priority).toBe(p);
    }
  });

  it('rejects an unknown priority on create', () => {
    expect(() =>
      service.createTicket(projectId, 'a', '', 'backlog', null, null, null, undefined, 'urgent'),
    ).toThrow(ValidationError);
    expect(() =>
      service.createTicket(projectId, 'a', '', 'backlog', null, null, null, undefined, 'urgent'),
    ).toThrow(/Valid priorities: low, medium, high, critical/);
  });

  it('rejects a non-string priority on create', () => {
    expect(() =>
      service.createTicket(projectId, 'a', '', 'backlog', null, null, null, undefined, 5),
    ).toThrow(ValidationError);
  });

  it('updates the priority', () => {
    const t = service.createTicket(projectId, 'a');
    expect(service.updateTicket(projectId, t.id, { priority: 'critical' }).priority).toBe('critical');
    expect(service.updateTicket(projectId, t.id, { priority: 'low' }).priority).toBe('low');
  });

  it('rejects an invalid priority on update', () => {
    const t = service.createTicket(projectId, 'a');
    expect(() => service.updateTicket(projectId, t.id, { priority: 'asap' })).toThrow(ValidationError);
    expect(() => service.updateTicket(projectId, t.id, { priority: null })).toThrow(ValidationError);
  });

  it('leaves priority untouched when not part of the updates', () => {
    const t = service.createTicket(projectId, 'a', '', 'backlog', null, null, null, undefined, 'high');
    expect(service.updateTicket(projectId, t.id, { title: 'b' }).priority).toBe('high');
  });
});

// ---------------------------------------------------------------------------
// REST routes: priority passthrough + validation mapping
// ---------------------------------------------------------------------------

describe('Ticket priority – REST routes', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let app: express.Express;
  let apiKey: string;
  let projectId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    app = express();
    app.use(express.json());
    app.use('/api/projects/:id', createTicketRoutes(service));

    apiKey = db.createAgent('bot').apiKey;
    projectId = db.createProject('p').id;
  });

  afterEach(() => {
    db.close();
  });

  it('creates a ticket with priority via POST', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-API-Key', apiKey)
      .send({ title: 'urgent thing', priority: 'critical' });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe('critical');
  });

  it('defaults to medium when POST omits priority', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-API-Key', apiKey)
      .send({ title: 'normal thing' });
    expect(res.status).toBe(201);
    expect(res.body.priority).toBe('medium');
  });

  it('rejects an invalid priority on POST with 400', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-API-Key', apiKey)
      .send({ title: 'x', priority: 'p0' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Valid priorities/);
  });

  it('updates the priority via PATCH', async () => {
    const t = service.createTicket(projectId, 'a');
    const res = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${t.id}`)
      .set('X-API-Key', apiKey)
      .send({ priority: 'high' });
    expect(res.status).toBe(200);
    expect(res.body.priority).toBe('high');
  });

  it('rejects an invalid priority on PATCH with 400', async () => {
    const t = service.createTicket(projectId, 'a');
    const res = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${t.id}`)
      .set('X-API-Key', apiKey)
      .send({ priority: 42 });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// MCP tools: priority passthrough
// ---------------------------------------------------------------------------

type ToolResult = { content: [{ type: 'text'; text: string }]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

describe('Ticket priority – MCP tools', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let tools: Map<string, ToolHandler>;
  let projectId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    const agentId = db.createAgent('mcp-bot').id;
    projectId = service.createProject('proj').id;

    tools = new Map();
    const fakeMcp = {
      tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
        tools.set(name, handler);
      },
    } as unknown as McpServer;
    registerMcpTools(fakeMcp, service, agentId, 'mcp-bot');
  });

  afterEach(() => {
    db.close();
  });

  function parse(result: ToolResult): any {
    expect(result.isError).toBeUndefined();
    return JSON.parse(result.content[0].text);
  }

  it('create_ticket accepts a priority and defaults to medium', async () => {
    const withPrio = parse(await tools.get('create_ticket')!({
      project_id: projectId, title: 'hot', priority: 'critical',
    }));
    expect(withPrio.priority).toBe('critical');

    const noPrio = parse(await tools.get('create_ticket')!({
      project_id: projectId, title: 'plain',
    }));
    expect(noPrio.priority).toBe('medium');
  });

  it('update_ticket changes the priority', async () => {
    const t = service.createTicket(projectId, 'a');
    const updated = parse(await tools.get('update_ticket')!({
      project_id: projectId, ticket_id: t.id, priority: 'low',
    }));
    expect(updated.priority).toBe('low');
  });

  it('list_tickets includes the priority in the summary', async () => {
    service.createTicket(projectId, 'a', '', 'backlog', null, null, null, undefined, 'high');
    const list = parse(await tools.get('list_tickets')!({ project_id: projectId }));
    expect(list.data[0].priority).toBe('high');
  });
});
