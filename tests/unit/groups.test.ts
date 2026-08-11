import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createTicketRoutes, createHumanTicketRoutes } from '../../src/api/routes/tickets.js';
import { ConflictError, ValidationError } from '../../src/services/errors.js';

// ---------------------------------------------------------------------------
// DB layer: group column, migration, queries, revisions
// ---------------------------------------------------------------------------

describe('Ticket groups – DB layer', () => {
  let db: AgentboardDB;
  let projectId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    projectId = db.createProject('p').id;
  });

  afterEach(() => {
    db.close();
  });

  it('creates a ticket without group (null)', () => {
    const t = db.createTicket(projectId, 'solo');
    expect(t.group).toBeNull();
  });

  it('creates a ticket with group', () => {
    const t = db.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
    expect(t.group).toBe('menu');
  });

  it('persists group across reads', () => {
    const t = db.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
    expect(db.getTicket(projectId, t.id)?.group).toBe('menu');
  });

  it('getTicketsByGroup returns only tickets of that group in that project', () => {
    db.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
    db.createTicket(projectId, 'b', '', 'ready', null, 'menu');
    db.createTicket(projectId, 'c', '', 'backlog', null, 'other');
    db.createTicket(projectId, 'd');
    const otherProject = db.createProject('p2').id;
    db.createTicket(otherProject, 'e', '', 'backlog', null, 'menu');

    const group = db.getTicketsByGroup(projectId, 'menu');
    expect(group.map((t) => t.title).sort()).toEqual(['a', 'b']);
  });

  it('updateTicket sets and clears group and logs revisions', () => {
    const t = db.createTicket(projectId, 'a');

    const updated = db.updateTicket(projectId, t.id, { group: 'menu' });
    expect(updated?.group).toBe('menu');

    const cleared = db.updateTicket(projectId, t.id, { group: null });
    expect(cleared?.group).toBeNull();

    const revisions = db.getRevisionsByTicket(t.id).filter((r) => r.field === 'group');
    expect(revisions).toHaveLength(2);
    expect(revisions[0]).toMatchObject({ oldValue: '', newValue: 'menu' });
    expect(revisions[1]).toMatchObject({ oldValue: 'menu', newValue: '' });
  });

  it('updateTicket without group key leaves group unchanged and logs no group revision', () => {
    const t = db.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
    const updated = db.updateTicket(projectId, t.id, { title: 'b' });
    expect(updated?.group).toBe('menu');
    expect(db.getRevisionsByTicket(t.id).filter((r) => r.field === 'group')).toHaveLength(0);
  });

  it('migrates an existing database without group_name column', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-test-'));
    const dbPath = path.join(dir, 'old.db');

    // Simulate a pre-groups database: tickets table without group_name
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE tickets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        column_name TEXT NOT NULL DEFAULT 'backlog',
        position INTEGER NOT NULL DEFAULT 0,
        agent_id TEXT,
        assignee_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO tickets (id, project_id, title) VALUES ('t1', 'p1', 'legacy');
    `);
    raw.close();

    const migrated = new AgentboardDB(dbPath);
    const legacy = migrated.getTicket('p1', 't1');
    expect(legacy?.group).toBeNull();

    // Re-opening (column already present) must not fail
    migrated.close();
    const reopened = new AgentboardDB(dbPath);
    expect(reopened.getTicket('p1', 't1')?.group).toBeNull();
    reopened.close();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Service layer: validation + group claim rule
// ---------------------------------------------------------------------------

describe('Ticket groups – service layer', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let projectId: string;
  let agentA: string;
  let agentB: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    projectId = db.createProject('p').id;
    agentA = db.createAgent('agent-a').id;
    agentB = db.createAgent('agent-b').id;
  });

  afterEach(() => {
    db.close();
  });

  describe('createTicket', () => {
    it('accepts a group and trims it', () => {
      const t = service.createTicket(projectId, 'a', '', 'backlog', null, '  menu  ');
      expect(t.group).toBe('menu');
    });

    it('treats empty/whitespace group as no group', () => {
      expect(service.createTicket(projectId, 'a', '', 'backlog', null, '').group).toBeNull();
      expect(service.createTicket(projectId, 'b', '', 'backlog', null, '   ').group).toBeNull();
      expect(service.createTicket(projectId, 'c', '', 'backlog', null, null).group).toBeNull();
      expect(service.createTicket(projectId, 'd').group).toBeNull();
    });

    it('rejects a non-string group', () => {
      expect(() =>
        service.createTicket(projectId, 'a', '', 'backlog', null, 42 as unknown as string),
      ).toThrow(ValidationError);
    });
  });

  describe('updateTicket', () => {
    it('sets, trims and clears the group', () => {
      const t = service.createTicket(projectId, 'a');
      expect(service.updateTicket(projectId, t.id, { group: ' menu ' }).group).toBe('menu');
      expect(service.updateTicket(projectId, t.id, { group: '' }).group).toBeNull();
      expect(service.updateTicket(projectId, t.id, { group: 'menu' }).group).toBe('menu');
      expect(service.updateTicket(projectId, t.id, { group: null }).group).toBeNull();
    });

    it('rejects a non-string, non-null group', () => {
      const t = service.createTicket(projectId, 'a');
      expect(() =>
        service.updateTicket(projectId, t.id, { group: 42 as unknown as string }),
      ).toThrow(ValidationError);
    });

    it('leaves group untouched when not part of the updates', () => {
      const t = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      expect(service.updateTicket(projectId, t.id, { title: 'b' }).group).toBe('menu');
    });

    it('rejects moving an assigned ticket into a group claimed by another agent', () => {
      const claimed = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      service.assignTicket(projectId, claimed.id, agentA);

      const foreign = service.createTicket(projectId, 'b');
      service.assignTicket(projectId, foreign.id, agentB);

      expect(() => service.updateTicket(projectId, foreign.id, { group: 'menu' })).toThrow(
        ConflictError,
      );
    });

    it('allows moving an unassigned ticket into a claimed group', () => {
      const claimed = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      service.assignTicket(projectId, claimed.id, agentA);

      const free = service.createTicket(projectId, 'b');
      expect(service.updateTicket(projectId, free.id, { group: 'menu' }).group).toBe('menu');
    });

    it("allows moving the claimer's own ticket into their claimed group", () => {
      const claimed = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      service.assignTicket(projectId, claimed.id, agentA);

      const own = service.createTicket(projectId, 'b');
      service.assignTicket(projectId, own.id, agentA);
      expect(service.updateTicket(projectId, own.id, { group: 'menu' }).group).toBe('menu');
    });

    it('does not run the claim check when the group stays the same', () => {
      const a = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      const b = service.createTicket(projectId, 'b', '', 'backlog', null, 'menu');
      service.assignTicket(projectId, a.id, agentA);
      service.assignTicket(projectId, b.id, agentA);
      // b keeps its group while claimed – must not throw
      expect(service.updateTicket(projectId, b.id, { group: 'menu', title: 'b2' }).title).toBe('b2');
    });
  });

  describe('assignTicket – claim rule', () => {
    it('lets the first agent claim a free group', () => {
      const t = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      expect(service.assignTicket(projectId, t.id, agentA).assigneeId).toBe(agentA);
    });

    it('blocks a second agent from taking a ticket of a claimed group', () => {
      const a = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      const b = service.createTicket(projectId, 'b', '', 'backlog', null, 'menu');
      service.assignTicket(projectId, a.id, agentA);

      expect(() => service.assignTicket(projectId, b.id, agentB)).toThrow(ConflictError);
      expect(() => service.assignTicket(projectId, b.id, agentB)).toThrow(/claimed by agent "agent-a"/);
    });

    it('lets the claiming agent take further tickets of the group', () => {
      const a = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      const b = service.createTicket(projectId, 'b', '', 'backlog', null, 'menu');
      service.assignTicket(projectId, a.id, agentA);
      expect(service.assignTicket(projectId, b.id, agentA).assigneeId).toBe(agentA);
    });

    it('does not affect tickets without a group', () => {
      const a = service.createTicket(projectId, 'a');
      const b = service.createTicket(projectId, 'b');
      service.assignTicket(projectId, a.id, agentA);
      expect(service.assignTicket(projectId, b.id, agentB).assigneeId).toBe(agentB);
    });

    it('does not conflict across different groups', () => {
      const a = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      const b = service.createTicket(projectId, 'b', '', 'backlog', null, 'search');
      service.assignTicket(projectId, a.id, agentA);
      expect(service.assignTicket(projectId, b.id, agentB).assigneeId).toBe(agentB);
    });

    it('does not conflict across projects with the same group name', () => {
      const otherProject = db.createProject('p2').id;
      const a = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      const b = service.createTicket(otherProject, 'b', '', 'backlog', null, 'menu');
      service.assignTicket(projectId, a.id, agentA);
      expect(service.assignTicket(otherProject, b.id, agentB).assigneeId).toBe(agentB);
    });

    it('releases the claim when the assigned ticket is unassigned', () => {
      const a = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      const b = service.createTicket(projectId, 'b', '', 'backlog', null, 'menu');
      service.assignTicket(projectId, a.id, agentA);
      service.unassignTicket(projectId, a.id);
      expect(service.assignTicket(projectId, b.id, agentB).assigneeId).toBe(agentB);
    });

    it('releases the claim when all assigned group tickets are done', () => {
      const a = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      const b = service.createTicket(projectId, 'b', '', 'backlog', null, 'menu');
      service.assignTicket(projectId, a.id, agentA);
      service.moveTicket(projectId, a.id, 'done');
      expect(service.assignTicket(projectId, b.id, agentB).assigneeId).toBe(agentB);
    });

    it('keeps the claim while at least one assigned group ticket is not done', () => {
      const a = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      const b = service.createTicket(projectId, 'b', '', 'backlog', null, 'menu');
      const c = service.createTicket(projectId, 'c', '', 'backlog', null, 'menu');
      service.assignTicket(projectId, a.id, agentA);
      service.assignTicket(projectId, b.id, agentA);
      service.moveTicket(projectId, a.id, 'done');
      expect(() => service.assignTicket(projectId, c.id, agentB)).toThrow(ConflictError);
    });

    it('ignores the ticket itself when checking the claim (takeover of a single ticket)', () => {
      // Only one ticket in the group, assigned to A. B may take it over –
      // same semantics as stealing an ungrouped ticket.
      const a = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      service.assignTicket(projectId, a.id, agentA);
      expect(service.assignTicket(projectId, a.id, agentB).assigneeId).toBe(agentB);
    });

    it('mentions the group claim in the activity log', () => {
      const a = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
      service.assignTicket(projectId, a.id, agentA, agentA);
      const activities = service.getActivitiesByProject(projectId);
      expect(activities.some((act) => act.details.includes('claims group "menu"'))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// REST routes: group passthrough + 409 mapping
// ---------------------------------------------------------------------------

describe('Ticket groups – REST routes', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let app: express.Express;
  let apiKeyA: string;
  let apiKeyB: string;
  let agentB: string;
  let projectId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    app = express();
    app.use(express.json());
    app.use('/api/projects/:id', createTicketRoutes(service));
    app.use('/api/projects/:id', createHumanTicketRoutes(service));

    apiKeyA = db.createAgent('bot-a').apiKey;
    const b = db.createAgent('bot-b');
    apiKeyB = b.apiKey;
    agentB = b.id;
    projectId = db.createProject('p').id;
  });

  afterEach(() => {
    db.close();
  });

  it('creates a ticket with group via POST', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-Api-Key', apiKeyA)
      .send({ title: 'a', group: 'menu' });
    expect(res.status).toBe(201);
    expect(res.body.group).toBe('menu');
  });

  it('creates a ticket without group via POST', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-Api-Key', apiKeyA)
      .send({ title: 'a' });
    expect(res.status).toBe(201);
    expect(res.body.group).toBeNull();
  });

  it('sets and clears group via PATCH', async () => {
    const t = service.createTicket(projectId, 'a');

    const set = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${t.id}`)
      .set('X-Api-Key', apiKeyA)
      .send({ group: 'menu' });
    expect(set.status).toBe(200);
    expect(set.body.group).toBe('menu');

    const clear = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${t.id}`)
      .set('X-Api-Key', apiKeyA)
      .send({ group: null });
    expect(clear.status).toBe(200);
    expect(clear.body.group).toBeNull();
  });

  it('returns 409 when assigning a ticket of a claimed group', async () => {
    const claimerId = db.getAgentByApiKey(apiKeyA)!.id;
    const a = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
    const b = service.createTicket(projectId, 'b', '', 'backlog', null, 'menu');
    service.assignTicket(projectId, a.id, claimerId);

    const res = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${b.id}/assign`)
      .set('X-Api-Key', apiKeyB)
      .send({ assignee_id: agentB });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('claimed by agent "bot-a"');
  });

  it('returns 409 on the human assign route for a claimed group', async () => {
    const claimerId = db.getAgentByApiKey(apiKeyA)!.id;
    const a = service.createTicket(projectId, 'a', '', 'backlog', null, 'menu');
    const b = service.createTicket(projectId, 'b', '', 'backlog', null, 'menu');
    service.assignTicket(projectId, a.id, claimerId);

    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets/${b.id}/assign`)
      .send({ assignee_id: agentB });
    expect(res.status).toBe(409);
  });

  it('returns 400 for an invalid group type via PATCH', async () => {
    const t = service.createTicket(projectId, 'a');
    const res = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${t.id}`)
      .set('X-Api-Key', apiKeyA)
      .send({ group: 42 });
    expect(res.status).toBe(400);
  });
});
