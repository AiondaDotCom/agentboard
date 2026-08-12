import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createTicketRoutes, createHumanTicketRoutes } from '../../src/api/routes/tickets.js';
import { NotFoundError, ValidationError, ConflictError } from '../../src/services/errors.js';

// ---------------------------------------------------------------------------
// Service layer: depends_on validation + movement gate
// ---------------------------------------------------------------------------

describe('Ticket dependencies – service layer', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let projectId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    projectId = service.createProject('p').id;
  });

  afterEach(() => {
    db.close();
  });

  describe('setting dependencies', () => {
    it('stores dependencies on create and resolves short ids', () => {
      const a = service.createTicket(projectId, 'A');
      const b = service.createTicket(projectId, 'B', '', undefined, null, null, null, [a.id.slice(0, 8)]);
      expect(b.dependsOn).toEqual([a.id]);
    });

    it('replaces and clears dependencies on update', () => {
      const a = service.createTicket(projectId, 'A');
      const b = service.createTicket(projectId, 'B');
      const c = service.createTicket(projectId, 'C');

      expect(service.updateTicket(projectId, c.id, { dependsOn: [a.id, b.id] }).dependsOn.sort()).toEqual([a.id, b.id].sort());
      expect(service.updateTicket(projectId, c.id, { dependsOn: [b.id] }).dependsOn).toEqual([b.id]);
      expect(service.updateTicket(projectId, c.id, { dependsOn: [] }).dependsOn).toEqual([]);
    });

    it('deduplicates dependency ids', () => {
      const a = service.createTicket(projectId, 'A');
      const b = service.createTicket(projectId, 'B');
      expect(service.updateTicket(projectId, b.id, { dependsOn: [a.id, a.id] }).dependsOn).toEqual([a.id]);
    });

    it('rejects unknown dependency tickets', () => {
      const a = service.createTicket(projectId, 'A');
      expect(() => service.updateTicket(projectId, a.id, { dependsOn: ['nope'] })).toThrow(NotFoundError);
    });

    it('rejects dependencies from another project', () => {
      const other = service.createProject('other').id;
      const foreign = service.createTicket(other, 'foreign');
      const a = service.createTicket(projectId, 'A');
      expect(() => service.updateTicket(projectId, a.id, { dependsOn: [foreign.id] })).toThrow(NotFoundError);
    });

    it('rejects self-dependencies', () => {
      const a = service.createTicket(projectId, 'A');
      expect(() => service.updateTicket(projectId, a.id, { dependsOn: [a.id] })).toThrow(ValidationError);
    });

    it('rejects non-array depends_on', () => {
      const a = service.createTicket(projectId, 'A');
      expect(() => service.updateTicket(projectId, a.id, { dependsOn: 'x' })).toThrow(ValidationError);
    });

    it('rejects direct dependency cycles (A→B, B→A)', () => {
      const a = service.createTicket(projectId, 'A');
      const b = service.createTicket(projectId, 'B');
      service.updateTicket(projectId, a.id, { dependsOn: [b.id] });
      expect(() => service.updateTicket(projectId, b.id, { dependsOn: [a.id] })).toThrow(/cycle/i);
    });

    it('accepts diamond dependencies (B→D, C→D, A→[B,C])', () => {
      const d = service.createTicket(projectId, 'D');
      const b = service.createTicket(projectId, 'B', '', undefined, null, null, null, [d.id]);
      const c = service.createTicket(projectId, 'C', '', undefined, null, null, null, [d.id]);
      const a = service.createTicket(projectId, 'A');
      expect(service.updateTicket(projectId, a.id, { dependsOn: [b.id, c.id] }).dependsOn.sort())
        .toEqual([b.id, c.id].sort());
    });

    it('rejects transitive dependency cycles (A→B→C, C→A)', () => {
      const a = service.createTicket(projectId, 'A');
      const b = service.createTicket(projectId, 'B');
      const c = service.createTicket(projectId, 'C');
      service.updateTicket(projectId, a.id, { dependsOn: [b.id] });
      service.updateTicket(projectId, b.id, { dependsOn: [c.id] });
      expect(() => service.updateTicket(projectId, c.id, { dependsOn: [a.id] })).toThrow(/cycle/i);
    });

    it('logs a revision when dependencies change', () => {
      const a = service.createTicket(projectId, 'A');
      const b = service.createTicket(projectId, 'B');
      service.updateTicket(projectId, b.id, { dependsOn: [a.id] });
      const revs = db.getRevisionsByTicket(b.id).filter((r) => r.field === 'depends_on');
      expect(revs).toHaveLength(1);
      expect(revs[0]!.newValue).toBe(a.id);
    });
  });

  describe('movement gate', () => {
    it('refuses to move a ticket with unfinished dependencies out of the first column', () => {
      const a = service.createTicket(projectId, 'Build backend');
      const b = service.createTicket(projectId, 'Build frontend', '', undefined, null, null, null, [a.id]);

      expect(() => service.moveTicket(projectId, b.id, 'in_progress')).toThrow(ConflictError);
    });

    it('explains WHICH tickets block the move and where they are', () => {
      const a = service.createTicket(projectId, 'Build backend', '', 'in_progress');
      const b = service.createTicket(projectId, 'Build frontend', '', undefined, null, null, null, [a.id]);

      try {
        service.moveTicket(projectId, b.id, 'in_progress');
        expect.unreachable('move should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ConflictError);
        const msg = (err as Error).message;
        expect(msg).toContain('Build backend');
        expect(msg).toContain(a.id.slice(0, 8));
        expect(msg).toContain('in in_progress');
        expect(msg).toContain('done');
      }
    });

    it('also gates updateTicket column changes and human close', () => {
      const a = service.createTicket(projectId, 'A');
      const b = service.createTicket(projectId, 'B', '', undefined, null, null, null, [a.id]);

      expect(() => service.updateTicket(projectId, b.id, { column: 'in_review' })).toThrow(ConflictError);
      expect(() => service.closeTicket(projectId, b.id)).toThrow(ConflictError);
    });

    it('refuses creating a ticket with open dependencies outside the first column', () => {
      const a = service.createTicket(projectId, 'A');
      expect(() =>
        service.createTicket(projectId, 'B', '', 'in_progress', null, null, null, [a.id]),
      ).toThrow(ConflictError);
    });

    it('allows the move once all dependencies are done', () => {
      const a = service.createTicket(projectId, 'A');
      const b = service.createTicket(projectId, 'B', '', undefined, null, null, null, [a.id]);

      service.moveTicket(projectId, a.id, 'done');
      expect(service.moveTicket(projectId, b.id, 'in_progress').column).toBe('in_progress');
    });

    it('allows moves within/into the first column despite open dependencies', () => {
      const a = service.createTicket(projectId, 'A');
      const b = service.createTicket(projectId, 'B', '', undefined, null, null, null, [a.id]);

      // Setting other fields without a column change is fine
      expect(service.updateTicket(projectId, b.id, { title: 'B2' }).title).toBe('B2');
      // Reopen (move to first column) is always allowed
      expect(service.openTicket(projectId, b.id).column).toBe('backlog');
    });

    it('gates again when a finished dependency is reopened', () => {
      const a = service.createTicket(projectId, 'A');
      const b = service.createTicket(projectId, 'B', '', undefined, null, null, null, [a.id]);

      service.moveTicket(projectId, a.id, 'done');
      service.moveTicket(projectId, b.id, 'in_progress');

      // Dependency gets reopened → B cannot advance further
      service.openTicket(projectId, a.id);
      expect(() => service.moveTicket(projectId, b.id, 'in_review')).toThrow(ConflictError);
    });

    it('removing the dependency unblocks the ticket', () => {
      const a = service.createTicket(projectId, 'A');
      const b = service.createTicket(projectId, 'B', '', undefined, null, null, null, [a.id]);

      service.updateTicket(projectId, b.id, { dependsOn: [] });
      expect(service.moveTicket(projectId, b.id, 'in_progress').column).toBe('in_progress');
    });

    it('works across groups (dependency in a different group)', () => {
      const a = service.createTicket(projectId, 'A', '', 'backlog', null, 'group-one');
      const b = service.createTicket(projectId, 'B', '', 'backlog', null, 'group-two', null, [a.id]);

      expect(() => service.moveTicket(projectId, b.id, 'in_progress')).toThrow(ConflictError);
      service.moveTicket(projectId, a.id, 'done');
      expect(service.moveTicket(projectId, b.id, 'in_progress').column).toBe('in_progress');
    });
  });

  describe('deletion', () => {
    it('deleting a dependency ticket removes the edge', () => {
      const a = service.createTicket(projectId, 'A');
      const b = service.createTicket(projectId, 'B', '', undefined, null, null, null, [a.id]);

      service.deleteTicket(projectId, a.id);
      expect(service.getTicket(projectId, b.id).dependsOn).toEqual([]);
      expect(service.moveTicket(projectId, b.id, 'in_progress').column).toBe('in_progress');
    });
  });
});

