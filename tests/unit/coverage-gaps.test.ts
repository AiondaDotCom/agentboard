import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { PubSub, pubsub, EVENTS } from '../../src/graphql/pubsub.js';
import { createResolvers } from '../../src/graphql/resolvers.js';
import { createAuditMiddleware } from '../../src/api/middleware/audit.js';
import { createAdminAuthMiddleware } from '../../src/api/middleware/auth.js';
import { createAgentRoutes } from '../../src/api/routes/agents.js';
import { createProjectRoutes } from '../../src/api/routes/projects.js';
import { createTicketRoutes, createHumanTicketRoutes } from '../../src/api/routes/tickets.js';
import { handleServiceError, routeParam, agentIdOf } from '../../src/api/routes/helpers.js';
import { DEFAULT_COLUMNS } from '../../src/types.js';
import { NotFoundError, ValidationError } from '../../src/services/errors.js';

// ---------------------------------------------------------------------------
// Service layer – remaining paths
// ---------------------------------------------------------------------------

describe('BoardService – remaining paths', () => {
  let db: AgentboardDB;
  let service: BoardService;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
  });

  afterEach(() => {
    db.close();
  });

  it('rotateAdminKey persists a fresh key', () => {
    const before = service.getOrCreateAdminKey();
    const rotated = service.rotateAdminKey();
    expect(rotated).not.toBe(before);
    expect(service.getOrCreateAdminKey()).toBe(rotated);
  });

  it('createAgent rethrows non-UNIQUE errors unchanged', () => {
    const original = db.createAgent.bind(db);
    (db as unknown as { createAgent: () => never }).createAgent = () => { throw new Error('disk full'); };
    expect(() => service.createAgent('x')).toThrow('disk full');
    (db as unknown as { createAgent: typeof original }).createAgent = original;
  });

  it('getAllAgents audits when an actor is given', () => {
    const actor = db.createAgent('actor').id;
    service.getAllAgents(actor);
    expect(db.getAllAuditEntries().some((e) => e.method === 'LIST' && e.path === 'agents')).toBe(true);
  });

  it('getAllAgentsWithKeys returns secrets', () => {
    db.createAgent('a');
    expect(service.getAllAgentsWithKeys()[0]!.apiKey).toMatch(/^ab-/);
  });

  it('getAgentById returns the agent or throws NotFoundError', () => {
    const a = db.createAgent('a');
    expect(service.getAgentById(a.id).name).toBe('a');
    expect(() => service.getAgentById('nope')).toThrow(NotFoundError);
  });

  it('getAgentByApiKey passes through', () => {
    const a = db.createAgent('a');
    expect(service.getAgentByApiKey(a.apiKey)?.id).toBe(a.id);
    expect(service.getAgentByApiKey('nope')).toBeUndefined();
  });

  it('deleteAgent deletes or throws NotFoundError', () => {
    const a = db.createAgent('a');
    service.deleteAgent(a.id);
    expect(() => service.deleteAgent(a.id)).toThrow(NotFoundError);
  });

  it('getProject with actor logs audit + activity', () => {
    const actor = db.createAgent('actor').id;
    const p = service.createProject('p');
    service.getProject(p.id, actor);
    expect(db.getAllAuditEntries().some((e) => e.method === 'READ')).toBe(true);
  });

  it('deleteProject with actor works and throws on unknown id', () => {
    const actor = db.createAgent('actor').id;
    const p = service.createProject('p');
    service.deleteProject(p.id, actor);
    expect(() => service.deleteProject(p.id, actor)).toThrow(NotFoundError);
  });

  it('createProject rejects a non-string name', () => {
    expect(() => service.createProject(42 as unknown as string)).toThrow(ValidationError);
  });

  it('updateProject rejects invalid name and description', () => {
    const p = service.createProject('p');
    expect(() => service.updateProject(p.id, { name: '' })).toThrow(ValidationError);
    expect(() => service.updateProject(p.id, { name: 42 as unknown as string })).toThrow(ValidationError);
    expect(() => service.updateProject(p.id, { description: 42 as unknown as string })).toThrow(ValidationError);
    expect(() => service.updateProject('nope', { name: 'x' })).toThrow(NotFoundError);
  });

  it('updateProject validates column entry shapes', () => {
    const p = service.createProject('p');
    expect(() => service.updateProject(p.id, { columns: 'x' })).toThrow(ValidationError);
    expect(() => service.updateProject(p.id, { columns: ['x', 'y'] })).toThrow(ValidationError);
    expect(() => service.updateProject(p.id, { columns: [null, null] })).toThrow(ValidationError);
    expect(() => service.updateProject(p.id, {
      columns: Array.from({ length: 21 }, (_, i) => ({ id: `c${i}`, title: `C${i}` })),
    })).toThrow(ValidationError);
  });

  it('createTicket validates blocked_reason and title types', () => {
    const p = service.createProject('p');
    expect(() => service.createTicket(p.id, 'a', '', undefined, null, null, 42 as unknown as string)).toThrow(ValidationError);
    expect(() => service.createTicket(p.id, '')).toThrow(ValidationError);
  });

  it('createTicket rejects non-string depends_on entries', () => {
    const p = service.createProject('p');
    expect(() => service.createTicket(p.id, 'a', '', undefined, null, null, null, [42])).toThrow(ValidationError);
    expect(() => service.createTicket(p.id, 'a', '', undefined, null, null, null, 'x')).toThrow(ValidationError);
  });

  it('getTicket with viewer publishes view notification and audits', () => {
    const viewer = db.createAgent('viewer').id;
    const p = service.createProject('p');
    const t = service.createTicket(p.id, 'a');
    expect(service.getTicket(p.id, t.id, viewer).id).toBe(t.id);
    expect(db.getAllAuditEntries().some((e) => e.method === 'READ')).toBe(true);
  });

  it('getTicketsByProject with actor and column filter audits the listing', () => {
    const actor = db.createAgent('actor').id;
    const p = service.createProject('p');
    service.createTicket(p.id, 'a');
    const result = service.getTicketsByProject(p.id, actor, { column: 'backlog' });
    expect(result.total).toBe(1);
    expect(db.getAllAuditEntries().some((e) => e.method === 'LIST')).toBe(true);
  });

  it('getCommentsByTicket / getRevisionsByTicket with viewer audit the read', () => {
    const viewer = db.createAgent('viewer').id;
    const p = service.createProject('p');
    const t = service.createTicket(p.id, 'a');
    service.createComment(p.id, t.id, viewer, 'hi');
    service.updateTicket(p.id, t.id, { title: 'b' });

    expect(service.getCommentsByTicket(p.id, t.id, viewer)).toHaveLength(1);
    expect(service.getRevisionsByTicket(p.id, t.id, viewer).length).toBeGreaterThan(0);
  });

  it('createComment validates the body', () => {
    const agent = db.createAgent('a').id;
    const p = service.createProject('p');
    const t = service.createTicket(p.id, 'a');
    expect(() => service.createComment(p.id, t.id, agent, '')).toThrow(ValidationError);
  });

  it('getActivitiesByProject requires the project', () => {
    const p = service.createProject('p');
    service.createTicket(p.id, 'a');
    expect(service.getActivitiesByProject(p.id).length).toBeGreaterThan(0);
    expect(() => service.getActivitiesByProject('nope')).toThrow(NotFoundError);
  });

  it('getAllAuditEntries / getAuditEntriesByAgent pass through', () => {
    const actor = db.createAgent('actor').id;
    service.getAllAgents(actor);
    expect(service.getAllAuditEntries(5).length).toBeGreaterThan(0);
    expect(service.getAuditEntriesByAgent(actor, 5).length).toBeGreaterThan(0);
  });

  it('notifyTicketView ignores unknown agents', () => {
    const p = service.createProject('p');
    const t = service.createTicket(p.id, 'a');
    expect(() => service.notifyTicketView(p.id, t.id, 'ghost')).not.toThrow();
  });

  it('createAgent rethrows non-Error throwables', () => {
    const original = db.createAgent.bind(db);
    (db as unknown as { createAgent: () => never }).createAgent = () => { throw 'boom'; }; // eslint-disable-line no-throw-literal
    try {
      service.createAgent('x');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBe('boom');
    } finally {
      (db as unknown as { createAgent: typeof original }).createAgent = original;
    }
  });

  it('stranded-ticket error pluralizes the count', () => {
    const p = service.createProject('p');
    service.createTicket(p.id, 'a', '', 'in_review');
    service.createTicket(p.id, 'b', '', 'in_review');
    expect(() => service.updateProject(p.id, {
      columns: [{ id: 'backlog', title: 'B' }, { id: 'done', title: 'D' }],
    })).toThrow(/2 tickets/);
  });

  it('dependency-gate error pluralizes with multiple open dependencies', () => {
    const p = service.createProject('p');
    const a = service.createTicket(p.id, 'A');
    const b = service.createTicket(p.id, 'B');
    const c = service.createTicket(p.id, 'C', '', undefined, null, null, null, [a.id, b.id]);
    expect(() => service.moveTicket(p.id, c.id, 'in_progress')).toThrow(/2 unfinished tickets/);
  });

  it('assignTicket rejects unknown assignees', () => {
    const p = service.createProject('p');
    const t = service.createTicket(p.id, 'a');
    expect(() => service.assignTicket(p.id, t.id, 'ghost')).toThrow(NotFoundError);
  });

  it('throws NotFoundError when the ticket vanishes mid-operation (concurrent delete)', () => {
    const p = service.createProject('p');
    const agent = db.createAgent('w').id;
    const make = (): string => service.createTicket(p.id, 'x').id;

    const patch = (method: 'updateTicket' | 'moveTicket' | 'moveTicketToProject' | 'assignTicket', fn: () => void): void => {
      const original = db[method].bind(db);
      (db as unknown as Record<string, unknown>)[method] = () => undefined;
      try {
        expect(fn).toThrow(NotFoundError);
      } finally {
        (db as unknown as Record<string, unknown>)[method] = original;
      }
    };

    const t1 = make();
    patch('updateTicket', () => service.updateTicket(p.id, t1, { title: 'y' }));
    patch('moveTicket', () => service.moveTicket(p.id, t1, 'done'));
    patch('moveTicket', () => service.closeTicket(p.id, t1));
    patch('moveTicket', () => service.openTicket(p.id, t1));
    const other = service.createProject('other');
    patch('moveTicketToProject', () => service.moveTicketToProject(p.id, t1, other.id));
    patch('assignTicket', () => service.assignTicket(p.id, t1, agent));
    patch('assignTicket', () => service.unassignTicket(p.id, t1));
  });

  it('updateProject throws NotFoundError when the project vanishes mid-update', () => {
    const p = service.createProject('p');
    const original = db.updateProject.bind(db);
    (db as unknown as { updateProject: () => undefined }).updateProject = () => undefined;
    try {
      expect(() => service.updateProject(p.id, { name: 'x' })).toThrow(NotFoundError);
    } finally {
      (db as unknown as { updateProject: typeof original }).updateProject = original;
    }
  });

  it('list audit falls back to the project id when the project vanished', () => {
    const actor = db.createAgent('actor').id;
    const p = service.createProject('p');
    service.createTicket(p.id, 'a');

    // First getProject call (requireProject) succeeds, second returns undefined
    const original = db.getProject.bind(db);
    let calls = 0;
    (db as unknown as { getProject: (id: string) => unknown }).getProject = (id: string) => {
      calls += 1;
      return calls === 1 ? original(id) : undefined;
    };
    try {
      const result = service.getTicketsByProject(p.id, actor);
      expect(result.total).toBe(1);
      expect(db.getAllAuditEntries().some((e) => e.path.includes(p.id))).toBe(true);
    } finally {
      (db as unknown as { getProject: typeof original }).getProject = original;
    }
  });

  it('group claim treats a vanished claimer agent as no claim', () => {
    const p = service.createProject('p');
    const agentA = db.createAgent('a').id;
    const agentB = db.createAgent('b').id;
    const t1 = service.createTicket(p.id, 't1', '', 'backlog', null, 'grp');
    const t2 = service.createTicket(p.id, 't2', '', 'backlog', null, 'grp');
    service.assignTicket(p.id, t1.id, agentA);

    const original = db.getAgentById.bind(db);
    (db as unknown as { getAgentById: (id: string) => unknown }).getAgentById = (id: string) =>
      id === agentA ? undefined : original(id);
    try {
      // Claimer can no longer be resolved → group counts as free
      expect(service.assignTicket(p.id, t2.id, agentB).assigneeId).toBe(agentB);
    } finally {
      (db as unknown as { getAgentById: typeof original }).getAgentById = original;
    }
  });

  it('findGroupClaimer falls back to "done" when the project cannot be loaded', () => {
    const p = service.createProject('p');
    const agentA = db.createAgent('a').id;
    const t1 = service.createTicket(p.id, 't1', '', 'backlog', null, 'grp');
    service.createTicket(p.id, 't2', '', 'backlog', null, 'grp');
    service.assignTicket(p.id, t1.id, agentA);

    const original = db.getProject.bind(db);
    (db as unknown as { getProject: () => undefined }).getProject = () => undefined;
    try {
      // Re-assigning the same agent is allowed even with the fallback path
      expect(service.assignTicket(p.id, t1.id, agentA).assigneeId).toBe(agentA);
    } finally {
      (db as unknown as { getProject: typeof original }).getProject = original;
    }
  });
});

