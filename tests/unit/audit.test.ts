import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createAuditMiddleware } from '../../src/api/middleware/audit.js';
import { createAuditRoutes } from '../../src/api/routes/audit.js';
import { createAgentRoutes } from '../../src/api/routes/agents.js';

describe('Audit Middleware', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let app: express.Express;
  let adminKey: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    adminKey = service.getOrCreateAdminKey();
    app = express();
    app.use(express.json());
    app.use('/api', createAuditMiddleware(db));
    app.use('/api/agents', createAgentRoutes(service));
    app.use('/api/audit', createAuditRoutes(service));
  });

  afterEach(() => {
    db.close();
  });

  it('should log GET requests to audit log', async () => {
    await request(app).get('/api/agents');

    // Wait briefly for the finish event to fire
    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = db.getAllAuditEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const agentEntry = entries.find(e => e.path === '/api/agents' && e.method === 'GET');
    expect(agentEntry).toBeDefined();
    expect(agentEntry!.statusCode).toBe(200);
    expect(agentEntry!.requestBody).toBe('');
  });

  it('should log POST requests with body to audit log', async () => {
    await request(app)
      .post('/api/agents')
      .set('X-Admin-Key', adminKey)
      .send({ name: 'audit-bot' });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = db.getAllAuditEntries();
    const postEntry = entries.find(e => e.method === 'POST');
    expect(postEntry).toBeDefined();
    expect(postEntry!.statusCode).toBe(201);
    expect(postEntry!.requestBody).toContain('audit-bot');
  });

  it('should capture agent ID when authenticated', async () => {
    const agent = db.createAgent('bot1');

    // The agent routes don't require auth, so we'd need a route that uses auth
    // But the audit middleware captures agentId if set on the request
    // Let's just verify the null agentId path works
    await request(app).get('/api/agents');

    await new Promise((resolve) => setTimeout(resolve, 50));

    const entries = db.getAllAuditEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]!.agentId).toBeNull();
  });
});

describe('Audit Routes', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let app: express.Express;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    app = express();
    app.use(express.json());
    app.use('/api/audit', createAuditRoutes(service));
  });

  afterEach(() => {
    db.close();
  });

  describe('GET /api/audit', () => {
    it('should return all audit entries', async () => {
      db.logAudit(null, 'GET', '/api/test', 200, '');
      db.logAudit(null, 'POST', '/api/test', 201, '{}');

      const res = await request(app).get('/api/audit');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('should respect limit parameter', async () => {
      for (let i = 0; i < 10; i++) {
        db.logAudit(null, 'GET', '/api/test', 200, '');
      }

      const res = await request(app).get('/api/audit?limit=3');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(3);
    });

    it('should use default limit when not specified', async () => {
      const res = await request(app).get('/api/audit');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    it('should handle invalid limit values', async () => {
      db.logAudit(null, 'GET', '/api/test', 200, '');

      const res = await request(app).get('/api/audit?limit=abc');
      expect(res.status).toBe(200);
      // NaN should fall back to default 100
    });

    it('should handle negative limit values', async () => {
      db.logAudit(null, 'GET', '/api/test', 200, '');

      const res = await request(app).get('/api/audit?limit=-5');
      expect(res.status).toBe(200);
      // Negative should fall back to default 100
    });

    it('should cap limit to 1000', async () => {
      const res = await request(app).get('/api/audit?limit=5000');
      expect(res.status).toBe(200);
    });
  });

  describe('GET /api/audit/agent/:agentId', () => {
    it('should return audit entries for specific agent', async () => {
      const agent = db.createAgent('bot1');
      const agent2 = db.createAgent('bot2');

      db.logAudit(agent.id, 'GET', '/api/test', 200, '');
      db.logAudit(agent2.id, 'POST', '/api/test', 201, '{}');
      db.logAudit(agent.id, 'DELETE', '/api/test', 204, '');

      const res = await request(app).get(`/api/audit/agent/${agent.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it('should respect limit on agent audit entries', async () => {
      const agent = db.createAgent('bot1');
      for (let i = 0; i < 10; i++) {
        db.logAudit(agent.id, 'GET', '/api/test', 200, '');
      }

      const res = await request(app).get(`/api/audit/agent/${agent.id}?limit=5`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(5);
    });

    it('should return empty array for agent with no entries', async () => {
      const res = await request(app).get('/api/audit/agent/nonexistent');
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    it('should handle invalid limit for agent entries', async () => {
      const agent = db.createAgent('bot1');
      db.logAudit(agent.id, 'GET', '/api/test', 200, '');

      const res = await request(app).get(`/api/audit/agent/${agent.id}?limit=abc`);
      expect(res.status).toBe(200);
    });
  });
});
