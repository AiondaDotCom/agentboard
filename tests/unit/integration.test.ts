import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createAgentRoutes } from '../../src/api/routes/agents.js';
import { createProjectRoutes } from '../../src/api/routes/projects.js';
import { createTicketRoutes, createHumanTicketRoutes } from '../../src/api/routes/tickets.js';
import { createAuditRoutes } from '../../src/api/routes/audit.js';
import { createAuditMiddleware } from '../../src/api/middleware/audit.js';

describe('Integration: Full API Workflow', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let app: express.Express;
  let ADMIN_KEY: string;

  // Shared state across sequential tests
  let clawbotId: string;
  let clawbotKey: string;
  let codeWriterId: string;
  let codeWriterKey: string;
  let projectId: string;
  let ticketLoginId: string;
  let ticketAuthId: string;
  let ticketTestsId: string;

  beforeAll(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    ADMIN_KEY = service.getOrCreateAdminKey();
    app = express();
    app.use(express.json());
    app.use('/api', createAuditMiddleware(db));
    app.use('/api/agents', createAgentRoutes(service));
    app.use('/api/projects', createProjectRoutes(service));
    app.use('/api/projects/:id', createTicketRoutes(service));
    app.use('/api/projects/:id', createHumanTicketRoutes(service));
    app.use('/api/audit', createAuditRoutes(service));
    // Activity route
    app.get('/api/projects/:id/activity', (req, res): void => {
      const id = String(req.params['id'] ?? '');
      const project = db.getProject(id);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const activities = db.getActivitiesByProject(id);
      res.json(activities);
    });
  });

  afterAll(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // 1. Admin creates agents
  // -------------------------------------------------------------------------

  it('should create agent "clawbot" (POST /api/agents)', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ name: 'clawbot' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('clawbot');
    expect(res.body.id).toBeDefined();
    expect(res.body.apiKey).toBeDefined();
    expect(res.body.createdAt).toBeDefined();

    clawbotId = res.body.id;
    clawbotKey = res.body.apiKey;
  });

  it('should create agent "code-writer" (POST /api/agents)', async () => {
    const res = await request(app)
      .post('/api/agents')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ name: 'code-writer' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('code-writer');

    codeWriterId = res.body.id;
    codeWriterKey = res.body.apiKey;
  });

  // -------------------------------------------------------------------------
  // 2. List agents
  // -------------------------------------------------------------------------

  it('should list 2 agents with no apiKey exposed (GET /api/agents)', async () => {
    const res = await request(app).get('/api/agents');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].name).toBe('clawbot');
    expect(res.body[1].name).toBe('code-writer');
    // apiKey must NOT be exposed in public listing
    for (const agent of res.body) {
      expect(agent.apiKey).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // 3. Admin creates a project
  // -------------------------------------------------------------------------

  it('should create project "feature-auth" (POST /api/projects)', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ name: 'feature-auth', description: 'Authentication feature' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('feature-auth');
    expect(res.body.description).toBe('Authentication feature');
    expect(res.body.id).toBeDefined();

    projectId = res.body.id;
  });

  // -------------------------------------------------------------------------
  // 4. List projects
  // -------------------------------------------------------------------------

  it('should list 1 project (GET /api/projects)', async () => {
    const res = await request(app).get('/api/projects');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('feature-auth');
  });

  it('should get project by id (GET /api/projects/:id)', async () => {
    const res = await request(app).get(`/api/projects/${projectId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(projectId);
    expect(res.body.name).toBe('feature-auth');
    expect(res.body.description).toBe('Authentication feature');
  });

  // -------------------------------------------------------------------------
  // 5. Agents create tickets
  // -------------------------------------------------------------------------

  it('should create ticket "Design login form" in backlog (clawbot)', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-Api-Key', clawbotKey)
      .send({ title: 'Design login form', description: 'Create the login UI' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Design login form');
    expect(res.body.column).toBe('backlog');
    expect(res.body.projectId).toBe(projectId);
    expect(res.body.agentId).toBe(clawbotId);

    ticketLoginId = res.body.id;
  });

  it('should create ticket "Implement auth API" in backlog (clawbot)', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-Api-Key', clawbotKey)
      .send({ title: 'Implement auth API', description: 'Build REST endpoints for auth' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Implement auth API');
    expect(res.body.column).toBe('backlog');

    ticketAuthId = res.body.id;
  });

  it('should create ticket "Write tests" in ready (code-writer)', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-Api-Key', codeWriterKey)
      .send({ title: 'Write tests', description: 'Unit and integration tests', column: 'ready' });

    expect(res.status).toBe(201);
    expect(res.body.title).toBe('Write tests');
    expect(res.body.column).toBe('ready');
    expect(res.body.agentId).toBe(codeWriterId);

    ticketTestsId = res.body.id;
  });

  // -------------------------------------------------------------------------
  // 6. List tickets
  // -------------------------------------------------------------------------

  it('should list 3 tickets (GET /api/projects/:id/tickets)', async () => {
    const res = await request(app).get(`/api/projects/${projectId}/tickets`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    expect(res.body.total).toBe(3);
    expect(res.body.page).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 7. Get single ticket
  // -------------------------------------------------------------------------

  it('should get a single ticket by id (GET /api/projects/:id/tickets/:ticketId)', async () => {
    const res = await request(app).get(`/api/projects/${projectId}/tickets/${ticketLoginId}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ticketLoginId);
    expect(res.body.title).toBe('Design login form');
    expect(res.body.description).toBe('Create the login UI');
    expect(res.body.column).toBe('backlog');
    expect(res.body.projectId).toBe(projectId);
  });

  // -------------------------------------------------------------------------
  // 8. Agent moves a ticket
  // -------------------------------------------------------------------------

  it('should move "Design login form" to in_progress (PATCH .../move)', async () => {
    const res = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${ticketLoginId}/move`)
      .set('X-Api-Key', clawbotKey)
      .send({ column: 'in_progress' });

    expect(res.status).toBe(200);
    expect(res.body.column).toBe('in_progress');
    expect(res.body.id).toBe(ticketLoginId);
  });

  // -------------------------------------------------------------------------
  // 9. Agent updates a ticket
  // -------------------------------------------------------------------------

  it('should update title and description of "Write tests" (PATCH .../tickets/:ticketId)', async () => {
    const res = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${ticketTestsId}`)
      .set('X-Api-Key', codeWriterKey)
      .send({ title: 'Write comprehensive tests', description: 'Cover all endpoints with integration tests' });

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Write comprehensive tests');
    expect(res.body.description).toBe('Cover all endpoints with integration tests');
    expect(res.body.id).toBe(ticketTestsId);
  });

  // -------------------------------------------------------------------------
  // 10. Agent adds comments
  // -------------------------------------------------------------------------

  it('should add comment from clawbot on login ticket', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets/${ticketLoginId}/comments`)
      .set('X-Api-Key', clawbotKey)
      .send({ body: 'Starting work on login form' });

    expect(res.status).toBe(201);
    expect(res.body.body).toBe('Starting work on login form');
    expect(res.body.agentId).toBe(clawbotId);
    expect(res.body.ticketId).toBe(ticketLoginId);
  });

  it('should add comment from code-writer on tests ticket', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets/${ticketTestsId}/comments`)
      .set('X-Api-Key', codeWriterKey)
      .send({ body: 'Tests are ready for review' });

    expect(res.status).toBe(201);
    expect(res.body.body).toBe('Tests are ready for review');
    expect(res.body.agentId).toBe(codeWriterId);
  });

  // -------------------------------------------------------------------------
  // 11. List comments
  // -------------------------------------------------------------------------

  it('should list comments on login ticket (GET .../comments)', async () => {
    const res = await request(app)
      .get(`/api/projects/${projectId}/tickets/${ticketLoginId}/comments`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].body).toBe('Starting work on login form');
  });

  it('should list comments on tests ticket (GET .../comments)', async () => {
    const res = await request(app)
      .get(`/api/projects/${projectId}/tickets/${ticketTestsId}/comments`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].body).toBe('Tests are ready for review');
  });

  // -------------------------------------------------------------------------
  // 12. Human closes a ticket
  // -------------------------------------------------------------------------

  it('should close a ticket (POST .../close, no auth)', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets/${ticketLoginId}/close`);

    expect(res.status).toBe(200);
    expect(res.body.column).toBe('done');
    expect(res.body.id).toBe(ticketLoginId);
  });

  // -------------------------------------------------------------------------
  // 13. Human reopens a ticket
  // -------------------------------------------------------------------------

  it('should reopen a ticket (POST .../open, no auth)', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets/${ticketLoginId}/open`);

    expect(res.status).toBe(200);
    expect(res.body.column).toBe('backlog');
    expect(res.body.id).toBe(ticketLoginId);
  });

  // -------------------------------------------------------------------------
  // 14. Check activity log
  // -------------------------------------------------------------------------

  it('should return activities for the project (GET /api/projects/:id/activity)', async () => {
    const res = await request(app).get(`/api/projects/${projectId}/activity`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // We created 3 tickets, moved 1, updated 1, added 2 comments, closed 1, reopened 1 = at least 9 activities
    expect(res.body.length).toBeGreaterThanOrEqual(9);
    // Check that activity entries have expected structure
    const first = res.body[0];
    expect(first.id).toBeDefined();
    expect(first.ticketId).toBeDefined();
    expect(first.action).toBeDefined();
    expect(first.details).toBeDefined();
    expect(first.timestamp).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // 15. Check audit log
  // -------------------------------------------------------------------------

  it('should return audit entries (GET /api/audit)', async () => {
    const res = await request(app).get('/api/audit');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // Check structure of an audit entry
    const entry = res.body[0];
    expect(entry.id).toBeDefined();
    expect(entry.method).toBeDefined();
    expect(entry.path).toBeDefined();
    expect(entry.statusCode).toBeDefined();
    expect(entry.timestamp).toBeDefined();
  });

  it('should return filtered audit entries by agent (GET /api/audit/agent/:agentId)', async () => {
    const res = await request(app).get(`/api/audit/agent/${clawbotId}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // All entries should belong to clawbot
    for (const entry of res.body) {
      expect(entry.agentId).toBe(clawbotId);
    }
  });

  // -------------------------------------------------------------------------
  // 16. Agent deletes a ticket
  // -------------------------------------------------------------------------

  it('should delete ticket "Implement auth API" (DELETE .../tickets/:ticketId)', async () => {
    const res = await request(app)
      .delete(`/api/projects/${projectId}/tickets/${ticketAuthId}`)
      .set('X-Api-Key', clawbotKey);

    expect(res.status).toBe(204);
  });

  it('should now list 2 tickets after deletion', async () => {
    const res = await request(app).get(`/api/projects/${projectId}/tickets`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.total).toBe(2);
  });

  // -------------------------------------------------------------------------
  // 17. Admin deletes an agent
  // -------------------------------------------------------------------------

  it('should delete agent "code-writer" (DELETE /api/agents/:id)', async () => {
    const res = await request(app)
      .delete(`/api/agents/${codeWriterId}`)
      .set('X-Admin-Key', ADMIN_KEY);

    expect(res.status).toBe(204);
  });

  it('should now list 1 agent after deletion', async () => {
    const res = await request(app).get('/api/agents');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe('clawbot');
  });

  // -------------------------------------------------------------------------
  // 18. Admin deletes the project
  // -------------------------------------------------------------------------

  it('should delete the project (DELETE /api/projects/:id)', async () => {
    const res = await request(app)
      .delete(`/api/projects/${projectId}`)
      .set('X-Admin-Key', ADMIN_KEY);

    expect(res.status).toBe(204);
  });

  it('should now list 0 projects after deletion', async () => {
    const res = await request(app).get('/api/projects');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 19. Error cases
  // -------------------------------------------------------------------------

  it('should return 401 when creating agent without admin key', async () => {
    const res = await request(app)
      .post('/api/agents')
      .send({ name: 'unauthorized' });

    expect(res.status).toBe(401);
  });

  it('should return 401 when creating project without admin key', async () => {
    const res = await request(app)
      .post('/api/projects')
      .send({ name: 'unauthorized' });

    expect(res.status).toBe(401);
  });

  it('should return 401 when creating ticket without agent key', async () => {
    // Create a fresh project for this test
    const projRes = await request(app)
      .post('/api/projects')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ name: 'temp-project' });
    const tempProjectId = projRes.body.id;

    const res = await request(app)
      .post(`/api/projects/${tempProjectId}/tickets`)
      .send({ title: 'unauthorized ticket' });

    expect(res.status).toBe(401);

    // Clean up
    await request(app)
      .delete(`/api/projects/${tempProjectId}`)
      .set('X-Admin-Key', ADMIN_KEY);
  });

  it('should return 404 for nonexistent project (GET /api/projects/nonexistent)', async () => {
    const res = await request(app).get('/api/projects/nonexistent');

    expect(res.status).toBe(404);
  });

  it('should return 400 when creating ticket with invalid column', async () => {
    // Create a fresh project for this test
    const projRes = await request(app)
      .post('/api/projects')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ name: 'temp-project-2' });
    const tempProjectId = projRes.body.id;

    const res = await request(app)
      .post(`/api/projects/${tempProjectId}/tickets`)
      .set('X-Api-Key', clawbotKey)
      .send({ title: 'Bad column', column: 'invalid_column' });

    expect(res.status).toBe(400);

    // Clean up
    await request(app)
      .delete(`/api/projects/${tempProjectId}`)
      .set('X-Admin-Key', ADMIN_KEY);
  });

  it('should return 400 when moving ticket with invalid column', async () => {
    // Create a fresh project and ticket for this test
    const projRes = await request(app)
      .post('/api/projects')
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ name: 'temp-project-3' });
    const tempProjectId = projRes.body.id;

    const ticketRes = await request(app)
      .post(`/api/projects/${tempProjectId}/tickets`)
      .set('X-Api-Key', clawbotKey)
      .send({ title: 'Moveable ticket' });
    const tempTicketId = ticketRes.body.id;

    const res = await request(app)
      .patch(`/api/projects/${tempProjectId}/tickets/${tempTicketId}/move`)
      .set('X-Api-Key', clawbotKey)
      .send({ column: 'nonexistent_column' });

    expect(res.status).toBe(400);

    // Clean up
    await request(app)
      .delete(`/api/projects/${tempProjectId}`)
      .set('X-Admin-Key', ADMIN_KEY);
  });
});
