import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createResolvers } from '../../src/graphql/resolvers.js';

describe('Global notifications', () => {
  let db: AgentboardDB;
  let service: BoardService;
  beforeEach(() => { db = new AgentboardDB(':memory:'); service = new BoardService(db); });
  afterEach(() => { db.close(); });

  it('persists each successful mutation once and publishes it globally with stable names', async () => {
    const resolvers = createResolvers(db) as { Subscription: { boardEventAdded: { subscribe: () => AsyncIterableIterator<Record<string, unknown>> } } };
    const iterator = resolvers.Subscription.boardEventAdded.subscribe();
    const agent = service.createAgent('Worker');
    const project = service.createProject('First project');
    const other = service.createProject('Other project');
    const ticket = service.createTicket(project.id, 'A ticket', undefined, undefined, agent.id);
    service.updateTicket(project.id, ticket.id, { title: 'Renamed ticket' }, agent.id);
    service.moveTicket(project.id, ticket.id, 'done', agent.id);
    service.createComment(project.id, ticket.id, agent.id, 'Finished');
    service.assignTicket(project.id, ticket.id, agent.id, agent.id);
    service.unassignTicket(project.id, ticket.id, agent.id);
    service.openTicket(project.id, ticket.id);
    service.closeTicket(project.id, ticket.id);
    service.moveTicketToProject(project.id, ticket.id, other.id, undefined, agent.id);
    service.deleteTicket(other.id, ticket.id, agent.id);
    service.updateProject(project.id, { name: 'New name' }, agent.id);
    service.deleteProject(project.id, agent.id);
    service.deleteAgent(agent.id);
    const events = db.getBoardEvents();
    expect(events).toHaveLength(16);
    expect(events.map(event => event.kind).reverse()).toEqual([
      'agent_created', 'project_created', 'project_created', 'ticket_created', 'ticket_updated',
      'ticket_moved', 'comment_added', 'ticket_assigned', 'ticket_unassigned', 'ticket_moved',
      'ticket_moved', 'ticket_transferred', 'ticket_deleted', 'project_updated', 'project_deleted', 'agent_deleted',
    ]);
    expect(events.find(event => event.kind === 'comment_added')).toMatchObject({
      projectName: 'First project', ticketTitle: 'Renamed ticket', actorName: 'Worker', ticketId: ticket.id,
    });
    expect(events.find(event => event.kind === 'ticket_moved')).toMatchObject({ detail: 'Done' });
    for (const expected of [...events].reverse()) expect((await iterator.next()).value).toEqual({ boardEventAdded: expected });
    await iterator.return?.();
  });

  it('keeps events useful when legacy column labels or optional display metadata are unavailable', () => {
    const project = service.createProject('Legacy project');
    const agent = service.createAgent('Worker');
    const ticket = service.createTicket(project.id, 'Legacy ticket');
    db.updateTicket(project.id, ticket.id, { column: 'retired_column' }, null);
    service.createComment(project.id, ticket.id, agent.id, 'Legacy column');
    expect(db.getBoardEvents()[0]).toMatchObject({ detail: 'retired_column', ticketTitle: 'Legacy ticket' });
    vi.spyOn(db, 'getProject').mockReturnValue(undefined);
    vi.spyOn(db, 'getAgentById').mockReturnValue(undefined);
    service.createComment(project.id, ticket.id, agent.id, 'Metadata unavailable');
    expect(db.getBoardEvents()[0]).toMatchObject({
      kind: 'comment_added', ticketId: ticket.id, projectId: null, actorName: '', detail: 'retired_column',
    });
  });

  it('does not notify reads or rejected writes; supports descending cursor pagination', () => {
    const project = service.createProject('Project');
    const initial = db.getBoardEvents();
    service.getProject(project.id);
    expect(() => service.createTicket(project.id, '')).toThrow();
    expect(db.getBoardEvents()).toEqual(initial);
    for (let n = 0; n < 105; n++) service.createTicket(project.id, `Ticket ${n}`);
    const first = db.getBoardEvents();
    const second = db.getBoardEvents(first.at(-1)!.id);
    expect(first).toHaveLength(100);
    expect(second).toHaveLength(6);
    expect(new Set([...first, ...second].map(event => event.id)).size).toBe(106);
  });
});
