import { test, expect, type Page } from '@playwright/test';
import type { Core } from 'cytoscape';
import { graphFixture, scopeFixture, scopeClock } from '../test/fixtures/graph-snapshot.js';
import { allTypes, onlyTypes } from './filter-controls.js';
import { projectDiscovery } from './project-fixture.js';

// Read-only test instrumentation: Cytoscape registers its core on its container.
// No production debug endpoint or browser-global mutation capability is shipped.
type GraphContainer = HTMLElement & { _cyreg: { cy: Core } };
async function graph(page: Page) {
  return page.locator('.graph-canvas').evaluate(element => {
    const cy = (element as GraphContainer)._cyreg.cy;
    return { nodes: cy.nodes().map(node => node.id()).sort(), zoom: cy.zoom(), pan: cy.pan(), positions: Object.fromEntries(cy.nodes().map(node => [node.id(), node.position()])), selected: cy.elements('.selected').map(node => node.id()) };
  });
}
async function point(page: Page, id?: string) {
  await page.locator('.graph-canvas').scrollIntoViewIfNeeded();
  // Let canvas rendering and Cytoscape's scroll/resize coordinate cache settle.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const box = (await page.locator('.graph-canvas').boundingBox())!;
  const position = await page.locator('.graph-canvas').evaluate((element, id) => {
    const cy = (element as GraphContainer)._cyreg.cy;
    return id ? cy.getElementById(id).renderedPosition() : { x: cy.width() - 30, y: 30 };
  }, id);
  return { x: box.x + position.x, y: box.y + position.y };
}

test.beforeEach(async ({ page }) => {
  await projectDiscovery(page, 'graph-fixture');
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: graphFixture }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await allTypes(page);
  await expect(page.locator('.graph-status')).toContainText('14 entities');
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
});

