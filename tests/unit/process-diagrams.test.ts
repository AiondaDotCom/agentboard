import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createProcessDiagramRoutes } from '../../src/api/routes/process-diagrams.js';
import { validateDiagram } from '../../src/services/process-diagrams.js';
import { MCP_INSTRUCTIONS, registerMcpTools } from '../../src/mcp-server.js';

// "Create folder": user → app → server, with an error path (#be30299e)
const createFolder = () => ({
  lanes: [{ id: 'user', name: 'User' }, { id: 'app', name: 'App' }, { id: 'server', name: 'Server' }],
  nodes: [
    { id: 'start', type: 'start', label: 'Tap “Create”', lane: 'user' },
    { id: 'encrypt', type: 'task', label: 'Encrypt folder name', lane: 'app' },
    { id: 'store', type: 'task', label: 'Store folder', lane: 'server' },
    { id: 'ok', type: 'decision', label: 'Stored?', lane: 'server' },
    { id: 'done', type: 'end', label: 'Folder visible', lane: 'user' },
    { id: 'error', type: 'end', label: 'Show error', lane: 'user' },
  ],
  flows: [
    { from: 'start', to: 'encrypt' },
    { from: 'encrypt', to: 'store' },
    { from: 'store', to: 'ok' },
    { from: 'ok', to: 'done', label: 'yes' },
    { from: 'ok', to: 'error', label: 'no' },
  ],
});

