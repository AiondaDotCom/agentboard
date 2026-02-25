import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createAgentRoutes } from '../../src/api/routes/agents.js';

describe('Agent Routes', () => {
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
    app.use('/api/agents', createAgentRoutes(service));
  });

  afterEach(() => {
    db.close();
  });

  describe('POST /api/agents', () => {
    it('should create an agent and return apiKey', async () => {
      const res = await request(app)
        .post('/api/agents')
        .set('X-Admin-Key', ADMIN_KEY)
        .send({ name: 'test-bot' });
      expect(res.status).toBe(201);
      expect(res.body.name).toBe('test-bot');
      expect(res.body.apiKey).toMatch(/^ab-/);
    });

    it('should require admin auth', async () => {
      const res = await request(app)
        .post('/api/agents')
        .send({ name: 'test-bot' });
      expect(res.status).toBe(401);
    });

    it('should reject invalid admin key', async () => {
      const res = await request(app)
        .post('/api/agents')
        .set('X-Admin-Key', 'wrong-key')
        .send({ name: 'test-bot' });
      expect(res.status).toBe(403);
    });

    it('should return 400 for missing name', async () => {
      const res = await request(app)
        .post('/api/agents')
        .set('X-Admin-Key', ADMIN_KEY)
        .send({});
      expect(res.status).toBe(400);
    });

    it('should return 400 for empty name', async () => {
      const res = await request(app)
        .post('/api/agents')
        .set('X-Admin-Key', ADMIN_KEY)
        .send({ name: '  ' });
      expect(res.status).toBe(400);
    });

    it('should return 409 for duplicate name', async () => {
      await request(app).post('/api/agents').set('X-Admin-Key', ADMIN_KEY).send({ name: 'bot1' });
      const res = await request(app).post('/api/agents').set('X-Admin-Key', ADMIN_KEY).send({ name: 'bot1' });
      expect(res.status).toBe(409);
    });
  });

  describe('GET /api/agents', () => {
    it('should list all agents without apiKey', async () => {
      await request(app).post('/api/agents').set('X-Admin-Key', ADMIN_KEY).send({ name: 'bot1' });
      await request(app).post('/api/agents').set('X-Admin-Key', ADMIN_KEY).send({ name: 'bot2' });
      const res = await request(app).get('/api/agents');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
      expect(res.body[0].apiKey).toBeUndefined();
    });
  });

  describe('DELETE /api/agents/:id', () => {
    it('should delete an agent', async () => {
      const create = await request(app).post('/api/agents').set('X-Admin-Key', ADMIN_KEY).send({ name: 'bot1' });
      const res = await request(app).delete(`/api/agents/${create.body.id}`).set('X-Admin-Key', ADMIN_KEY);
      expect(res.status).toBe(204);
      const list = await request(app).get('/api/agents');
      expect(list.body).toHaveLength(0);
    });

    it('should return 404 for nonexistent agent', async () => {
      const res = await request(app).delete('/api/agents/nonexistent').set('X-Admin-Key', ADMIN_KEY);
      expect(res.status).toBe(404);
    });

    it('should require admin auth', async () => {
      const res = await request(app).delete('/api/agents/some-id');
      expect(res.status).toBe(401);
    });
  });
});