// ---------------------------------------------------------------------------
// REST layer
// ---------------------------------------------------------------------------

describe('Ticket dependencies – REST', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let app: express.Express;
  let apiKey: string;
  let projectId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    const agent = db.createAgent('bot');
    apiKey = agent.apiKey;
    projectId = service.createProject('p').id;

    app = express();
    app.use(express.json());
    app.use('/api/projects/:id', createTicketRoutes(service));
    app.use('/api/projects/:id', createHumanTicketRoutes(service));
  });

  afterEach(() => {
    db.close();
  });

  it('accepts depends_on and blocked_reason on create and returns them', async () => {
    const a = service.createTicket(projectId, 'A');
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-Api-Key', apiKey)
      .send({ title: 'B', depends_on: [a.id], blocked_reason: 'waiting for A' });

    expect(res.status).toBe(201);
    expect(res.body.dependsOn).toEqual([a.id]);
    expect(res.body.blockedReason).toBe('waiting for A');
  });

  it('returns 409 with an explanation when moving a gated ticket', async () => {
    const a = service.createTicket(projectId, 'Backend API');
    const b = service.createTicket(projectId, 'Frontend', '', undefined, null, null, null, [a.id]);

    const res = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${b.id}/move`)
      .set('X-Api-Key', apiKey)
      .send({ column: 'in_progress' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Backend API');
  });

  it('updates dependencies via PATCH', async () => {
    const a = service.createTicket(projectId, 'A');
    const b = service.createTicket(projectId, 'B');

    const res = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${b.id}`)
      .set('X-Api-Key', apiKey)
      .send({ depends_on: [a.id] });

    expect(res.status).toBe(200);
    expect(res.body.dependsOn).toEqual([a.id]);

    const cleared = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${b.id}`)
      .set('X-Api-Key', apiKey)
      .send({ depends_on: [] });

    expect(cleared.body.dependsOn).toEqual([]);
  });

  it('sets and clears blocked_reason via PATCH', async () => {
    const t = service.createTicket(projectId, 'T');
    const set = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${t.id}`)
      .set('X-Api-Key', apiKey)
      .send({ blocked_reason: 'missing test data' });
    expect(set.body.blockedReason).toBe('missing test data');

    const cleared = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${t.id}`)
      .set('X-Api-Key', apiKey)
      .send({ blocked_reason: '' });
    expect(cleared.body.blockedReason).toBeNull();
  });

  it('returns 400 for a dependency cycle', async () => {
    const a = service.createTicket(projectId, 'A');
    const b = service.createTicket(projectId, 'B', '', undefined, null, null, null, [a.id]);

    const res = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${a.id}`)
      .set('X-Api-Key', apiKey)
      .send({ depends_on: [b.id] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cycle/i);
  });
});
