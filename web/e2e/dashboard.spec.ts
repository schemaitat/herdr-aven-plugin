import { test, expect } from '@playwright/test';
import { graphFixture } from '../test/fixtures/graph-snapshot.js';
import { largeGraph } from '../test/fixtures/large-graph.js';
import type { Core } from 'cytoscape';
import { orbitalLayout } from '../src/graph/layout.js';
import { defaultFilters, projectGraph } from '../src/graph/state.js';
import { allTypes } from './filter-controls.js';
import { projectDiscovery } from './project-fixture.js';

test('loading, empty, offline/retry, stale and optional-source outage states recover without breaking inspection', async ({ page }) => {
  await projectDiscovery(page, graphFixture.scope.project);
  let mode: 'empty' | 'offline' | 'optional' | 'stale' = 'empty';
  let release!: () => void;
  const loading = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/bootstrap', async route => { await loading; return route.fulfill({ json: { token: 'fixture-token' } }); });
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.route('**/api/snapshot', route => mode === 'offline' ? route.fulfill({ status: 503 }) : route.fulfill({ json: mode === 'empty' ? { ...graphFixture, nodes: [], edges: [] } : { ...graphFixture, health: [{ source: 'aven', status: mode === 'stale' ? 'stale' : 'ok', observedAt: graphFixture.observedAt, message: mode === 'stale' ? 'Retained previous Aven snapshot' : 'Tasks available' }, ...['herdr', 'opencode', 'dispatcher'].map(source => ({ source, status: 'unavailable', observedAt: graphFixture.observedAt, message: 'Optional capability unavailable' }))] } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  await expect(page.getByText('Reading local sources…')).toBeVisible();
  release();
  await expect(page.getByText('No entities match. Broaden the filters or check source health.')).toBeVisible();
  mode = 'offline';
  await expect(page.getByRole('alert')).toContainText('Snapshot unavailable');
  mode = 'optional';
  await expect(page.locator('.health.unavailable')).toHaveCount(3);
  const entry = page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /Standalone investigation/ });
  await entry.click();
  await page.keyboard.press('i');
  await expect(page.getByRole('complementary').getByRole('heading', { name: 'Standalone investigation', exact: true })).toBeVisible();
  mode = 'stale';
  await expect(page.locator('.health.stale')).toContainText('Retained previous Aven snapshot');
  await expect(entry).toHaveAttribute('aria-pressed', 'true');
});

test('cap is disclosed without losing search/list/detail discovery; entity and log DOM is windowed', async ({ page }) => {
  await projectDiscovery(page, 'performance-fixture');
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: largeGraph(560) }));
  await page.route('**/api/projects/*/logs/**', route => route.fulfill({ json: { entries: Array.from({ length: 100 }, (_, index) => ({ id: `log:${index}`, source: 'dispatcher', observedAt: '2026-10-20T12:00:00Z', text: `Summary ${index}`, durable: true })), message: 'Fixture window', gap: false } }));
  await page.goto('/');
  await allTypes(page);
  await expect(page.getByText(/Graph limited to 500 visible nodes · 60 additional matches/)).toBeVisible();
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  const entities = page.getByRole('region', { name: 'Entities', exact: true });
  await expect(entities.locator('li')).toHaveCount(40);
  for (let index = 0; index < 13; index++) await entities.getByRole('button', { name: 'Next entities', exact: true }).click();
  const last = entities.getByRole('button', { name: /Task 559/ });
  await last.focus(); await page.keyboard.press('Enter');
  await page.keyboard.press('i');
  await expect(page.getByRole('complementary').getByRole('heading', { name: 'Task 559', exact: true })).toBeVisible();
  await page.getByLabel('Search entities').fill('Task 559');
  // Selection does not change component focus; the complete list and i-opened
  // evidence remain available even for an off-canvas match.
  await expect(page.getByRole('complementary').getByRole('heading', { name: 'Task 559', exact: true })).toBeVisible();
  await expect(entities.getByRole('button', { name: /Task 559/ })).toBeVisible();
  await expect(last).toHaveAttribute('aria-pressed', 'true');
  const history = page.getByRole('region', { name: 'Event history' });
  await page.getByRole('button', { name: 'Event history', exact: true }).click();
  await history.getByRole('button', { name: 'Load / refresh history' }).click();
  await expect(history.locator('li')).toHaveCount(40);
  await history.getByRole('button', { name: 'Next history summaries' }).click();
  await expect(history.getByText(/Summary 79/, { exact: false })).toBeVisible();
  await expect(history.locator('li')).toHaveCount(40);
});

test('same-turn dense projection and reset controls use the latest identities/positions', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const fixture = largeGraph();
  await projectDiscovery(page, fixture.scope.project);
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: fixture }));
  await page.goto('/');
  await allTypes(page);
  await expect(page.locator('.graph-status')).toContainText('500 entities');
  // Both React updates land before the next canvas frame; reset must first
  // flush the pending projection rather than positioning removed epic nodes.
  await page.getByText('Filters', { exact: true }).click();
  await page.getByRole('checkbox', { name: 'epic', exact: true }).evaluate(element => {
    (element as HTMLInputElement).click();
    [...document.querySelectorAll('button')].find(button => button.textContent === 'Reset positions')!.click();
  });
  await expect.poll(() => page.locator('.graph-canvas').evaluate(element => (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy.nodes().length)).toBe(480);
  const projected = projectGraph(fixture, { ...defaultFilters(), kinds: new Set(['task']) }, new Set(), Date.parse(fixture.observedAt));
  const expected = Object.fromEntries(orbitalLayout(projected.nodes, projected.edges));
  const actual = await page.locator('.graph-canvas').evaluate(element => Object.fromEntries((element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy.nodes().map(node => [node.id(), node.position()])));
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  // Radial trigonometry can differ in the last bits between Node's and the
  // browser's V8; geometry identity is asserted to six decimals.
  for (const [id, position] of Object.entries(expected)) {
    expect(actual[id].x, id).toBeCloseTo(position.x, 6);
    expect(actual[id].y, id).toBeCloseTo(position.y, 6);
  }
  expect(errors).toEqual([]);
});

test('source health is available through the compact disclosure rather than persistent dashboard cards', async ({ page }) => {
  await projectDiscovery(page, graphFixture.scope.project);
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: graphFixture }));
  await page.goto('/');
  const sources = page.getByText(/Sources ·/);
  await sources.click();
  await expect(page.locator('.sources')).toContainText('aven');
  await expect(page.locator('.scope-strip')).toHaveCount(0);
});
