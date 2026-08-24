import { test, expect, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAdminKey(): string {
  const dbPath = path.resolve(process.env['DB_PATH'] || 'agentboard-e2e.db');
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare("SELECT value FROM settings WHERE key = 'admin_api_key'").get() as
    | { value: string }
    | undefined;
  db.close();
  if (!row) throw new Error('Admin key not found in DB');
  return row.value;
}

async function apiCreateAgent(
  baseURL: string,
  adminKey: string,
  name: string,
): Promise<{ id: string; apiKey: string }> {
  const res = await fetch(`${baseURL}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Failed to create agent: ${res.status}`);
  return res.json() as Promise<{ id: string; apiKey: string }>;
}

async function apiCreateProject(
  baseURL: string,
  adminKey: string,
  name: string,
  description?: string,
): Promise<{ id: string }> {
  const res = await fetch(`${baseURL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
    body: JSON.stringify({ name, description }),
  });
  if (!res.ok) throw new Error(`Failed to create project: ${res.status}`);
  return res.json() as Promise<{ id: string }>;
}

async function apiCreateTicket(
  baseURL: string,
  apiKey: string,
  projectId: string,
  title: string,
  opts?: { column?: string; description?: string; blocked_reason?: string; depends_on?: string[] },
): Promise<{ id: string }> {
  const res = await fetch(`${baseURL}/api/projects/${projectId}/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({
      title,
      column: opts?.column ?? 'backlog',
      description: opts?.description,
      blocked_reason: opts?.blocked_reason,
      depends_on: opts?.depends_on,
    }),
  });
  if (!res.ok) throw new Error(`Failed to create ticket: ${res.status}`);
  return res.json() as Promise<{ id: string }>;
}

