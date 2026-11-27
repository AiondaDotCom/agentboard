import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { AgentboardDB } from '../../src/db/database.js';
import { BoardService } from '../../src/services/board.service.js';
import type { ScreenshotInput } from '../../src/services/html-drafts.js';
import { assignRefs, validateDiagram } from '../../src/services/process-diagrams.js';
import type { ProcessDiagramInput } from '../../src/services/process-diagrams.js';

function png(width: number, height = 10): Buffer {
  return PNG.sync.write(new PNG({ width, height }));
}

function shotInput(
  width: number,
  overrides: Partial<ScreenshotInput> = {},
): ScreenshotInput {
  return {
    png_base64: png(width).toString('base64'),
    width,
    height: 800,
    theme: 'light',
    ...overrides,
  };
}

function simpleDiagram(): ProcessDiagramInput {
  return {
    lanes: [{ id: 'user', name: 'User' }],
    nodes: [
      { id: 'start', type: 'start', label: 'Begin', lane: 'user' },
      { id: 'done', type: 'end', label: 'Finish', lane: 'user' },
    ],
    flows: [{ from: 'start', to: 'done' }],
  };
}

describe('HTML draft service edge cases', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let projectId: string;
  let ticketId: string;
  let agentId: string;
  let draftId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    agentId = service.createAgent('designer').id;
    projectId = service.createProject('Design').id;
    ticketId = service.createTicket(projectId, 'Screen').id;
    draftId = service.htmlDrafts.save(
      projectId,
      ticketId,
      'Screen',
      '<p>x</p>',
      agentId,
    ).id;
  });
  afterEach(() => {
    db.close();
  });

  const screenshot = (input: ScreenshotInput | null): unknown =>
    service.htmlDrafts.screenshot(projectId, ticketId, draftId, 1, input, agentId);

  it('validates title and html text', () => {
    expect(() =>
      service.htmlDrafts.save(projectId, ticketId, '   ', '<p>x</p>', agentId),
    ).toThrow('title must be nonempty and at most 200 bytes');
    expect(() =>
      service.htmlDrafts.save(projectId, ticketId, 'x'.repeat(201), '<p>x</p>', agentId),
    ).toThrow('title must be nonempty');
    expect(() =>
      service.htmlDrafts.save(projectId, ticketId, 'T', 42 as unknown as string, agentId),
    ).toThrow('html must be nonempty');
  });

  it('rejects unknown tickets and expected_version without draft_id', () => {
    expect(() => service.htmlDrafts.list(projectId, 'missing')).toThrow(
      'Ticket not found',
    );
    expect(() =>
      service.htmlDrafts.save(projectId, ticketId, 'T', '<p>x</p>', agentId, undefined, 1),
    ).toThrow('expected_version requires draft_id');
    expect(() =>
      service.htmlDrafts.save(projectId, ticketId, 'T', '<p>x</p>', agentId, 'unknown', 1),
    ).toThrow('Draft not found');
    expect(db.latestHtmlDraft('unknown')).toBeUndefined();
  });

  it('rejects invalid version numbers', () => {
    expect(() => service.htmlDrafts.get(projectId, ticketId, draftId, 0)).toThrow(
      'Invalid draft version',
    );
    expect(() => service.htmlDrafts.get(projectId, ticketId, draftId, 1.5)).toThrow(
      'Invalid draft version',
    );
    expect(db.getHtmlDraft('unknown', 1)).toBeUndefined();
  });

  it('validates screenshot viewport and theme', () => {
    expect(() => screenshot(null)).toThrow('Invalid screenshot viewport or theme');
    expect(() => screenshot(shotInput(100))).toThrow(
      'Invalid screenshot viewport or theme',
    );
    expect(() => screenshot(shotInput(390, { height: 100 }))).toThrow(
      'Invalid screenshot viewport or theme',
    );
    expect(() =>
      screenshot(shotInput(390, { theme: 'sepia' as ScreenshotInput['theme'] })),
    ).toThrow('Invalid screenshot viewport or theme');
  });

  it('rejects non-PNG data, mismatched dimensions and corrupted images', () => {
    expect(() =>
      screenshot(shotInput(390, { png_base64: 'data:image/png;base64,AAAA' })),
    ).toThrow('Expected raw PNG base64');
    expect(() =>
      screenshot(shotInput(390, { png_base64: Buffer.from('not a png').toString('base64') })),
    ).toThrow('Invalid PNG');
    expect(() =>
      screenshot(shotInput(1280, { png_base64: png(390).toString('base64') })),
    ).toThrow('PNG dimensions do not match viewport or exceed limits');
    const corrupt = png(390);
    // Flip a byte inside the IDAT chunk so the CRC check fails while header and IEND stay intact
    const idat = corrupt.indexOf('IDAT');
    corrupt[idat + 6] = (corrupt[idat + 6] ?? 0) ^ 0xff;
    expect(() =>
      screenshot(shotInput(390, { png_base64: corrupt.toString('base64') })),
    ).toThrow('PNG image cannot be decoded');
    expect(db.getDraftScreenshots(draftId, 1)).toHaveLength(0);
  });

  it('allows at most 16 screenshots per version', () => {
    const input = shotInput(390);
    for (let i = 0; i < 16; i++) screenshot(input);
    expect(db.getDraftScreenshots(draftId, 1)).toHaveLength(16);
    expect(() => screenshot(input)).toThrow(
      'At most 16 screenshots per draft version',
    );
  });

  it('returns stored screenshot bytes and 404s unknown screenshots', () => {
    const input = shotInput(390);
    const shot = service.htmlDrafts.screenshot(projectId, ticketId, draftId, 1, input, agentId);
    const bytes = service.htmlDrafts.image(projectId, ticketId, draftId, 1, shot.id);
    expect(bytes.equals(Buffer.from(input.png_base64, 'base64'))).toBe(true);
    expect(() =>
      service.htmlDrafts.image(projectId, ticketId, draftId, 1, 'nope'),
    ).toThrow('Screenshot not found');
    expect(db.getDraftScreenshotPng(draftId, 1, 'nope')).toBeUndefined();
  });
});

