import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { registerMcpTools, getOrCreateMcpAgent } from '../../src/mcp-server.js';

// The MCP SDK server is exercised end-to-end via the running HTTP server;
// here we register the tools against a stub to unit-test every handler.

type ToolResult = { content: [{ type: 'text'; text: string }]; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function collectTools(service: BoardService, agentId: string, agentName: string): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const fakeMcp = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  } as unknown as McpServer;
  registerMcpTools(fakeMcp, service, agentId, agentName);
  return tools;
}

function parse(result: ToolResult): any {
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

describe('MCP tools', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let tools: Map<string, ToolHandler>;
  let agentId: string;
  let projectId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    agentId = db.createAgent('mcp-bot').id;
    projectId = service.createProject('proj').id;
    tools = collectTools(service, agentId, 'mcp-bot');
  });

  afterEach(() => {
    db.close();
  });

  it('registers all 17 tools', () => {
    expect([...tools.keys()].sort()).toEqual([
      'add_comment', 'assign_ticket', 'create_project', 'create_ticket',
      'delete_project', 'delete_ticket', 'get_comments', 'get_project',
      'get_ticket', 'get_ticket_history', 'list_agents', 'list_projects',
      'list_tickets', 'move_ticket', 'update_project', 'update_ticket', 'whoami',
    ]);
  });

  it('list_projects / get_project / create_project / update_project / delete_project', async () => {
    const created = parse(await tools.get('create_project')!({ name: 'via-mcp', description: 'd' }));
    expect(created.columns).toHaveLength(6);

    const custom = parse(await tools.get('create_project')!({
      name: 'custom', columns: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }],
    }));
    expect(custom.columns.map((c: any) => c.id)).toEqual(['a', 'b']);

    const list = parse(await tools.get('list_projects')!({}));
    expect(list.map((p: any) => p.name)).toContain('via-mcp');

    const got = parse(await tools.get('get_project')!({ project_id: created.id }));
    expect(got.columns).toHaveLength(6);

    const updated = parse(await tools.get('update_project')!({
      project_id: created.id,
      name: 'renamed',
      description: 'nd',
      columns: [{ id: 'x', title: 'X' }, { id: 'y', title: 'Y' }],
    }));
    expect(updated.name).toBe('renamed');
    expect(updated.columns.map((c: any) => c.id)).toEqual(['x', 'y']);

    const deleted = parse(await tools.get('delete_project')!({ project_id: created.id }));
    expect(deleted).toEqual({ deleted: true });
  });

  it('create/get/update/move/list/delete ticket incl. blocked_reason and depends_on', async () => {
    const a = parse(await tools.get('create_ticket')!({ project_id: projectId, title: 'A' }));
    expect(a.column).toBe('backlog');

    const b = parse(await tools.get('create_ticket')!({
      project_id: projectId, title: 'B', description: 'desc', column: 'backlog',
      group: 'g1', blocked_reason: 'waiting', depends_on: [a.id],
    }));
    expect(b.blockedReason).toBe('waiting');
    expect(b.dependsOn).toEqual([a.id]);

    // Dependency gate refuses the move and explains why
    const refused = await tools.get('move_ticket')!({ project_id: projectId, ticket_id: b.id, column: 'in_progress' });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain('depends on');
    expect(refused.content[0].text).toContain('A');

    // Finish the dependency → move works
    parse(await tools.get('move_ticket')!({ project_id: projectId, ticket_id: a.id, column: 'done' }));
    const moved = parse(await tools.get('move_ticket')!({ project_id: projectId, ticket_id: b.id, column: 'in_progress' }));
    expect(moved.column).toBe('in_progress');

    const updated = parse(await tools.get('update_ticket')!({
      project_id: projectId, ticket_id: b.id,
      title: 'B2', description: 'd2', column: 'in_review', group: '', blocked_reason: '', depends_on: [],
    }));
    expect(updated.title).toBe('B2');
    expect(updated.group).toBeNull();
    expect(updated.blockedReason).toBeNull();
    expect(updated.dependsOn).toEqual([]);

    const listed = parse(await tools.get('list_tickets')!({ project_id: projectId, column: 'in_review', page: 1, per_page: 10 }));
    expect(listed.total).toBe(1);
    expect(listed.data[0].description).toBeUndefined(); // summary without description

    const full = parse(await tools.get('get_ticket')!({ project_id: projectId, ticket_id: b.id }));
    expect(full.description).toBe('d2');

    const deleted = parse(await tools.get('delete_ticket')!({ project_id: projectId, ticket_id: a.id }));
    expect(deleted).toEqual({ deleted: true });
  });

  it('assign_ticket assigns and unassigns', async () => {
    const other = db.createAgent('other').id;
    const t = parse(await tools.get('create_ticket')!({ project_id: projectId, title: 'T' }));

    const assigned = parse(await tools.get('assign_ticket')!({ project_id: projectId, ticket_id: t.id, assignee_id: other }));
    expect(assigned.assigneeId).toBe(other);

    const unassigned = parse(await tools.get('assign_ticket')!({ project_id: projectId, ticket_id: t.id }));
    expect(unassigned.assigneeId).toBeNull();
  });

  it('add_comment / get_comments / get_ticket_history', async () => {
    const t = parse(await tools.get('create_ticket')!({ project_id: projectId, title: 'T' }));

    const comment = parse(await tools.get('add_comment')!({ project_id: projectId, ticket_id: t.id, body: 'hello' }));
    expect(comment.body).toBe('hello');

    const comments = parse(await tools.get('get_comments')!({ project_id: projectId, ticket_id: t.id }));
    expect(comments).toHaveLength(1);

    parse(await tools.get('update_ticket')!({ project_id: projectId, ticket_id: t.id, title: 'T2' }));
    const history = parse(await tools.get('get_ticket_history')!({ project_id: projectId, ticket_id: t.id }));
    expect(history.some((r: any) => r.field === 'title')).toBe(true);
  });

  it('list_agents / whoami', async () => {
    const agents = parse(await tools.get('list_agents')!({}));
    expect(agents.some((a: any) => a.name === 'mcp-bot')).toBe(true);

    const who = parse(await tools.get('whoami')!({}));
    expect(who).toEqual({ agentId, agentName: 'mcp-bot' });
  });

  it('returns isError with the service message on failure', async () => {
    const res = await tools.get('get_project')!({ project_id: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Project not found');
  });

  it('returns a generic message for non-Error throwables', async () => {
    const broken = {
      getProject: () => { throw 'boom'; }, // eslint-disable-line no-throw-literal
    } as unknown as BoardService;
    const brokenTools = collectTools(broken, agentId, 'mcp-bot');
    const res = await brokenTools.get('get_project')!({ project_id: 'x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Failed');
  });

  it('getOrCreateMcpAgent reuses an existing agent and creates a new one', () => {
    const existing = getOrCreateMcpAgent(service, 'mcp-bot');
    expect(existing).toBe(agentId);

    const fresh = getOrCreateMcpAgent(service, 'brand-new');
    expect(fresh).not.toBe(agentId);
    expect(service.getAllAgents().some((a) => a.name === 'brand-new')).toBe(true);
  });
});
