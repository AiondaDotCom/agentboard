import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';

// Simplified BPMN at a ticket: section appears, steps and flows carry copyable sub-IDs (#be30299e)
test('process diagram with copyable sub-IDs and large view', async ({ page, request, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const db = new Database(path.resolve(process.env['DB_PATH'] || 'agentboard-e2e.db'), { readonly: true });
  const { value: key } = db.prepare("SELECT value FROM settings WHERE key = 'admin_api_key'").get() as { value: string };
  db.close();
  const admin = { 'X-Admin-Key': key };
  const project = (await (await request.post('/api/projects', { headers: admin, data: { name: 'BPMN QA ' + Date.now() } })).json()) as { id: string };
  const agent = (await (await request.post('/api/agents', { headers: admin, data: { name: 'BPMN QA ' + Date.now() } })).json()) as { apiKey: string };
  const headers = { 'X-Api-Key': agent.apiKey };
  const ticket = (await (await request.post(`/api/projects/${project.id}/tickets`, { headers, data: { title: 'Create folder' } })).json()) as { id: string };

  await page.addInitScript(() => localStorage.setItem('agentboard.language', 'de'));
  await page.request.post('/api/auth/login', { data: { key } });
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  await expect(page.locator('#modal-title')).toHaveText('Create folder');
  // No diagram yet: no empty section
  await expect(page.locator('#modal-process-section')).toBeHidden();

  const saved = await request.post(`/api/projects/${project.id}/tickets/${ticket.id}/process-diagrams`, {
    headers,
    data: {
      title: 'Ordner anlegen',
      lanes: [{ id: 'user', name: 'Nutzer' }, { id: 'server', name: 'Server' }],
      nodes: [
        { id: 'start', type: 'start', label: 'Tippt „Erstellen“', lane: 'user' },
        { id: 'store', type: 'task', label: 'Ordner speichern', lane: 'server' },
        { id: 'ok', type: 'decision', label: 'Gespeichert?', lane: 'server' },
        { id: 'done', type: 'end', label: 'Ordner sichtbar', lane: 'user' },
        { id: 'error', type: 'end', label: 'Fehler zeigen', lane: 'user' },
      ],
      flows: [
        { from: 'start', to: 'store' },
        { from: 'store', to: 'ok' },
        { from: 'ok', to: 'done', label: 'ja' },
        { from: 'ok', to: 'error', label: 'nein' },
      ],
    },
  });
  expect(saved.status()).toBe(201);
  const diagram = (await saved.json()) as { id: string };

  // Live update through the board event, without reloading
  const section = page.locator('#modal-process-section');
  await expect(section).toBeVisible();
  await expect(page.locator('#modal-process-count')).toHaveText('(1)');
  const card = page.locator('#ticket-process .pd-card');
  await expect(card.locator('.pd-id').first()).toHaveText(`${diagram.id.slice(0, 8)} · v1`);
  await expect(card.locator('g.pd-node')).toHaveCount(5);

  await card.locator('g.pd-node[data-ref="S2"]').click();
  await expect(card.locator('.pd-detail')).toContainText('Ordner speichern');
  await card.locator('.pd-detail .pd-copy').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `Ablauf ${diagram.id} v1 („Ordner anlegen“), Schritt S2 „Ordner speichern“ (Server)`,
  );

  await card.locator('.pd-steps summary').click();
  const row = card.locator('.pd-row', { hasText: 'F4' });
  await row.getByRole('button', { name: 'ID kopieren' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `Ablauf ${diagram.id} v1 („Ordner anlegen“), Pfeil F4: S3 „Gespeichert?“ → S5 „Fehler zeigen“ [nein]`,
  );

  // Large view in a modal dialog; Escape returns the card to the ticket
  await card.getByRole('button', { name: 'Groß anzeigen' }).click();
  await expect(page.locator('dialog.pd-dialog[open] .pd-card')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.pd-dialog')).toHaveCount(0);
  await expect(page.locator('#ticket-process .pd-card')).toHaveCount(1);
  await expect(page.locator('#ticket-modal')).toBeVisible();
});
