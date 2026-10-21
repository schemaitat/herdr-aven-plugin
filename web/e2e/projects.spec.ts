import { test, expect, type Page } from '@playwright/test';
import type { Core } from 'cytoscape';
import type { GraphSnapshot } from '../shared/graph.js';
import { graphFixture } from '../test/fixtures/graph-snapshot.js';
import { allTypes } from './filter-controls.js';

const listing = { workspace: 'default', startup: 'alpha', status: 'ok', message: 'Configured workspace only', projects: [{ key: 'alpha', name: 'Alpha' }, { key: 'beta', name: 'Beta' }] };
function snapshot(project: string, version = 1): GraphSnapshot {
  return { ...graphFixture, scope: { workspace: 'default', project }, version, stream: { status: 'fixture', gaps: 0, instance: project },
    nodes: graphFixture.nodes.map(node => ({ ...node, label: `${project} ${node.label}`, state: 'active', changedAt: new Date().toISOString() })),
    health: project === 'alpha' ? graphFixture.health : [...graphFixture.health, { source: 'dispatcher', status: 'unavailable', observedAt: '', message: 'Local store unavailable for non-startup project; scoped Aven recovery snapshots only' }, { source: 'herdr', status: 'unavailable', observedAt: '', message: 'Local topology unavailable for non-startup project; startup repository topology is not reused' }],
  };
}
async function fixtures(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('**/api/projects', route => { expect(route.request().headers().authorization).toBe('Bearer fixture-token'); return route.fulfill({ json: listing }); });
  await page.route('**/api/snapshot', route => route.fulfill({ json: snapshot('alpha') }));
  await page.route('**/api/projects/*/snapshot', route => route.fulfill({ json: snapshot(new URL(route.request().url()).pathname.split('/')[3]) }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.route('**/api/projects/*/stream', route => route.fulfill({ status: 404 }));
}
async function visual(page: Page) {
  return page.locator('.graph-canvas').evaluate(element => {
    const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
    return { zoom: cy.zoom(), pan: cy.pan(), positions: Object.fromEntries(cy.nodes().map(node => [node.id(), node.position()])), selected: cy.elements('.selected').map(node => node.id()) };
  });
}

test('project switch disposes active physics, clears component/pins and never writes through the old renderer', async ({ page }) => {
  await fixtures(page); await page.goto('/'); await allTypes(page);
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /alpha Build graph/ }).click();
  await expect(page.getByRole('button', { name: 'Show all', exact: true }).first()).toBeVisible();
  await page.locator('.graph-canvas').evaluate(element => {
    const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
    cy.getElementById('task:b').position({ x: 2345, y: 6789 }); cy.getElementById('task:b').emit('dragfree');
    Object.assign(window, { oldPhysics: { host: element, cy } });
  });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.graph-canvas')).toHaveAttribute('data-motion', 'active');
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('beta');
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('beta');
  await expect(page.locator('.graph-status')).toContainText('14 entities');
  await expect(page.locator('.graph-canvas')).toHaveAttribute('data-motion', 'sleeping', { timeout: 1800 });
  await expect(page.getByRole('button', { name: 'Show all', exact: true })).toHaveCount(0);
  expect((await visual(page)).positions['task:b']).not.toEqual({ x: 2345, y: 6789 });
  const disposed = () => page.evaluate(() => {
    const old = (window as unknown as { oldPhysics: { host: HTMLElement; cy: Core } }).oldPhysics;
    return { destroyed: old.cy.destroyed(), ticks: old.host.dataset.physicsTicks, active: old.host.dataset.motion };
  });
  const before = await disposed(); expect(before.destroyed).toBe(true); expect(before.active).toBe('sleeping');
  await page.waitForTimeout(100); expect(await disposed()).toEqual(before);
});

test('project switching removes current selection cues from the replacement canvas', async ({ page }) => {
  await fixtures(page); await page.goto('/'); await allTypes(page);
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /alpha Build graph/ }).click();
  await expect(page.locator('.graph-cue[data-cue~="one-hop"]')).not.toHaveCount(0);
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('beta');
  await expect(page.locator('.graph-cue')).toHaveCount(0);
});