describe('batch ops for drafts and diagrams', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let projectId: string;
  let ticketId: string;
  let agentId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    agentId = service.createAgent('bot').id;
    projectId = service.createProject('P').id;
    ticketId = service.createTicket(projectId, 'T').id;
  });
  afterEach(() => {
    db.close();
  });

  const ids = (): Record<string, string> => ({
    project_id: projectId,
    ticket_id: ticketId,
  });

  it('requires an agent identity for write ops', () => {
    const results = service.executeBatch(
      [
        { op: 'save_html_draft', args: { ...ids(), title: 'T', html: '<p>x</p>' } },
        { op: 'add_draft_screenshot', args: { ...ids(), draft_id: 'd', version: 1 } },
        { op: 'review_html_draft', args: { ...ids(), draft_id: 'd', version: 1 } },
        { op: 'save_process_diagram', args: { ...ids(), title: 'D', ...simpleDiagram() } },
      ],
      null,
    );
    expect(results.map((r) => r.ok)).toEqual([false, false, false, false]);
    for (const r of results) expect(r.error).toBe('Agent identity required');
  });

  it('runs the full draft and diagram lifecycle', () => {
    const saved = service.executeBatch(
      [
        { op: 'save_html_draft', args: { ...ids(), title: 'Screen', html: '<p>x</p>' } },
        { op: 'save_process_diagram', args: { ...ids(), title: 'Flow', ...simpleDiagram() } },
      ],
      agentId,
    );
    const draftId = (saved[0]?.result as { id: string }).id;
    const diagramId = (saved[1]?.result as { id: string }).id;
    const shotInput390 = shotInput(390);
    const ops = service.executeBatch(
      [
        { op: 'get_html_draft', args: { ...ids(), draft_id: draftId, version: 1 } },
        { op: 'add_draft_screenshot', args: { ...ids(), draft_id: draftId, version: 1, ...shotInput390 } },
        { op: 'get_process_diagram', args: { ...ids(), diagram_id: diagramId, version: 1 } },
        { op: 'delete_process_diagram', args: { ...ids(), diagram_id: diagramId } },
      ],
      agentId,
    );
    expect(ops.map((r) => r.ok)).toEqual([true, true, true, true]);
    expect((ops[0]?.result as { title: string }).title).toBe('Screen');
    const shotId = (ops[1]?.result as { id: string }).id;
    expect((ops[2]?.result as { title: string }).title).toBe('Flow');
    expect(ops[3]?.result).toEqual({ deleted: true, id: diagramId, versions: 1 });
    const review = service.executeBatch(
      [
        {
          op: 'review_html_draft',
          args: {
            ...ids(),
            draft_id: draftId,
            version: 1,
            status: 'needs_changes',
            findings: 'Clipped',
            screenshot_ids: [shotId],
            visually_inspected: true,
          },
        },
      ],
      agentId,
    );
    expect(review[0]?.ok).toBe(true);
    expect((review[0]?.result as { reviewStatus: string }).reviewStatus).toBe('needs_changes');
  });
});

