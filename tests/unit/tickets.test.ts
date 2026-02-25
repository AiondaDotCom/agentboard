import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AgentboardDB } from '../../src/db/database.js';
import { createTicketRoutes, createHumanTicketRoutes } from '../../src/api/routes/tickets.js';

describe('Ticket Routes', () => {
  let db: AgentboardDB;
  let app: express.Express;
  let apiKey: string;
  let projectId: string;

  beforeEach(async () => {
    db = new AgentboardDB(':memory:');
    app = express();
    app.use(express.json());
    app.use('/api/projects/:id', createTicketRoutes(db));
    app.use('/api/projects/:id', createHumanTicketRoutes(db));

    apiKey = db.createAgent('bot1').apiKey;
    projectId = db.createProject('test-project').id;
  });

  afterEach(() => {
    db.close();
  });

  describe('POST /api/projects/:id/tickets', () => {
    it('should create a ticket', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Fix bug' });
      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Fix bug');
      expect(res.body.column).toBe('backlog');
    });

    it('should create a ticket in specified column', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task', column: 'ready' });
      expect(res.body.column).toBe('ready');
    });

    it('should create a ticket with description', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task', description: 'Some description' });
      expect(res.status).toBe(201);
      expect(res.body.description).toBe('Some description');
    });

    it('should return 400 for missing title', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({});
      expect(res.status).toBe(400);
    });

    it('should return 400 for invalid column', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task', column: 'invalid' });
      expect(res.status).toBe(400);
    });

    it('should return 404 for nonexistent project', async () => {
      const res = await request(app)
        .post('/api/projects/nonexistent/tickets')
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      expect(res.status).toBe(404);
    });

    it('should require auth', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .send({ title: 'Task' });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/projects/:id/tickets', () => {
    it('should list tickets', async () => {
      await request(app).post(`/api/projects/${projectId}/tickets`).set('X-Api-Key', apiKey).send({ title: 'T1' });
      await request(app).post(`/api/projects/${projectId}/tickets`).set('X-Api-Key', apiKey).send({ title: 'T2' });
      const res = await request(app).get(`/api/projects/${projectId}/tickets`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('should return 404 for nonexistent project', async () => {
      const res = await request(app).get('/api/projects/nonexistent/tickets');
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/projects/:id/tickets/:ticketId', () => {
    it('should get a single ticket', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app).get(`/api/projects/${projectId}/tickets/${create.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Task');
    });

    it('should return 404 for nonexistent ticket', async () => {
      const res = await request(app).get(`/api/projects/${projectId}/tickets/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/projects/:id/tickets/:ticketId', () => {
    it('should update ticket title', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Old' });
      const res = await request(app)
        .patch(`/api/projects/${projectId}/tickets/${create.body.id}`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'New' });
      expect(res.status).toBe(200);
      expect(res.body.title).toBe('New');
    });

    it('should update ticket description', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app)
        .patch(`/api/projects/${projectId}/tickets/${create.body.id}`)
        .set('X-Api-Key', apiKey)
        .send({ description: 'Updated desc' });
      expect(res.status).toBe(200);
      expect(res.body.description).toBe('Updated desc');
    });

    it('should update ticket column via PATCH', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app)
        .patch(`/api/projects/${projectId}/tickets/${create.body.id}`)
        .set('X-Api-Key', apiKey)
        .send({ column: 'in_review' });
      expect(res.status).toBe(200);
      expect(res.body.column).toBe('in_review');
    });

    it('should return 400 for invalid column', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app)
        .patch(`/api/projects/${projectId}/tickets/${create.body.id}`)
        .set('X-Api-Key', apiKey)
        .send({ column: 'invalid' });
      expect(res.status).toBe(400);
    });

    it('should return 400 for empty title', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app)
        .patch(`/api/projects/${projectId}/tickets/${create.body.id}`)
        .set('X-Api-Key', apiKey)
        .send({ title: '' });
      expect(res.status).toBe(400);
    });

    it('should return 400 for non-string title', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app)
        .patch(`/api/projects/${projectId}/tickets/${create.body.id}`)
        .set('X-Api-Key', apiKey)
        .send({ title: 123 });
      expect(res.status).toBe(400);
    });

    it('should return 400 for non-string description', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app)
        .patch(`/api/projects/${projectId}/tickets/${create.body.id}`)
        .set('X-Api-Key', apiKey)
        .send({ description: 123 });
      expect(res.status).toBe(400);
    });

    it('should return 404 for nonexistent ticket', async () => {
      const res = await request(app)
        .patch(`/api/projects/${projectId}/tickets/nonexistent`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'New' });
      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /api/projects/:id/tickets/:ticketId/move', () => {
    it('should move a ticket', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app)
        .patch(`/api/projects/${projectId}/tickets/${create.body.id}/move`)
        .set('X-Api-Key', apiKey)
        .send({ column: 'in_progress' });
      expect(res.status).toBe(200);
      expect(res.body.column).toBe('in_progress');
    });

    it('should return 400 for invalid column', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app)
        .patch(`/api/projects/${projectId}/tickets/${create.body.id}/move`)
        .set('X-Api-Key', apiKey)
        .send({ column: 'bad' });
      expect(res.status).toBe(400);
    });

    it('should return 400 for missing column', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app)
        .patch(`/api/projects/${projectId}/tickets/${create.body.id}/move`)
        .set('X-Api-Key', apiKey)
        .send({});
      expect(res.status).toBe(400);
    });

    it('should return 404 for nonexistent ticket', async () => {
      const res = await request(app)
        .patch(`/api/projects/${projectId}/tickets/nonexistent/move`)
        .set('X-Api-Key', apiKey)
        .send({ column: 'done' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/projects/:id/tickets/:ticketId', () => {
    it('should delete a ticket', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app)
        .delete(`/api/projects/${projectId}/tickets/${create.body.id}`)
        .set('X-Api-Key', apiKey);
      expect(res.status).toBe(204);
    });

    it('should return 404 for nonexistent ticket', async () => {
      const res = await request(app)
        .delete(`/api/projects/${projectId}/tickets/nonexistent`)
        .set('X-Api-Key', apiKey);
      expect(res.status).toBe(404);
    });
  });

  describe('Comments', () => {
    it('should add and list comments', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });

      const commentRes = await request(app)
        .post(`/api/projects/${projectId}/tickets/${create.body.id}/comments`)
        .set('X-Api-Key', apiKey)
        .send({ body: 'Great work!' });
      expect(commentRes.status).toBe(201);
      expect(commentRes.body.body).toBe('Great work!');

      const listRes = await request(app)
        .get(`/api/projects/${projectId}/tickets/${create.body.id}/comments`);
      expect(listRes.status).toBe(200);
      expect(listRes.body).toHaveLength(1);
    });

    it('should return 400 for empty comment body', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app)
        .post(`/api/projects/${projectId}/tickets/${create.body.id}/comments`)
        .set('X-Api-Key', apiKey)
        .send({ body: '' });
      expect(res.status).toBe(400);
    });

    it('should return 400 for missing comment body', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app)
        .post(`/api/projects/${projectId}/tickets/${create.body.id}/comments`)
        .set('X-Api-Key', apiKey)
        .send({});
      expect(res.status).toBe(400);
    });

    it('should return 404 for comment on nonexistent ticket', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/tickets/nonexistent/comments`)
        .set('X-Api-Key', apiKey)
        .send({ body: 'Hello' });
      expect(res.status).toBe(404);
    });

    it('should return 404 for listing comments on nonexistent ticket', async () => {
      const res = await request(app)
        .get(`/api/projects/${projectId}/tickets/nonexistent/comments`);
      expect(res.status).toBe(404);
    });
  });

  describe('Human actions', () => {
    it('should close a ticket (move to done)', async () => {
      const create = await request(app)
        .post(`/api/projects/${projectId}/tickets`)
        .set('X-Api-Key', apiKey)
        .send({ title: 'Task' });
      const res = await request(app)
        .post(`/api/projects/${projectId}/tickets/${create.body.id}/close`);
      expect(res.status).toBe(200);
      expect(res.body.column).toBe('done');
    });

    it('should open a ticket (move to backlog)', async () => {
      const ticket = db.createTicket(projectId, 'Done Task', '', 'done');
      const res = await request(app)
        .post(`/api/projects/${projectId}/tickets/${ticket.id}/open`);
      expect(res.status).toBe(200);
      expect(res.body.column).toBe('backlog');
    });

    it('should return 404 for nonexistent ticket on close', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/tickets/nonexistent/close`);
      expect(res.status).toBe(404);
    });

    it('should return 404 for nonexistent ticket on open', async () => {
      const res = await request(app)
        .post(`/api/projects/${projectId}/tickets/nonexistent/open`);
      expect(res.status).toBe(404);
    });
  });
});
