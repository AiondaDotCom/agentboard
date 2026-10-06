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
  async function capture(name) {
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(root, 'docs', name), animations: 'disabled' });
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
} finally {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
  await rm(temp, { recursive: true, force: true });
}