test('A → B → A resets project memory/selection/query/epic but retains type/state/time preferences and scoped history', async ({ page }, info) => {
  await fixtures(page);
  let releaseBeta!: () => void;
  const betaReady = new Promise<void>(resolve => { releaseBeta = resolve; });
  await page.route('**/api/projects/beta/snapshot', async route => { await betaReady; return route.fulfill({ json: snapshot('beta') }); });
  const logReads: string[] = [];
  await page.route('**/api/projects/*/logs/**', route => {
    const project = new URL(route.request().url()).pathname.split('/')[3]; logReads.push(project);
    return route.fulfill({ json: { entries: [{ id: 'same-entry', source: 'dispatcher', text: `${project} history`, observedAt: '', durable: true }], message: `${project} scoped history`, gap: false } });
  });
  await page.goto('/'); await allTypes(page);
  await expect(page.locator('.graph-status')).toContainText('14 entities');
  const baseline = await visual(page);
  await page.getByText('Filters', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Source state', exact: true }).selectOption('active');
  await page.getByRole('combobox', { name: 'Recent source changes', exact: true }).selectOption('24h');
  await page.getByLabel('Epic scope', { exact: true }).selectOption('epic:a');
  await page.getByText('Filters', { exact: true }).click();
  await page.getByLabel('Search entities').fill('Build');
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /alpha Build graph/ }).click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.locator('.graph-canvas').evaluate(element => {
    const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
    cy.getElementById('task:b').position({ x: 2345, y: 6789 }); cy.getElementById('task:b').emit('dragfree');
  });
  await page.getByRole('button', { name: 'Event history', exact: true }).click();
  await page.getByRole('button', { name: 'Load / refresh history' }).click();
  await expect(page.getByText('alpha history', { exact: false })).toBeVisible();
  const arranged = await visual(page);
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('beta');
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('beta');
  await expect(page.locator('.graph-status')).toContainText('0 entities');
  await expect(page.getByText('alpha history', { exact: false })).toHaveCount(0);
  releaseBeta();
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('beta');
  await expect(page.locator('.graph-status')).toContainText('14 entities');
  const reset = await visual(page);
  expect(reset.selected).toEqual([]);
  expect(reset.positions['task:b']).toEqual(baseline.positions['task:b']);
  expect(reset.zoom).not.toBe(arranged.zoom);
  await expect(page.getByLabel('Search entities')).toHaveValue('');
  await expect(page.getByText('alpha history', { exact: false })).toHaveCount(0);
  await expect(page.locator('.health.unavailable')).toHaveCount(2);
  await page.getByText(/Sources ·/).click();
  await expect(page.getByText(/startup repository topology is not reused/)).toBeVisible();
  await page.getByText('Filters', { exact: true }).click();
  await expect(page.getByLabel('Epic scope', { exact: true })).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'Source state', exact: true })).toHaveValue('active');
  await expect(page.getByRole('combobox', { name: 'Recent source changes', exact: true })).toHaveValue('24h');
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(9);
  await page.getByText('Filters', { exact: true }).click();
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /beta Build graph/ }).click();
  await page.getByRole('button', { name: 'Event history', exact: true }).click();
  await page.getByRole('button', { name: 'Load / refresh history' }).click();
  await expect(page.getByText('beta history', { exact: false })).toBeVisible();
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('alpha');
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('alpha');
  await expect(page.locator('.graph-status')).toContainText('14 entities');
  const returned = await visual(page);
  expect(returned.positions).toEqual(reset.positions); expect(returned.selected).toEqual([]);
  // Beta's explicit unavailable-source health messages consume more viewport
  // height. Fresh camera fits may therefore differ across projects, but neither
  // may reuse Alpha's manually changed camera or pinned geometry.
  expect(returned.zoom).not.toBe(arranged.zoom); expect(returned.pan).not.toEqual(arranged.pan);
  await expect(page.locator('.inspector')).toHaveCount(0);
  expect(logReads).toEqual(['alpha', 'beta']);
  for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`projects-${size.width}.png`), fullPage: true });
  }
});