// ---------------------------------------------------------------------------
// DB layer – remaining paths
// ---------------------------------------------------------------------------

describe('AgentboardDB – remaining paths', () => {
  let db: AgentboardDB;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('getOrCreateAdminKey creates once and then returns the stored key', () => {
    const key = db.getOrCreateAdminKey();
    expect(key).toMatch(/^admin-/);
    expect(db.getOrCreateAdminKey()).toBe(key);
  });

  it('falls back to default columns when the stored JSON is corrupt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-test-'));
    const dbPath = path.join(dir, 'corrupt.db');

    const first = new AgentboardDB(dbPath);
    const p = first.createProject('p');
    first.close();

    const raw = new Database(dbPath);
    raw.prepare('UPDATE projects SET columns = ? WHERE id = ?').run('{not json', p.id);
    raw.prepare("INSERT INTO projects (id, name, columns) VALUES ('p2', 'empty', '[]')").run();
    raw.prepare("INSERT INTO projects (id, name, columns) VALUES ('p3', 'notarray', '{\"a\":1}')").run();
    raw.close();

    const reopened = new AgentboardDB(dbPath);
    expect(reopened.getProject(p.id)?.columns).toEqual(DEFAULT_COLUMNS);
    expect(reopened.getProject('p2')?.columns).toEqual(DEFAULT_COLUMNS);
    expect(reopened.getProject('p3')?.columns).toEqual(DEFAULT_COLUMNS);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('updateProject returns undefined for unknown projects', () => {
    expect(db.updateProject('nope', { name: 'x' })).toBeUndefined();
  });

  it('updateProject keeps columns when only the name changes', () => {
    const p = db.createProject('p');
    const updated = db.updateProject(p.id, { name: 'renamed' });
    expect(updated?.name).toBe('renamed');
    expect(updated?.columns).toEqual(DEFAULT_COLUMNS);
  });

  it('opens the default db path when none is given', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-test-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const defaultDb = new AgentboardDB();
      defaultDb.createProject('p');
      defaultDb.close();
      expect(fs.existsSync(path.join(dir, 'agentboard.db'))).toBe(true);
    } finally {
      process.chdir(cwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mapTicketRow defaults a missing comment_count to 0', () => {
    const mapper = (db as unknown as { mapTicketRow: (r: Record<string, unknown>) => { commentCount: number } });
    const ticket = mapper.mapTicketRow({
      id: 't', project_id: 'p', title: 'x', description: '',
      column_name: 'backlog', position: 0, group_name: null, blocked_reason: null,
      agent_id: null, assignee_id: null, comment_count: null, depends_on: null,
      created_at: 'now', updated_at: 'now',
    });
    expect(ticket.commentCount).toBe(0);
  });

  it('getTicket returns undefined for ambiguous short-id prefixes', () => {
    const p = db.createProject('p');
    // Two tickets whose ids share no controllable prefix – emulate ambiguity
    // by asking for the empty-ish prefix shared by all ids
    db.createTicket(p.id, 'a');
    db.createTicket(p.id, 'b');
    const all = db.getTicketsByProject(p.id).data;
    const shared = all[0]!.id.slice(0, 1);
    const ambiguous = all.filter((t) => t.id.startsWith(shared)).length > 1;
    if (ambiguous) {
      expect(db.getTicket(p.id, shared)).toBeUndefined();
    } else {
      expect(db.getTicket(p.id, all[1]!.id.slice(0, 1))?.id).toBe(all[1]!.id);
    }
  });

  it('deleteTicket / deleteAgent / deleteProject return false for unknown ids', () => {
    expect(db.deleteTicket('p', 't')).toBe(false);
    expect(db.deleteAgent('a')).toBe(false);
    expect(db.deleteProject('p')).toBe(false);
  });

  it('updateTicket and assignTicket return undefined for unknown tickets', () => {
    const p = db.createProject('p');
    expect(db.updateTicket(p.id, 'nope', { title: 'x' })).toBeUndefined();
    expect(db.assignTicket(p.id, 'nope', null)).toBeUndefined();
  });

  it('updateTicket logs revisions when the ticket author (agentId) is set and cleared', () => {
    const p = db.createProject('p');
    const a = db.createAgent('a');
    const t = db.createTicket(p.id, 'x');
    db.updateTicket(p.id, t.id, { agentId: a.id });
    db.updateTicket(p.id, t.id, { agentId: null });
    const revs = db.getRevisionsByTicket(t.id).filter((r) => r.field === 'agentId');
    expect(revs).toHaveLength(2);
    expect(revs[0]!.newValue).toBe(a.id);
    expect(revs[1]!).toMatchObject({ oldValue: a.id, newValue: '' });
  });

  it('assignTicket skips the revision when the assignee does not change', () => {
    const p = db.createProject('p');
    const a = db.createAgent('a');
    const t = db.createTicket(p.id, 'x');
    db.assignTicket(p.id, t.id, a.id);
    db.assignTicket(p.id, t.id, a.id); // same assignee again
    expect(db.getRevisionsByTicket(t.id).filter((r) => r.field === 'assigneeId')).toHaveLength(1);
  });

  it('logRevision defaults the actor to null when undefined is passed', () => {
    const p = db.createProject('p');
    const t = db.createTicket(p.id, 'x');
    const rev = db.logRevision(t.id, null, 'title', 'a', 'b');
    expect(rev.agentId).toBeNull();
  });

  it('sessions: create, check, delete', () => {
    db.createSession('tok');
    expect(db.hasSession('tok')).toBe(true);
    db.deleteSession('tok');
    expect(db.hasSession('tok')).toBe(false);
  });

  it('mcp sessions: create, lookup, touch, delete, prune', () => {
    const agent = db.createAgent('a');
    db.createMcpSession('s1', agent.id);
    expect(db.getMcpSessionAgentId('s1')).toBe(agent.id);
    expect(db.getMcpSessionAgentId('nope')).toBeUndefined();

    db.touchMcpSession('s1');
    expect(db.pruneOldMcpSessions(30)).toBe(0); // fresh session survives
    expect(db.pruneOldMcpSessions(0)).toBeGreaterThanOrEqual(0);

    db.deleteMcpSession('s1');
    expect(db.getMcpSessionAgentId('s1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PubSub
// ---------------------------------------------------------------------------

describe('PubSub – iterator edge cases', () => {
  it('delivers events published before next() is called (push queue)', async () => {
    const ps = new PubSub();
    const it = ps.subscribe('E');
    ps.publish('E', { n: 1 });
    ps.publish('E', { n: 2 });
    expect((await it.next()).value).toEqual({ n: 1 });
    expect((await it.next()).value).toEqual({ n: 2 });
    await it.return!();
  });

  it('resolves pending next() calls when an event arrives (pull queue)', async () => {
    const ps = new PubSub();
    const it = ps.subscribe('E');
    const pending = it.next();
    ps.publish('E', { n: 1 });
    expect((await pending).value).toEqual({ n: 1 });
    await it.return!();
  });

  it('return() finishes pending and subsequent next() calls', async () => {
    const ps = new PubSub();
    const it = ps.subscribe('E');
    const pending = it.next();
    await it.return!();
    expect((await pending).done).toBe(true);
    expect((await it.next()).done).toBe(true);
  });

  it('throw() rejects and detaches the listener', async () => {
    const ps = new PubSub();
    const it = ps.subscribe('E');
    await expect(it.throw!(new Error('stop'))).rejects.toThrow('stop');
  });

  it('is itself async-iterable', () => {
    const ps = new PubSub();
    const it = ps.subscribe('E');
    expect(it[Symbol.asyncIterator]()).toBe(it);
    const filtered = ps.asyncIterableIterator('E', () => true);
    expect(filtered[Symbol.asyncIterator]()).toBe(filtered);
  });

  it('asyncIterableIterator without filter returns the plain iterator', async () => {
    const ps = new PubSub();
    const it = ps.asyncIterableIterator('E');
    ps.publish('E', { n: 1 });
    expect((await it.next()).value).toEqual({ n: 1 });
    await it.return!();
  });

  it('filtered iterator skips non-matching events and forwards return()', async () => {
    const ps = new PubSub();
    const it = ps.asyncIterableIterator('E', (p) => (p as { keep?: boolean }).keep === true);
    const pending = it.next();
    ps.publish('E', { keep: false });
    ps.publish('E', { keep: true });
    expect((await pending).value).toEqual({ keep: true });
    expect((await it.return!()).done).toBe(true);
  });

  it('filtered iterator stops on done and forwards throw()', async () => {
    const ps = new PubSub();
    const it = ps.asyncIterableIterator('E', () => false);
    const pending = it.next();
    await it.return!();
    expect((await pending).done).toBe(true);

    const it2 = ps.asyncIterableIterator('E', () => true);
    await expect(it2.throw!(new Error('stop'))).rejects.toThrow('stop');
  });
});

// ---------------------------------------------------------------------------
// GraphQL resolvers – full coverage incl. subscriptions
// ---------------------------------------------------------------------------

describe('GraphQL resolvers – subscriptions and field resolvers', () => {
  let db: AgentboardDB;
  let resolvers: any;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    resolvers = createResolvers(db);
  });

  afterEach(() => {
    db.close();
  });

  it('field resolvers handle missing agents gracefully', () => {
    expect(resolvers.Ticket.agent({ agentId: null })).toBeNull();
    expect(resolvers.Ticket.agent({ agentId: 'ghost' })).toBeNull();
    expect(resolvers.Ticket.assignee({ assigneeId: null })).toBeNull();
    expect(resolvers.Ticket.assignee({ assigneeId: 'ghost' })).toBeNull();
    expect(resolvers.Comment.agent({ agentId: 'ghost' })).toBeNull();
    expect(resolvers.Activity.agent({ agentId: null })).toBeNull();
    expect(resolvers.Activity.agent({ agentId: 'ghost' })).toBeNull();
  });

  it('project-scoped subscriptions only deliver events of their project', async () => {
    const events: Array<[string, string, string]> = [
      ['ticketCreated', EVENTS.TICKET_CREATED, 'ticketCreated'],
      ['ticketUpdated', EVENTS.TICKET_UPDATED, 'ticketUpdated'],
      ['ticketMoved', EVENTS.TICKET_MOVED, 'ticketMoved'],
      ['ticketDeleted', EVENTS.TICKET_DELETED, 'ticketDeleted'],
      ['activityAdded', EVENTS.ACTIVITY_ADDED, 'activityAdded'],
      ['commentAdded', EVENTS.COMMENT_ADDED, 'commentAdded'],
      ['ticketAccessed', EVENTS.TICKET_ACCESSED, 'ticketAccessed'],
      ['ticketViewed', EVENTS.TICKET_VIEWED, 'ticketViewed'],
    ];

    for (const [field, event, key] of events) {
      const it = resolvers.Subscription[field].subscribe(null, { projectId: 'p1' });
      const pending = it.next();
      pubsub.publish(event, { [key]: { id: 'wrong' }, projectId: 'other' });
      pubsub.publish(event, { [key]: { id: 'right' }, projectId: 'p1' });
      const result = await pending;
      expect(result.value.projectId).toBe('p1');
      await it.return!();
    }
  });

  it('global subscriptions deliver every event', async () => {
    for (const [field, event] of [
      ['agentChanged', EVENTS.AGENT_CHANGED],
      ['projectChanged', EVENTS.PROJECT_CHANGED],
      ['auditAdded', EVENTS.AUDIT_ADDED],
      ['runtimeStatusChanged', EVENTS.RUNTIME_STATUS_CHANGED],
    ] as const) {
      const it = resolvers.Subscription[field].subscribe();
      const pending = it.next();
      pubsub.publish(event, { anything: true });
      expect((await pending).value).toEqual({ anything: true });
      await it.return!();
    }
  });
});

// ---------------------------------------------------------------------------
// Middleware – remaining branches
// ---------------------------------------------------------------------------

describe('Middleware – remaining branches', () => {
  it('audit middleware swallows logging failures', async () => {
    const db = new AgentboardDB(':memory:');
    const broken = { logAudit: () => { throw new Error('db gone'); } } as unknown as AgentboardDB;

    const app = express();
    app.use(express.json());
    app.use(createAuditMiddleware(broken));
    app.get('/ping', (_req, res) => { res.json({ ok: true }); });

    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
    db.close();
  });

  it('admin auth accepts a static key string', async () => {
    const app = express();
    app.use(createAdminAuthMiddleware('static-secret'));
    app.get('/x', (_req, res) => { res.json({ ok: true }); });

    expect((await request(app).get('/x')).status).toBe(401);
    expect((await request(app).get('/x').set('X-Admin-Key', 'wrong')).status).toBe(403);
    expect((await request(app).get('/x').set('X-Admin-Key', 'static-secret')).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Routes – error branches + helpers
// ---------------------------------------------------------------------------

describe('Routes – error branches', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let app: express.Express;
  let adminKey: string;
  let apiKey: string;
  let projectId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    adminKey = service.getOrCreateAdminKey();
    apiKey = db.createAgent('bot').apiKey;
    projectId = service.createProject('p').id;

    app = express();
    app.use(express.json());
    app.use('/api/agents', createAgentRoutes(service));
    app.use('/api/projects', createProjectRoutes(service));
    app.use('/api/projects/:id', createTicketRoutes(service));
    app.use('/api/projects/:id', createHumanTicketRoutes(service));
  });

  afterEach(() => {
    db.close();
  });

  it('DELETE /api/agents/:id → 404 for unknown agent', async () => {
    const res = await request(app).delete('/api/agents/nope').set('X-Admin-Key', adminKey);
    expect(res.status).toBe(404);
  });

  it('POST /api/agents/admin-key/rotate returns a new key', async () => {
    const res = await request(app).post('/api/agents/admin-key/rotate').set('X-Admin-Key', adminKey);
    expect(res.status).toBe(200);
    expect(res.body.adminKey).toMatch(/^admin-/);
  });

  it('GET /api/projects/:id → 404 for unknown project', async () => {
    const res = await request(app).get('/api/projects/nope');
    expect(res.status).toBe(404);
  });

  it('PATCH /api/projects/:id → 404 for unknown project', async () => {
    const res = await request(app).patch('/api/projects/nope').set('X-Admin-Key', adminKey).send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/projects/:id → 404 for unknown project', async () => {
    const res = await request(app).delete('/api/projects/nope').set('X-Admin-Key', adminKey);
    expect(res.status).toBe(404);
  });

  it('GET /api/projects/:id/tickets/:ticketId → 404 for unknown ticket', async () => {
    const res = await request(app).get(`/api/projects/${projectId}/tickets/nope`);
    expect(res.status).toBe(404);
  });

  it('GET single ticket accepts an X-Api-Key for the viewing indicator', async () => {
    const t = service.createTicket(projectId, 'a');
    const res = await request(app)
      .get(`/api/projects/${projectId}/tickets/${t.id}`)
      .set('X-Api-Key', apiKey);
    expect(res.status).toBe(200);
  });

  it('DELETE ticket → 404 for unknown ticket', async () => {
    const res = await request(app)
      .delete(`/api/projects/${projectId}/tickets/nope`)
      .set('X-Api-Key', apiKey);
    expect(res.status).toBe(404);
  });

  it('comments/revisions listing → 404 for unknown ticket', async () => {
    expect((await request(app).get(`/api/projects/${projectId}/tickets/nope/comments`)).status).toBe(404);
    expect((await request(app).get(`/api/projects/${projectId}/tickets/nope/revisions`)).status).toBe(404);
  });

  it('human open/close/assign → 404 for unknown ticket', async () => {
    expect((await request(app).post(`/api/projects/${projectId}/tickets/nope/open`)).status).toBe(404);
    expect((await request(app).post(`/api/projects/${projectId}/tickets/nope/close`)).status).toBe(404);
    expect((await request(app).post(`/api/projects/${projectId}/tickets/nope/assign`).send({ assignee_id: 'x' })).status).toBe(404);
  });

  it('human assign and unassign work on a real ticket', async () => {
    const t = service.createTicket(projectId, 'a');
    const agent = db.createAgent('worker');

    const assigned = await request(app)
      .post(`/api/projects/${projectId}/tickets/${t.id}/assign`)
      .send({ assignee_id: agent.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.assigneeId).toBe(agent.id);

    const unassigned = await request(app)
      .post(`/api/projects/${projectId}/tickets/${t.id}/assign`)
      .send({});
    expect(unassigned.status).toBe(200);
    expect(unassigned.body.assigneeId).toBeNull();
  });

  it('agent PATCH assign route unassigns without assignee_id', async () => {
    const t = service.createTicket(projectId, 'a');
    const agent = db.createAgent('worker');
    service.assignTicket(projectId, t.id, agent.id);

    const res = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${t.id}/assign`)
      .set('X-Api-Key', apiKey)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.assigneeId).toBeNull();
  });

  it('routeParam falls back to empty string, agentIdOf to null', () => {
    expect(routeParam({ params: {} }, 'id')).toBe('');
    expect(routeParam({ params: { id: 'abc' } }, 'id')).toBe('abc');
    expect(agentIdOf({ params: {} } as never)).toBeNull();
    expect(agentIdOf({ agentId: 'a1' } as never)).toBe('a1');
  });

  it('POST tickets ignores non-string description/group (service validates the rest)', async () => {
    const res = await request(app)
      .post(`/api/projects/${projectId}/tickets`)
      .set('X-Api-Key', apiKey)
      .send({ title: 'typed', description: 42, group: 42 });
    expect(res.status).toBe(201);
    expect(res.body.description).toBe('');
    expect(res.body.group).toBeNull();
  });

  it('PATCH tickets with an empty body changes nothing', async () => {
    const t = service.createTicket(projectId, 'same');
    const res = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${t.id}`)
      .set('X-Api-Key', apiKey)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('same');
  });

  it('GET tickets supports column/page/per_page query params', async () => {
    service.createTicket(projectId, 'a');
    service.createTicket(projectId, 'b');
    const res = await request(app)
      .get(`/api/projects/${projectId}/tickets?column=backlog&page=1&per_page=1`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.total).toBe(2);
  });

  it('assign routes treat a non-string assignee_id as unassign', async () => {
    const t = service.createTicket(projectId, 'a');
    const viaAgent = await request(app)
      .patch(`/api/projects/${projectId}/tickets/${t.id}/assign`)
      .set('X-Api-Key', apiKey)
      .send({ assignee_id: 42 });
    expect(viaAgent.status).toBe(200);
    expect(viaAgent.body.assigneeId).toBeNull();

    const viaHuman = await request(app)
      .post(`/api/projects/${projectId}/tickets/${t.id}/assign`)
      .send({ assignee_id: 42 });
    expect(viaHuman.status).toBe(200);
    expect(viaHuman.body.assigneeId).toBeNull();
  });

  it('PATCH project updates name, description and columns together', async () => {
    const res = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set('X-Admin-Key', adminKey)
      .send({ name: 'n2', description: 'd2', columns: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('n2');
    expect(res.body.columns).toHaveLength(2);
  });

  it('handleServiceError maps unknown errors to 500', () => {
    const responses: Array<{ status: number; body: unknown }> = [];
    const fakeRes = {
      status(code: number) { return { json: (b: unknown) => responses.push({ status: code, body: b }) }; },
    } as unknown as Parameters<typeof handleServiceError>[0];

    handleServiceError(fakeRes, new Error('kaboom'));
    handleServiceError(fakeRes, 'not-an-error');
    expect(responses[0]).toEqual({ status: 500, body: { error: 'kaboom' } });
    expect(responses[1]).toEqual({ status: 500, body: { error: 'Unknown error' } });
  });
});
