import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createTicketRoutes, createHumanTicketRoutes } from '../../src/api/routes/tickets.js';

// ---------------------------------------------------------------------------
// Database-level revision tests
// ---------------------------------------------------------------------------

describe('Ticket Revisions (DB)', () => {
  let db: AgentboardDB;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('should log a revision entry', () => {
    const agent = db.createAgent('bot1');
    const project = db.createProject('proj');
    const ticket = db.createTicket(project.id, 'Task', '', 'backlog', agent.id);

    const rev = db.logRevision(ticket.id, agent.id, 'title', 'Task', 'Updated Task');
    expect(rev.id).toBeDefined();
    expect(rev.ticketId).toBe(ticket.id);
    expect(rev.agentId).toBe(agent.id);
    expect(rev.field).toBe('title');
    expect(rev.oldValue).toBe('Task');
    expect(rev.newValue).toBe('Updated Task');
    expect(rev.timestamp).toBeDefined();
  });

  it('should return revisions for a ticket in chronological order', () => {
    const agent = db.createAgent('bot1');
    const project = db.createProject('proj');
    const ticket = db.createTicket(project.id, 'Task', '', 'backlog', agent.id);

    db.logRevision(ticket.id, agent.id, 'column', 'backlog', 'ready');
    db.logRevision(ticket.id, agent.id, 'column', 'ready', 'in_progress');
    db.logRevision(ticket.id, agent.id, 'title', 'Task', 'Updated');

    const revs = db.getRevisionsByTicket(ticket.id);
    expect(revs).toHaveLength(3);
    expect(revs[0]!.field).toBe('column');
    expect(revs[0]!.oldValue).toBe('backlog');
    expect(revs[2]!.field).toBe('title');
  });

  it('should return empty array for ticket with no revisions', () => {
    const project = db.createProject('proj');
    const ticket = db.createTicket(project.id, 'Task');
    const revs = db.getRevisionsByTicket(ticket.id);
    expect(revs).toHaveLength(0);
  });

  it('should log revision with null agentId for human actions', () => {
    const project = db.createProject('proj');
    const ticket = db.createTicket(project.id, 'Task');

    const rev = db.logRevision(ticket.id, null, 'column', 'backlog', 'done');
    expect(rev.agentId).toBeNull();
  });

  it('should auto-log revisions when updateTicket changes title', () => {
    const agent = db.createAgent('bot1');
    const project = db.createProject('proj');
    const ticket = db.createTicket(project.id, 'Old Title', '', 'backlog', agent.id);

    db.updateTicket(project.id, ticket.id, { title: 'New Title' }, agent.id);

    const revs = db.getRevisionsByTicket(ticket.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.field).toBe('title');
    expect(revs[0]!.oldValue).toBe('Old Title');
    expect(revs[0]!.newValue).toBe('New Title');
    expect(revs[0]!.agentId).toBe(agent.id);
  });

  it('should auto-log revisions when updateTicket changes description', () => {
    const agent = db.createAgent('bot1');
    const project = db.createProject('proj');
    const ticket = db.createTicket(project.id, 'Task', 'Old desc', 'backlog', agent.id);

    db.updateTicket(project.id, ticket.id, { description: 'New desc' }, agent.id);

    const revs = db.getRevisionsByTicket(ticket.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.field).toBe('description');
    expect(revs[0]!.oldValue).toBe('Old desc');
    expect(revs[0]!.newValue).toBe('New desc');
  });

  it('should auto-log revisions when moveTicket changes column', () => {
    const agent = db.createAgent('bot1');
    const project = db.createProject('proj');
    const ticket = db.createTicket(project.id, 'Task', '', 'backlog', agent.id);

    db.moveTicket(project.id, ticket.id, 'in_progress', agent.id);

    const revs = db.getRevisionsByTicket(ticket.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.field).toBe('column');
    expect(revs[0]!.oldValue).toBe('backlog');
    expect(revs[0]!.newValue).toBe('in_progress');
  });

  it('should log multiple field changes in one updateTicket call', () => {
    const agent = db.createAgent('bot1');
    const project = db.createProject('proj');
    const ticket = db.createTicket(project.id, 'Old', 'Old desc', 'backlog', agent.id);

    db.updateTicket(project.id, ticket.id, {
      title: 'New',
      description: 'New desc',
      column: 'ready',
    }, agent.id);

    const revs = db.getRevisionsByTicket(ticket.id);
    expect(revs).toHaveLength(3);
    const fields = revs.map(r => r.field).sort();
    expect(fields).toEqual(['column', 'description', 'title']);
  });

  it('should NOT log revision when nothing actually changes', () => {
    const agent = db.createAgent('bot1');
    const project = db.createProject('proj');
    const ticket = db.createTicket(project.id, 'Task', 'desc', 'backlog', agent.id);

    // Update with same values
    db.updateTicket(project.id, ticket.id, { title: 'Task', description: 'desc' }, agent.id);

    const revs = db.getRevisionsByTicket(ticket.id);
    expect(revs).toHaveLength(0);
  });

  it('should log human move with null actorId', () => {
    const project = db.createProject('proj');
    const agent = db.createAgent('bot1');
    const ticket = db.createTicket(project.id, 'Task', '', 'backlog', agent.id);

    db.moveTicket(project.id, ticket.id, 'done', null);

    const revs = db.getRevisionsByTicket(ticket.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.agentId).toBeNull();
    expect(revs[0]!.field).toBe('column');
  });

  it('should cascade delete revisions when ticket is deleted', () => {
    const agent = db.createAgent('bot1');
    const project = db.createProject('proj');
    const ticket = db.createTicket(project.id, 'Task', '', 'backlog', agent.id);

    db.moveTicket(project.id, ticket.id, 'ready', agent.id);
    db.moveTicket(project.id, ticket.id, 'done', agent.id);
    expect(db.getRevisionsByTicket(ticket.id)).toHaveLength(2);

    db.deleteTicket(project.id, ticket.id);
    expect(db.getRevisionsByTicket(ticket.id)).toHaveLength(0);
  });

  it('should preserve revisions when agent is deleted (SET NULL)', () => {
    const agent = db.createAgent('bot1');
    const project = db.createProject('proj');
    const ticket = db.createTicket(project.id, 'Task', '', 'backlog', agent.id);

    db.moveTicket(project.id, ticket.id, 'ready', agent.id);
    db.deleteAgent(agent.id);

    const revs = db.getRevisionsByTicket(ticket.id);
    expect(revs).toHaveLength(1);
    expect(revs[0]!.agentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route-level revision tests
// ---------------------------------------------------------------------------

describe('Ticket Revision Routes', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let app: express.Express;
  let apiKey: string;
  let agentId: string;
  let projectId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    app = express();
    app.use(express.json());
    app.use('/api/projects/:id', createTicketRoutes(service));
    app.use('/api/projects/:id', createHumanTicketRoutes(service));

    const agent = db.createAgent('bot1');
    apiKey = agent.apiKey;
    agentId = agent.id;
    projectId = db.createProject('test-project').id;
  });

  afterEach(() => {
    db.close();
  });

  it('GET /revisions should return empty array for new ticket', async () => {
    const ticket = db.createTicket(projectId, 'Task', '', 'backlog', agentId);

    const res = await request(app)
      .get(`/api/projects/${projectId}/tickets/${ticket.id}/revisions`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it('GET /revisions should return 404 for nonexistent ticket', async () => {
    const res = await request(app)
      .get(`/api/projects/${projectId}/tickets/nonexistent/revisions`);
    expect(res.status).toBe(404);
  });

  it('should log revision when ticket is moved via PATCH', async () => {
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-Api-Key', apiKey)
      .send({ title: 'Task', column: 'backlog' });

    const ticketId = createRes.body.id;

    await request(app)
      .patch(`/api/projects/${projectId}/tickets/${ticketId}/move`)
      .set('X-Api-Key', apiKey)
      .send({ column: 'in_progress' });

    const res = await request(app)
      .get(`/api/projects/${projectId}/tickets/${ticketId}/revisions`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].field).toBe('column');
    expect(res.body[0].oldValue).toBe('backlog');
    expect(res.body[0].newValue).toBe('in_progress');
    expect(res.body[0].agentId).toBe(agentId);
  });

  it('should log revision when ticket is updated via PATCH', async () => {
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-Api-Key', apiKey)
      .send({ title: 'Old Title', description: 'Old' });

    const ticketId = createRes.body.id;

    await request(app)
      .patch(`/api/projects/${projectId}/tickets/${ticketId}`)
      .set('X-Api-Key', apiKey)
      .send({ title: 'New Title' });

    const res = await request(app)
      .get(`/api/projects/${projectId}/tickets/${ticketId}/revisions`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].field).toBe('title');
    expect(res.body[0].oldValue).toBe('Old Title');
    expect(res.body[0].newValue).toBe('New Title');
  });

  it('should log revision with null agentId when human closes ticket', async () => {
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-Api-Key', apiKey)
      .send({ title: 'Task', column: 'in_progress' });

    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/projects/${projectId}/tickets/${ticketId}/close`);

    const res = await request(app)
      .get(`/api/projects/${projectId}/tickets/${ticketId}/revisions`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].field).toBe('column');
    expect(res.body[0].oldValue).toBe('in_progress');
    expect(res.body[0].newValue).toBe('done');
    expect(res.body[0].agentId).toBeNull();
  });

  it('should log revision with null agentId when human reopens ticket', async () => {
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-Api-Key', apiKey)
      .send({ title: 'Task', column: 'done' });

    const ticketId = createRes.body.id;

    await request(app)
      .post(`/api/projects/${projectId}/tickets/${ticketId}/open`);

    const res = await request(app)
      .get(`/api/projects/${projectId}/tickets/${ticketId}/revisions`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].field).toBe('column');
    expect(res.body[0].oldValue).toBe('done');
    expect(res.body[0].newValue).toBe('backlog');
    expect(res.body[0].agentId).toBeNull();
  });

  it('should accumulate multiple revisions over ticket lifecycle', async () => {
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-Api-Key', apiKey)
      .send({ title: 'Feature', column: 'backlog' });

    const ticketId = createRes.body.id;

    // Move through columns
    await request(app)
      .patch(`/api/projects/${projectId}/tickets/${ticketId}/move`)
      .set('X-Api-Key', apiKey)
      .send({ column: 'ready' });

    await request(app)
      .patch(`/api/projects/${projectId}/tickets/${ticketId}/move`)
      .set('X-Api-Key', apiKey)
      .send({ column: 'in_progress' });

    // Update title
    await request(app)
      .patch(`/api/projects/${projectId}/tickets/${ticketId}`)
      .set('X-Api-Key', apiKey)
      .send({ title: 'Feature v2' });

    // Human closes
    await request(app)
      .post(`/api/projects/${projectId}/tickets/${ticketId}/close`);

    const res = await request(app)
      .get(`/api/projects/${projectId}/tickets/${ticketId}/revisions`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(4);

    // Verify chronological order
    expect(res.body[0].field).toBe('column');
    expect(res.body[0].newValue).toBe('ready');
    expect(res.body[1].field).toBe('column');
    expect(res.body[1].newValue).toBe('in_progress');
    expect(res.body[2].field).toBe('title');
    expect(res.body[2].newValue).toBe('Feature v2');
    expect(res.body[3].field).toBe('column');
    expect(res.body[3].newValue).toBe('done');
    expect(res.body[3].agentId).toBeNull();
  });
});
