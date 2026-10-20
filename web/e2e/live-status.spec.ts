import { test, expect, type Page } from '@playwright/test';
import type { Core } from 'cytoscape';
import type { Activity, GraphSnapshot } from '../shared/graph.js';
import { applyActivity } from '../server/activity.js';
import { apiEvent, liveFixture } from '../test/fixtures/opencode-api.js';
import { summarizeEvent } from '../server/logs.js';

function live(state: Activity['state'], version?: number): GraphSnapshot {
  const now = Date.now();
  const snapshot = applyActivity(liveFixture(), new Map(['ses_one', 'ses_two'].map(id => [id, {
    sessionId: id, state: id === 'ses_one' ? state : 'idle', freshness: 'current', observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 4500).toISOString(), approval: id === 'ses_one', input: id === 'ses_one',
  }])));
  return { ...snapshot, version, health: [...snapshot.health, { source: 'opencode', status: 'ok', observedAt: new Date(now).toISOString(), message: 'Controlled API fixture' }], events: [summarizeEvent(apiEvent(1), 'ses_one', [])!], stream: { status: 'connected (no replay)', gaps: 0 } };
}
async function visualState(page: Page) {
  return page.locator('.graph-canvas').evaluate(element => {
    const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
    return { zoom: cy.zoom(), pan: cy.pan(), positions: cy.nodes().map(node => [node.id(), node.position()]), working: cy.getElementById('task:one').data('working'), selected: cy.elements('.selected').map(item => item.id()) };
  });
}
test.beforeEach(async ({ page }) => {
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
});

test('API activity transitions within five seconds without task-status/camera/selection changes; waiting and terminal disagreements remain inspectable', async ({ page }, info) => {
  let state: Activity['state'] = 'working';
  const audit: string[] = [];
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.route('**/api/snapshot', route => {
    audit.push(route.request().method()); expect(route.request().headers().authorization).toBe('Bearer fixture-token');
    return route.fulfill({ json: live(state) });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  const entities = page.getByRole('region', { name: 'Entities', exact: true });
  const task = entities.getByRole('button', { name: /task task:one/ });
  await expect(task).toContainText('Task status: todo · Working');
  await task.click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const before = await visualState(page);
  const activity = page.getByRole('region', { name: 'Live activity' });
  await page.getByRole('button', { name: 'Live activity', exact: true }).click();
  await expect(activity.getByText('Approval: true · Input: true', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  state = 'idle';
  await expect(task).not.toContainText('Working', { timeout: 5000 });
  await expect(task).toContainText('Task status: todo');
  expect((await visualState(page)).working).toBe('no');
  state = 'working';
  await expect(task).toContainText('Working', { timeout: 5000 });
  expect(await visualState(page)).toEqual(before);
  await entities.getByRole('button', { name: /session session:opencode:ses_one/ }).click();
  await page.getByRole('button', { name: 'Live activity', exact: true }).click();
  await expect(activity.getByText(/Herdr terminal observation: idle/)).toBeVisible();
  await expect(activity.getByText('Working · current', { exact: true })).toBeVisible();
  expect(await activity.textContent()).not.toContain('private prompt');
  expect(audit.every(method => method === 'GET')).toBe(true);
  await page.screenshot({ path: info.outputPath('live-activity.png'), fullPage: true });
});

test('disconnected browser hard-expires Working and recovers authoritative state without losing selection', async ({ page }) => {
  let available = true;
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.route('**/api/snapshot', route => available ? route.fulfill({ json: live('working') }) : route.fulfill({ status: 503 }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  const task = page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /task task:one/ });
  await expect(task).toContainText('Working'); await task.click();
  available = false;
  await expect(task).not.toContainText('Working', { timeout: 6000 });
  await page.getByRole('button', { name: 'Live activity', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Live activity' }).getByText('unknown · stale', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Live activity' }).locator('.waiting')).toHaveCount(0);
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  await expect(task).not.toContainText('Awaiting');
  expect((await visualState(page)).working).toBe('no');
  available = true;
  await expect(task).toContainText('Working', { timeout: 5000 });
  await expect(task).toHaveAttribute('aria-pressed', 'true');
  await expect(task).toContainText('Task status: todo');
});

test('authenticated stream reconnects/resnapshots version gaps, ignores duplicate/out-of-order snapshots and lazily pages safe history', async ({ page }) => {
  let snapshots = 0; let streams = 0; let logReads = 0;
  await page.route('**/api/snapshot', route => { snapshots++; return route.fulfill({ json: live(snapshots === 1 ? 'idle' : 'working', snapshots === 1 ? 1 : 3) }); });
  await page.route('**/api/stream', route => {
    streams++; expect(route.request().headers().authorization).toBe('Bearer fixture-token');
    const frames = [3, 3, 2].map(version => `id: ${version}\nevent: snapshot\ndata: ${JSON.stringify({ schema: 'live-graph/v1', version, snapshot: live(version === 2 ? 'idle' : 'working', version) })}\n\n`).join('');
    return route.fulfill({ contentType: 'text/event-stream', body: frames });
  });
  const hostile = '<img src=x onerror="window.__injected=true">';
  await page.route('**/api/logs/**', route => {
    logReads++; expect(route.request().headers().authorization).toBe('Bearer fixture-token');
    return route.fulfill({ json: { entries: [{ id: `log-${logReads}`, source: 'opencode', sessionId: 'ses_one', cursor: String(logReads), observedAt: new Date().toISOString(), text: hostile, durable: true }], next: logReads === 1 ? 'fixture-cursor' : undefined, message: 'Durable summaries; payloads omitted', gap: true } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  const entities = page.getByRole('region', { name: 'Entities', exact: true });
  await expect(entities.getByRole('button', { name: /task task:one/ })).toContainText('Working');
  await expect.poll(() => snapshots).toBeGreaterThanOrEqual(2);
  await expect.poll(() => streams).toBeGreaterThanOrEqual(2);
  expect(logReads).toBe(0);
  await entities.getByRole('button', { name: /session session:opencode:ses_one/ }).click();
  const history = page.getByRole('region', { name: 'Event history' });
  await page.getByRole('button', { name: 'Event history', exact: true }).click();
  await history.getByRole('button', { name: 'Load / refresh history' }).click();
  await expect(history.getByText(hostile, { exact: false })).toBeVisible();
  await history.getByRole('button', { name: 'Load next page' }).click();
  await expect(history.locator('li')).toHaveCount(2);
  await expect(history).toContainText('History gap / incomplete coverage');
  expect(await page.locator('img').count()).toBe(0); expect(await page.evaluate(() => '__injected' in window)).toBe(false);
  expect(logReads).toBe(2);
});
