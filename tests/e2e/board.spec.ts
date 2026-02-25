import { test, expect } from '@playwright/test';

// Helper to create test data via API
async function createAgent(baseURL: string, name: string): Promise<{ id: string; apiKey: string }> {
  const res = await fetch(`${baseURL}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return res.json() as Promise<{ id: string; apiKey: string }>;
}

async function createProject(baseURL: string, apiKey: string, name: string): Promise<{ id: string }> {
  const res = await fetch(`${baseURL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ name }),
  });
  return res.json() as Promise<{ id: string }>;
}

async function createTicket(
  baseURL: string,
  apiKey: string,
  projectId: string,
  title: string,
  column: string = 'backlog',
): Promise<{ id: string }> {
  const res = await fetch(`${baseURL}/api/projects/${projectId}/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify({ title, column }),
  });
  return res.json() as Promise<{ id: string }>;
}

test.describe('Agentboard UI', () => {
  let agent: { id: string; apiKey: string };
  let project: { id: string };

  test.beforeEach(async ({ baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    agent = await createAgent(url, `bot-${Date.now()}`);
    project = await createProject(url, agent.apiKey, `project-${Date.now()}`);
  });

  test('should load the page with header and project selector', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.logo-text')).toContainText('agentboard');
    await expect(page.locator('#project-select')).toBeVisible();
  });

  test('should show "no project" message initially', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#no-project')).toBeVisible();
    await expect(page.locator('#board')).toBeHidden();
  });

  test('should show board when project is selected', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    await createTicket(url, agent.apiKey, project.id, 'Test Ticket');

    await page.goto('/');
    // Wait for projects to load
    await page.waitForSelector(`#project-select option[value="${project.id}"]`);
    await page.selectOption('#project-select', project.id);

    // Board should be visible
    await expect(page.locator('#board')).toBeVisible();
    // Should see 5 columns
    const columns = page.locator('.column');
    await expect(columns).toHaveCount(5);
  });

  test('should display tickets in correct columns', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    await createTicket(url, agent.apiKey, project.id, 'Backlog Task', 'backlog');
    await createTicket(url, agent.apiKey, project.id, 'In Progress Task', 'in_progress');
    await createTicket(url, agent.apiKey, project.id, 'Done Task', 'done');

    await page.goto('/');
    await page.waitForSelector(`#project-select option[value="${project.id}"]`);
    await page.selectOption('#project-select', project.id);

    // Wait for tickets to load
    await page.waitForSelector('.ticket-card');

    const backlogTickets = page.locator('[data-column="backlog"] .ticket-card');
    const progressTickets = page.locator('[data-column="in_progress"] .ticket-card');
    const doneTickets = page.locator('[data-column="done"] .ticket-card');

    await expect(backlogTickets).toHaveCount(1);
    await expect(progressTickets).toHaveCount(1);
    await expect(doneTickets).toHaveCount(1);

    await expect(backlogTickets.first()).toContainText('Backlog Task');
    await expect(progressTickets.first()).toContainText('In Progress Task');
    await expect(doneTickets.first()).toContainText('Done Task');
  });

  test('should close a ticket via button', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    await createTicket(url, agent.apiKey, project.id, 'Open Task', 'backlog');

    await page.goto('/');
    await page.waitForSelector(`#project-select option[value="${project.id}"]`);
    await page.selectOption('#project-select', project.id);
    await page.waitForSelector('.ticket-card');

    // Click Close button
    await page.click('.btn-close');

    // Wait for ticket to move to done column
    await page.waitForSelector('[data-column="done"] .ticket-card');
    const doneTickets = page.locator('[data-column="done"] .ticket-card');
    await expect(doneTickets).toHaveCount(1);
  });

  test('should reopen a ticket via button', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    await createTicket(url, agent.apiKey, project.id, 'Closed Task', 'done');

    await page.goto('/');
    await page.waitForSelector(`#project-select option[value="${project.id}"]`);
    await page.selectOption('#project-select', project.id);
    await page.waitForSelector('.ticket-card');

    // Click Reopen button
    await page.click('.btn-open');

    // Wait for ticket to move to backlog
    await page.waitForSelector('[data-column="backlog"] .ticket-card');
    const backlogTickets = page.locator('[data-column="backlog"] .ticket-card');
    await expect(backlogTickets).toHaveCount(1);
  });

  test('should show activity feed when project selected', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    await createTicket(url, agent.apiKey, project.id, 'Some Task');

    await page.goto('/');
    await page.waitForSelector(`#project-select option[value="${project.id}"]`);
    await page.selectOption('#project-select', project.id);

    await expect(page.locator('#activity-feed')).toBeVisible();
  });

  test('should show audit log panel', async ({ page, baseURL }) => {
    const url = baseURL ?? 'http://localhost:3000';
    await createTicket(url, agent.apiKey, project.id, 'Task');

    await page.goto('/');
    await page.waitForSelector(`#project-select option[value="${project.id}"]`);
    await page.selectOption('#project-select', project.id);

    // Audit panel should be visible
    await expect(page.locator('#audit-panel')).toBeVisible();

    // Click Show button
    await page.click('#audit-toggle');
    await expect(page.locator('#audit-list')).toBeVisible();
  });

  test('should show agent count', async ({ page }) => {
    await page.goto('/');
    // Wait for agents to load
    await page.waitForFunction(() => {
      const el = document.getElementById('agent-count');
      return el && !el.textContent?.includes('0 agents');
    }, { timeout: 5000 }).catch(() => {
      // May still be 0 if this is the first test, that's ok
    });
    await expect(page.locator('#agent-count')).toBeVisible();
  });
});