describe('process diagrams (simplified BPMN)', () => {
  let db: AgentboardDB, service: BoardService, projectId: string, ticketId: string, agentId: string, apiKey: string, app: express.Express;
  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    const agent = service.createAgent('planner');
    agentId = agent.id;
    apiKey = agent.apiKey;
    projectId = service.createProject('iOS').id;
    ticketId = service.createTicket(projectId, 'Folders').id;
    app = express();
    app.use(express.json());
    app.use('/api/projects/:id', createProcessDiagramRoutes(service, (cookie) => cookie === 'session=test'));
  });
  afterEach(() => db.close());

  it('assigns sub-IDs and keeps them stable across versions', () => {
    const one = service.processDiagrams.save(projectId, ticketId, 'Create folder', createFolder(), agentId);
    expect(one.version).toBe(1);
    expect(one.nodes.map((n) => n.ref)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
    expect(one.flows.map((f) => f.ref)).toEqual(['F1', 'F2', 'F3', 'F4', 'F5']);

    // v2 drops "encrypt" and adds "validate": survivors keep their IDs, new ones never reuse old numbers
    const next = createFolder();
    next.nodes = next.nodes.filter((n) => n.id !== 'encrypt');
    next.nodes.splice(1, 0, { id: 'validate', type: 'task', label: 'Validate name', lane: 'app' });
    next.flows = [{ from: 'start', to: 'validate' }, { from: 'validate', to: 'store' }, ...next.flows.slice(2)];
    const two = service.processDiagrams.save(projectId, ticketId, 'Create folder', next, agentId, one.id, 1);
    expect(two.version).toBe(2);
    expect(Object.fromEntries(two.nodes.map((n) => [n.id, n.ref]))).toEqual({
      start: 'S1', validate: 'S7', store: 'S3', ok: 'S4', done: 'S5', error: 'S6',
    });
    expect(Object.fromEntries(two.flows.map((f) => [`${f.from}>${f.to}`, f.ref]))).toEqual({
      'start>validate': 'F6', 'validate>store': 'F7', 'store>ok': 'F3', 'ok>done': 'F4', 'ok>error': 'F5',
    });
    // Agent-supplied refs are ignored: the server owns sub-IDs
    const forged = createFolder();
    (forged.nodes[0] as Record<string, unknown>)['ref'] = 'S99';
    expect(service.processDiagrams.save(projectId, ticketId, 'Other', forged, agentId).nodes[0].ref).toBe('S1');

    expect(() => service.processDiagrams.save(projectId, ticketId, 'Create folder', next, agentId, one.id, 1)).toThrow(/changed/);
    expect(service.processDiagrams.list(projectId, ticketId)).toHaveLength(3);
    expect(service.processDiagrams.get(projectId, ticketId, one.id, 1).nodes[1].id).toBe('encrypt');
  });

  it('refuses diagrams the board could not draw truthfully', () => {
    const cases: [string, (d: ReturnType<typeof createFolder>) => void][] = [
      ['start event', (d) => { d.nodes = d.nodes.filter((n) => n.type !== 'start'); d.flows = d.flows.slice(1); }],
      ['end event', (d) => { d.nodes = d.nodes.filter((n) => n.type !== 'end'); d.flows = d.flows.slice(0, 3); }],
      ['unknown lane', (d) => { d.nodes[1].lane = 'cloud'; }],
      ['unknown node', (d) => { d.flows.push({ from: 'store', to: 'ghost' }); }],
      ['Duplicate node', (d) => { d.nodes.push({ ...d.nodes[1] }); }],
      ['Not reachable', (d) => { d.nodes.push({ id: 'island', type: 'task', label: 'Island', lane: 'app' }); d.flows.push({ from: 'island', to: 'done' }); }],
      ['no outgoing flow', (d) => { d.flows = d.flows.filter((f) => f.from !== 'encrypt'); d.flows.push({ from: 'start', to: 'store' }); }],
      ['at least two', (d) => { d.flows = d.flows.filter((f) => f.to !== 'error'); d.nodes = d.nodes.filter((n) => n.id !== 'error'); }],
      ['incoming', (d) => { d.flows.push({ from: 'store', to: 'start' }); }],
      ['must be one of', (d) => { (d.nodes[1] as { type: string }).type = 'subprocess'; }],
      ['must match', (d) => { d.nodes[1].id = 'bad id<script>'; }],
    ];
    for (const [message, mutate] of cases) {
      const d = createFolder();
      mutate(d);
      expect(() => validateDiagram(d), message).toThrow(new RegExp(message));
    }
    // Loops back to an earlier step are legitimate processes (retry)
    const retry = createFolder();
    retry.flows.push({ from: 'error', to: 'encrypt' } as never);
    expect(() => validateDiagram(retry)).toThrow(/End event/);
    const loop = createFolder();
    loop.nodes.push({ id: 'again', type: 'task', label: 'Retry', lane: 'user' });
    loop.flows = loop.flows.map((f) => (f.to === 'error' ? { ...f, to: 'again' } : f));
    loop.flows.push({ from: 'again', to: 'encrypt' }, { from: 'again', to: 'error' });
    expect(validateDiagram(loop).nodes).toHaveLength(7);
  });

  it('lets humans read with their session and only agents write over REST', async () => {
    const base = `/api/projects/${projectId}/tickets/${ticketId}/process-diagrams`;
    await request(app).get(base).expect(401);
    await request(app).post(base).set('Cookie', 'session=test').send({ title: 'x', ...createFolder() }).expect(401);
    const saved = await request(app).post(base).set('X-Api-Key', apiKey).send({ title: 'Create folder', ...createFolder() }).expect(201);
    expect(saved.body.nodes[0].ref).toBe('S1');
    const listed = await request(app).get(base).set('Cookie', 'session=test').expect(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.body).toHaveLength(1);
    await request(app).get(`${base}/${saved.body.id}/versions/1`).set('X-Api-Key', apiKey).expect(200);
    await request(app).get(`${base}/${saved.body.id}/versions/2`).set('X-Api-Key', apiKey).expect(404);
    await request(app).post(base).set('X-Api-Key', apiKey).send({ title: 'Broken', lanes: [] }).expect(400);
    const other = service.createTicket(projectId, 'Elsewhere').id;
    await request(app).get(`/api/projects/${projectId}/tickets/${other}/process-diagrams/${saved.body.id}/versions/1`).set('X-Api-Key', apiKey).expect(404);
    // Removal: not via another ticket, not anonymously, not cross-site; humans with session may
    await request(app).delete(`/api/projects/${projectId}/tickets/${other}/process-diagrams/${saved.body.id}`).set('X-Api-Key', apiKey).expect(404);
    await request(app).delete(`${base}/${saved.body.id}`).expect(401);
    await request(app).delete(`${base}/${saved.body.id}`).set('Cookie', 'session=test').set('Sec-Fetch-Site', 'cross-site').send({}).expect(403);
    const gone = await request(app).delete(`${base}/${saved.body.id}`).set('Cookie', 'session=test').send({}).expect(200);
    expect(gone.body).toEqual({ deleted: true, id: saved.body.id, versions: 1 });
    await request(app).get(base).set('Cookie', 'session=test').expect(200, []);
  });

  it('offers create and read as MCP tools and in batch', async () => {
    type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> | { content: { text: string }[]; isError?: boolean };
    const tools = new Map<string, Handler>();
    registerMcpTools({
      registerTool: (name: string, _c: unknown, h: Handler) => tools.set(name, h),
      tool: (name: string, _d: string, _s: unknown, h: Handler) => tools.set(name, h),
    } as unknown as McpServer, service, agentId, 'planner');
    const saved = JSON.parse((await tools.get('save_process_diagram')!({ project_id: projectId, ticket_id: ticketId, title: 'Create folder', ...createFolder() })).content[0].text);
    expect(saved.flows[3]).toEqual({ from: 'ok', to: 'done', label: 'yes', ref: 'F4' });
    const read = JSON.parse((await tools.get('get_process_diagram')!({ project_id: projectId, ticket_id: ticketId, diagram_id: saved.id, version: 1 })).content[0].text);
    expect(read.lanes.map((l: { name: string }) => l.name)).toEqual(['User', 'App', 'Server']);
    const bad = await tools.get('save_process_diagram')!({ project_id: projectId, ticket_id: ticketId, title: 'x', lanes: [{ id: 'a', name: 'A' }], nodes: [], flows: [] });
    expect(bad.isError).toBe(true);
    const batch = service.executeBatch([
      { op: 'save_process_diagram', args: { project_id: projectId, ticket_id: ticketId, title: 'Improve description', ...createFolder() } },
      { op: 'list_process_diagrams', args: { project_id: projectId, ticket_id: ticketId } },
    ], agentId);
    expect(batch.map((r) => r.ok)).toEqual([true, true]);
    expect((batch[1].result as unknown[]).length).toBe(2);
    expect(MCP_INSTRUCTIONS).toContain('save_process_diagram');
    const removed = JSON.parse((await tools.get('delete_process_diagram')!({ project_id: projectId, ticket_id: ticketId, diagram_id: saved.id })).content[0].text);
    expect(removed).toEqual({ deleted: true, id: saved.id, versions: 1 });
    expect(service.processDiagrams.list(projectId, ticketId).map((d) => d.id)).not.toContain(saved.id);
    expect((await tools.get('delete_process_diagram')!({ project_id: projectId, ticket_id: ticketId, diagram_id: saved.id })).isError).toBe(true);
  });
});