test('bubble shapes, typed directed relationships, derived provenance and graph/list selection', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const sourceShape = await page.locator('.graph-canvas').evaluate(element => {
    const cy = (element as GraphContainer)._cyreg.cy;
    return { epic: [cy.getElementById('epic:a').style('shape'), cy.getElementById('epic:a').width()], task: [cy.getElementById('task:a').style('shape'), cy.getElementById('task:a').width()], agent: cy.getElementById('agent:a').style('shape'), derived: cy.edges('[kind = "agent-dependency"]').map(edge => [edge.source().id(), edge.target().id(), edge.data('label')]) };
  });
  expect(sourceShape.epic).toEqual(['ellipse', 100]); expect(sourceShape.task).toEqual(['ellipse', 46]);
  expect(sourceShape.agent).toBe('diamond');
  expect(sourceShape.derived).toEqual([['agent:a', 'agent:b', 'derived dependency'], ['agent:b', 'agent:c', 'derived dependency']]);
  await page.screenshot({ path: info.outputPath('graph-overview.png'), fullPage: true });
  const taskPoint = await point(page, 'task:b');
  await page.mouse.click(taskPoint.x, taskPoint.y);
  const details = page.getByRole('complementary', { name: 'Entity details' });
  await expect(details.getByRole('heading', { name: 'Build graph', exact: true })).toBeVisible();
  const list = page.getByRole('region', { name: 'Entities', exact: true });
  await expect(list.getByRole('button', { name: /task Build graph/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(details.getByText('← incoming blocks (blocked by this source)', { exact: true })).toBeVisible();
  await list.getByRole('button', { name: /agent worker \/ graph/ }).click();
  await expect(details.getByText('Derived from recorded task blocker and assignments', { exact: true }).first()).toBeVisible();
  expect((await graph(page)).selected).toContain('agent:b');
  const edgeId = await page.locator('.graph-canvas').evaluate(element => {
    const edge = (element as GraphContainer)._cyreg.cy.edges('[kind = "agent-dependency"]').first();
    edge.emit('tap'); return edge.id();
  });
  await expect(details.getByRole('heading', { name: 'Derived agent dependency', exact: true })).toBeVisible();
  expect((await graph(page)).selected).toContain(edgeId);
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await page.screenshot({ path: info.outputPath('graph-fixture.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('actual pan, wheel zoom, drag, fit/reset and ordinary snapshot refresh retain context', async ({ page }) => {
  const before = await graph(page);
  let location = await point(page);
  await page.mouse.move(location.x, location.y); await page.mouse.down();
  await page.mouse.move(location.x - 85, location.y + 45, { steps: 10 }); await page.mouse.up();
  await expect.poll(async () => (await graph(page)).pan.x).not.toBe(before.pan.x);
  location = await point(page);
  await page.mouse.move(location.x, location.y); await page.mouse.wheel(0, -180);
  await expect.poll(async () => (await graph(page)).zoom).toBeGreaterThan(before.zoom);
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  location = await point(page, 'task:b');
  await page.mouse.move(location.x, location.y); await page.mouse.down();
  await page.mouse.move(location.x + 70, location.y + 35, { steps: 12 }); await page.mouse.up();
  await expect.poll(async () => (await graph(page)).positions['task:b'].x).not.toBe(before.positions['task:b'].x);
  const dragged = await graph(page);
  let requests = 0;
  await page.route('**/api/snapshot', route => { requests++; return route.fulfill({ json: { ...graphFixture, observedAt: '2026-10-20T12:00:05Z', nodes: graphFixture.nodes.map(node => node.id === 'task:b' ? { ...node, label: 'Build graph updated' } : node) } }); });
  await expect.poll(() => requests, { timeout: 10000 }).toBeGreaterThan(0);
  await expect(page.getByRole('region', { name: 'Entities', exact: true }).getByText('Build graph updated', { exact: true })).toBeVisible();
  const refreshed = await graph(page);
  expect(refreshed.positions).toEqual(dragged.positions);
  expect(refreshed.zoom).toBe(dragged.zoom); expect(refreshed.pan).toEqual(dragged.pan);
  await page.getByLabel('Search entities').fill('standalone');
  expect((await graph(page)).nodes).toEqual(['task:solo']);
  await page.getByLabel('Search entities').fill('');
  expect((await graph(page)).positions['task:b']).toEqual(dragged.positions['task:b']);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  expect((await graph(page)).zoom).toBeGreaterThan(dragged.zoom);
  await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await page.getByRole('button', { name: 'Reset positions', exact: true }).click();
  expect((await graph(page)).positions['task:b']).toEqual(before.positions['task:b']);
});

test('collapse/expand, cross-epic boundaries, search/type/status filters and keyboard discovery', async ({ page }) => {
  await page.getByRole('button', { name: 'Collapse Aurora epic', exact: true }).click();
  await expect(page.getByText(/2 collapsed tasks/)).toBeVisible();
  expect((await graph(page)).nodes).not.toContain('task:b');
  const summary = await page.locator('.graph-canvas').evaluate(element => (element as GraphContainer)._cyreg.cy.edges('[kind = "blocks"]').map(edge => [edge.source().id(), edge.target().id(), edge.data('label')]));
  expect(summary).toContainEqual(['epic:a', 'task:c', 'collapsed · blocks']);
  await page.locator('.graph-canvas').evaluate(element => { (element as GraphContainer)._cyreg.cy.edges('[kind = "blocks"]').filter(edge => edge.source().id() === 'epic:a').first().emit('tap'); });
  await expect(page.getByRole('complementary').getByText('Collapsed boundary connection · source → target', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Expand Aurora epic', exact: true }).click();
  await expect(page.getByRole('complementary').getByRole('heading', { name: 'blocks', exact: true })).toBeVisible();
  await expect(page.getByRole('complementary').getByRole('button', { name: 'Build graph', exact: true })).toBeVisible();
  expect((await graph(page)).nodes).toContain('task:b');
  const p = await point(page, 'epic:a');
  await page.mouse.dblclick(p.x, p.y);
  await expect(page.getByRole('button', { name: 'Expand Aurora epic', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Expand Aurora epic', exact: true }).click();
  await page.getByText('Filters', { exact: true }).click();
  await onlyTypes(page, ['task']);
  await page.getByLabel('Source state').selectOption('active');
  expect((await graph(page)).nodes).toEqual(['task:b']);
  await page.getByRole('button', { name: 'All types', exact: true }).click(); await page.getByLabel('Source state').selectOption('all');
  await page.keyboard.press('Escape');
  await page.getByLabel('Search entities').fill('Standalone');
  const button = page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /Standalone investigation/ });
  // From search, use only keyboard to traverse selects and graph controls into the list.
  await page.getByLabel('Search entities').focus();
  for (let i = 0; i < 20 && !(await button.evaluate(element => element === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(button).toBeFocused(); await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  const details = page.getByRole('complementary', { name: 'Entity details' });
  await expect(details.getByRole('heading', { name: 'Standalone investigation', exact: true })).toBeVisible();
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await expect(details.getByRole('heading', { name: 'Review graph', exact: true })).toBeVisible();
  await page.getByLabel('Search entities').fill('');
  // Every visible entity can be selected from the keyboard list, matching graph scope.
  const ids = (await graph(page)).nodes;
  for (const id of ids) {
    const node = graphFixture.nodes.find(node => node.id === id)!;
    const entry = page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: new RegExp(node.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first();
    await entry.focus(); await page.keyboard.press('Enter');
    await expect(details.getByRole('heading', { name: node.label, exact: true })).toBeVisible();
    expect((await graph(page)).selected).toContain(id);
  }
});

test('ordinary renders retain one instance; disposal/remount destroys old core and listeners', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.locator('.graph-canvas').evaluate(element => {
    (window as unknown as { prior: Core }).prior = (element as GraphContainer)._cyreg.cy;
  });
  await page.getByLabel('Search entities').fill('adapter'); await page.getByLabel('Search entities').fill('');
  expect(await page.locator('.graph-canvas').evaluate(element => (element as GraphContainer)._cyreg.cy === (window as unknown as { prior: Core }).prior)).toBe(true);
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const location = await point(page, 'task:b');
  await page.mouse.move(location.x, location.y); await page.mouse.down();
  await page.mouse.move(location.x + 60, location.y + 25, { steps: 8 }); await page.mouse.up();
  const retained = await graph(page);
  for (let i = 0; i < 3; i++) {
    await page.getByRole('button', { name: 'Hide graph', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reset positions', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as unknown as { prior: Core }).prior.destroyed())).toBe(true);
    expect(await page.evaluate(() => {
      const previous = (window as unknown as { prior: { _private: { emitter: { listeners: { type: string }[] } } } }).prior;
      return previous._private.emitter.listeners.filter(listener => ['tap', 'dbltap'].includes(listener.type)).length;
    })).toBe(0);
    await expect(page.locator('.graph-canvas canvas')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show graph', exact: true }).click();
    await expect(page.locator('.graph-status')).toContainText('14 entities');
    const remounted = await graph(page);
    expect(remounted.positions).toEqual(retained.positions);
    expect(remounted.zoom).toBe(retained.zoom); expect(remounted.pan).toEqual(retained.pan);
    const listeners = await page.locator('.graph-canvas').evaluate(element => {
      const cy = (element as GraphContainer)._cyreg.cy;
      (window as unknown as { prior: Core }).prior = cy;
      return (cy as unknown as { _private: { emitter: { listeners: { type: string }[] } } })._private.emitter.listeners.map(listener => listener.type);
    });
    expect(listeners.filter(event => event === 'tap')).toHaveLength(1);
    expect(listeners.filter(event => event === 'dbltap')).toHaveLength(1);
    expect(listeners.filter(event => event === 'zoom')).toHaveLength(1);
  }
  expect(errors).toEqual([]);
});

test('slash and visible search preview matching scope, arrows select, Escape restores camera/selection and Enter commits', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Search /', exact: true });
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /Standalone investigation/ }).click();
  await page.getByLabel('Search entities', { exact: true }).fill('standalone');
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const baseline = await graph(page);
  await trigger.focus(); await page.keyboard.press('/');
  const dialog = page.getByRole('dialog', { name: 'Search entities' });
  const query = dialog.getByRole('combobox', { name: 'Preview query' });
  await expect(query).toBeFocused();
  await query.fill('bd gh');
  await expect.poll(async () => (await graph(page)).nodes).toEqual(['task:b']);
  await expect(page.locator('#entities .entity')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  await expect(dialog.getByRole('option', { name: /Build graph/ })).toHaveAttribute('aria-selected', 'true');
  expect((await graph(page)).selected).toEqual(['task:b']);
  await page.locator('.graph-canvas').evaluate(element => (element as GraphContainer)._cyreg.cy.viewport({ zoom: .9, pan: { x: 42, y: 67 } }));
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible(); await expect(trigger).toBeFocused();
  expect(await graph(page)).toEqual(baseline);
  await trigger.click();
  await query.fill('rv gh'); await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter');
  await expect(dialog).not.toBeVisible(); await expect(trigger).toBeFocused();
  await expect(page.getByLabel('Search entities', { exact: true })).toHaveValue('rv gh');
  expect((await graph(page)).nodes).toEqual(['task:c']);
  expect((await graph(page)).selected).toEqual(['task:c']);
});

test('search ignores editable, modified and IME slash; query baseline survives authoritative live refresh and vanished IDs', async ({ page }) => {
  const search = page.getByLabel('Search entities', { exact: true });
  await search.focus(); await page.keyboard.press('/');
  await expect(search).toHaveValue('/'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await search.fill('');
  for (const selector of ['input', 'select']) {
    await page.locator(selector).first().evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })));
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.evaluate(() => {
    for (const tag of ['textarea', 'div']) {
      const element = document.createElement(tag); element.contentEditable = 'true'; document.body.append(element);
      element.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true })); element.remove();
    }
    for (const options of [{ isComposing: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }]) document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, ...options }));
  });
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /Standalone investigation/ }).click();
  await page.getByRole('button', { name: 'Search /', exact: true }).click();
  await page.getByRole('combobox', { name: 'Preview query' }).fill('build graph');
  await page.keyboard.press('ArrowDown');
  let refreshed = 0;
  await page.route('**/api/snapshot', route => { refreshed++; return route.fulfill({ json: { ...graphFixture, nodes: graphFixture.nodes.filter(node => node.id !== 'task:solo' && node.id !== 'task:b') } }); });
  await expect.poll(() => refreshed, { timeout: 10000 }).toBeGreaterThan(0);
  await expect(page.getByRole('dialog').getByText('No matches.', { exact: false })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  expect((await graph(page)).selected).toEqual([]);
  expect((await graph(page)).nodes).not.toContain('task:solo');
});

test('defaults, multi-type/empty/reset controls, combined fuzzy/state/time/epic scope and off-canvas details agree', async ({ page }) => {
  await page.clock.setFixedTime(scopeClock);
  await page.route('**/api/snapshot', route => route.fulfill({ json: scopeFixture }));
  await page.reload();
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  expect((await graph(page)).nodes).not.toContain('pane:a');
  await page.getByText('Filters', { exact: true }).click();
  for (const kind of ['epic', 'task', 'attempt', 'agent', 'session']) await expect(page.getByRole('checkbox', { name: kind, exact: true })).toBeChecked();
  for (const kind of ['workspace', 'pane', 'worktree', 'boundary']) await expect(page.getByRole('checkbox', { name: kind, exact: true })).not.toBeChecked();
  await expect(page.getByLabel('Recent source changes')).toHaveValue('all');
  await onlyTypes(page, []);
  await expect(page.getByText('No matching entities in this scope.', { exact: false })).toBeVisible();
  expect((await graph(page)).nodes).toEqual([]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Reset empty scope', exact: true }).click();
  await expect(page.locator('.scope-chips')).toContainText('5 of 9 types');
  const details = page.getByRole('complementary', { name: 'Entity details' });
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /Standalone investigation/ }).click();
  await page.getByText('Filters', { exact: true }).click();
  await onlyTypes(page, ['task', 'agent']);
  await page.getByLabel('Source state').selectOption('active');
  await page.getByLabel('Recent source changes').selectOption('24h');
  await page.getByLabel('Epic scope').selectOption('epic:a');
  // Epic choices come from the unfiltered snapshot even when epic types/state exclude them.
  await expect(page.getByLabel('Epic scope').locator('option')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Search /', exact: true }).click();
  await page.getByRole('combobox', { name: 'Preview query' }).fill('bd gh');
  await expect.poll(async () => (await graph(page)).nodes).toEqual(['task:b']);
  await expect(page.locator('#entities .entity')).toHaveCount(1);
  await page.keyboard.press('Escape'); // restores prior selected standalone entity, not a forced visible match
  await expect(details.getByRole('heading', { name: 'Standalone investigation', exact: true })).toBeVisible();
  await expect(page.getByText('Selected entity is off-canvas', { exact: false })).toBeVisible();
  expect((await graph(page)).nodes).toEqual(['task:b']);
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await expect(page.getByLabel('Search entities')).toHaveValue('');
  expect((await graph(page)).nodes).not.toContain('pane:a');
});

test('recent source windows disclose unknowns, shared resources do not leak other epic owners, and disappearing epic stays explicit', async ({ page }) => {
  await page.clock.setFixedTime(scopeClock);
  let snapshot = scopeFixture;
  await page.route('**/api/snapshot', route => route.fulfill({ json: snapshot }));
  await page.reload();
  await allTypes(page);
  await page.getByText('Filters', { exact: true }).click();
  await page.getByLabel('Recent source changes').selectOption('24h');
  await page.keyboard.press('Escape');
  await expect(page.locator('.scope-chips')).toContainText('5 unknown/invalid/future-time exclusions');
  expect((await graph(page)).nodes).not.toContain('task:c');
  expect((await graph(page)).nodes).toContain('session:a');
  await page.getByText('Filters', { exact: true }).click();
  await page.getByLabel('Recent source changes').selectOption('all');
  await page.getByLabel('Epic scope').selectOption('epic:a');
  await page.keyboard.press('Escape');
  const scoped = (await graph(page)).nodes;
  expect(scoped).toContain('session:a');
  expect(scoped).not.toContain('agent:c');
  expect(scoped).not.toContain('task:c');
  snapshot = { ...snapshot, nodes: snapshot.nodes.filter(node => node.id !== 'epic:a'), edges: snapshot.edges.filter(edge => edge.source !== 'epic:a') };
  await expect(page.getByText('The selected epic is no longer', { exact: false })).toBeVisible({ timeout: 10000 });
  expect((await graph(page)).nodes).toEqual([]);
  await page.getByText('Filters', { exact: true }).click();
  await expect(page.getByLabel('Epic scope', { exact: true })).toHaveValue('epic:a');
  await page.getByRole('button', { name: 'Clear epic', exact: true }).click();
  await page.keyboard.press('Escape');
  expect((await graph(page)).nodes).toContain('task:c');
});
