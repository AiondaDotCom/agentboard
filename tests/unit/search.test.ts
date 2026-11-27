import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import { createSearchRoutes } from '../../src/api/routes/search.js';
import { MAX_SEARCH_RESULTS } from '../../src/types.js';

describe('Ticket search', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let app: express.Express;
  let projectA: string;
  let projectB: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    projectA = service.createProject('Alpha').id;
    projectB = service.createProject('Beta').id;
    app = express();
    app.use('/api/search', createSearchRoutes(service));
  });

  afterEach(() => {
    db.close();
  });

  it('finds a ticket by its full ID across projects, with project and column names', () => {
    service.createTicket(projectA, 'Other');
    const t = service.createTicket(projectB, 'Target');
    const hits = service.searchTickets(t.id);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(t.id);
    expect(hits[0].projectName).toBe('Beta');
    expect(hits[0].columnTitle).toBe('Backlog');
  });

  it('accepts uppercase IDs, a leading # and surrounding whitespace', () => {
    const t = service.createTicket(projectA, 'Target');
    expect(service.searchTickets(`  #${t.id.toUpperCase()} `)[0].id).toBe(t.id);
    expect(service.searchTickets(`#${t.id.slice(0, 8)}`)[0].id).toBe(t.id);
  });

  it('finds tickets by an ID fragment and by title', () => {
    const t = service.createTicket(projectA, 'Fix the Login page');
    expect(service.searchTickets(t.id.slice(10, 20)).map((h) => h.id)).toContain(t.id);
    expect(service.searchTickets('login PAGE').map((h) => h.id)).toEqual([t.id]);
  });

  it('ranks exact ID before ID prefix before ID fragment before title', () => {
    const exact = service.createTicket(projectA, 'x');
    const prefix = service.createTicket(projectA, 'y');
    const fragment = service.createTicket(projectA, 'z');
    const title = service.createTicket(projectA, 'q');
    const raw = db as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } };
    const setId = (from: string, to: string): void => raw.db.prepare('UPDATE tickets SET id = ? WHERE id = ?').run(to, from);
    setId(exact.id, 'abc');
    setId(prefix.id, 'abcdef');
    setId(fragment.id, 'zzabc');
    raw.db.prepare('UPDATE tickets SET title = ? WHERE id = ?').run('has abc inside', title.id);
    expect(service.searchTickets('abc').map((h) => h.id)).toEqual(['abc', 'abcdef', 'zzabc', title.id]);
  });

  it('treats LIKE wildcards literally', () => {
    service.createTicket(projectA, 'plain');
    const t = service.createTicket(projectA, '100% done_now');
    expect(service.searchTickets('%').map((h) => h.id)).toEqual([t.id]);
    expect(service.searchTickets('_').map((h) => h.id)).toEqual([t.id]);
  });

  it('falls back to the column ID when the column is no longer configured', () => {
    const t = service.createTicket(projectA, 'Orphan');
    const raw = db as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } };
    raw.db.prepare('UPDATE tickets SET column_name = ? WHERE id = ?').run('gone', t.id);
    expect(service.searchTickets('Orphan')[0].columnTitle).toBe('gone');
  });

  it('returns nothing for empty or non-string queries', () => {
    service.createTicket(projectA, 'a');
    expect(service.searchTickets('')).toEqual([]);
    expect(service.searchTickets('  # ')).toEqual([]);
    expect(service.searchTickets(undefined)).toEqual([]);
    expect(service.searchTickets(['a'])).toEqual([]);
  });

  it('limits results (default 20, capped, invalid limits fall back)', () => {
    for (let i = 0; i < MAX_SEARCH_RESULTS + 5; i++) service.createTicket(projectA, `Item ${i}`);
    expect(service.searchTickets('Item')).toHaveLength(20);
    expect(service.searchTickets('Item', 3)).toHaveLength(3);
    expect(service.searchTickets('Item', '4')).toHaveLength(4);
    expect(service.searchTickets('Item', 1000)).toHaveLength(MAX_SEARCH_RESULTS);
    expect(service.searchTickets('Item', 0)).toHaveLength(20);
    expect(service.searchTickets('Item', 'abc')).toHaveLength(20);
  });

  it('GET /api/search returns matching tickets', async () => {
    const t = service.createTicket(projectA, 'Route target');
    const res = await request(app).get('/api/search').query({ q: t.id, limit: '5' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ id: t.id, projectId: projectA, projectName: 'Alpha' });
  });

  it('GET /api/search without q returns an empty list', async () => {
    const res = await request(app).get('/api/search');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
