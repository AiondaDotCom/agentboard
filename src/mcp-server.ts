// ---------------------------------------------------------------------------
// Agentboard MCP – Tool registration
//
// Exports registerMcpTools() for embedding in the HTTP server (same process).
// Also works as standalone stdio entry point via: npx tsx src/mcp-server.ts
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BoardService } from './services/board.service.js';

// ---------------------------------------------------------------------------
// Tool registration (shared between embedded + standalone)
// ---------------------------------------------------------------------------

export function registerMcpTools(
  mcp: McpServer,
  service: BoardService,
  agentId: string,
  agentName: string,
): void {
  // Helpers
  function ok(data: unknown) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  }
  function err(message: string) {
    return { content: [{ type: 'text' as const, text: message }], isError: true as const };
  }
  function wrap<T>(fn: () => T) {
    try { return ok(fn()); }
    catch (e) { return err(e instanceof Error ? e.message : 'Failed'); }
  }

  // --- Projects ---
  mcp.tool('list_projects', 'List all projects on the board', {},
    async () => ok(service.getAllProjects(agentId)));

  mcp.tool('get_project', 'Get details of a specific project, including its board column configuration (columns array; first column = where new tickets land, last column = finished/done)',
    { project_id: z.string().describe('Project ID') },
    async ({ project_id }) => wrap(() => service.getProject(project_id, agentId)));

  const columnsParam = z.array(z.object({
    id: z.string().describe('Column id slug (lowercase, e.g. "in_progress")'),
    title: z.string().describe('Display name (e.g. "In Progress")'),
  })).min(2).max(20).optional().describe('Board columns in order. Convention: FIRST column is where new tickets land, LAST column counts as finished (releases group claims, satisfies dependencies). Default: backlog, blocked, in_progress, rework, in_review, done.');

  mcp.tool('create_project', 'Create a new project (admin). Board columns are configurable per project via "columns".',
    {
      name: z.string().describe('Project name'),
      description: z.string().optional().describe('Project description'),
      columns: columnsParam,
    },
    async ({ name, description, columns }) => wrap(() => service.createProject(name, description, agentId, columns)));

  mcp.tool('update_project', 'Update a project: rename, change description, or reconfigure the board columns. Columns that still contain tickets cannot be removed (move the tickets first).',
    {
      project_id: z.string().describe('Project ID'),
      name: z.string().optional().describe('New project name'),
      description: z.string().optional().describe('New project description'),
      columns: columnsParam,
    },
    async ({ project_id, name, description, columns }) => {
      const updates: { name?: string; description?: string; columns?: unknown } = {};
      if (name !== undefined) updates.name = name;
      if (description !== undefined) updates.description = description;
      if (columns !== undefined) updates.columns = columns;
      return wrap(() => service.updateProject(project_id, updates, agentId));
    });

  mcp.tool('delete_project', 'Delete a project (admin)',
    { project_id: z.string().describe('Project ID') },
    async ({ project_id }) => wrap(() => { service.deleteProject(project_id, agentId); return { deleted: true }; }));

  // --- Tickets ---
  mcp.tool('list_tickets', 'List all tickets in a project (returns summary without description – use get_ticket for full details)',
    {
      project_id: z.string().describe('Project ID'),
      column: z.string().optional().describe('Filter by column id – must be one of the project\'s configured columns (see get_project)'),
      page: z.number().int().min(1).optional().describe('Page number (default: 1)'),
      per_page: z.number().int().min(1).max(100).optional().describe('Items per page (default: 50, max: 100)'),
    },
    async ({ project_id, column, page, per_page }) => wrap(() => {
      const result = service.getTicketsByProject(project_id, agentId, { column, page, per_page });
      return {
        ...result,
        data: result.data.map(({ description, ...rest }) => rest),
      };
    }));

  mcp.tool('get_ticket', 'Get details of a specific ticket including description',
    { project_id: z.string().describe('Project ID'), ticket_id: z.string().describe('Ticket ID') },
    async ({ project_id, ticket_id }) =>
      wrap(() => service.getTicket(project_id, ticket_id, agentId)));

  mcp.tool('create_ticket', 'Create a new ticket in a project. Descriptions support Markdown formatting (bold, lists, headings, code blocks, etc.) – please use Markdown for better readability. Use "group" to bundle related tickets that must be handled by a single agent (assigning one ticket of a group claims the whole group). Use "depends_on" for tickets that must be finished first – a ticket with unfinished dependencies can only stay in the first column.', {
    project_id: z.string().describe('Project ID'),
    title: z.string().describe('Ticket title'),
    description: z.string().optional().describe('Ticket description (supports Markdown: **bold**, *italic*, - lists, ## headings, `code`, etc.)'),
    column: z.string().optional().describe('Initial column id – must be one of the project\'s configured columns, see get_project (default: the project\'s first column)'),
    group: z.string().optional().describe('Group name for related tickets that only one agent should work on (e.g. tickets touching the same files). Assigning any ticket of a group claims the whole group for that agent.'),
    blocked_reason: z.string().optional().describe('Why this ticket cannot proceed (external dependency, missing credentials, etc.). Shown prominently on the board.'),
    depends_on: z.array(z.string()).optional().describe('Ticket ids this ticket depends on. While any of them is not in the last (done) column, this ticket cannot be moved out of the first column.'),
  }, async ({ project_id, title, description, column, group, blocked_reason, depends_on }) =>
    wrap(() => service.createTicket(project_id, title, description, column, agentId, group, blocked_reason, depends_on)));

  mcp.tool('update_ticket', 'Update a ticket (title, description, column, group, blocked_reason, or depends_on). Descriptions support Markdown formatting. Moving to a column other than the first is refused while the ticket has unfinished dependencies – the error explains which tickets must be finished first.', {
    project_id: z.string().describe('Project ID'),
    ticket_id: z.string().describe('Ticket ID'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description (supports Markdown: **bold**, *italic*, - lists, ## headings, `code`, etc.)'),
    column: z.string().optional().describe('New column id – must be one of the project\'s configured columns (see get_project)'),
    group: z.string().optional().describe('Group name for related tickets that only one agent should work on. Pass an empty string to remove the ticket from its group.'),
    blocked_reason: z.string().optional().describe('Why the ticket is blocked (external dependency). Pass an empty string to clear it.'),
    depends_on: z.array(z.string()).optional().describe('Replaces the full dependency list (ticket ids that must be done first). Pass an empty array to clear all dependencies.'),
  }, async ({ project_id, ticket_id, title, description, column, group, blocked_reason, depends_on }) => {
    const updates: {
      title?: string; description?: string; column?: string; group?: string | null;
      blockedReason?: string | null; dependsOn?: unknown;
    } = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (column !== undefined) updates.column = column;
    if (group !== undefined) updates.group = group;
    if (blocked_reason !== undefined) updates.blockedReason = blocked_reason;
    if (depends_on !== undefined) updates.dependsOn = depends_on;
    return wrap(() => service.updateTicket(project_id, ticket_id, updates, agentId));
  });

  mcp.tool('move_ticket', 'Move a ticket to a different column. Refused (with an explanation of which tickets must be finished first) while the ticket has unfinished dependencies and the target is not the first column.', {
    project_id: z.string().describe('Project ID'),
    ticket_id: z.string().describe('Ticket ID'),
    column: z.string().describe('Target column id – must be one of the project\'s configured columns (see get_project)'),
  }, async ({ project_id, ticket_id, column }) =>
    wrap(() => service.moveTicket(project_id, ticket_id, column, agentId)));

  mcp.tool('assign_ticket', 'Assign a ticket to an agent, or unassign it. Note: if the ticket belongs to a group, assigning it claims the WHOLE group for that agent – other agents cannot take tickets of a claimed group until it is released (all tickets done or unassigned).', {
    project_id: z.string().describe('Project ID'),
    ticket_id: z.string().describe('Ticket ID'),
    assignee_id: z.string().optional().describe('Agent ID to assign (omit or empty to unassign)'),
  }, async ({ project_id, ticket_id, assignee_id }) => {
    if (assignee_id) {
      return wrap(() => service.assignTicket(project_id, ticket_id, assignee_id, agentId));
    }
    return wrap(() => service.unassignTicket(project_id, ticket_id, agentId));
  });

  mcp.tool('delete_ticket', 'Delete a ticket',
    { project_id: z.string().describe('Project ID'), ticket_id: z.string().describe('Ticket ID') },
    async ({ project_id, ticket_id }) => wrap(() => { service.deleteTicket(project_id, ticket_id, agentId); return { deleted: true }; }));

  // --- Comments ---
  mcp.tool('add_comment', 'Add a comment to a ticket. Comments support Markdown formatting for better readability.', {
    project_id: z.string().describe('Project ID'),
    ticket_id: z.string().describe('Ticket ID'),
    body: z.string().describe('Comment text (supports Markdown: **bold**, *italic*, - lists, `code`, etc.)'),
  }, async ({ project_id, ticket_id, body }) =>
    wrap(() => service.createComment(project_id, ticket_id, agentId, body)));

  mcp.tool('get_comments', 'Get all comments on a ticket',
    { project_id: z.string().describe('Project ID'), ticket_id: z.string().describe('Ticket ID') },
    async ({ project_id, ticket_id }) =>
      wrap(() => service.getCommentsByTicket(project_id, ticket_id, agentId)));

  // --- History ---
  mcp.tool('get_ticket_history', 'Get the full revision history of a ticket (who changed what, when)',
    { project_id: z.string().describe('Project ID'), ticket_id: z.string().describe('Ticket ID') },
    async ({ project_id, ticket_id }) =>
      wrap(() => service.getRevisionsByTicket(project_id, ticket_id, agentId)));

  // --- Agents ---
  mcp.tool('list_agents', 'List all registered agents', {},
    async () => ok(service.getAllAgents(agentId)));

  mcp.tool('whoami', 'Show which agent identity this MCP server is using', {},
    async () => ok({ agentId, agentName }));
}

// ---------------------------------------------------------------------------
// Ensure agent exists (used by both embedded + standalone)
// ---------------------------------------------------------------------------

export function getOrCreateMcpAgent(service: BoardService, name: string): string {
  const all = service.getAllAgents();
  const existing = all.find((a) => a.name === name);
  if (existing) return existing.id;
  return service.createAgent(name).id;
}

// ---------------------------------------------------------------------------
// Standalone stdio entry point (for use WITHOUT the HTTP server)
// ---------------------------------------------------------------------------

const isMain = process.argv[1]?.endsWith('mcp-server.ts') || process.argv[1]?.endsWith('mcp-server.js');

/* v8 ignore start -- process entry point, only runs via `npx tsx src/mcp-server.ts` */
if (isMain) {
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { AgentboardDB } = await import('./db/database.js');
  const { BoardService } = await import('./services/board.service.js');

  const DB_PATH = process.env['AGENTBOARD_DB'] || 'agentboard.db';
  const AGENT_NAME = process.env['AGENTBOARD_AGENT'] || 'mcp-agent';

  const db = new AgentboardDB(DB_PATH);
  const svc = new BoardService(db);
  const aid = getOrCreateMcpAgent(svc, AGENT_NAME);

  const mcp = new McpServer({ name: 'agentboard', version: '1.0.0' });
  registerMcpTools(mcp, svc, aid, AGENT_NAME);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}
/* v8 ignore stop */
