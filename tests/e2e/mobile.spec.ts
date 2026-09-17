import { test, expect, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';

async function expectFits(page: Page, selector: string): Promise<void> {
  const element = page.locator(selector);
  await expect(element).toBeVisible();
  await expect.poll(() => element.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
}

for (const viewport of [{ width: 320, height: 700 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test.describe(`Mobile ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, isMobile: true, hasTouch: true });

    test('overview, scrolling board, ticket details and editable columns stay usable', async ({ page, request }) => {
      const db = new Database(path.resolve(process.env['DB_PATH'] || 'agentboard-e2e.db'), { readonly: true });
      const { value: key } = db.prepare("SELECT value FROM settings WHERE key = 'admin_api_key'").get() as { value: string };
      db.close();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      const headers = { 'X-Admin-Key': key };
      const name = `Mobile ${viewport.width} ${Date.now()} with a long project name`;
      const projectResponse = await request.post('/api/projects', { headers, data: { name, description: 'Long description '.repeat(12) } });
      expect(projectResponse.ok()).toBeTruthy();
      const project = await projectResponse.json() as { id: string };
      const otherResponse = await request.post('/api/projects', { headers, data: { name: `${name} empty` } });
      expect(otherResponse.ok()).toBeTruthy();
      const other = await otherResponse.json() as { id: string };
      const agentResponse = await request.post('/api/agents', { headers, data: { name: `Mobile agent ${Date.now()}` } });
      expect(agentResponse.ok()).toBeTruthy();
      const agent = await agentResponse.json() as { id: string; apiKey: string };
      try {
        const ticketResponse = await request.post(`/api/projects/${project.id}/tickets`, {
          headers: { 'X-Api-Key': agent.apiKey },
          data: {
            title: 'A mobile ticket with long content',
            description: `https://example.com/${'longpath'.repeat(40)}\n\n\`\`\`js\n${'const example = 123; '.repeat(40)}\n\`\`\`\n\n${'Paragraph for vertical scrolling.\n\n'.repeat(25)}`,
          },
        });
        expect(ticketResponse.ok()).toBeTruthy();
        await page.goto('/login.html');
        await expectFits(page, '.login-card');
        await page.locator('#password').fill(key);
        await page.locator('.btn-login').click();
        await expect(page.locator('#project-overview')).toBeVisible();
        await expectFits(page, '.overview-table-wrap');
        await page.getByText(name, { exact: true }).click();
        await expect(page.locator('.column')).toHaveCount(6);
        await expectFits(page, 'header');
        const board = page.locator('#board');
        expect(await page.locator('.column').first().evaluate(el => el.clientWidth)).toBeGreaterThan(250);
        await board.evaluate(el => { el.scrollLeft = el.scrollWidth; });
        await expect(page.locator('.column').last()).toBeInViewport();
        await board.evaluate(el => { el.scrollLeft = 0; });
        await page.getByText('A mobile ticket with long content', { exact: true }).click();
        await expectFits(page, '#ticket-modal .modal-body');
        await page.getByRole('button', { name: 'History', exact: true }).click();
        await expect(page.locator('#tab-history')).toBeVisible();
        await expect(page.locator('#ticket-modal .modal-close')).toBeInViewport();
        await page.locator('#ticket-modal .modal-close').click();
        await page.locator('#edit-columns-btn').click();
        await expectFits(page, '#columns-modal .modal');
        await page.getByRole('button', { name: '+ Add column', exact: true }).click();
        await page.getByRole('textbox', { name: 'Column name' }).last().fill('Mobile QA');
        await page.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.locator('#columns-modal')).toBeHidden();
        await expect(page.locator('.column')).toHaveCount(7);
        await board.evaluate(el => { el.scrollLeft = el.scrollWidth; });
        await expect(page.locator('.column').last()).toBeInViewport();
        await expect(page.locator('.column-title').last()).toHaveText('MOBILE QA');
        await page.locator('#agent-count').click();
        await expect(page.locator('.agent-row').first()).toBeVisible();
        await expectFits(page, '#agents-modal .modal');
        await page.locator('#agents-modal .modal-close').click();
        await page.locator('#audit-toggle').click();
        await expectFits(page, '#audit-list');
        await page.locator('#current-project-name').click();
        await expectFits(page, '.overview-table-wrap');
        expect(errors).toEqual([]);
      } finally {
        await request.delete(`/api/projects/${project.id}`, { headers });
        await request.delete(`/api/projects/${other.id}`, { headers });
        await request.delete(`/api/agents/${agent.id}`, { headers });
      }
    });
  });
}