test('late uncooperative A snapshot/stream/history and wrong-scope B responses cannot cross a switch', async ({ page }) => {
  await fixtures(page);
  // Deliberately ignore fetch AbortSignals so this verifies generation checks as well as abort.
  await page.addInitScript(() => {
    const native = window.fetch.bind(window);
    const pending: { path: string; resolve: (response: Response) => void }[] = [];
    const streams: { path: string; controller: ReadableStreamDefaultController<Uint8Array> }[] = [];
    let deferSnapshots = false;
    const control = {
      pending: () => pending.map(item => item.path), streams: () => streams.map(item => item.path),
      defer: () => { deferSnapshots = true; },
      resolve: (path: string, value: unknown) => { const index = pending.findIndex(item => item.path === path); if (index < 0) throw new Error('No pending read'); pending.splice(index, 1)[0].resolve(new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })); },
      frame: (path: string, value: unknown) => { const stream = streams.find(item => item.path === path)!; stream.controller.enqueue(new TextEncoder().encode((Array.isArray(value) ? value : [value]).map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''))); },
    };
    Object.assign(window, { projectTest: control });
    window.fetch = async (input, init) => {
      const path = new URL(String(input), location.origin).pathname;
      if (path.endsWith('/stream')) {
        const body = new ReadableStream<Uint8Array>({ start(controller) { streams.push({ path, controller }); } });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }
      if ((deferSnapshots && path === '/api/snapshot') || path.includes('/logs/')) return new Promise<Response>(resolve => pending.push({ path, resolve }));
      return native(input, init);
    };
  });
  type Control = { pending(): string[]; streams(): string[]; defer(): void; resolve(path: string, value: unknown): void; frame(path: string, value: unknown): void };
  await page.goto('/'); await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('alpha');
  await expect.poll(() => page.evaluate(() => (window as unknown as { projectTest: Control }).projectTest.streams().length)).toBe(1);
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /alpha Build graph/ }).click();
  await page.getByRole('button', { name: 'Event history', exact: true }).click();
  await page.getByRole('button', { name: 'Load / refresh history' }).click();
  await page.evaluate(() => (window as unknown as { projectTest: Control }).projectTest.defer());
  const old = snapshot('alpha', 999); old.nodes[0].label = 'LATE ALPHA MUST NOT APPEAR';
  await page.evaluate(old => { const c = (window as unknown as { projectTest: Control }).projectTest; c.frame('/api/stream', [{ schema: 'live-heartbeat/v1', scope: { project: 'alpha', workspace: 'default' }, version: 99, instance: 'alpha', health: [], stream: { status: 'old', gaps: 0 } }, { schema: 'live-graph/v1', version: old.version, snapshot: old }]); }, old);
  await expect.poll(() => page.evaluate(() => (window as unknown as { projectTest: Control }).projectTest.pending().some(path => path === '/api/snapshot'))).toBe(true);
  const oldLog = (await page.evaluate(() => (window as unknown as { projectTest: Control }).projectTest.pending())).find(path => path.includes('/logs/'))!;
  await page.getByRole('combobox', { name: 'Project', exact: true }).selectOption('beta');
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('beta');
  await page.evaluate(({ old, oldLog }) => {
    const c = (window as unknown as { projectTest: Control }).projectTest;
    c.resolve('/api/snapshot', old); c.resolve(oldLog, { entries: [{ id: 'late', text: 'LATE HISTORY', source: 'dispatcher', observedAt: '', durable: true }], message: 'LATE HISTORY', gap: false });
  }, { old, oldLog });
  await expect(page.getByText(/LATE ALPHA|LATE HISTORY/)).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('beta');
  await expect.poll(() => page.evaluate(() => (window as unknown as { projectTest: Control }).projectTest.streams().length)).toBe(2);
  const wrong = snapshot('alpha', 1000);
  await page.evaluate(wrong => { const c = (window as unknown as { projectTest: Control }).projectTest; c.frame('/api/projects/beta/stream', { schema: 'live-graph/v1', version: wrong.version, snapshot: wrong }); }, wrong);
  await expect(page.locator('.live-connection')).toContainText('polling fallback');
  await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('beta');
});

test('independent browser contexts, discovery errors/retry, reconnect and polling fallback preserve selected scope', async ({ browser, baseURL }) => {
  const a = await browser.newContext({ baseURL }); const b = await browser.newContext({ baseURL });
  try {
    const one = await a.newPage(); const two = await b.newPage(); await fixtures(one); await fixtures(two);
    let outage = false; let wrongScope = false; let partial = true;
    await one.route('**/api/projects', route => outage ? route.fulfill({ status: 503 }) : route.fulfill({ json: { ...listing, status: partial ? 'incomplete' : 'ok', message: 'Discovery cap reached' } }));
    await one.route('**/api/projects/beta/snapshot', route => route.fulfill({ json: snapshot(wrongScope ? 'alpha' : 'beta') }));
    await Promise.all([one.goto('/'), two.goto('/')]);
    await expect(one.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('alpha'); await expect(two.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('alpha');
    await one.getByRole('combobox', { name: 'Project', exact: true }).selectOption('beta');
    await expect(one.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('beta'); await expect(two.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('alpha');
    await expect(one.locator('.live-connection')).toContainText('polling fallback');
    outage = true; await one.getByRole('button', { name: 'Retry project discovery' }).click();
    await expect(one.getByText(/Project discovery unavailable. Current project retained/)).toBeVisible();
    await expect(one.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('beta');
    outage = false; partial = false; await one.getByRole('button', { name: 'Retry project discovery' }).click();
    await expect(one.getByRole('button', { name: 'Retry project discovery' })).toHaveCount(0);
    // Discovery failure on reload still uses the trusted startup alias, with an explicit retry path.
    outage = true; await one.reload();
    await expect(one.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('alpha');
    await expect(one.getByRole('button', { name: 'Retry project discovery' })).toBeVisible();
    outage = false; await one.getByRole('button', { name: 'Retry project discovery' }).click();
    await one.getByRole('combobox', { name: 'Project', exact: true }).selectOption('beta');
    await expect(one.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('beta');
    wrongScope = true;
    await expect(one.getByRole('alert')).toContainText('Snapshot unavailable for default / beta');
    await expect(one.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('beta');
    wrongScope = false;
    await expect(one.getByRole('alert')).toHaveCount(0);
    await expect(two.getByRole('combobox', { name: 'Project', exact: true })).toHaveValue('alpha');
  } finally { await a.close(); await b.close(); }
});
