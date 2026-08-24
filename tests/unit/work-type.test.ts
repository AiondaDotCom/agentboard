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
import { WORK_TYPES, WORK_TYPE_FILTERS } from '../../src/types.js';

// ---------------------------------------------------------------------------
// DB layer: nullable work_type column, filter, revisions, migration
// ---------------------------------------------------------------------------

describe('Ticket work type – DB layer', () => {
  let db: AgentboardDB;
  let projectId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    projectId = db.createProject('p').id;
  });

  afterEach(() => {
    db.close();
  });

  it('is null when no work type is given', () => {
    const t = db.createTicket(projectId, 'a');
    expect(t.workType).toBeNull();
    expect(db.getTicket(projectId, t.id)?.workType).toBeNull();
  });

  it('creates a ticket with an explicit work type', () => {
    const t = db.createTicket(projectId, 'a', '', 'backlog', null, null, null, [], 'medium', 'mechanical');
    expect(t.workType).toBe('mechanical');
    expect(db.getTicket(projectId, t.id)?.workType).toBe('mechanical');
  });

  it('updates the work type and logs a revision', () => {
    const t = db.createTicket(projectId, 'a');
    const updated = db.updateTicket(projectId, t.id, { workType: 'judgment' });
    expect(updated?.workType).toBe('judgment');

    const revisions = db.getRevisionsByTicket(t.id).filter((r) => r.field === 'work_type');
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ oldValue: '', newValue: 'judgment' });
  });

  it('logs a revision when the work type is cleared', () => {
    const t = db.createTicket(projectId, 'a', '', 'backlog', null, null, null, [], 'medium', 'judgment');
    const cleared = db.updateTicket(projectId, t.id, { workType: null });
    expect(cleared?.workType).toBeNull();

    const revisions = db.getRevisionsByTicket(t.id).filter((r) => r.field === 'work_type');
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ oldValue: 'judgment', newValue: '' });
  });

  it('leaves the work type untouched and logs no revision when not part of the updates', () => {
    const t = db.createTicket(projectId, 'a', '', 'backlog', null, null, null, [], 'medium', 'mechanical');
    const updated = db.updateTicket(projectId, t.id, { title: 'b' });
    expect(updated?.workType).toBe('mechanical');
    expect(db.getRevisionsByTicket(t.id).filter((r) => r.field === 'work_type')).toHaveLength(0);
  });

  it('treats an explicit undefined work type as "clear"', () => {
    const t = db.createTicket(projectId, 'a', '', 'backlog', null, null, null, [], 'medium', 'mechanical');
    const updated = db.updateTicket(projectId, t.id, { workType: undefined });
    expect(updated?.workType).toBeNull();
  });

  it('filters the ticket list by work type', () => {
    db.createTicket(projectId, 'mech', '', 'backlog', null, null, null, [], 'medium', 'mechanical');
    db.createTicket(projectId, 'judge', '', 'backlog', null, null, null, [], 'medium', 'judgment');
    db.createTicket(projectId, 'plain');

    const mech = db.getTicketsByProject(projectId, { work_type: 'mechanical' });
    expect(mech.total).toBe(1);
    expect(mech.data[0]!.title).toBe('mech');

    const judge = db.getTicketsByProject(projectId, { work_type: 'judgment' });
    expect(judge.data.map((t) => t.title)).toEqual(['judge']);
  });

  it('filters for unclassified tickets with work_type=none', () => {
    db.createTicket(projectId, 'mech', '', 'backlog', null, null, null, [], 'medium', 'mechanical');
    db.createTicket(projectId, 'plain');

    const none = db.getTicketsByProject(projectId, { work_type: 'none' });
    expect(none.total).toBe(1);
    expect(none.data[0]!.title).toBe('plain');
  });

  it('combines the work type filter with the column filter', () => {
    db.createTicket(projectId, 'a', '', 'backlog', null, null, null, [], 'medium', 'mechanical');
    db.createTicket(projectId, 'b', '', 'in_progress', null, null, null, [], 'medium', 'mechanical');

    const res = db.getTicketsByProject(projectId, { column: 'in_progress', work_type: 'mechanical' });
    expect(res.data.map((t) => t.title)).toEqual(['b']);
  });

  it('returns everything when no work type filter is given', () => {
    db.createTicket(projectId, 'a', '', 'backlog', null, null, null, [], 'medium', 'mechanical');
    db.createTicket(projectId, 'b');
    expect(db.getTicketsByProject(projectId).total).toBe(2);
  });

  it('migrates an existing database without work_type column', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-test-'));
    const dbPath = path.join(dir, 'old.db');

    // Simulate a pre-work_type database: tickets table without work_type
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
        priority TEXT NOT NULL DEFAULT 'medium',
        agent_id TEXT,
        assignee_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tickets (id, project_id, title) VALUES ('t1', 'p1', 'legacy');
    `);
    raw.close();

    const migrated = new AgentboardDB(dbPath);
    expect(migrated.getTicket('p1', 't1')?.workType).toBeNull();

    // Re-opening (column already present) must not fail
    migrated.close();
    const reopened = new AgentboardDB(dbPath);
    expect(reopened.getTicket('p1', 't1')?.workType).toBeNull();
    reopened.close();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Service layer: validation, clearing, filter validation
// ---------------------------------------------------------------------------

describe('Ticket work type – service layer', () => {
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

  it('exposes exactly two work types plus the "none" filter', () => {
    expect(WORK_TYPES).toEqual(['mechanical', 'judgment']);
    expect(WORK_TYPE_FILTERS).toEqual(['mechanical', 'judgment', 'none']);
  });

  it('leaves the work type unset when omitted', () => {
    expect(service.createTicket(projectId, 'a').workType).toBeNull();
  });

  it('accepts every valid work type on create', () => {
    for (const w of WORK_TYPES) {
      const t = service.createTicket(projectId, `t-${w}`, '', 'backlog', null, null, null, undefined, undefined, w);
      expect(t.workType).toBe(w);
    }
  });

  it('treats null and an empty string as unclassified on create', () => {
    expect(
      service.createTicket(projectId, 'a', '', 'backlog', null, null, null, undefined, undefined, null).workType,
    ).toBeNull();
    expect(
      service.createTicket(projectId, 'b', '', 'backlog', null, null, null, undefined, undefined, '  ').workType,
    ).toBeNull();
  });

  it('rejects an unknown work type on create', () => {
    expect(() =>
      service.createTicket(projectId, 'a', '', 'backlog', null, null, null, undefined, undefined, 'acceptance'),
    ).toThrow(ValidationError);
    expect(() =>
      service.createTicket(projectId, 'a', '', 'backlog', null, null, null, undefined, undefined, 'acceptance'),
    ).toThrow(/Valid work types: mechanical, judgment/);
  });

  it('rejects a non-string work type on create', () => {
    expect(() =>
      service.createTicket(projectId, 'a', '', 'backlog', null, null, null, undefined, undefined, 7),
    ).toThrow(ValidationError);
  });

  it('updates the work type', () => {
    const t = service.createTicket(projectId, 'a');
    expect(service.updateTicket(projectId, t.id, { workType: 'mechanical' }).workType).toBe('mechanical');
    expect(service.updateTicket(projectId, t.id, { workType: 'judgment' }).workType).toBe('judgment');
  });

  it('clears the work type with an empty string or null', () => {
    const t = service.createTicket(projectId, 'a', '', 'backlog', null, null, null, undefined, undefined, 'judgment');
    expect(service.updateTicket(projectId, t.id, { workType: '' }).workType).toBeNull();

    const t2 = service.createTicket(projectId, 'b', '', 'backlog', null, null, null, undefined, undefined, 'judgment');
    expect(service.updateTicket(projectId, t2.id, { workType: null }).workType).toBeNull();
  });

  it('rejects an invalid work type on update', () => {
    const t = service.createTicket(projectId, 'a');
    expect(() => service.updateTicket(projectId, t.id, { workType: 'routing' })).toThrow(ValidationError);
    expect(() => service.updateTicket(projectId, t.id, { workType: 3 })).toThrow(ValidationError);
  });

  it('leaves the work type untouched when not part of the updates', () => {
    const t = service.createTicket(projectId, 'a', '', 'backlog', null, null, null, undefined, undefined, 'mechanical');
    expect(service.updateTicket(projectId, t.id, { title: 'b' }).workType).toBe('mechanical');
  });

  it('filters the list by work type', () => {
    service.createTicket(projectId, 'mech', '', 'backlog', null, null, null, undefined, undefined, 'mechanical');
    service.createTicket(projectId, 'plain');

    expect(service.getTicketsByProject(projectId, null, { work_type: 'mechanical' }).total).toBe(1);
    expect(service.getTicketsByProject(projectId, null, { work_type: 'none' }).total).toBe(1);
    expect(service.getTicketsByProject(projectId, null, {}).total).toBe(2);
  });

  it('rejects an invalid work type filter', () => {
    expect(() => service.getTicketsByProject(projectId, null, { work_type: 'urteil' as never })).toThrow(ValidationError);
    expect(() => service.getTicketsByProject(projectId, null, { work_type: 9 as never })).toThrow(
      /Valid filters: mechanical, judgment, none/,
    );
  });

  it('names the active filters in the audit entry', () => {
    const agentId = db.createAgent('bot').id;
    service.createTicket(projectId, 'a', '', 'backlog', null, null, null, undefined, undefined, 'mechanical');
    service.getTicketsByProject(projectId, agentId, { column: 'backlog', work_type: 'mechanical' });
    service.getTicketsByProject(projectId, agentId, {});

    const entries = db.getAllAuditEntries(50).filter((e) => e.method === 'LIST');
    expect(entries.some((e) => e.path.includes('column=backlog, work_type=mechanical'))).toBe(true);
    expect(entries.some((e) => /tickets in 'p'$/.test(e.path))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// REST routes: passthrough, filter, validation mapping
// ---------------------------------------------------------------------------

describe('Ticket work type – REST routes', () => {
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

  it('creates a ticket with a work type via POST', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-API-Key', apiKey)
      .send({ title: 'rename a symbol', work_type: 'mechanical' });
    expect(res.status).toBe(201);
    expect(res.body.workType).toBe('mechanical');
  });

  it('leaves the work type null when POST omits it', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-API-Key', apiKey)
      .send({ title: 'unclassified' });
    expect(res.status).toBe(201);
    expect(res.body.workType).toBeNull();
  });

  it('rejects an invalid work type on POST with 400', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-API-Key', apiKey)
      .send({ title: 'x', work_type: 'gpt-5.4' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Valid work types/);
  });

  it('updates and clears the work type via PATCH', async () => {
    const t = service.createTicket(projectId, 'a');
    const set = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${t.id}`)
      .set('X-API-Key', apiKey)
      .send({ work_type: 'judgment' });
    expect(set.status).toBe(200);
    expect(set.body.workType).toBe('judgment');

    const cleared = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${t.id}`)
      .set('X-API-Key', apiKey)
      .send({ work_type: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.workType).toBeNull();
  });

  it('rejects an invalid work type on PATCH with 400', async () => {
    const t = service.createTicket(projectId, 'a');
    const res = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${t.id}`)
      .set('X-API-Key', apiKey)
      .send({ work_type: 42 });
    expect(res.status).toBe(400);
  });

  it('filters the ticket list via ?work_type=', async () => {
    service.createTicket(projectId, 'mech', '', 'backlog', null, null, null, undefined, undefined, 'mechanical');
    service.createTicket(projectId, 'plain');

    const mech = await request(app).get(`/api/projects/${projectId}/tickets?work_type=mechanical`);
    expect(mech.status).toBe(200);
    expect(mech.body.data.map((t: { title: string }) => t.title)).toEqual(['mech']);

    const none = await request(app).get(`/api/projects/${projectId}/tickets?work_type=none`);
    expect(none.body.data.map((t: { title: string }) => t.title)).toEqual(['plain']);

    const all = await request(app).get(`/api/projects/${projectId}/tickets`);
    expect(all.body.total).toBe(2);
  });

  it('rejects an invalid ?work_type= filter with 400', async () => {
    const res = await request(app).get(`/api/projects/${projectId}/tickets?work_type=abnahme`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Valid filters/);
  });
});

