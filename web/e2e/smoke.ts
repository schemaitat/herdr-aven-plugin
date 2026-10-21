import { test, expect } from '@playwright/test';

test('real scoped sources render with keyboard list/details and protected API', async ({ page, request }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) console.log(`Browser asset error: ${response.status()} ${new URL(response.url()).pathname}`); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Project explorer' })).toBeVisible();
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  const entities = page.getByRole('region', { name: 'Entities', exact: true });
  await expect(entities.locator('button.entity').first()).toBeVisible({ timeout: 20000 });
  const first = entities.locator('button.entity').first();
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  const details = page.getByRole('complementary', { name: 'Entity details' });
  await expect(details.getByText('Stable identity', { exact: true })).toBeVisible();
  await expect(details.getByRole('heading', { name: 'Provenance', exact: true })).toBeVisible();
  await page.getByLabel('Search entities').fill('no-such-entity-7c901');
  await expect(entities.getByText('No entities match.', { exact: false })).toBeVisible();
  await page.getByLabel('Search entities').fill('');
  await page.screenshot({ path: info.outputPath('explorer.png'), fullPage: true });
  const unauthorized = await request.get('/api/snapshot');
  expect(unauthorized.status()).toBe(401);
  for (const path of ['/server/index.ts', '/server/config.ts', '/@fs/etc/passwd', '/.env']) {
    const response = await request.get(path);
    expect([403, 404]).toContain(response.status());
  }
  const bootstrap = await request.get('/bootstrap');
  const { token } = await bootstrap.json();
  const snapshot = await (await request.get('/api/snapshot', { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(snapshot.nodes.some((node: { kind: string }) => ['task', 'epic'].includes(node.kind))).toBe(true);
  expect(snapshot.health.find((source: { source: string }) => source.source === 'aven').status).toBe('ok');
  expect(JSON.stringify(snapshot)).not.toMatch(/pending_prompt|aven_exe|auth_headers|prompt_id/);
  expect(errors).toEqual([]);
  console.log(JSON.stringify({ nodes: snapshot.nodes.length, edges: snapshot.edges.length, sources: snapshot.health.map((source: { source: string; status: string }) => `${source.source}:${source.status}`) }));
});

test('untrusted labels are text and unavailable sources remain visible', async ({ page }) => {
  await page.route('**/api/projects', route => route.fulfill({ json: { workspace: 'default', startup: 'fixture', projects: [{ key: 'fixture', name: 'Fixture' }], status: 'ok', message: 'Fixture' } }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  const hostile = '<img src=x onerror="window.__injected=true">';
  await page.route('**/api/snapshot', route => route.fulfill({ json: {
    schema: 'local-explorer/v1', scope: { project: 'fixture', workspace: 'default' }, observedAt: '2026-10-20T00:00:00Z',
    nodes: [{ id: 'task:fixture', kind: 'task', label: hostile, state: 'todo', details: { untrusted: '<script>alert(1)</script>' }, provenance: [{ source: 'aven', record: 'fixture', observedAt: '2026-10-20T00:00:00Z' }] }], edges: [],
    health: [{ source: 'aven', status: 'ok', observedAt: '2026-10-20T00:00:00Z', message: 'Fixture' }, { source: 'herdr', status: 'unavailable', observedAt: '2026-10-20T00:00:00Z', message: 'No Herdr' }],
  } }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  await page.getByRole('button', { name: new RegExp('img src=x') }).click();
  await expect(page.getByRole('complementary').getByRole('heading', { name: hostile, exact: true })).toBeVisible();
  await expect(page.getByText('<script>alert(1)</script>', { exact: true })).toBeVisible();
  await expect(page.getByText('herdr · unavailable', { exact: true })).toBeVisible();
  expect(await page.locator('img').count()).toBe(0);
  expect(await page.evaluate(() => '__injected' in window)).toBe(false);
});