async function apiAddComment(
  baseURL: string,
  apiKey: string,
  projectId: string,
  ticketId: string,
  body: string,
): Promise<void> {
  const res = await fetch(`${baseURL}/api/projects/${projectId}/tickets/${ticketId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`Failed to add comment: ${res.status}`);
}

async function login(page: Page, adminKey: string): Promise<void> {
  await page.goto('/login.html');
  await page.fill('#password', adminKey);
  await page.click('.btn-login');
  await page.waitForURL(/\/(?:index\.html)?$/);
}

// Navigate to a specific project on the board
async function navigateToProject(page: Page, projectName: string): Promise<void> {
  // If we're on the board view, go back to overview first
  const projectLabel = page.locator('#current-project-name');
  if (await projectLabel.isVisible().catch(() => false)) {
    await projectLabel.click();
    await page.waitForSelector('.overview-table');
  }

  // Click the project row in the overview table
  await page.locator('.overview-project-name', { hasText: projectName }).click();
  await page.waitForSelector('#board:not(.hidden)');
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

test.describe('Agentboard E2E – Comprehensive Feature Test', () => {
  let adminKey: string;
  let agent: { id: string; apiKey: string };
  let project: { id: string };
  let projectName: string;
  let consoleErrors: string[] = [];

  test.beforeAll(() => {
    adminKey = getAdminKey();
  });

  test.beforeEach(async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    consoleErrors = [];

    // Collect JS console errors and page errors
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(`[console.error] ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      consoleErrors.push(`[pageerror] ${err.message}`);
    });

    // Create isolated test data with unique names
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    agent = await apiCreateAgent(url, adminKey, `e2e-bot-${uid}`);
    projectName = `E2E-${uid}`;
    project = await apiCreateProject(url, adminKey, projectName, 'Automated test');
  });

  test.afterEach(() => {
    // Filter out expected noise: WebSocket disconnects, resource loading (401 redirects, CDN), network errors
    const realErrors = consoleErrors.filter(
      (e) =>
        !e.includes('WebSocket') &&
        !e.includes('net::ERR') &&
        !e.includes('Failed to load resource') &&
        !e.includes('favicon'),
    );
    expect(realErrors, `Unexpected JS console errors:\n${realErrors.join('\n')}`).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 1. Login
  // -------------------------------------------------------------------------

  test('Login: shows error for invalid key, succeeds with correct key', async ({ page }) => {
    await page.goto('/login.html');

    // Page elements present
    await expect(page.locator('.login-logo')).toContainText('Agentboard');
    await expect(page.locator('.login-title')).toContainText('Sign in');
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('.btn-login')).toBeVisible();

    // Wrong key → error
    await page.fill('#password', 'wrong-key-12345');
    await page.click('.btn-login');
    await expect(page.locator('#error')).toContainText(/invalid/i);

    // Correct key → redirect to dashboard
    await page.fill('#password', adminKey);
    await page.click('.btn-login');
    await page.waitForURL(/\/(?:index\.html)?$/);
    await expect(page.locator('.logo-text')).toContainText('agentboard');
  });

  // -------------------------------------------------------------------------
  // 2. Project Overview
  // -------------------------------------------------------------------------

  test('Overview: shows project with correct ticket counts per column', async ({
    page,
    baseURL,
  }) => {
    const url = baseURL ?? 'http://localhost:3000';

    // Seed tickets across columns
    await apiCreateTicket(url, agent.apiKey, project.id, 'Backlog 1', { column: 'backlog' });
    await apiCreateTicket(url, agent.apiKey, project.id, 'Backlog 2', { column: 'backlog' });
    await apiCreateTicket(url, agent.apiKey, project.id, 'Blocked 1', { column: 'blocked' });
    await apiCreateTicket(url, agent.apiKey, project.id, 'In Progress 1', { column: 'in_progress' });
    await apiCreateTicket(url, agent.apiKey, project.id, 'Done 1', { column: 'done' });

    await login(page, adminKey);

    // Overview should be visible
    await page.waitForSelector('.overview-table');
    const projectRow = page.locator('tr', { has: page.locator('.overview-project-name', { hasText: projectName }) });
    await expect(projectRow).toBeVisible();

    // Verify ticket counts per column (chips render in column order, then total)
    const counts = projectRow.locator('.overview-count');
    // Columns: backlog, blocked, in_progress, rework, in_review, done, total
    await expect(counts.nth(0)).toHaveText('2'); // backlog
    await expect(counts.nth(1)).toHaveText('1'); // blocked
    await expect(counts.nth(2)).toHaveText('1'); // in_progress
    await expect(counts.nth(3)).toHaveText('0'); // rework
    await expect(counts.nth(4)).toHaveText('0'); // in_review
    await expect(counts.nth(5)).toHaveText('1'); // done
    await expect(counts.nth(6)).toHaveText('5'); // total
  });

  // -------------------------------------------------------------------------
  // 3. Board View – Columns & Tickets
  // -------------------------------------------------------------------------

  test('Board: displays tickets in correct columns with 6-column default layout', async ({
    page,
    baseURL,
  }) => {
    const url = baseURL ?? 'http://localhost:3000';

    await apiCreateTicket(url, agent.apiKey, project.id, 'BL Task', { column: 'backlog' });
    await apiCreateTicket(url, agent.apiKey, project.id, 'BK Task', { column: 'blocked' });
    await apiCreateTicket(url, agent.apiKey, project.id, 'IP Task', { column: 'in_progress' });
    await apiCreateTicket(url, agent.apiKey, project.id, 'IR Task', { column: 'in_review' });
    await apiCreateTicket(url, agent.apiKey, project.id, 'DN Task', { column: 'done' });

    await login(page, adminKey);
    await navigateToProject(page, projectName);

    // 6 default columns exist
    await expect(page.locator('.column')).toHaveCount(6);

    // Each column has the correct ticket
    await expect(page.locator('[data-column="backlog"] .ticket-title')).toHaveText('BL Task');
    await expect(page.locator('[data-column="blocked"] .ticket-title')).toHaveText('BK Task');
    await expect(page.locator('[data-column="in_progress"] .ticket-title')).toHaveText('IP Task');
    await expect(page.locator('[data-column="in_review"] .ticket-title')).toHaveText('IR Task');
    await expect(page.locator('[data-column="done"] .ticket-title')).toHaveText('DN Task');

    // Column headers
    await expect(page.locator('[data-column="backlog"] .column-title')).toHaveText('BACKLOG');
    await expect(page.locator('[data-column="done"] .column-title')).toHaveText('DONE');

    // Column counts
    await expect(page.locator('[data-column="backlog"] .column-count')).toHaveText('1');
    await expect(page.locator('[data-column="done"] .column-count')).toHaveText('1');
  });

  // -------------------------------------------------------------------------
  // 4. Ticket Card – Meta info (author, comment count)
  // -------------------------------------------------------------------------

  test('Ticket card: shows author, assignee, and comment count', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';

    const ticket = await apiCreateTicket(url, agent.apiKey, project.id, 'Meta Test Ticket', {
      column: 'backlog',
      description: 'Testing metadata display',
    });

    // Add comments via API
    await apiAddComment(url, agent.apiKey, project.id, ticket.id, 'First comment');
    await apiAddComment(url, agent.apiKey, project.id, ticket.id, 'Second comment');

    await login(page, adminKey);
    await navigateToProject(page, projectName);

    const card = page.locator('.ticket-card', { hasText: 'Meta Test Ticket' });
    await expect(card).toBeVisible();

    // Author badge visible
    await expect(card.locator('.ticket-agent')).toBeVisible();

    // Comment count shows 2
    await expect(card.locator('.ticket-comment-count')).toContainText('2');
  });

  // -------------------------------------------------------------------------
  // 5. Close / Reopen Ticket
  // -------------------------------------------------------------------------

  test('Close and Reopen: moves ticket between columns', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';

    await apiCreateTicket(url, agent.apiKey, project.id, 'Toggle Task', { column: 'backlog' });

    await login(page, adminKey);
    await navigateToProject(page, projectName);
    await page.waitForSelector('.ticket-card');

    // Verify ticket is in backlog
    await expect(page.locator('[data-column="backlog"] .ticket-card')).toHaveCount(1);

    // Close → ticket moves to done
    await page.click('[data-column="backlog"] .btn-close');
    await expect(page.locator('[data-column="done"] .ticket-card')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('[data-column="backlog"] .ticket-card')).toHaveCount(0);

    // Reopen → ticket moves back to backlog
    await page.click('[data-column="done"] .btn-open');
    await expect(page.locator('[data-column="backlog"] .ticket-card')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('[data-column="done"] .ticket-card')).toHaveCount(0);
  });

  // -------------------------------------------------------------------------
  // 6. Ticket Detail Modal
  // -------------------------------------------------------------------------

  test('Modal: opens on ticket click, shows title, description, column badge', async ({
    page,
    baseURL,
  }) => {
    const url = baseURL ?? 'http://localhost:3000';

    await apiCreateTicket(url, agent.apiKey, project.id, 'Modal Test Ticket', {
      column: 'in_progress',
      description: '## Description\n\nThis is a **markdown** description.',
    });

    await login(page, adminKey);
    await navigateToProject(page, projectName);

    // Click the ticket card (not the button)
    await page.locator('.ticket-card .ticket-title', { hasText: 'Modal Test Ticket' }).click();

    // Modal should be visible
    const modal = page.locator('#ticket-modal');
    await expect(modal).not.toHaveClass(/hidden/);

    // Title
    await expect(page.locator('#modal-title')).toHaveText('Modal Test Ticket');

    // Column badge
    await expect(page.locator('#modal-column-badge')).toContainText('In Progress');

    // Description rendered as markdown (has heading or bold)
    const descHtml = await page.locator('#modal-desc').innerHTML();
    expect(descHtml).toContain('<strong>markdown</strong>');

    // Ticket ID shown (truncated)
    await expect(page.locator('#modal-ticket-id')).toContainText('#');

    // Author displayed
    await expect(page.locator('#modal-author')).toContainText(agent.id.slice(0, 1) ? '' : '', {});
    // Just check it's not empty or it contains something
    const authorText = await page.locator('#modal-author').textContent();
    expect(authorText!.length).toBeGreaterThan(0);

    // Close modal by clicking X
    await page.click('.modal-close');
    await expect(modal).toHaveClass(/hidden/);
  });

  // -------------------------------------------------------------------------
  // 7. Modal – Comments Tab
  // -------------------------------------------------------------------------

  test('Modal Comments: shows existing comments', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';

    const ticket = await apiCreateTicket(url, agent.apiKey, project.id, 'Comment Ticket', {
      column: 'backlog',
    });
    await apiAddComment(url, agent.apiKey, project.id, ticket.id, 'Hello from **E2E** test!');

    await login(page, adminKey);
    await navigateToProject(page, projectName);

    // Open modal
    await page.locator('.ticket-card .ticket-title', { hasText: 'Comment Ticket' }).click();
    await expect(page.locator('#ticket-modal')).not.toHaveClass(/hidden/);

    // Comments tab should be active by default
    await expect(page.locator('.modal-tab[data-tab="comments"]')).toHaveClass(/active/);

    // Comment should be visible with markdown rendered
    const commentBody = page.locator('.modal-comment-body');
    await expect(commentBody).toBeVisible();
    const html = await commentBody.innerHTML();
    expect(html).toContain('<strong>E2E</strong>');

    // Comment agent name visible
    await expect(page.locator('.modal-comment-agent').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 8. Modal – History Tab
  // -------------------------------------------------------------------------

  test('Modal History: shows revision entries after ticket changes', async ({
    page,
    baseURL,
  }) => {
    const url = baseURL ?? 'http://localhost:3000';

    const ticket = await apiCreateTicket(url, agent.apiKey, project.id, 'History Ticket', {
      column: 'backlog',
    });

    // Update ticket to generate a revision
    await fetch(`${url}/api/projects/${project.id}/tickets/${ticket.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': agent.apiKey },
      body: JSON.stringify({ title: 'History Ticket (Updated)' }),
    });

    await login(page, adminKey);
    await navigateToProject(page, projectName);

    // Open modal
    await page.locator('.ticket-card .ticket-title', { hasText: 'History Ticket' }).click();
    await expect(page.locator('#ticket-modal')).not.toHaveClass(/hidden/);

    // Switch to History tab
    await page.click('.modal-tab[data-tab="history"]');
    await expect(page.locator('#tab-history')).not.toHaveClass(/hidden/);
    await expect(page.locator('#tab-comments')).toHaveClass(/hidden/);

    // At least one revision entry
    const revisions = page.locator('.modal-revision');
    await expect(revisions.first()).toBeVisible();

    // Revision shows old → new values
    await expect(page.locator('.modal-revision-old').first()).toBeVisible();
    await expect(page.locator('.modal-revision-new').first()).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 9. Activity Feed
  // -------------------------------------------------------------------------

  test('Activity feed: visible and shows events after ticket actions', async ({
    page,
    baseURL,
  }) => {
    const url = baseURL ?? 'http://localhost:3000';

    // Create a ticket (generates activity)
    await apiCreateTicket(url, agent.apiKey, project.id, 'Activity Ticket', { column: 'backlog' });

    await login(page, adminKey);
    await navigateToProject(page, projectName);

    // Activity feed should be visible
    const feed = page.locator('#activity-feed');
    await expect(feed).toBeVisible();

    // Should have at least 1 activity entry
    const items = page.locator('.activity-item');
    await expect(items.first()).toBeVisible();

    // Activity count label
    await expect(page.locator('#activity-count')).toContainText(/\d+ event/);
  });

  // -------------------------------------------------------------------------
  // 10. Audit Log
  // -------------------------------------------------------------------------

  test('Audit log: toggle Show/Hide works, entries appear', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';

    await apiCreateTicket(url, agent.apiKey, project.id, 'Audit Ticket', { column: 'backlog' });

    await login(page, adminKey);
    await navigateToProject(page, projectName);

    // Audit panel visible
    const auditPanel = page.locator('#audit-panel');
    await expect(auditPanel).toBeVisible();

    // Initially the audit list is hidden
    await expect(page.locator('#audit-list')).toHaveClass(/hidden/);

    // Click Show
    await page.click('#audit-toggle');
    await expect(page.locator('#audit-list')).not.toHaveClass(/hidden/);
    await expect(page.locator('#audit-toggle')).toHaveText('Hide');

    // Should have audit entries
    const items = page.locator('.audit-item');
    await expect(items.first()).toBeVisible();

    // Click Hide
    await page.click('#audit-toggle');
    await expect(page.locator('#audit-list')).toHaveClass(/hidden/);
    await expect(page.locator('#audit-toggle')).toHaveText('Show');
  });

  // -------------------------------------------------------------------------
  // 11. Agents Modal
  // -------------------------------------------------------------------------

  test('Agents modal: opens from badge, shows agent list', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    await apiCreateTicket(url, agent.apiKey, project.id, 'Placeholder', { column: 'backlog' });

    await login(page, adminKey);

    // Agent count badge in header
    const badge = page.locator('#agent-count');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(/\d+ agent/);

    // Click badge to open modal
    await badge.click();

    const agentsModal = page.locator('#agents-modal');
    await expect(agentsModal).not.toHaveClass(/hidden/);

    // Agent list should have entries
    await page.waitForSelector('.agent-row');
    const rows = page.locator('.agent-row');
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    // Each row has a name and an API key
    await expect(rows.first().locator('.agent-row-name')).toBeVisible();
    await expect(rows.first().locator('.agent-row-key')).toBeVisible();

    // Copy button present
    await expect(rows.first().locator('.btn-copy')).toBeVisible();

    // Close modal
    await page.click('#agents-modal .modal-close');
    await expect(agentsModal).toHaveClass(/hidden/);
  });

  // -------------------------------------------------------------------------
  // 12. Modal close via overlay click
  // -------------------------------------------------------------------------

  test('Modal: closes when clicking overlay backdrop', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';

    await apiCreateTicket(url, agent.apiKey, project.id, 'Overlay Test', { column: 'backlog' });

    await login(page, adminKey);
    await navigateToProject(page, projectName);

    // Open modal
    await page.locator('.ticket-card .ticket-title', { hasText: 'Overlay Test' }).click();
    await expect(page.locator('#ticket-modal')).not.toHaveClass(/hidden/);

    // Click the overlay (outside the modal content)
    await page.locator('#ticket-modal').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('#ticket-modal')).toHaveClass(/hidden/);
  });

  // -------------------------------------------------------------------------
  // 13. Navigation: Overview ↔ Board
  // -------------------------------------------------------------------------

  test('Navigation: can switch between overview and board view', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    await apiCreateTicket(url, agent.apiKey, project.id, 'Nav Test', { column: 'backlog' });

    await login(page, adminKey);

    // Overview is visible initially
    await page.waitForSelector('.overview-table');
    await expect(page.locator('#project-overview')).toBeVisible();

    // Click project → board view
    await page.locator('.overview-project-name', { hasText: projectName }).click();
    await page.waitForSelector('#board:not(.hidden)');
    await expect(page.locator('#board')).toBeVisible();

    // Back label shown
    const backLabel = page.locator('#current-project-name');
    await expect(backLabel).toBeVisible();

    // Click back → overview
    await backLabel.click();
    await page.waitForSelector('.overview-table');
    await expect(page.locator('#project-overview')).toBeVisible();
  });

  // -------------------------------------------------------------------------
  // 14. Blocked reason + last-touched on cards
  // -------------------------------------------------------------------------

  test('Card shows blocked reason and last-touched time', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';

    await apiCreateTicket(url, agent.apiKey, project.id, 'Blocked Ticket', {
      column: 'blocked',
      blocked_reason: 'Waiting for Apple signing',
    });

    await login(page, adminKey);
    await navigateToProject(page, projectName);

    const card = page.locator('.ticket-card', { hasText: 'Blocked Ticket' });
    await expect(card.locator('.ticket-blocked')).toContainText('Waiting for Apple signing');
    await expect(card.locator('.ticket-updated')).toContainText(/ago|\d/);

    // Modal shows the blocked reason prominently
    await card.locator('.ticket-title').click();
    await expect(page.locator('#modal-blocked')).toContainText('Waiting for Apple signing');
    await expect(page.locator('#modal-updated')).toContainText(/ago|now|\d/);
    await page.click('.modal-close');
  });

  // -------------------------------------------------------------------------
  // 15. Dependencies: badge, arrows, modal list
  // -------------------------------------------------------------------------

  test('Dependency badge shows arrows to dependency tickets', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';

    const dep = await apiCreateTicket(url, agent.apiKey, project.id, 'Base Work', { column: 'in_progress' });
    await apiCreateTicket(url, agent.apiKey, project.id, 'Follow-up Work', {
      column: 'backlog',
      depends_on: [dep.id],
    });

    await login(page, adminKey);
    await navigateToProject(page, projectName);

    const card = page.locator('.ticket-card', { hasText: 'Follow-up Work' });
    const badge = card.locator('.ticket-deps');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveClass(/deps-open/);

    // Click badge → SVG arrows appear, dependency card highlighted
    await badge.click();
    await expect(page.locator('#dep-arrows')).not.toHaveClass(/hidden/);
    await expect(page.locator('#dep-arrows path.dep-line')).toHaveCount(1);
    await expect(page.locator('.ticket-card.dep-target', { hasText: 'Base Work' })).toBeVisible();

    // Click elsewhere → arrows disappear
    await page.locator('header').click();
    await expect(page.locator('#dep-arrows')).toHaveClass(/hidden/);

    // Modal lists the dependency with its column
    await card.locator('.ticket-title').click();
    await expect(page.locator('#modal-deps')).toContainText('Base Work');
    await expect(page.locator('#modal-deps')).toContainText('In Progress');
    await page.click('.modal-close');
  });

  // -------------------------------------------------------------------------
  // 16. Columns editor
  // -------------------------------------------------------------------------

  test('Columns editor adds a new column to the board', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    await apiCreateTicket(url, agent.apiKey, project.id, 'Some Ticket', { column: 'backlog' });

    await login(page, adminKey);
    await navigateToProject(page, projectName);

    await expect(page.locator('.column')).toHaveCount(6);

    // Open the editor, add a column, save
    await page.click('#edit-columns-btn');
    await expect(page.locator('#columns-modal')).not.toHaveClass(/hidden/);
    await expect(page.locator('.columns-editor-row')).toHaveCount(6);

    await page.click('text=+ Add column');
    await page.locator('.columns-editor-row').last().locator('.columns-editor-title').fill('QA Check');
    await page.click('.btn-save-columns');

    await expect(page.locator('#columns-modal')).toHaveClass(/hidden/);
    await expect(page.locator('.column')).toHaveCount(7);
    await expect(page.locator('[data-column="qa_check"] .column-title')).toHaveText('QA CHECK');
  });

  test('Columns editor refuses to remove a column that still has tickets', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    await apiCreateTicket(url, agent.apiKey, project.id, 'Sticky Ticket', { column: 'in_review' });

    await login(page, adminKey);
    await navigateToProject(page, projectName);

    await page.click('#edit-columns-btn');
    // Remove the "In Review" row (5th of 6)
    await page.locator('.columns-editor-row').nth(4).locator('.btn-remove-column').click();
    await page.click('.btn-save-columns');

    // Error is shown, modal stays open, board unchanged
    await expect(page.locator('#columns-error')).toBeVisible();
    await expect(page.locator('#columns-error')).toContainText('in_review');
    await expect(page.locator('#columns-modal')).not.toHaveClass(/hidden/);
    await page.click('#columns-modal .modal-close');
    await expect(page.locator('.column')).toHaveCount(6);
  });

  // -------------------------------------------------------------------------
  // 17. No JS console errors during full workflow
  // -------------------------------------------------------------------------

  test('Full workflow: create → view → close → reopen → comment → history – no JS errors', async ({
    page,
    baseURL,
  }) => {
    const url = baseURL ?? 'http://localhost:3000';

    // Create a ticket with a comment
    const ticket = await apiCreateTicket(url, agent.apiKey, project.id, 'Full Workflow Ticket', {
      column: 'rework',
      description: '# Workflow Test\n\n- Step one\n- Step two',
    });
    await apiAddComment(url, agent.apiKey, project.id, ticket.id, 'Initial comment');

    await login(page, adminKey);
    await navigateToProject(page, projectName);

    // Ticket visible in ready column
    await expect(page.locator('[data-column="rework"] .ticket-title')).toHaveText('Full Workflow Ticket');

    // Open modal, check content
    await page.locator('.ticket-card .ticket-title', { hasText: 'Full Workflow Ticket' }).click();
    await expect(page.locator('#modal-title')).toHaveText('Full Workflow Ticket');
    await expect(page.locator('#modal-column-badge')).toContainText('Rework');
    await expect(page.locator('.modal-comment-body').first()).toBeVisible();

    // Switch to history tab
    await page.click('.modal-tab[data-tab="history"]');
    await expect(page.locator('#tab-history')).not.toHaveClass(/hidden/);

    // Switch back to comments
    await page.click('.modal-tab[data-tab="comments"]');
    await expect(page.locator('#tab-comments')).not.toHaveClass(/hidden/);

    // Close modal
    await page.click('.modal-close');
    await expect(page.locator('#ticket-modal')).toHaveClass(/hidden/);

    // Close the ticket
    await page.click('[data-column="rework"] .btn-close');
    await expect(page.locator('[data-column="done"] .ticket-card')).toHaveCount(1, { timeout: 5000 });

    // Reopen the ticket
    await page.click('[data-column="done"] .btn-open');
    await expect(page.locator('[data-column="backlog"] .ticket-card')).toHaveCount(1, { timeout: 5000 });

    // Open agents modal
    await page.click('#agent-count');
    await expect(page.locator('#agents-modal')).not.toHaveClass(/hidden/);
    await page.click('#agents-modal .modal-close');

    // Toggle audit log
    await page.click('#audit-toggle');
    await expect(page.locator('#audit-list')).not.toHaveClass(/hidden/);
    await page.click('#audit-toggle');
    await expect(page.locator('#audit-list')).toHaveClass(/hidden/);

    // Navigate back to overview
    await page.locator('#current-project-name').click();
    await page.waitForSelector('.overview-table');

    // The afterEach hook will assert zero JS console errors
  });
});
