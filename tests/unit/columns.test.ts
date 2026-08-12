import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createProjectRoutes } from '../../src/api/routes/projects.js';
import { DEFAULT_COLUMNS, LEGACY_COLUMNS } from '../../src/types.js';
import { ValidationError, ConflictError } from '../../src/services/errors.js';

const CUSTOM = [
  { id: 'todo', title: 'Rückstand' },
  { id: 'doing', title: 'In Arbeit' },
  { id: 'finished', title: 'Erledigt' },
];

// ---------------------------------------------------------------------------
// DB layer
// ---------------------------------------------------------------------------

describe('Project columns – DB layer', () => {
  let db: AgentboardDB;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('new projects get the 6-column default set', () => {
    const p = db.createProject('p');
    expect(p.columns).toEqual(DEFAULT_COLUMNS);
  });

  it('stores and returns custom columns', () => {
    const p = db.createProject('p', '', CUSTOM);
    expect(db.getProject(p.id)?.columns).toEqual(CUSTOM);
  });

  it('updateProject replaces columns', () => {
    const p = db.createProject('p');
    const updated = db.updateProject(p.id, { columns: CUSTOM });
    expect(updated?.columns).toEqual(CUSTOM);
    expect(updated?.name).toBe('p');
  });

  it('migrates existing projects to the legacy 5-column set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-test-'));
    const dbPath = path.join(dir, 'old.db');

    // Simulate a pre-columns database: projects without columns, ticket in "ready"
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        column_name TEXT NOT NULL DEFAULT 'backlog',
        position INTEGER NOT NULL DEFAULT 0,
        group_name TEXT,
        agent_id TEXT,
        assignee_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO projects (id, name) VALUES ('p1', 'legacy project');
      INSERT INTO tickets (id, project_id, title, column_name) VALUES ('t1', 'p1', 'legacy', 'ready');
    `);
    raw.close();

    const migrated = new AgentboardDB(dbPath);
    expect(migrated.getProject('p1')?.columns).toEqual(LEGACY_COLUMNS);
    expect(migrated.getTicket('p1', 't1')?.column).toBe('ready');
    expect(migrated.getTicket('p1', 't1')?.blockedReason).toBeNull();

    // A ticket move within the legacy set must still work through the service
    const service = new BoardService(migrated);
    expect(service.moveTicket('p1', 't1', 'ready').column).toBe('ready');

    // New projects in the migrated DB get the new default set
    expect(migrated.createProject('fresh').columns).toEqual(DEFAULT_COLUMNS);

    migrated.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Service layer
// ---------------------------------------------------------------------------

describe('Project columns – service layer', () => {
  let db: AgentboardDB;
  let service: BoardService;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('createProject', () => {
    it('uses the default set when no columns are given', () => {
      expect(service.createProject('p').columns).toEqual(DEFAULT_COLUMNS);
    });

    it('accepts a custom column set', () => {
      expect(service.createProject('p', '', null, CUSTOM).columns).toEqual(CUSTOM);
    });

    it('rejects fewer than 2 columns', () => {
      expect(() => service.createProject('p', '', null, [{ id: 'only', title: 'Only' }])).toThrow(ValidationError);
    });

    it('rejects invalid column ids', () => {
      expect(() => service.createProject('p', '', null, [
        { id: 'OK Then', title: 'x' },
        { id: 'done', title: 'Done' },
      ])).toThrow(ValidationError);
    });

    it('rejects duplicate column ids', () => {
      expect(() => service.createProject('p', '', null, [
        { id: 'a', title: 'A' },
        { id: 'a', title: 'B' },
      ])).toThrow(ValidationError);
    });

    it('rejects empty or overlong titles', () => {
      expect(() => service.createProject('p', '', null, [
        { id: 'a', title: '' },
        { id: 'b', title: 'B' },
      ])).toThrow(ValidationError);
      expect(() => service.createProject('p', '', null, [
        { id: 'a', title: 'x'.repeat(51) },
        { id: 'b', title: 'B' },
      ])).toThrow(ValidationError);
    });
  });

  describe('updateProject', () => {
    it('updates name, description and columns', () => {
      const p = service.createProject('p');
      const updated = service.updateProject(p.id, { name: 'renamed', description: 'desc', columns: CUSTOM });
      expect(updated.name).toBe('renamed');
      expect(updated.description).toBe('desc');
      expect(updated.columns).toEqual(CUSTOM);
    });

    it('refuses to remove a column that still contains tickets', () => {
      const p = service.createProject('p');
      service.createTicket(p.id, 'in review', '', 'in_review');
      expect(() => service.updateProject(p.id, { columns: CUSTOM })).toThrow(ValidationError);
      expect(() => service.updateProject(p.id, { columns: CUSTOM })).toThrow(/in_review/);
    });

    it('allows removing a column once its tickets are moved away', () => {
      const p = service.createProject('p');
      const t = service.createTicket(p.id, 'in review', '', 'in_review');
      service.moveTicket(p.id, t.id, 'backlog');
      const cols = [
        { id: 'backlog', title: 'Backlog' },
        { id: 'done', title: 'Done' },
      ];
      expect(service.updateProject(p.id, { columns: cols }).columns).toEqual(cols);
    });
  });

  describe('ticket operations against custom columns', () => {
    let projectId: string;

    beforeEach(() => {
      projectId = service.createProject('p', '', null, CUSTOM).id;
    });

    it('new tickets land in the first column by default', () => {
      expect(service.createTicket(projectId, 'a').column).toBe('todo');
    });

    it('accepts only configured columns', () => {
      expect(service.createTicket(projectId, 'a', '', 'doing').column).toBe('doing');
      expect(() => service.createTicket(projectId, 'b', '', 'backlog')).toThrow(ValidationError);
      expect(() => service.moveTicket(projectId, service.createTicket(projectId, 'c').id, 'nope')).toThrow(/Valid columns: todo, doing, finished/);
    });

    it('list filter validates against project columns', () => {
      expect(() => service.getTicketsByProject(projectId, null, { column: 'ready' })).toThrow(ValidationError);
      expect(service.getTicketsByProject(projectId, null, { column: 'todo' }).data).toEqual([]);
    });

    it('closeTicket moves to the last column, openTicket back to the first', () => {
      const t = service.createTicket(projectId, 'a');
      expect(service.closeTicket(projectId, t.id).column).toBe('finished');
      expect(service.openTicket(projectId, t.id).column).toBe('todo');
    });

    it('group claim is released when tickets reach the custom last column', () => {
      const agentA = db.createAgent('a').id;
      const agentB = db.createAgent('b').id;
      const t1 = service.createTicket(projectId, 't1', '', 'todo', null, 'grp');
      const t2 = service.createTicket(projectId, 't2', '', 'todo', null, 'grp');

      service.assignTicket(projectId, t1.id, agentA);
      expect(() => service.assignTicket(projectId, t2.id, agentB)).toThrow(ConflictError);

      // Claimer finishes their ticket → group is free again
      service.moveTicket(projectId, t1.id, 'finished');
      expect(service.assignTicket(projectId, t2.id, agentB).assigneeId).toBe(agentB);
    });
  });

  describe('blocked_reason', () => {
    let projectId: string;

    beforeEach(() => {
      projectId = service.createProject('p').id;
    });

    it('stores a trimmed blocked reason on create', () => {
      const t = service.createTicket(projectId, 'a', '', 'blocked', null, null, '  waiting for signing cert  ');
      expect(t.blockedReason).toBe('waiting for signing cert');
    });

    it('defaults to null and clears via empty string', () => {
      const t = service.createTicket(projectId, 'a');
      expect(t.blockedReason).toBeNull();

      const set = service.updateTicket(projectId, t.id, { blockedReason: 'missing secure enclave' });
      expect(set.blockedReason).toBe('missing secure enclave');

      const cleared = service.updateTicket(projectId, t.id, { blockedReason: '' });
      expect(cleared.blockedReason).toBeNull();
    });

    it('logs revisions for blocked_reason changes', () => {
      const t = service.createTicket(projectId, 'a');
      service.updateTicket(projectId, t.id, { blockedReason: 'x' });
      service.updateTicket(projectId, t.id, { blockedReason: null });
      const revs = db.getRevisionsByTicket(t.id).filter((r) => r.field === 'blocked_reason');
      expect(revs).toHaveLength(2);
      expect(revs[0]).toMatchObject({ oldValue: '', newValue: 'x' });
      expect(revs[1]).toMatchObject({ oldValue: 'x', newValue: '' });
    });

    it('rejects non-string blocked reasons', () => {
      const t = service.createTicket(projectId, 'a');
      expect(() => service.updateTicket(projectId, t.id, { blockedReason: 42 as unknown as string })).toThrow(ValidationError);
    });
  });
});

// ---------------------------------------------------------------------------
// REST layer
// ---------------------------------------------------------------------------

describe('Project columns – REST', () => {
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
    app.use('/api/projects', createProjectRoutes(service));
  });

  afterEach(() => {
    db.close();
  });

  it('POST /api/projects accepts custom columns', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('X-Admin-Key', adminKey)
      .send({ name: 'p', columns: CUSTOM });
    expect(res.status).toBe(201);
    expect(res.body.columns).toEqual(CUSTOM);
  });

  it('POST /api/projects rejects an invalid columns config with 400', async () => {
    const res = await request(app)
      .post('/api/projects')
      .set('X-Admin-Key', adminKey)
      .send({ name: 'p', columns: [{ id: 'only', title: 'Only' }] });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/projects/:id updates columns (admin)', async () => {
    const p = service.createProject('p');
    const res = await request(app)
      .patch(`/api/projects/${p.id}`)
      .set('X-Admin-Key', adminKey)
      .send({ columns: CUSTOM });
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual(CUSTOM);
  });

  it('PATCH /api/projects/:id requires the admin key', async () => {
    const p = service.createProject('p');
    const res = await request(app)
      .patch(`/api/projects/${p.id}`)
      .send({ columns: CUSTOM });
    expect(res.status).toBe(401);
  });

  it('PUT /api/projects/:id/columns updates columns without auth (human action)', async () => {
    const p = service.createProject('p');
    const res = await request(app)
      .put(`/api/projects/${p.id}/columns`)
      .send({ columns: CUSTOM });
    expect(res.status).toBe(200);
    expect(res.body.columns).toEqual(CUSTOM);
  });

  it('PUT /api/projects/:id/columns returns 400 when tickets would be stranded', async () => {
    const p = service.createProject('p');
    service.createTicket(p.id, 'a', '', 'in_review');
    const res = await request(app)
      .put(`/api/projects/${p.id}/columns`)
      .send({ columns: CUSTOM });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/in_review/);
  });
});
