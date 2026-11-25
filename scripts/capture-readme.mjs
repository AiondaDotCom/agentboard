// Capture the real UI against a disposable demo database, never the user's board.
// Run via `npm run screenshots` (builds the server first).
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { AgentboardDB } from '../dist/db/database.js';
import { BoardService } from '../dist/services/board.service.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const temp = await mkdtemp(path.join(tmpdir(), 'agentboard-readme-'));
let child;
let browser;
try {
  const dbPath = path.join(temp, 'demo.db');
  const db = new AgentboardDB(dbPath);
  const service = new BoardService(db);
  let adminKey, project, detailTicket, lastRead;
  try {
    adminKey = service.getOrCreateAdminKey();
    const planner = service.createAgent('architecture-agent');
    const builder = service.createAgent('implementation-agent');
    const reviewer = service.createAgent('review-agent');
    project = service.createProject('Agentboard · Release 1.0', 'A shared workspace for AI agents and human reviewers.');
    const platform = service.createProject('Platform Reliability', 'Resilient services, observability and performance.');
    const docs = service.createProject('Developer Experience', 'Make the first integration straightforward.');
    function ticket(title, column, description, agent = builder, priority = 'medium', group) {
      return service.createTicket(project.id, title, description, column, agent.id, group, undefined, undefined, priority, 'mechanical');
    }
    ticket('Keyboard navigation for the board', 'backlog', 'Reach columns, cards and ticket details without a mouse.', planner);
    ticket('Export project activity', 'backlog', 'Download recent activity for a project review.', planner, 'low');
    const blocked = ticket('Validate webhook delivery', 'blocked', 'Check retries and delivery status against the staging endpoint.', builder, 'high');
    service.updateTicket(project.id, blocked.id, { blockedReason: 'Waiting for the staging endpoint' }, builder.id);
    detailTicket = ticket('Keep every project in view', 'in_progress', '## A live inbox for the whole board\n\nAgents work across several projects at once. The notification bell brings their updates into one place.\n\n- Stream ticket changes and comments immediately\n- Show unread events directly on the bell\n- Keep the board accessible beside ticket details\n- Restore missed events after reconnecting', builder, 'high', 'Realtime');
    service.assignTicket(project.id, detailTicket.id, builder.id, planner.id);
    const reconnect = ticket('Recover events after reconnecting', 'in_progress', 'Reload durable event history and avoid duplicate entries.', builder, 'high', 'Realtime');
    service.assignTicket(project.id, reconnect.id, builder.id, planner.id);
    ticket('Polish mobile ticket details', 'rework', 'Keep long descriptions readable at narrow viewport widths.', builder);
    const review = ticket('Follow the system color scheme', 'in_review', 'Check light and dark surfaces, status colors and form controls.', reviewer);
    service.assignTicket(project.id, review.id, reviewer.id, planner.id);
    ticket('Choose English or German', 'done', 'Save the preferred UI language in local storage.', builder);
    ticket('Make ticket changes visible', 'done', 'Animate updates without requiring a browser refresh.', builder);
    const perf = service.createTicket(platform.id, 'Trace slow API requests', 'Connect request timings to database queries.', 'in_progress', builder.id);
    service.createTicket(platform.id, 'Review connection limits', 'Verify behavior under concurrent agent sessions.', 'backlog', reviewer.id);
    service.createTicket(docs.id, 'Document the MCP connection', 'Explain agent keys and the first tool call.', 'in_review', planner.id);
    service.createComment(project.id, detailTicket.id, planner.id, 'The bell should cover **all projects**, even while someone is watching a different board.');
    service.createComment(project.id, detailTicket.id, builder.id, 'The live stream and unread counter are connected. Read state survives a reload.');
    service.createComment(project.id, detailTicket.id, reviewer.id, 'Verified comments, status changes and reconnects. The board remains usable beside the ticket.');
    service.moveTicket(platform.id, perf.id, 'done', reviewer.id);
    service.createComment(project.id, review.id, reviewer.id, 'Both color schemes follow the system setting without reloading the page.');
    service.reportRuntime({ host: 'demo-workstation', workingCodex: 2, workingClaude: 1, workingOpenCode: 0, workingCursor: 0, idleCodex: 0, idleClaude: 0, idleOpenCode: 0, idleCursor: 0 });
    lastRead = db.getBoardEvents()[0].id - 3;
  } finally { db.close(); }

  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const baseURL = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['dist/server.js'], {
    cwd: root, env: { ...process.env, PORT: String(port), DB_PATH: dbPath }, stdio: 'ignore',
  });
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error('Screenshot server exited before startup');
    try { if ((await fetch(`${baseURL}/login.html`)).ok) { ready = true; break; } } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('Screenshot server did not start');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await page.addInitScript(({ read }) => {
    localStorage.setItem('agentboard.language', 'en');
    localStorage.setItem('agentboard.notifications.read', String(read));
  }, { read: lastRead });
  const login = await page.request.post(`${baseURL}/api/auth/login`, { data: { key: adminKey } });
  if (!login.ok()) throw new Error('Screenshot login failed');
  await mkdir(path.join(root, 'docs'), { recursive: true });
  async function capture(name, options = {}) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(root, 'docs', name), animations: 'disabled', ...options });
    console.log(`docs/${name}`);
  }
  await page.goto(`${baseURL}/projects/${project.id}`);
  await page.locator('.ticket-card').first().waitFor();
  await page.waitForFunction(() => document.getElementById('notification-count').textContent === '3');
  await capture('board.png');

  await page.emulateMedia({ colorScheme: 'light' });
  // Show all six columns beside the panel so clipping cannot look like an overlay.
  await page.setViewportSize({ width: 2560, height: 1200 });
  await page.locator(`[data-ticket-id="${detailTicket.id}"] .ticket-title`).click();
  await page.locator('#modal-comments .modal-comment').first().waitFor();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.modal-ticket')).backgroundColor === 'rgb(255, 255, 255)');
  const boardBounds = await page.locator('#board').boundingBox();
  const panelBounds = await page.locator('#ticket-modal').boundingBox();
  assert.ok(boardBounds.x + boardBounds.width <= panelBounds.x, 'Ticket panel must sit beside the board');
  for (const column of await page.locator('#board .column').all()) {
    const bounds = await column.boundingBox();
    assert.ok(bounds.x >= boardBounds.x && bounds.x + bounds.width <= panelBounds.x,
      'Every column must be fully visible in the split-view screenshot');
  }
  await capture('ticket-split-view.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.modal-ticket')).backgroundColor !== 'rgb(255, 255, 255)');
  await capture('ticket-split-view-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator('#ticket-modal .modal-close').click();
  await page.locator('#ticket-modal').waitFor({ state: 'hidden' });
  await page.locator('#current-project-name').click();
  await page.locator('.overview-table').waitFor();
  await page.setViewportSize({ width: 1600, height: 680 });
  await capture('overview.png');

  await page.locator('.overview-project-name', { hasText: project.name }).click();
  await page.locator('.ticket-card').first().waitFor();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('#settings-toggle').click();
  await page.locator('#ui-language').selectOption('de');
  await page.locator('#settings-close').click();
  await page.locator('#notifications-toggle').click();
  await page.locator('.notification-item').first().waitFor();
  await page.waitForFunction(() => document.getElementById('notifications-title').textContent === 'Benachrichtigungen');
  await capture('notifications.png');

  // HTML draft and process diagram: created through the REST API after the captures
  // above, so the overview and the unread count of the earlier images stay unchanged.
  async function api(method, url, data, headers) {
    const response = await fetch(`${baseURL}${url}`, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data),
    });
    if (!response.ok) throw new Error(`${method} ${url} failed: ${response.status} ${await response.text()}`);
    return response.json();
  }
  const designer = await api('POST', '/api/agents', { name: 'design-agent' }, { 'X-Admin-Key': adminKey });
  const asDesigner = { 'X-Api-Key': designer.apiKey };
  const mailApp = await api('POST', '/api/projects', { name: 'Demo Mail App', description: 'Sample project for the README screenshots.' }, { 'X-Admin-Key': adminKey });
  const folderTicket = await api('POST', `/api/projects/${mailApp.id}/tickets`, {
    title: 'Create folder with AI-assisted description', column: 'in_progress', priority: 'high',
    description: '## Goal\n\nUsers create a folder and can let an AI service turn a rough note into a clear description.\n\n- The name must be unique in the account\n- The AI suggestion is optional and editable\n- If the AI service fails, the user keeps their own text',
  }, asDesigner);
  const ticketApi = `/api/projects/${mailApp.id}/tickets/${folderTicket.id}`;
  const folderScreen = (aiPanel) => `<style>
  .screen { padding: 20px 18px 28px; font: 15px/1.45 system-ui, sans-serif; color: light-dark(#1c1c1e, #f5f5f7); }
  .bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 22px; }
  .bar span { color: #0a7cff; } .bar b { font-size: 17px; }
  label { display: block; font-size: 13px; font-weight: 600; color: light-dark(#5b5b60, #a1a1a6); margin: 16px 0 6px; }
  .field { border: 1px solid light-dark(#d1d1d6, #3a3a3c); border-radius: 10px; padding: 11px 12px; background: light-dark(#fff, #2c2c2e); }
  .note { min-height: 64px; color: light-dark(#3a3a3c, #d1d1d6); }
  .ai { margin-top: 16px; border-radius: 12px; padding: 14px; background: light-dark(#eef5ff, #1d2a3a); border: 1px solid light-dark(#b8d6ff, #2f4d73); }
  .ai h4 { margin: 0 0 6px; font-size: 14px; color: light-dark(#0057c2, #8ec2ff); }
  .ai p { margin: 0 0 12px; }
  .row { display: flex; gap: 8px; }
  .btn { flex: 1; text-align: center; border-radius: 10px; padding: 10px; font-weight: 600; }
  .primary { background: #0a7cff; color: #fff; } .secondary { background: light-dark(#e5e5ea, #3a3a3c); }
  .hint { font-size: 12px; color: light-dark(#6e6e73, #98989d); margin-top: 6px; }
</style>
<div class="screen">
  <div class="bar"><span>Cancel</span><b>New folder</b><span>Create</span></div>
  <label>Name</label><div class="field">Invoices 2026</div>
  <div class="hint">Unique within your account</div>
  <label>Description</label><div class="field note">all bills from suppliers, also receipts for tax</div>
  ${aiPanel}
</div>`;
  let draft = await api('POST', `${ticketApi}/drafts`, {
    title: 'New folder',
    html: folderScreen('<div class="row" style="margin-top:16px"><div class="btn secondary">Improve with AI</div></div>'),
  }, asDesigner);
  draft = await api('POST', `${ticketApi}/drafts`, {
    title: 'New folder', draft_id: draft.id, expected_version: draft.version,
    html: folderScreen(`<div class="ai"><h4>AI suggestion</h4>
    <p>Supplier invoices and tax-relevant receipts for 2026.</p>
    <div class="row"><div class="btn primary">Use suggestion</div><div class="btn secondary">Keep mine</div></div></div>`),
  }, asDesigner);
  assert.equal(draft.version, 2, 'The draft screenshot should show a second version');

  const lanes = [{ id: 'user', name: 'User' }, { id: 'app', name: 'App' }, { id: 'server', name: 'Server' }, { id: 'ai', name: 'AI service' }];
  const nodes = [
    { id: 'open', type: 'start', label: 'Open “New folder”', lane: 'user' },
    { id: 'enter', type: 'task', label: 'Enter name and note', lane: 'user' },
    { id: 'improve', type: 'task', label: 'Tap “Improve with AI”', lane: 'user' },
    { id: 'send', type: 'task', label: 'Send note to AI service', lane: 'app' },
    { id: 'suggest', type: 'task', label: 'Suggest clear description', lane: 'ai' },
    { id: 'received', type: 'decision', label: 'Suggestion received?', lane: 'app' },
    { id: 'failed', type: 'task', label: 'Show error, keep own text', lane: 'app' },
    { id: 'accept', type: 'task', label: 'Accept or edit suggestion', lane: 'user' },
    { id: 'submit', type: 'task', label: 'Send folder to server', lane: 'app' },
    { id: 'valid', type: 'decision', label: 'Name valid and unique?', lane: 'server' },
    { id: 'create', type: 'task', label: 'Create folder', lane: 'server' },
    { id: 'show', type: 'task', label: 'Show folder in list', lane: 'app' },
    { id: 'done', type: 'end', label: 'Folder ready', lane: 'user' },
  ];
  const flows = [
    { from: 'open', to: 'enter' }, { from: 'enter', to: 'improve' }, { from: 'improve', to: 'send' },
    { from: 'send', to: 'suggest' }, { from: 'suggest', to: 'received' },
    { from: 'received', to: 'accept', label: 'yes' }, { from: 'received', to: 'failed', label: 'error' },
    { from: 'accept', to: 'submit' }, { from: 'failed', to: 'submit' }, { from: 'submit', to: 'valid' },
    { from: 'valid', to: 'create', label: 'valid' }, { from: 'create', to: 'show' }, { from: 'show', to: 'done' },
  ];
  const v1 = await api('POST', `${ticketApi}/process-diagrams`, {
    title: 'Create folder', lanes, nodes, flows: [...flows, { from: 'valid', to: 'enter', label: 'invalid' }],
  }, asDesigner);
  // Version 2 adds a hint step; existing steps keep their sub-IDs (S1…, F1…).
  const diagram = await api('POST', `${ticketApi}/process-diagrams`, {
    title: 'Create folder', diagram_id: v1.id, expected_version: v1.version, lanes,
    nodes: [...nodes, { id: 'hint', type: 'task', label: 'Explain what to change', lane: 'app' }],
    flows: [...flows, { from: 'valid', to: 'hint', label: 'invalid' }, { from: 'hint', to: 'enter' }],
  }, asDesigner);
  assert.equal(diagram.nodes.find(n => n.id === 'create').ref, v1.nodes.find(n => n.id === 'create').ref,
    'Sub-IDs must stay stable across diagram versions');

  // Ticket as full page, light: the mobile draft preview with its draft ID; process folded away.
  await page.evaluate(() => localStorage.setItem('agentboard.ticketFull', '1'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`${baseURL}/projects/${mailApp.id}/tickets/${folderTicket.id}`);
  await page.locator('#ticket-drafts .draft-id code').waitFor();
  await page.locator('#ticket-process .pd-card').waitFor();
  await page.locator('#modal-process-section > summary').click();
  await page.locator('#ticket-drafts iframe').waitFor();
  await page.frameLocator('#ticket-drafts iframe').locator('.ai').waitFor();
  await page.locator('#modal-drafts-section').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await capture('ticket-html-draft.png');

  // Ticket as full page, dark: the whole process diagram with lanes and sub-IDs.
  // Wide enough that the 14-step diagram is drawn at its natural size (labels stay legible).
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 2400, height: 1200 });
  await page.goto(`${baseURL}/projects/${mailApp.id}/tickets/${folderTicket.id}`);
  await page.locator('#ticket-process .pd-card svg').waitFor();
  await page.locator('#modal-drafts-section > summary').click();
  await page.locator('#modal-process-section').evaluate(el => el.scrollIntoView({ block: 'start' }));
  await capture('ticket-process-diagram.png');

  // "Show large" with a selected step: its sub-ID and the copy button.
  await page.locator('#ticket-process .pd-card .draft-action', { hasText: 'Show large' }).click();
  await page.locator('dialog.pd-dialog[open]').waitFor();
  const created = diagram.nodes.find(n => n.id === 'create').ref;
  await page.locator(`dialog.pd-dialog g.pd-node[data-ref="${created}"]`).click();
  await page.locator('dialog.pd-dialog .pd-detail-active').waitFor();
  const svgBounds = await page.locator('dialog.pd-dialog .pd-svg').boundingBox();
  assert.ok(svgBounds.width >= 2200, `Diagram should be drawn at natural size, got ${svgBounds.width}px`);
  // The dialog fills the window; keep only the diagram, the selected step and the copy button.
  const detailBounds = await page.locator('dialog.pd-dialog .pd-steps').boundingBox();
  await capture('process-diagram-large.png', { clip: { x: 0, y: 0, width: 2400, height: Math.ceil(detailBounds.y + detailBounds.height + 24) } });
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  await rm(temp, { recursive: true, force: true });
}