// ---------------------------------------------------------------------------
// MCP tools + batch
// ---------------------------------------------------------------------------

type ToolResult = { content: [{ type: 'text'; text: string }]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

describe('Ticket work type – MCP tools', () => {
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

  it('create_ticket accepts a work type and leaves it null when omitted', async () => {
    const classified = parse(await tools.get('create_ticket')!({
      project_id: projectId, title: 'bump a version', work_type: 'mechanical',
    }));
    expect(classified.workType).toBe('mechanical');

    const plain = parse(await tools.get('create_ticket')!({ project_id: projectId, title: 'plain' }));
    expect(plain.workType).toBeNull();
  });

  it('update_ticket sets and clears the work type', async () => {
    const t = service.createTicket(projectId, 'a');
    const set = parse(await tools.get('update_ticket')!({
      project_id: projectId, ticket_id: t.id, work_type: 'judgment',
    }));
    expect(set.workType).toBe('judgment');

    const cleared = parse(await tools.get('update_ticket')!({
      project_id: projectId, ticket_id: t.id, work_type: '',
    }));
    expect(cleared.workType).toBeNull();
  });

  it('list_tickets exposes the work type and filters by it', async () => {
    service.createTicket(projectId, 'mech', '', 'backlog', null, null, null, undefined, undefined, 'mechanical');
    service.createTicket(projectId, 'plain');

    const all = parse(await tools.get('list_tickets')!({ project_id: projectId }));
    expect(all.total).toBe(2);
    expect(all.data.find((t: { title: string }) => t.title === 'mech').workType).toBe('mechanical');

    const mech = parse(await tools.get('list_tickets')!({ project_id: projectId, work_type: 'mechanical' }));
    expect(mech.data.map((t: { title: string }) => t.title)).toEqual(['mech']);

    const none = parse(await tools.get('list_tickets')!({ project_id: projectId, work_type: 'none' }));
    expect(none.data.map((t: { title: string }) => t.title)).toEqual(['plain']);
  });

  it('carries the work type through batch create / update / list', async () => {
    const result = parse(await tools.get('batch')!({
      operations: [
        { op: 'create_ticket', args: { project_id: projectId, title: 'mech', work_type: 'mechanical' } },
        { op: 'create_ticket', args: { project_id: projectId, title: 'plain' } },
        { op: 'list_tickets', args: { project_id: projectId, work_type: 'mechanical' } },
      ],
    }));

    expect(result[0].result.workType).toBe('mechanical');
    expect(result[1].result.workType).toBeNull();
    expect(result[2].result.data.map((t: { title: string }) => t.title)).toEqual(['mech']);

    const ticketId = result[0].result.id;
    const second = parse(await tools.get('batch')!({
      operations: [
        { op: 'update_ticket', args: { project_id: projectId, ticket_id: ticketId, work_type: 'judgment' } },
        { op: 'update_ticket', args: { project_id: projectId, ticket_id: ticketId, work_type: '' } },
      ],
    }));
    expect(second[0].result.workType).toBe('judgment');
    expect(second[1].result.workType).toBeNull();
  });
});
