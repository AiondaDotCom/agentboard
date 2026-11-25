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

  // Humans can remove a diagram that does not fit the ticket
  page.once('dialog', (d) => void d.accept());
  await page.locator('#ticket-process .pd-card').getByRole('button', { name: 'Entfernen' }).click();
  await expect(page.locator('#modal-process-section')).toBeHidden();
  expect(await (await request.get(`/api/projects/${project.id}/tickets/${ticket.id}/process-diagrams`, { headers })).json()).toEqual([]);
});

// A line through a shape it does not belong to reads as a different process
// (25.11.2026: "S11 → Text unverändert" ran through S13, S15, S16). Property check over every segment.
// Alarm probe 25.11.2026: the first routing (commit c428ee1) gives 26 crossings for this diagram.
const IMPROVE = {"title": "Feld „Verbessern“ mit KI", "lanes": [{"id": "user", "name": "Nutzer"}, {"id": "app", "name": "App"}, {"id": "ki", "name": "KI-Dienst"}], "nodes": [{"id": "start", "type": "start", "label": "Tippt „Verbessern“ an einem Feld", "lane": "user"}, {"id": "available", "type": "decision", "label": "KI verfügbar?", "lane": "app"}, {"id": "manual", "type": "task", "label": "Hinweis: manuell weiter", "lane": "app"}, {"id": "snapshot", "type": "task", "label": "Formularkontext und Feldstände festhalten", "lane": "app"}, {"id": "request", "type": "task", "label": "Name, Elternordner, drei Texte senden", "lane": "app"}, {"id": "clear", "type": "decision", "label": "Zweck klar?", "lane": "ki"}, {"id": "ask", "type": "task", "label": "Kurze Rückfrage zeigen", "lane": "app"}, {"id": "answer", "type": "task", "label": "Beantwortet Rückfrage", "lane": "user"}, {"id": "generate", "type": "task", "label": "Vorschlag nur für dieses Feld erzeugen", "lane": "ki"}, {"id": "usable", "type": "decision", "label": "Antwort brauchbar?", "lane": "app"}, {"id": "noSuggestion", "type": "task", "label": "Hinweis: kein Vorschlag", "lane": "app"}, {"id": "stale", "type": "decision", "label": "Kontext seit Anfrage geändert?", "lane": "app"}, {"id": "outdated", "type": "task", "label": "Vorschlag verwerfen, neu anfragen anbieten", "lane": "app"}, {"id": "contradiction", "type": "decision", "label": "Widerspruch zu anderem Feld?", "lane": "app"}, {"id": "warn", "type": "task", "label": "Widerspruch melden, Nachbarfeld bleibt", "lane": "app"}, {"id": "preview", "type": "task", "label": "Vorschau „Bisher / KI-Vorschlag“", "lane": "app"}, {"id": "accept", "type": "decision", "label": "Übernehmen?", "lane": "user"}, {"id": "replace", "type": "task", "label": "Nur dieses Feld ersetzen", "lane": "app"}, {"id": "improved", "type": "end", "label": "Feld verbessert, noch nicht gespeichert", "lane": "user"}, {"id": "unchanged", "type": "end", "label": "Text unverändert", "lane": "user"}], "flows": [{"from": "start", "to": "available"}, {"from": "available", "to": "snapshot", "label": "ja"}, {"from": "available", "to": "manual", "label": "nein"}, {"from": "manual", "to": "unchanged"}, {"from": "snapshot", "to": "request"}, {"from": "request", "to": "clear"}, {"from": "clear", "to": "generate", "label": "ja"}, {"from": "clear", "to": "ask", "label": "nein"}, {"from": "ask", "to": "answer"}, {"from": "answer", "to": "request"}, {"from": "generate", "to": "usable"}, {"from": "usable", "to": "stale", "label": "ja"}, {"from": "usable", "to": "noSuggestion", "label": "nein / Zeitlimit"}, {"from": "noSuggestion", "to": "unchanged"}, {"from": "stale", "to": "outdated", "label": "ja"}, {"from": "stale", "to": "contradiction", "label": "nein"}, {"from": "outdated", "to": "unchanged"}, {"from": "contradiction", "to": "warn", "label": "ja"}, {"from": "contradiction", "to": "preview", "label": "nein"}, {"from": "warn", "to": "preview"}, {"from": "preview", "to": "accept"}, {"from": "accept", "to": "replace", "label": "Übernehmen"}, {"from": "accept", "to": "unchanged", "label": "Verwerfen"}, {"from": "replace", "to": "improved"}]};

