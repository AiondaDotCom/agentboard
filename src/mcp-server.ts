// ---------------------------------------------------------------------------
// Agentboard MCP – Tool registration
//
// Exports registerMcpTools() for embedding in the HTTP server (same process).
// Also works as standalone stdio entry point via: npx tsx src/mcp-server.ts
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { VISUAL_REVIEW_INSTRUCTIONS } from './services/html-drafts.js';
import { PROCESS_DIAGRAM_INSTRUCTIONS, NODE_TYPES, LIMITS } from './services/process-diagrams.js';
import type { BoardService } from './services/board.service.js';
import { BATCH_OPS, MAX_BATCH_OPS } from './types.js';
import type { Ticket } from './types.js';

// ---------------------------------------------------------------------------
// Server instructions – shown to the AI client on connect.
// Actively advertises the batch tool: one round-trip instead of N is both
// faster and cheaper (tokens) for the calling model.
// ---------------------------------------------------------------------------

export const MCP_INSTRUCTIONS =
  'Agentboard – realtime Kanban board for AI agents. ' +
  'PERFORMANCE RULE: Whenever you are about to make MORE THAN ONE tool call ' +
  '(e.g. creating several tickets, updating/moving multiple tickets, or any mix of operations), ' +
  'ALWAYS use the `batch` tool instead of individual calls. One batch call executes many ' +
  'operations in a single round-trip – dramatically faster and cheaper than sequential tool calls. ' +
  'Use individual tools only for single, stand-alone operations. ' + VISUAL_REVIEW_INSTRUCTIONS + ' ' + PROCESS_DIAGRAM_INSTRUCTIONS;

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

  // --- Batch (registered first so clients see it prominently) ---
  mcp.tool('batch', `PREFERRED whenever you have more than one operation to perform: executes up to ${MAX_BATCH_OPS} board operations in ONE call (one round-trip instead of N – much faster and saves tokens). Each entry is {"op": <tool name>, "args": {...}} with exactly the same semantics and argument names as the tool of the same name (supported: ${BATCH_OPS.join(', ')}). Operations run sequentially in array order and are reported individually as {op, ok, result|error} – a failed operation does NOT stop or roll back the others, so always check each result. Note: ids of tickets created earlier in the same batch are not referenceable by later operations.`, {
    operations: z.array(z.object({
      op: z.enum(BATCH_OPS).describe('Operation to execute – same name, semantics and args as the corresponding individual tool'),
      args: z.record(z.string(), z.unknown()).optional().describe('Arguments for the operation, exactly as for the tool of the same name (e.g. project_id, ticket_id, title, column, ...)'),
    })).min(1).max(MAX_BATCH_OPS).describe('Operations to execute sequentially in array order'),
  }, async ({ operations }) => wrap(() => {
    const results = service.executeBatch(operations, agentId);
    // Same token-saving trim as the standalone list_tickets tool
    return results.map((r) => {
      if (r.op !== 'list_tickets' || !r.ok) return r;
      const page = r.result as { data: Ticket[] };
      return { ...r, result: { ...page, data: page.data.map(({ description, ...rest }) => rest) } };
    });
  }));

  // HTML source is stored separately from Markdown, with version-bound visual evidence.
  const draftTarget = { project_id: z.string(), ticket_id: z.string() };
  const draftVersion = { ...draftTarget, draft_id: z.string(), version: z.number().int().positive() };
  mcp.registerTool('save_html_draft', { description: 'Create a static HTML/CSS mockup at a ticket or save a new immutable version. Use draft_id plus expected_version when updating. Multiple named drafts represent different screens. Returns preview URL, version and pending review status. ' + VISUAL_REVIEW_INSTRUCTIONS, inputSchema:
    { ...draftTarget, title: z.string(), html: z.string().max(524288), draft_id: z.string().optional(), expected_version: z.number().int().positive().optional() } },
    a => wrap(() => service.htmlDrafts.save(a.project_id, a.ticket_id, a.title, a.html, agentId, a.draft_id, a.expected_version)));
  mcp.registerTool('list_html_drafts', { description: 'List all HTML draft versions at a ticket, with screenshots and review status (without HTML source). ' + VISUAL_REVIEW_INSTRUCTIONS, inputSchema:
    draftTarget }, a => wrap(() => service.htmlDrafts.list(a.project_id, a.ticket_id)));
  mcp.registerTool('get_html_draft', { description: 'Read an exact HTML draft version and its preview URL, source and evidence. ' + VISUAL_REVIEW_INSTRUCTIONS, inputSchema:
    draftVersion }, a => wrap(() => service.htmlDrafts.get(a.project_id, a.ticket_id, a.draft_id, a.version)));
  mcp.registerTool('add_draft_screenshot', { description: 'Attach an actual browser PNG screenshot to the exact draft version inspected. png_base64 is raw base64 (no data URL); width/height are browser viewport CSS pixels. Never upload fabricated evidence. Uploading alone does not mark a draft reviewed.', inputSchema:
    { ...draftVersion, png_base64: z.string().max(8388608), width: z.number().int(), height: z.number().int(), theme: z.enum(['light','dark']) } },
    a => wrap(() => service.htmlDrafts.screenshot(a.project_id, a.ticket_id, a.draft_id, a.version, a, agentId)));
  mcp.registerTool('review_html_draft', { description: 'Record findings only AFTER actually viewing the attached screenshots. Passing requires mobile and desktop in both light and dark mode. No browser access: leave pending. This is AI visual review, NEVER human approval. ' + VISUAL_REVIEW_INSTRUCTIONS, inputSchema:
    { ...draftVersion, status: z.enum(['passed','needs_changes']), findings: z.string(), screenshot_ids: z.array(z.string()).min(1), visually_inspected: z.literal(true) } },
    a => wrap(() => service.htmlDrafts.review(a.project_id, a.ticket_id, a.draft_id, a.version, a.status, a.findings, a.screenshot_ids, a.visually_inspected, agentId)));

  // Simplified BPMN of the business process a ticket describes; the board lays it out and draws it.
  const lane = z.object({ id: z.string().describe('Short id, letters/digits/_/-'), name: z.string().describe('Actor, e.g. "User", "App", "Server"') });
  const node = z.object({ id: z.string(), type: z.enum(NODE_TYPES).describe('start/end event, task, or decision (exclusive gateway)'), label: z.string().max(LIMITS.label), lane: z.string().describe('Lane id') });
  const flow = z.object({ from: z.string(), to: z.string(), label: z.string().optional().describe('Required in practice for flows leaving a decision, e.g. "yes"/"no"') });
  mcp.registerTool('save_process_diagram', { description: 'Attach a simplified BPMN diagram of the business process this ticket describes, or save a new immutable version (diagram_id + expected_version). The board validates (one start, one end, every node reachable, decisions with ≥2 labelled exits) and draws it with swimlanes. Returns the diagram id and version the user can refer to. ' + PROCESS_DIAGRAM_INSTRUCTIONS, inputSchema:
    { ...draftTarget, title: z.string(), lanes: z.array(lane).min(1).max(LIMITS.lanes), nodes: z.array(node).min(2).max(LIMITS.nodes), flows: z.array(flow).min(1).max(LIMITS.flows), diagram_id: z.string().optional(), expected_version: z.number().int().positive().optional() } },
    a => wrap(() => service.processDiagrams.save(a.project_id, a.ticket_id, a.title, a, agentId, a.diagram_id, a.expected_version)));
  mcp.registerTool('list_process_diagrams', { description: 'List all process diagram versions at a ticket (newest first), including lanes, nodes and flows.', inputSchema:
    draftTarget }, a => wrap(() => service.processDiagrams.list(a.project_id, a.ticket_id)));
  mcp.registerTool('delete_process_diagram', { description: 'Remove a process diagram and all its versions from a ticket, e.g. when it does not describe the ticket\'s business process.', inputSchema:
    { ...draftTarget, diagram_id: z.string() } },
    a => wrap(() => service.processDiagrams.remove(a.project_id, a.ticket_id, a.diagram_id, agentId)));
  mcp.registerTool('get_process_diagram', { description: 'Read one exact process diagram version.', inputSchema:
    { ...draftTarget, diagram_id: z.string(), version: z.number().int().positive() } },
    a => wrap(() => service.processDiagrams.get(a.project_id, a.ticket_id, a.diagram_id, a.version)));

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
  mcp.tool('list_tickets', 'List all tickets in a project (returns summary without description – use get_ticket for full details). Use "work_type" to pull only the tickets that match a worker: mechanical work for a cheap deterministic model, judgment work for a reasoning model.',
    {
      project_id: z.string().describe('Project ID'),
      column: z.string().optional().describe('Filter by column id – must be one of the project\'s configured columns (see get_project)'),
      work_type: z.enum(['mechanical', 'judgment', 'none']).optional().describe('Filter by kind of work: "mechanical" (solution shape is known), "judgment" (design / root-cause / trade-offs), "none" (still unclassified)'),
      page: z.number().int().min(1).optional().describe('Page number (default: 1)'),
      per_page: z.number().int().min(1).max(100).optional().describe('Items per page (default: 50, max: 100)'),
    },
    async ({ project_id, column, work_type, page, per_page }) => wrap(() => {
      const result = service.getTicketsByProject(project_id, agentId, { column, work_type, page, per_page });
      return {
        ...result,
        data: result.data.map(({ description, ...rest }) => rest),
      };
    }));

  mcp.tool('get_ticket', 'Get details of a specific ticket including description',
    { project_id: z.string().describe('Project ID'), ticket_id: z.string().describe('Ticket ID') },
    async ({ project_id, ticket_id }) =>
      wrap(() => service.getTicket(project_id, ticket_id, agentId)));

  mcp.tool('create_ticket', 'Create a new ticket in a project. To create SEVERAL tickets, use the `batch` tool instead (much faster). Descriptions support Markdown formatting (bold, lists, headings, code blocks, etc.) – please use Markdown for better readability. Use "group" to bundle related tickets that must be handled by a single agent (assigning one ticket of a group claims the whole group). Use "depends_on" for tickets that must be finished first – a ticket with unfinished dependencies can only stay in the first column.', {
    project_id: z.string().describe('Project ID'),
    title: z.string().describe('Ticket title'),
    description: z.string().optional().describe('Ticket description (supports Markdown: **bold**, *italic*, - lists, ## headings, `code`, etc.)'),
    column: z.string().optional().describe('Initial column id – must be one of the project\'s configured columns, see get_project (default: the project\'s first column)'),
    group: z.string().optional().describe('Group name for related tickets that only one agent should work on (e.g. tickets touching the same files). Assigning any ticket of a group claims the whole group for that agent.'),
    blocked_reason: z.string().optional().describe('Why this ticket cannot proceed (external dependency, missing credentials, etc.). Shown prominently on the board.'),
    depends_on: z.array(z.string()).optional().describe('Ticket ids this ticket depends on. While any of them is not in the last (done) column, this ticket cannot be moved out of the first column.'),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Ticket priority (default: medium). Shown as a colored badge on the board; tickets are ordered by priority within a column.'),
    work_type: z.enum(['mechanical', 'judgment']).optional().describe('What kind of work this is: "mechanical" = the shape of the solution is known and the diff is checkable against a hard done-criterion; "judgment" = design, root-cause analysis, weighing trade-offs. Decides which kind of worker can take the ticket – do NOT put model names here. Omit if you honestly cannot tell.'),
  }, async ({ project_id, title, description, column, group, blocked_reason, depends_on, priority, work_type }) =>
    wrap(() => service.createTicket(project_id, title, description, column, agentId, group, blocked_reason, depends_on, priority, work_type)));

  mcp.tool('update_ticket', 'Update a ticket (title, description, column, group, blocked_reason, depends_on, priority, or work_type). To update SEVERAL tickets, use the `batch` tool instead (much faster). Descriptions support Markdown formatting. Moving to a column other than the first is refused while the ticket has unfinished dependencies – the error explains which tickets must be finished first.', {
    project_id: z.string().describe('Project ID'),
    ticket_id: z.string().describe('Ticket ID'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New description (supports Markdown: **bold**, *italic*, - lists, ## headings, `code`, etc.)'),
    column: z.string().optional().describe('New column id – must be one of the project\'s configured columns (see get_project)'),
    group: z.string().optional().describe('Group name for related tickets that only one agent should work on. Pass an empty string to remove the ticket from its group.'),
    blocked_reason: z.string().optional().describe('Why the ticket is blocked (external dependency). Pass an empty string to clear it.'),
    depends_on: z.array(z.string()).optional().describe('Replaces the full dependency list (ticket ids that must be done first). Pass an empty array to clear all dependencies.'),
    priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('New ticket priority. Shown as a colored badge on the board; tickets are ordered by priority within a column.'),
    work_type: z.enum(['mechanical', 'judgment', '']).optional().describe('New kind of work: "mechanical" (solution shape is known) or "judgment" (design / root-cause / trade-offs). Pass an empty string to clear the classification.'),
  }, async ({ project_id, ticket_id, title, description, column, group, blocked_reason, depends_on, priority, work_type }) => {
    const updates: {
      title?: string; description?: string; column?: string; group?: string | null;
      blockedReason?: string | null; dependsOn?: unknown; priority?: unknown; workType?: unknown;
    } = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (column !== undefined) updates.column = column;
    if (group !== undefined) updates.group = group;
    if (blocked_reason !== undefined) updates.blockedReason = blocked_reason;
    if (depends_on !== undefined) updates.dependsOn = depends_on;
    if (priority !== undefined) updates.priority = priority;
    if (work_type !== undefined) updates.workType = work_type;
    return wrap(() => service.updateTicket(project_id, ticket_id, updates, agentId));
  });

  mcp.tool('move_ticket', 'Move a ticket to a different column. To move SEVERAL tickets, use the `batch` tool instead (much faster). Refused (with an explanation of which tickets must be finished first) while the ticket has unfinished dependencies and the target is not the first column.', {
    project_id: z.string().describe('Project ID'),
    ticket_id: z.string().describe('Ticket ID'),
    column: z.string().describe('Target column id – must be one of the project\'s configured columns (see get_project)'),
  }, async ({ project_id, ticket_id, column }) =>
    wrap(() => service.moveTicket(project_id, ticket_id, column, agentId)));

  mcp.tool('move_ticket_to_project', 'Move a ticket to a DIFFERENT project (it keeps its id, title, comments and history). Lands in the target project\'s first column unless "column" says otherwise. Dependencies never cross projects: the ticket\'s own dependencies are dropped, and the move is refused while other tickets still depend on it.', {
    project_id: z.string().describe('Current project ID of the ticket'),
    ticket_id: z.string().describe('Ticket ID'),
    target_project_id: z.string().describe('Project ID to move the ticket to'),
    column: z.string().optional().describe('Column id in the TARGET project (default: the target project\'s first column). Check get_project for the target\'s column configuration – column ids differ per project.'),
  }, async ({ project_id, ticket_id, target_project_id, column }) =>
    wrap(() => service.moveTicketToProject(project_id, ticket_id, target_project_id, column, agentId)));

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

  const mcp = new McpServer({ name: 'agentboard', version: '1.0.0' }, { instructions: MCP_INSTRUCTIONS });
  registerMcpTools(mcp, svc, aid, AGENT_NAME);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}
/* v8 ignore stop */
