import { test, expect } from '@playwright/test';
import Database from 'better-sqlite3';
import path from 'node:path';

test('HTML draft preview, isolation, versions and human approval', async ({
  page,
  request,
}) => {
  const db = new Database(
    path.resolve(process.env['DB_PATH'] || 'agentboard-e2e.db'),
    { readonly: true },
  );
  const { value: key } = db
    .prepare("SELECT value FROM settings WHERE key = 'admin_api_key'")
    .get() as { value: string };
  db.close();
  const admin = { 'X-Admin-Key': key };
  const project = (await (
    await request.post('/api/projects', {
      headers: admin,
      data: { name: 'HTML QA ' + Date.now() },
    })
  ).json()) as { id: string };
  const agent = (await (
    await request.post('/api/agents', {
      headers: admin,
      data: { name: 'HTML QA ' + Date.now() },
    })
  ).json()) as { apiKey: string };
  const headers = { 'X-Api-Key': agent.apiKey };
  const ticket = (await (
    await request.post(`/api/projects/${project.id}/tickets`, {
      headers,
      data: { title: 'Folder definition mockup' },
    })
  ).json()) as { id: string };
  const base = `/api/projects/${project.id}/tickets/${ticket.id}/drafts`;
  const html =
    '<style>body{padding:20px;box-sizing:border-box}article{padding:24px;border:1px solid #888;border-radius:20px}h1{font:600 24px system-ui}@media(prefers-color-scheme:dark){article{background:rgb(20,30,40)}}</style><article><h1>New folder</h1><p>Description, inclusions and exclusions</p><button>Fill empty fields with AI</button></article><script>parent.pwned=true</script><img src="https://forbidden.example/pixel" onerror="parent.pwned=true"><meta http-equiv="refresh" content="0;url=https://forbidden.example">';
  const response = await request.post(base, {
    headers,
    data: { title: 'Create folder', html },
  });
  expect(response.status()).toBe(201);
  const draft = (await response.json()) as {
    id: string;
    version: number;
    previewPath: string;
  };
  await page.addInitScript(() =>
    localStorage.setItem('agentboard.language', 'de'),
  );
  await page.request.post('/api/auth/login', { data: { key } });
  const forbidden: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes('forbidden.example')) forbidden.push(r.url());
  });
  await page.goto(`/projects/${project.id}/tickets/${ticket.id}`);
  await expect(page.locator('#modal-drafts-section')).toBeVisible();
  await expect(page.locator('#ticket-drafts .draft-id code')).toContainText(
    `${draft.id} · v${draft.version}`,
  );
  await expect(page.locator('#ticket-drafts')).toContainText(
    'Visuelle Prüfung ausstehend',
  );
  await expect(
    page
      .frameLocator('#ticket-drafts iframe')
      .getByRole('heading', { name: 'New folder' }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => Reflect.get(window, 'pwned')),
  ).toBeUndefined();
  expect(forbidden).toEqual([]);
  await page.getByRole('button', { name: 'Diese Version freigeben' }).click();
  await expect(page.locator('#ticket-drafts')).toContainText(
    'Vom Nutzer freigegeben',
  );
  const v2 = await request.post(base, {
    headers,
    data: {
      title: 'Create folder',
      html: html.replace('New folder', 'New folder v2'),
      draft_id: draft.id,
      expected_version: 1,
    },
  });
  expect(v2.status()).toBe(201);
  await page
    .getByRole('button', { name: 'Entwürfe neu laden', exact: true })
    .click();
  await page.getByLabel('Ansicht und Version').selectOption(`${draft.id}:2`);
  await expect(page.locator('#ticket-drafts')).toContainText(
    'Visuelle Prüfung ausstehend',
  );
  await expect(page.locator('#ticket-drafts')).toContainText(
    'Noch nicht vom Nutzer freigegeben',
  );
  await page.getByLabel('Ansicht und Version').selectOption(`${draft.id}:1`);
  await expect(
    page
      .frameLocator('#ticket-drafts iframe')
      .getByRole('heading', { name: 'New folder', exact: true }),
  ).toBeVisible();
  for (const width of [390, 1280])
    for (const theme of ['light', 'dark'] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(
        draft.previewPath + `&capture=1&width=${width}&theme=${theme}`,
      );
      const frame = page.frameLocator('iframe');
      await expect(
        frame.getByRole('heading', { name: 'New folder', exact: true }),
      ).toBeVisible();
      expect(
        await page.locator('iframe').evaluate((el) => el.clientWidth),
      ).toBe(width);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth - innerWidth,
        ),
      ).toBeLessThanOrEqual(1);
      if (theme === 'dark')
        await expect(frame.locator('article')).toHaveCSS(
          'background-color',
          'rgb(20, 30, 40)',
        );
      await page.screenshot({
        path: `/tmp/agentboard-html-${width}-${theme}.png`,
        fullPage: true,
      });
    }
  await request.delete(`/api/projects/${project.id}`, { headers: admin });
});