test('no flow line crosses a shape it does not belong to', async ({ page, request }) => {
  const db = new Database(path.resolve(process.env['DB_PATH'] || 'agentboard-e2e.db'), { readonly: true });
  const { value: key } = db.prepare("SELECT value FROM settings WHERE key = 'admin_api_key'").get() as { value: string };
  db.close();
  const admin = { 'X-Admin-Key': key };
  const project = (await (await request.post('/api/projects', { headers: admin, data: { name: 'BPMN Routing ' + Date.now() } })).json()) as { id: string };
  const agent = (await (await request.post('/api/agents', { headers: admin, data: { name: 'BPMN Routing ' + Date.now() } })).json()) as { apiKey: string };
  const headers = { 'X-Api-Key': agent.apiKey };
  const ticket = (await (await request.post(`/api/projects/${project.id}/tickets`, { headers, data: { title: 'Improve field' } })).json()) as { id: string };
  expect((await request.post(`/api/projects/${project.id}/tickets/${ticket.id}/process-diagrams`, { headers, data: IMPROVE })).status()).toBe(201);
  await page.request.post('/api/auth/login', { data: { key } });
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  await expect(page.locator('#ticket-process g.pd-node')).toHaveCount(IMPROVE.nodes.length);
  const result = await page.evaluate(() => {
    const card = document.querySelector('#ticket-process .pd-card') as HTMLElement;
    const boxes = [...card.querySelectorAll('g.pd-node')].map((g) => ({ ref: (g as HTMLElement).dataset['ref'], box: (g.querySelector('.pd-shape') as SVGGraphicsElement).getBBox() }));
    const hits: string[] = [];
    let segments = 0;
    for (const g of card.querySelectorAll('g.pd-flow')) {
      const d = (g.querySelector('.pd-line') as SVGPathElement).getAttribute('d') ?? '';
      const points: [number, number][] = [];
      let x = 0, y = 0;
      for (const [, c, v] of d.matchAll(/([MHV])\s*([-\d.]+(?:,[-\d.]+)?)/g)) {
        if (c === 'M') [x, y] = v.split(',').map(Number) as [number, number];
        else if (c === 'H') x = Number(v);
        else y = Number(v);
        points.push([x, y]);
      }
      for (let i = 1; i < points.length; i++) {
        segments++;
        const [x1, y1] = points[i - 1], [x2, y2] = points[i];
        for (const { ref, box } of boxes) {
          const inX = Math.max(x1, x2) > box.x + 2 && Math.min(x1, x2) < box.x + box.width - 2;
          const inY = Math.max(y1, y2) > box.y + 2 && Math.min(y1, y2) < box.y + box.height - 2;
          if (inX && inY) hits.push(`${(g as HTMLElement).dataset['ref']} crosses ${ref}`);
        }
      }
    }
    return { segments, hits };
  });
  // Denominator: every flow drawn with several segments, otherwise "no hits" proves nothing
  expect(result.segments).toBeGreaterThan(IMPROVE.flows.length * 2);
  expect(result.hits).toEqual([]);
});

// Ticket as full page (like Jira); stays full page after a reload (⌘R)
test('ticket opens as full page and stays so after reload', async ({ page, request }) => {
  const db = new Database(path.resolve(process.env['DB_PATH'] || 'agentboard-e2e.db'), { readonly: true });
  const { value: key } = db.prepare("SELECT value FROM settings WHERE key = 'admin_api_key'").get() as { value: string };
  db.close();
  const admin = { 'X-Admin-Key': key };
  const project = (await (await request.post('/api/projects', { headers: admin, data: { name: 'Full page ' + Date.now() } })).json()) as { id: string };
  const agent = (await (await request.post('/api/agents', { headers: admin, data: { name: 'Full page ' + Date.now() } })).json()) as { apiKey: string };
  const ticket = (await (await request.post(`/api/projects/${project.id}/tickets`, { headers: { 'X-Api-Key': agent.apiKey }, data: { title: 'Wide ticket' } })).json()) as { id: string };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('agentboard.language', 'de'));
  await page.request.post('/api/auth/login', { data: { key } });
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  const panel = page.locator('#ticket-modal');
  await expect(page.locator('#modal-title')).toHaveText('Wide ticket');
  const narrow = (await panel.boundingBox())!.width;
  await expect(page.locator('#board')).toBeVisible();
  const toggle = page.getByRole('button', { name: 'Ticket auf ganzer Seite öffnen' });
  await toggle.click();
  await expect(page.locator('#board')).toBeHidden();
  expect((await panel.boundingBox())!.width).toBeGreaterThan(narrow + 300);
  await page.reload();
  await expect(page.locator('#modal-title')).toHaveText('Wide ticket');
  await expect(page.locator('#board')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Ticket wieder neben dem Board zeigen' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Ticket wieder neben dem Board zeigen' }).click();
  await expect(page.locator('#board')).toBeVisible();
});
