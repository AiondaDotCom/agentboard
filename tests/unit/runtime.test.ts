import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
    workingOpenCode: 0,
    idleCodex: 3,
    idleClaude: 4,
    idleOpenCode: 0,
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

  it('migrates existing runtime reports for OpenCode', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'agentboard-runtime-'));
    const databasePath = path.join(directory, 'legacy.db');
    const legacy = new Database(databasePath);
    legacy.exec(`CREATE TABLE runtime_reports (
      host TEXT PRIMARY KEY,
      working_codex INTEGER NOT NULL DEFAULT 0,
      working_claude INTEGER NOT NULL DEFAULT 0,
      idle_codex INTEGER NOT NULL DEFAULT 0,
      idle_claude INTEGER NOT NULL DEFAULT 0,
      reported_at TEXT NOT NULL DEFAULT (datetime('now'))
    ); INSERT INTO runtime_reports (host, working_codex, working_claude)
      VALUES ('cortex', 1, 2);`);
    legacy.close();

    try {
      const migrated = new AgentboardDB(databasePath);
      expect(migrated.getRuntimeReports(0)[0]).toMatchObject({
        workingOpenCode: 0,
        idleOpenCode: 0,
      });
      migrated.close();

      const reopened = new AgentboardDB(databasePath);
      reopened.upsertRuntimeReport(payload);
      expect(reopened.getRuntimeReports(0)[0]).toMatchObject(payload);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('stores, updates, aggregates, and publishes reports', async () => {
    const iterator = pubsub.subscribe(EVENTS.RUNTIME_STATUS_CHANGED);
    const result = service.reportRuntime(payload);
    expect(result).toMatchObject({
      working: 3, idle: 7, codexWorking: 2, claudeWorking: 1, openCodeWorking: 0,
    });
    expect(result.hosts[0]).toMatchObject(payload);
    expect((await iterator.next()).value).toEqual({ runtimeStatusChanged: result });
    await iterator.return?.();

    service.reportRuntime({ ...payload, workingCodex: 0 });
    expect(db.getRuntimeReports(0)[0]?.workingCodex).toBe(0);
    expect(db.getRuntimeReports()).toHaveLength(1);

    const withOpenCode = service.reportRuntime({
      ...payload,
      workingOpenCode: 4,
      idleOpenCode: 2,
    });
    expect(withOpenCode).toMatchObject({ working: 7, idle: 9, openCodeWorking: 4 });
  });

  it('tracks one persistent non-stop working streak across count changes', () => {
    expect(service.getRuntimeStatus()).toMatchObject({
      working: 0,
      workingSince: null,
      workingForSeconds: 0,
    });

    const started = service.reportRuntime(payload);
    expect(started.workingSince).toBeTruthy();
    expect(started.workingForSeconds).toBe(0);

    const historicalStart = new Date(Date.now() - 3_661_000).toISOString();
    db.setSetting('runtime_work_started_at', historicalStart);
    const scaledUp = service.reportRuntime({ ...payload, workingCodex: 5 });
    expect(scaledUp.workingSince).toBe(historicalStart);
    expect(scaledUp.workingForSeconds).toBeGreaterThanOrEqual(3660);

    db.deleteSetting('runtime_work_started_at');
    const recovered = service.reportRuntime(payload);
    expect(recovered.workingSince).toBeTruthy();

    const stopped = service.reportRuntime({
      ...payload,
      workingCodex: 0,
      workingClaude: 0,
    });
    expect(stopped).toMatchObject({ working: 0, workingSince: null, workingForSeconds: 0 });
    expect(db.getSetting('runtime_work_started_at')).toBeUndefined();

    service.reportRuntime({ ...payload, workingCodex: 0, workingClaude: 0 });
    expect(db.getSetting('runtime_work_started_at')).toBeUndefined();
  });

  it.each([
    [null, 'host'],
    [{ ...payload, host: '' }, 'host'],
    [{ ...payload, host: 'bad host' }, 'host'],
    [{ ...payload, workingCodex: -1 }, 'workingCodex'],
    [{ ...payload, workingClaude: 1.5 }, 'workingClaude'],
    [{ ...payload, workingOpenCode: -1 }, 'workingOpenCode'],
    [{ ...payload, idleCodex: 1001 }, 'idleCodex'],
    [{ ...payload, idleClaude: undefined }, 'idleClaude'],
    [{ ...payload, idleOpenCode: 1.5 }, 'idleOpenCode'],
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
