import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { ValidationError } from '../../src/services/errors.js';
import { createBatchRoutes } from '../../src/api/routes/batch.js';
import { registerMcpTools, MCP_INSTRUCTIONS } from '../../src/mcp-server.js';
import { BATCH_OPS, MAX_BATCH_OPS } from '../../src/types.js';

describe('Batch operations', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let agentId: string;
  let projectId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    agentId = db.createAgent('batch-bot').id;
    projectId = service.createProject('proj').id;
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Service layer: envelope validation
  // -------------------------------------------------------------------------

  describe('BoardService.executeBatch – envelope validation', () => {
    it('rejects a non-array', () => {
      expect(() => service.executeBatch('nope', agentId)).toThrow(ValidationError);
      expect(() => service.executeBatch({ op: 'list_projects' }, agentId)).toThrow(ValidationError);
    });

    it('rejects an empty array', () => {
      expect(() => service.executeBatch([], agentId)).toThrow(ValidationError);
    });

    it(`rejects more than ${MAX_BATCH_OPS} operations`, () => {
      const ops = Array.from({ length: MAX_BATCH_OPS + 1 }, () => ({ op: 'list_projects' }));
      expect(() => service.executeBatch(ops, agentId)).toThrow(ValidationError);
    });

    it('rejects entries that are not objects', () => {
      expect(() => service.executeBatch(['list_projects'], agentId)).toThrow(/Operation #0/);
      expect(() => service.executeBatch([null], agentId)).toThrow(/Operation #0/);
      expect(() => service.executeBatch([['list_projects']], agentId)).toThrow(/Operation #0/);
    });

    it('rejects unknown ops and lists the supported ones', () => {
      expect(() => service.executeBatch([{ op: 'explode' }], agentId)).toThrow(/unknown "op"/);
      expect(() => service.executeBatch([{ op: 'explode' }], agentId)).toThrow(/list_projects/);
      expect(() => service.executeBatch([{}], agentId)).toThrow(/unknown "op"/);
    });

    it('rejects non-object args', () => {
      expect(() => service.executeBatch([{ op: 'list_projects', args: 'x' }], agentId)).toThrow(/"args" must be an object/);
      expect(() => service.executeBatch([{ op: 'list_projects', args: null }], agentId)).toThrow(/"args" must be an object/);
      expect(() => service.executeBatch([{ op: 'list_projects', args: [] }], agentId)).toThrow(/"args" must be an object/);
    });

    it('nothing is executed when the envelope is invalid', () => {
      expect(() => service.executeBatch([
        { op: 'create_ticket', args: { project_id: projectId, title: 'T' } },
        { op: 'explode' },
      ], agentId)).toThrow(ValidationError);
      expect(service.getTicketsByProject(projectId).total).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Service layer: dispatch of every supported op
  // -------------------------------------------------------------------------

  describe('BoardService.executeBatch – operations', () => {
    it('supports every advertised op', () => {
      expect(BATCH_OPS).toHaveLength(17);

      const setup = service.executeBatch([
        { op: 'create_project', args: { name: 'p2', description: 'd', columns: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] } },
        { op: 'create_ticket', args: { project_id: projectId, title: 'T1', description: 'desc', column: 'backlog', group: 'g', blocked_reason: 'waiting', priority: 'high' } },
        { op: 'create_ticket', args: { project_id: projectId, title: 'T2' } },
      ], agentId);
      expect(setup.every((r) => r.ok)).toBe(true);
      const p2 = setup[0]!.result as { id: string; columns: { id: string }[] };
      expect(p2.columns.map((c) => c.id)).toEqual(['a', 'b']);
      const t1 = setup[1]!.result as { id: string; blockedReason: string; priority: string };
      expect(t1.blockedReason).toBe('waiting');
      expect(t1.priority).toBe('high');
      const t2 = setup[2]!.result as { id: string };

      const results = service.executeBatch([
        { op: 'list_projects' },
        { op: 'get_project', args: { project_id: projectId } },
        { op: 'update_project', args: { project_id: p2.id, name: 'p2r', description: 'nd', columns: [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }] } },
        { op: 'list_tickets', args: { project_id: projectId, column: 'backlog', page: 1, per_page: 10 } },
        { op: 'get_ticket', args: { project_id: projectId, ticket_id: t1.id } },
        { op: 'update_ticket', args: { project_id: projectId, ticket_id: t1.id, title: 'T1b', description: 'd2', column: 'in_progress', group: '', blocked_reason: '', depends_on: [], priority: 'low' } },
        { op: 'move_ticket', args: { project_id: projectId, ticket_id: t1.id, column: 'in_review' } },
        { op: 'assign_ticket', args: { project_id: projectId, ticket_id: t1.id, assignee_id: agentId } },
        { op: 'assign_ticket', args: { project_id: projectId, ticket_id: t1.id } },
        { op: 'add_comment', args: { project_id: projectId, ticket_id: t1.id, body: 'hi' } },
        { op: 'get_comments', args: { project_id: projectId, ticket_id: t1.id } },
        { op: 'get_ticket_history', args: { project_id: projectId, ticket_id: t1.id } },
        { op: 'list_agents' },
        { op: 'move_ticket_to_project', args: { project_id: projectId, ticket_id: t1.id, target_project_id: p2.id, column: 'x' } },
        { op: 'delete_ticket', args: { project_id: projectId, ticket_id: t2.id } },
        { op: 'delete_project', args: { project_id: p2.id } },
      ], agentId);

      expect(results.every((r) => r.ok)).toBe(true);
      expect((results[0]!.result as unknown[]).length).toBeGreaterThan(0);
      expect((results[2]!.result as { name: string }).name).toBe('p2r');
      expect((results[3]!.result as { total: number }).total).toBe(2);
      expect((results[5]!.result as { title: string; group: null }).title).toBe('T1b');
      expect((results[6]!.result as { column: string }).column).toBe('in_review');
      expect((results[7]!.result as { assigneeId: string }).assigneeId).toBe(agentId);
      expect((results[8]!.result as { assigneeId: null }).assigneeId).toBeNull();
      expect((results[9]!.result as { body: string }).body).toBe('hi');
      expect((results[10]!.result as unknown[]).length).toBe(1);
      expect((results[12]!.result as { name: string }[]).map((a) => a.name)).toContain('batch-bot');
      expect((results[13]!.result as { projectId: string; column: string }).projectId).toBe(p2.id);
      expect((results[13]!.result as { column: string }).column).toBe('x');
      expect(results[14]!.result).toEqual({ deleted: true });
      expect(results[15]!.result).toEqual({ deleted: true });
      expect(service.getTicketsByProject(projectId).total).toBe(0);
    });

    it('reports individual failures without stopping the rest (no rollback)', () => {
      const results = service.executeBatch([
        { op: 'create_ticket', args: { project_id: projectId, title: 'ok1' } },
        { op: 'get_ticket', args: { project_id: projectId, ticket_id: 'missing' } },
        { op: 'create_ticket', args: { project_id: projectId } }, // missing title
        { op: 'create_ticket', args: { project_id: projectId, title: 'ok2' } },
        { op: 'get_project' }, // missing project_id entirely
      ], agentId);

      expect(results.map((r) => r.ok)).toEqual([true, false, false, true, false]);
      expect(results[4]!.error).toContain('not found');
      expect(results[1]!.error).toContain('not found');
      expect(results[2]!.error).toContain('title');
      expect(results[1]!.result).toBeUndefined();
      expect(service.getTicketsByProject(projectId).total).toBe(2);
    });

    it('reports conflict errors (dependency gate) per operation', () => {
      const [a, b] = service.executeBatch([
        { op: 'create_ticket', args: { project_id: projectId, title: 'dep' } },
      ], agentId);
      const depId = (a!.result as { id: string }).id;
      expect(b).toBeUndefined();

      const t = service.createTicket(projectId, 'blocked', undefined, undefined, agentId, undefined, undefined, [depId]);
      const results = service.executeBatch([
        { op: 'move_ticket', args: { project_id: projectId, ticket_id: t.id, column: 'in_progress' } },
      ], agentId);
      expect(results[0]!.ok).toBe(false);
      expect(results[0]!.error).toContain('depends on');
    });

    it('works without an actor and defaults missing args to {}', () => {
      const results = service.executeBatch([{ op: 'list_projects' }]);
      expect(results[0]!.ok).toBe(true);
    });

    it('falls back to a generic message for non-Error throws', () => {
      vi.spyOn(service, 'getAllAgents').mockImplementation(() => { throw 'boom'; });
      const results = service.executeBatch([{ op: 'list_agents' }], agentId);
      expect(results[0]).toEqual({ op: 'list_agents', ok: false, error: 'Failed' });
      vi.restoreAllMocks();
    });

    it('writes one BATCH audit entry summarizing the outcome', () => {
      service.executeBatch([
        { op: 'list_projects' },
        { op: 'get_project', args: { project_id: 'missing' } },
      ], agentId);
      const entry = service.getAllAuditEntries().find((e) => e.method === 'BATCH');
      expect(entry).toBeDefined();
      expect(entry!.path).toBe('2 operations');
      expect(entry!.requestBody).toContain('1 ok, 1 failed');
      expect(entry!.requestBody).toContain('list_projects, get_project');
    });

    it('uses singular wording for a one-operation batch', () => {
      service.executeBatch([{ op: 'list_projects' }], agentId);
      const entry = service.getAllAuditEntries().find((e) => e.method === 'BATCH');
      expect(entry!.path).toBe('1 operation');
    });
  });

  // -------------------------------------------------------------------------
  // REST: POST /api/batch
  // -------------------------------------------------------------------------

  describe('POST /api/batch', () => {
    let app: express.Express;
    let apiKey: string;

    beforeEach(() => {
      app = express();
      app.use(express.json());
      app.use('/api/batch', createBatchRoutes(service));
      apiKey = db.getAllAgentsWithKeys().find((a) => a.id === agentId)!.apiKey;
    });

    it('requires authentication', async () => {
      const res = await request(app).post('/api/batch').send({ operations: [{ op: 'list_projects' }] });
      expect(res.status).toBe(401);
    });

    it('executes operations and returns per-op results (200 despite item failures)', async () => {
      const res = await request(app)
        .post('/api/batch')
        .set('X-Api-Key', apiKey)
        .send({
          operations: [
            { op: 'create_ticket', args: { project_id: projectId, title: 'via REST' } },
            { op: 'get_ticket', args: { project_id: projectId, ticket_id: 'missing' } },
          ],
        });
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(2);
      expect(res.body.results[0].ok).toBe(true);
      expect(res.body.results[0].result.title).toBe('via REST');
      expect(res.body.results[1].ok).toBe(false);
      expect(res.body.results[1].error).toContain('not found');
    });

    it('returns 400 for an invalid envelope', async () => {
      const res = await request(app)
        .post('/api/batch')
        .set('X-Api-Key', apiKey)
        .send({ operations: 'nope' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('operations');
    });
  });

  // -------------------------------------------------------------------------
  // MCP: batch tool
  // -------------------------------------------------------------------------

  describe('MCP batch tool', () => {
    type ToolResult = { content: [{ type: 'text'; text: string }]; isError?: boolean };
    type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;
    let tools: Map<string, ToolHandler>;

    beforeEach(() => {
      tools = new Map();
      const fakeMcp = {
        tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
          tools.set(name, handler);
        },
      } as unknown as McpServer;
      registerMcpTools(fakeMcp, service, agentId, 'batch-bot');
    });

    it('executes a mixed batch and trims descriptions from list_tickets results', async () => {
      const res = await tools.get('batch')!({
        operations: [
          { op: 'create_ticket', args: { project_id: projectId, title: 'A', description: 'long text' } },
          { op: 'list_tickets', args: { project_id: projectId } },
          { op: 'list_tickets', args: { project_id: 'missing' } },
        ],
      });
      expect(res.isError).toBeUndefined();
      const results = JSON.parse(res.content[0].text);
      expect(results).toHaveLength(3);
      expect(results[0].ok).toBe(true);
      expect(results[0].result.description).toBe('long text');
      expect(results[1].ok).toBe(true);
      expect(results[1].result.total).toBe(1);
      expect(results[1].result.data[0].description).toBeUndefined();
      expect(results[2].ok).toBe(false);
      expect(results[2].error).toContain('not found');
    });

    it('returns an error result for an invalid envelope', async () => {
      const res = await tools.get('batch')!({ operations: [] });
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain('operations');
    });
  });

  // -------------------------------------------------------------------------
  // Server instructions advertise the batch tool
  // -------------------------------------------------------------------------

  it('MCP_INSTRUCTIONS advertise preferring the batch tool', () => {
    expect(MCP_INSTRUCTIONS).toContain('`batch`');
    expect(MCP_INSTRUCTIONS).toContain('ALWAYS');
  });
});
