import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createProjectRoutes } from '../../src/api/routes/projects.js';

describe('Project Routes', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let app: express.Express;
  let ADMIN_KEY: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    ADMIN_KEY = service.getOrCreateAdminKey();
    app = express();
    app.use(express.json());
    app.use('/api/projects', createProjectRoutes(service));
  });

  afterEach(() => {
    db.close();
  });

  describe('POST /api/projects', () => {
    it('should create a project', async () => {
      const res = await request(app)
        .post('/api/projects')
        .set('X-Admin-Key', ADMIN_KEY)
        .send({ name: 'My Project', description: 'Desc' });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('My Project');
    });

    it('should require auth', async () => {
      const res = await request(app)
        .post('/api/projects')
        .send({ name: 'Project' });
      expect(res.status).toBe(401);
    });

    it('should return 400 for missing name', async () => {
      const res = await request(app)
        .post('/api/projects')
        .set('X-Admin-Key', ADMIN_KEY)
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/projects', () => {
    it('should list projects', async () => {
      await request(app).post('/api/projects').set('X-Admin-Key', ADMIN_KEY).send({ name: 'P1' });
      const res = await request(app).get('/api/projects');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  describe('GET /api/projects/:id', () => {
    it('should get a single project', async () => {
      const create = await request(app).post('/api/projects').set('X-Admin-Key', ADMIN_KEY).send({ name: 'P1' });
      const res = await request(app).get(`/api/projects/${create.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('P1');
    });

    it('should return 404 for nonexistent project', async () => {
      const res = await request(app).get('/api/projects/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/projects/:id', () => {
    it('should delete a project', async () => {
      const create = await request(app).post('/api/projects').set('X-Admin-Key', ADMIN_KEY).send({ name: 'P1' });
      const res = await request(app).delete(`/api/projects/${create.body.id}`).set('X-Admin-Key', ADMIN_KEY);
      expect(res.status).toBe(204);
    });

    it('should return 404 for nonexistent project', async () => {
      const res = await request(app).delete('/api/projects/nonexistent').set('X-Admin-Key', ADMIN_KEY);
      expect(res.status).toBe(404);
    });
  });
});
