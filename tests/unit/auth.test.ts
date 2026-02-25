import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createAuthMiddleware } from '../../src/api/middleware/auth.js';

describe('Auth Middleware', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let app: express.Express;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    app = express();
    app.use(express.json());

    const auth = createAuthMiddleware(service);
    app.get('/protected', auth, (_req, res) => {
      res.json({ ok: true });
    });
  });

  afterEach(() => {
    db.close();
  });

  it('should return 401 if no X-Api-Key header', async () => {
    const res = await request(app).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Missing/);
  });

  it('should return 403 for invalid API key', async () => {
    const res = await request(app)
      .get('/protected')
      .set('X-Api-Key', 'invalid-key');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Invalid/);
  });

  it('should pass through with valid API key', async () => {
    const agent = db.createAgent('bot1');
    const res = await request(app)
      .get('/protected')
      .set('X-Api-Key', agent.apiKey);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
