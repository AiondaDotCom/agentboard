import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AgentboardDB } from '../../src/db/database.js';
import { createRuntimeRoutes } from '../../src/api/routes/runtime.js';
import { BoardService } from '../../src/services/board.service.js';
import { EVENTS, pubsub } from '../../src/graphql/pubsub.js';

describe('runtime activity reporting', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let app: express.Express;
  const payload = {
    host: 'cortex',
    workingCodex: 2,
    workingClaude: 1,
    idleCodex: 3,
    idleClaude: 4,
  };

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    app = express();
    app.use(express.json());
    app.use('/api/runtime', createRuntimeRoutes(service));
  });

  afterEach(() => db.close());

  it('creates one persistent runtime key', () => {
    const key = service.getOrCreateRuntimeApiKey();
    expect(key).toMatch(/^runtime-/);
    expect(service.getOrCreateRuntimeApiKey()).toBe(key);
  });

  it('stores, updates, aggregates, and publishes reports', async () => {
    const iterator = pubsub.subscribe(EVENTS.RUNTIME_STATUS_CHANGED);
    const result = service.reportRuntime(payload);
    expect(result).toMatchObject({ working: 3, idle: 7, codexWorking: 2, claudeWorking: 1 });
    expect(result.hosts[0]).toMatchObject(payload);
    expect((await iterator.next()).value).toEqual({ runtimeStatusChanged: result });
    await iterator.return?.();

    service.reportRuntime({ ...payload, workingCodex: 0 });
    expect(db.getRuntimeReports(0)[0]?.workingCodex).toBe(0);
    expect(db.getRuntimeReports()).toHaveLength(1);
  });

  it.each([
    [null, 'host'],
    [{ ...payload, host: '' }, 'host'],
    [{ ...payload, host: 'bad host' }, 'host'],
    [{ ...payload, workingCodex: -1 }, 'workingCodex'],
    [{ ...payload, workingClaude: 1.5 }, 'workingClaude'],
    [{ ...payload, idleCodex: 1001 }, 'idleCodex'],
    [{ ...payload, idleClaude: undefined }, 'idleClaude'],
  ])('rejects invalid reports', (body, field) => {
    expect(() => service.reportRuntime(body)).toThrow(field);
  });

  it('exposes GET and protects POST with the dedicated key', async () => {
    expect((await request(app).get('/api/runtime')).body).toMatchObject({ working: 0, hosts: [] });
    expect((await request(app).post('/api/runtime').send(payload)).status).toBe(401);
    expect((await request(app).post('/api/runtime').set('X-Api-Key', 'x').send(payload)).status).toBe(403);
    const runtimeKey = service.getOrCreateRuntimeApiKey();
    expect((await request(app).post('/api/runtime').set('X-Api-Key', 'x'.repeat(runtimeKey.length)).send(payload)).status).toBe(403);
    expect((await request(app).post('/api/runtime').set('X-Api-Key', runtimeKey)).status).toBe(400);

    const response = await request(app)
      .post('/api/runtime')
      .set('X-Api-Key', runtimeKey)
      .send(payload);
    expect(response.status).toBe(200);
    expect(response.body.working).toBe(3);
  });

  it('returns validation errors from POST', async () => {
    const response = await request(app)
      .post('/api/runtime')
      .set('X-Api-Key', service.getOrCreateRuntimeApiKey())
      .send({ ...payload, workingCodex: 'two' });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/workingCodex/);
  });
});