describe('process diagram validation edge cases', () => {
  let db: AgentboardDB;
  let service: BoardService;
  let projectId: string;
  let ticketId: string;
  let agentId: string;

  beforeEach(() => {
    db = new AgentboardDB(':memory:');
    service = new BoardService(db);
    agentId = service.createAgent('planner').id;
    projectId = service.createProject('P').id;
    ticketId = service.createTicket(projectId, 'T').id;
  });
  afterEach(() => {
    db.close();
  });

  it('numbers elements from 1 when the previous version has no sub-IDs', () => {
    const result = assignRefs(simpleDiagram(), simpleDiagram());
    expect(result.nodes.map((n) => n.ref)).toEqual(['S1', 'S2']);
    expect(result.flows.map((f) => f.ref)).toEqual(['F1']);
    const fresh = assignRefs(
      { ...simpleDiagram(), nodes: [...simpleDiagram().nodes, { id: 'x', type: 'task', label: 'X', lane: 'user' }] },
      { ...simpleDiagram(), nodes: [{ id: 'old', type: 'task', label: 'Old', lane: 'user', ref: 'Sx' }] },
    );
    expect(fresh.nodes.map((n) => n.ref)).toEqual(['S1', 'S2', 'S3']);
  });

  it('rejects malformed diagrams', () => {
    const base = simpleDiagram();
    expect(() => validateDiagram({ ...base, lanes: ['user'] })).toThrow(
      'lanes[0] must be an object',
    );
    expect(() =>
      validateDiagram({ ...base, lanes: [base.lanes[0], base.lanes[0]] }),
    ).toThrow('Duplicate lane id "user"');
    expect(() =>
      validateDiagram({ ...base, lanes: [{ id: 'user', name: '' }] }),
    ).toThrow('lanes[0].name must be nonempty text of at most 60 characters');
    expect(() =>
      validateDiagram({ ...base, flows: [...base.flows, { from: 'start', to: 'start' }] }),
    ).toThrow('Flow start → start loops onto itself');
    expect(() =>
      validateDiagram({ ...base, flows: [...base.flows, { from: 'start', to: 'done' }] }),
    ).toThrow('Duplicate flow start → done');
  });

  it('enforces ticket, version and draft lookup rules', () => {
    expect(() => service.processDiagrams.list(projectId, 'missing')).toThrow(
      'Ticket not found',
    );
    const saved = service.processDiagrams.save(projectId, ticketId, 'Flow', simpleDiagram(), agentId);
    expect(() => service.processDiagrams.get(projectId, ticketId, saved.id, 0)).toThrow(
      'Invalid diagram version',
    );
    expect(() =>
      service.processDiagrams.save(projectId, ticketId, 'Flow', simpleDiagram(), agentId, 'unknown', 1),
    ).toThrow('Diagram not found');
    expect(() =>
      service.processDiagrams.save(projectId, ticketId, 'Flow', simpleDiagram(), agentId, undefined, 1),
    ).toThrow('expected_version requires diagram_id');
    expect(service.processDiagrams.list(projectId, ticketId)).toHaveLength(1);
  });
});
