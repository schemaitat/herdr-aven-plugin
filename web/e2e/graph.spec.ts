import { test, expect, type Page } from '@playwright/test';
import type { Core } from 'cytoscape';
import { graphFixture, scopeFixture, scopeClock } from '../test/fixtures/graph-snapshot.js';
import { allTypes, onlyRelationships, onlyTypes } from './filter-controls.js';
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
const sleep = (page: Page) => expect(page.locator('.graph-canvas')).toHaveAttribute('data-motion', 'sleeping', { timeout: 1800 });
const distance = (positions: Record<string, { x: number; y: number }>, a: string, b: string) => Math.hypot(positions[a].x - positions[b].x, positions[a].y - positions[b].y);

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
  // The inspector floats above the lower-right canvas in this layout.
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  const taskPoint = await point(page, 'task:b');
  await page.mouse.click(taskPoint.x, taskPoint.y);
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  const details = page.getByRole('complementary', { name: 'Entity details' });
  await expect(details.getByRole('heading', { name: 'Build graph', exact: true })).toBeVisible();
  const list = page.getByRole('region', { name: 'Entities', exact: true });
  await expect(list.getByRole('button', { name: /task Build graph/ })).toHaveAttribute('aria-pressed', 'true');
  await details.locator('summary').click();
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

test('single-click entity focus exposes visible one-hop pulse markers and direct edge emphasis', async ({ page }) => {
  const pointToTask = await point(page, 'task:b');
  await page.mouse.click(pointToTask.x, pointToTask.y);
  await expect(page.getByText('Connected component · shortest-hop rings', { exact: false })).toBeVisible();
  await expect(page.locator('.graph-cue[data-cue~="one-hop"]')).not.toHaveCount(0);
  await expect(page.getByText('1 hop', { exact: true }).first()).toBeVisible();
  const emphasized = await page.locator('.graph-canvas').evaluate(element => (element as GraphContainer)._cyreg.cy.elements('.direct-edge').map(edge => edge.id()));
  expect(emphasized.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Show all', exact: true }).first().click();
  // Show all restores overview geometry but deliberately retains selection/cues.
  await expect(page.locator('.graph-cue[data-cue~="one-hop"]')).not.toHaveCount(0);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(page.locator('.graph-cue[data-cue~="one-hop"]')).toHaveCount(0);
});

test('cue bounds track rendered geometry after pan, zoom and static selection', async ({ page }) => {
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /task Build graph/ }).click();
  const check = async () => {
    await expect.poll(async () => page.locator('.graph-canvas').evaluate(element => {
      const cy = (element as GraphContainer)._cyreg.cy;
      const canvas = element.getBoundingClientRect();
      return Math.max(...['epic:a', 'task:a', 'agent:b'].map(id => {
        const node = cy.getElementById(id);
        const cue = [...document.querySelectorAll<HTMLElement>('.graph-cue[data-cue~="one-hop"]')].find(item => item.dataset.key?.includes(`neighbor:${id}`));
        if (!cue) return Infinity;
        const bounds = cue.getBoundingClientRect(), point = node.renderedPosition();
        const x = canvas.left + point.x, y = canvas.top + point.y;
        const error = Math.hypot((bounds.left + bounds.right) / 2 - x, (bounds.top + bounds.bottom) / 2 - y);
        return bounds.left <= x - node.renderedOuterWidth() / 2 && bounds.right >= x + node.renderedOuterWidth() / 2 && bounds.top <= y - node.renderedOuterHeight() / 2 && bounds.bottom >= y + node.renderedOuterHeight() / 2 ? error : Infinity;
      }));
    })).toBeLessThanOrEqual(2);
  };
  await check();
  await page.locator('.graph-canvas').evaluate(element => (element as GraphContainer)._cyreg.cy.panBy({ x: 35, y: -20 }));
  await check();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await check();
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  const dragPoint = await point(page, 'task:a');
  await page.mouse.move(dragPoint.x, dragPoint.y); await page.mouse.down();
  await page.mouse.move(dragPoint.x + 50, dragPoint.y + 30, { steps: 4 });
  await check();
  await page.mouse.up();
  await check();
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  await page.getByRole('button', { name: 'Pause motion', exact: true }).click();
  await check();
  await page.locator('.graph-canvas').evaluate(element => {
    const node = (element as GraphContainer)._cyreg.cy.getElementById('task:a');
    node.position({ x: node.position().x + 60, y: node.position().y + 25 });
  });
  await check();
  await page.setViewportSize({ width: 390, height: 844 });
  await check();
  await page.getByRole('button', { name: 'List only', exact: true }).click();
  await page.getByRole('button', { name: 'Show graph', exact: true }).click();
  await check();
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
  const reset = (await graph(page)).positions['task:b'];
  expect(reset).not.toEqual(dragged.positions['task:b']);
  await page.getByRole('button', { name: 'Reset positions', exact: true }).click();
  expect((await graph(page)).positions['task:b']).toEqual(reset);
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
  await expect(page.getByRole('button', { name: 'Collapse Aurora epic', exact: true })).toBeVisible();
  await expect.poll(async () => (await graph(page)).nodes.includes('pane:unused')).toBe(false);
  await page.getByRole('button', { name: 'Show all', exact: true }).first().click();
  await expect.poll(async () => (await graph(page)).nodes.includes('pane:unused')).toBe(true);
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
  await details.locator('summary').click();
  await details.getByRole('button', { name: 'Review graph', exact: true }).focus(); await page.keyboard.press('Enter');
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
    await page.getByRole('button', { name: 'List only', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reset positions', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as unknown as { prior: Core }).prior.destroyed())).toBe(true);
    expect(await page.evaluate(() => {
      const previous = (window as unknown as { prior: { _private: { emitter: { listeners: { type: string }[] } } } }).prior;
      return previous._private.emitter.listeners.filter(listener => ['tap', 'dbltap'].includes(listener.type)).length;
    })).toBe(0);
    await expect(page.locator('.graph-canvas canvas')).toHaveCount(0);
    await page.getByRole('button', { name: 'Show graph', exact: true }).click();
    await expect(page.locator('.graph-status')).toContainText(`${retained.nodes.length} entities`);
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
  const types = page.getByRole('group', { name: 'Entity types', exact: true });
  const relations = page.getByRole('group', { name: 'Relationship kinds', exact: true });
  for (const kind of ['epic', 'task', 'attempt', 'agent', 'session']) await expect(types.getByRole('checkbox', { name: kind, exact: true })).toBeChecked();
  for (const kind of ['workspace', 'pane', 'worktree', 'boundary']) await expect(types.getByRole('checkbox', { name: kind, exact: true })).not.toBeChecked();
  for (const kind of ['contains', 'blocks']) await expect(relations.getByRole('checkbox', { name: kind, exact: true })).toBeChecked();
  for (const kind of ['related', 'assigned', 'session', 'placed-in', 'worktree', 'agent-dependency']) await expect(relations.getByRole('checkbox', { name: kind, exact: true })).not.toBeChecked();
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

test('relationship presets scope edges and connectivity without removing eligible isolated entities', async ({ page }) => {
  await page.getByText('Filters', { exact: true }).click();
  await page.getByRole('button', { name: 'No relationships', exact: true }).click();
  await page.keyboard.press('Escape');
  expect((await graph(page)).nodes).toHaveLength(14);
  expect(await page.locator('.graph-canvas').evaluate(element => (element as GraphContainer)._cyreg.cy.edges().length)).toBe(0);
  await page.getByText('Filters', { exact: true }).click();
  await onlyRelationships(page, ['blocks']);
  await page.keyboard.press('Escape');
  const blockKinds = await page.locator('.graph-canvas').evaluate(element => (element as GraphContainer)._cyreg.cy.edges().map(edge => edge.data('kind')));
  expect(blockKinds).toEqual(['blocks', 'blocks', 'blocks']);
  await page.getByRole('button', { name: 'Reset filters', exact: true }).click();
  await expect(page.locator('.scope-chips')).toContainText('2 of 8 relationships');
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

test('real drag reacts within 100ms, neighbors follow, pins survive filters, selection contracts and clear returns without drift', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await expect(page.locator('.graph-canvas')).toHaveAttribute('data-motion', 'active'); await sleep(page);
  const overview = await graph(page);
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  const location = await point(page, 'task:b');
  await page.mouse.move(location.x, location.y); await page.mouse.down();
  const beforeDrag = await graph(page);
  const start = await page.locator('.graph-canvas').evaluate(() => performance.now());
  await page.mouse.move(location.x + 70, location.y + 20, { steps: 4 });
  const reaction = await page.locator('.graph-canvas').evaluate(async (element, { start, before }) => {
    const cy = (element as GraphContainer)._cyreg.cy;
    return new Promise<number>(resolve => {
      const frame = () => { const p = cy.getElementById('task:a').position(); if (Math.hypot(p.x - before.x, p.y - before.y) > .01 || performance.now() - start > 100) resolve(performance.now() - start); else requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
    });
  }, { start, before: beforeDrag.positions['task:a'] });
  expect(reaction).toBeLessThanOrEqual(100);
  expect((await graph(page)).positions['task:a']).not.toEqual(beforeDrag.positions['task:a']);
  await page.mouse.up(); const released = performance.now(); await sleep(page);
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  const settleMs = performance.now() - released;
  expect(settleMs).toBeLessThanOrEqual(1500);
  const pinned = (await graph(page)).positions['task:b'];
  await page.getByLabel('Search entities').fill('standalone'); await page.getByLabel('Search entities').fill(''); await sleep(page);
  expect((await graph(page)).positions['task:b']).toEqual(pinned);
  await page.getByRole('button', { name: 'Reset positions', exact: true }).click(); await sleep(page);
  const baseline = await graph(page);
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /task Build graph/ }).click(); await sleep(page);
  const selected = await graph(page);
  expect(distance(selected.positions, 'task:b', 'task:a')).toBeLessThan(distance(baseline.positions, 'task:b', 'task:a'));
  // Single-click component focus intentionally removes disconnected resources
  // from this projection; their overview geometry is retained for Show all.
  expect(selected.positions['pane:unused']).toBeUndefined();
  const clearance = await page.locator('.graph-canvas').evaluate(element => {
    const nodes = (element as GraphContainer)._cyreg.cy.nodes().map(node => ({ p: node.position(), radius: node.outerWidth() / 2 }));
    let minimum = Infinity;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) minimum = Math.min(minimum, Math.hypot(nodes[i].p.x - nodes[j].p.x, nodes[i].p.y - nodes[j].p.y) - nodes[i].radius - nodes[j].radius);
    return minimum;
  });
  expect(clearance).toBeGreaterThanOrEqual(0);
  await page.screenshot({ path: info.outputPath('physics-selected-settled.png') });
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click(); await sleep(page);
  expect((await graph(page)).positions).toEqual(baseline.positions);
  for (let i = 0; i < 3; i++) {
    const target = await point(page, 'task:b'); await page.mouse.dblclick(target.x, target.y);
    await page.getByRole('button', { name: 'Show all', exact: true }).first().click(); await sleep(page);
    expect((await graph(page)).positions).toEqual(baseline.positions);
    expect((await graph(page)).pan).toEqual(baseline.pan); expect((await graph(page)).zoom).toBe(baseline.zoom);
  }
  console.log('PHYSICS_TIMING', JSON.stringify({ reactionMs: reaction, settleMs, minimumClearance: clearance }));
  await info.attach('physics-timing', { body: JSON.stringify({ reactionMs: reaction, settleMs, minimumClearance: clearance, overviewNodes: overview.nodes.length }), contentType: 'application/json' });
});

test('Pause freezes by next frame, runtime reduced motion runs no ticks, rapid selection/search rollback and disposal cancel work', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'Pause motion', exact: true }).click();
  const paused = await graph(page), count = await page.locator('.graph-canvas').getAttribute('data-physics-ticks');
  await page.waitForTimeout(150);
  expect((await graph(page)).positions).toEqual(paused.positions);
  expect(await page.locator('.graph-canvas').getAttribute('data-physics-ticks')).toBe(count);
  await page.getByRole('button', { name: 'Resume motion', exact: true }).click();
  await expect(page.locator('.graph-canvas')).toHaveAttribute('data-motion', 'active');
  await page.emulateMedia({ reducedMotion: 'reduce' }); await sleep(page);
  const reducedCount = await page.locator('.graph-canvas').getAttribute('data-physics-ticks');
  const list = page.getByRole('region', { name: 'Entities', exact: true });
  for (const label of ['Build graph', 'Review graph', 'Build adapter']) await list.getByRole('button', { name: new RegExp(`task ${label}`) }).click();
  await page.waitForTimeout(100);
  expect(await page.locator('.graph-canvas').getAttribute('data-physics-ticks')).toBe(reducedCount);
  await page.emulateMedia({ reducedMotion: 'no-preference' }); await expect(page.locator('.graph-canvas')).toHaveAttribute('data-motion', 'active'); await sleep(page);
  const baseline = await graph(page);
  await page.getByRole('button', { name: 'Search /', exact: true }).click();
  await page.getByRole('combobox', { name: 'Preview query' }).fill('standalone');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Escape'); await sleep(page);
  expect(await graph(page)).toEqual(baseline);
  await list.getByRole('button', { name: /task Build graph/ }).click();
  await page.getByRole('button', { name: 'List only', exact: true }).click();
  await expect(page.locator('.graph-canvas')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show graph', exact: true }).click(); await sleep(page);
  await expect(page.locator('.graph-status')).toContainText('12 entities');
  await page.getByRole('button', { name: 'Reset positions', exact: true }).click();
  // Capture the full deterministic overview explicitly before entering another
  // component; clear selection is the approved focus-exit path.
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  const overview = await graph(page);
  await list.getByRole('button', { name: /task Review graph/ }).click(); await sleep(page);
  await page.getByRole('button', { name: 'Pause motion', exact: true }).click();
  const frozen = await graph(page);
  await page.getByRole('button', { name: 'List only', exact: true }).click();
  await page.getByRole('button', { name: 'Show graph', exact: true }).click(); await sleep(page);
  expect((await graph(page)).positions).toEqual(frozen.positions);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  const cleared = await graph(page);
  // Clear selection exits component focus. Paused shared geometry remains frozen,
  // while disconnected overview-only resources are projected back in.
  for (const [id, position] of Object.entries(frozen.positions)) expect(cleared.positions[id]).toEqual(position);
  for (const id of ['pane:unused', 'worktree:unused']) {
    expect(frozen.positions[id]).toBeUndefined();
    expect(cleared.positions[id]).toBeDefined();
  }
  await page.getByRole('button', { name: 'Resume motion', exact: true }).click(); await sleep(page);
  const resumed = await graph(page);
  // Resume applies the full overview captured before entering the component.
  expect(resumed.positions).toEqual(overview.positions);
});

test('component keyboard entry, anchor removal and hidden-kind boundaries keep other filters intact', async ({ page }) => {
  const list = page.getByRole('region', { name: 'Entities', exact: true });
  await list.getByRole('button', { name: /task Build graph/ }).click();
  // Entity activation is itself the keyboard-equivalent component entry.
  await expect(page.getByRole('button', { name: 'Show all', exact: true }).first()).toBeVisible();
  expect((await graph(page)).nodes).not.toContain('pane:unused');
  await page.getByLabel('Search entities').fill('Unassigned pane');
  await expect(page.getByText('Component anchor is unavailable', { exact: false })).toBeVisible();
  expect((await graph(page)).nodes).toEqual(['pane:unused']);
  await page.getByLabel('Search entities').fill('');
  await page.getByText('Filters', { exact: true }).click();
  await onlyTypes(page, ['task']);
  await page.keyboard.press('Escape');
  await list.getByRole('button', { name: /task Build graph/ }).click();
  // Show all exits focus, so the transient focused action is not repeated.
  expect((await graph(page)).nodes.every(id => id.startsWith('task:'))).toBe(true);
  await page.getByRole('button', { name: 'Show all', exact: true }).first().click();
  expect((await graph(page)).nodes.every(id => id.startsWith('task:'))).toBe(true);
});

test('status-only stream updates do not extend active physics or wake a sleeping solver; visibility suspends without catch-up', async ({ page }) => {
  let snapshot = graphFixture;
  let send: (() => Promise<void>) | undefined;
  await page.route('**/api/snapshot', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/stream', async route => {
    await new Promise<void>(resolve => { send = async () => {
      await route.fulfill({ contentType: 'text/event-stream', body: `event: snapshot\ndata: ${JSON.stringify({ schema: 'live-graph/v1', version: 2, snapshot })}\n\n` }); resolve();
    }; });
  });
  await page.reload(); await allTypes(page);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(page.locator('.graph-canvas')).toHaveAttribute('data-motion', 'active'); await sleep(page);
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /task Build graph/ }).click();
  const began = performance.now(), activations = await page.locator('.graph-canvas').getAttribute('data-activations');
  snapshot = { ...graphFixture, version: 2, nodes: graphFixture.nodes.map(node => ({ ...node, state: 'done' })) };
  await expect.poll(() => Boolean(send)).toBe(true); await send!();
  await expect(page.getByRole('complementary').getByText('task · Task status: done', { exact: true })).toBeVisible();
  expect(await page.locator('.graph-canvas').getAttribute('data-activations')).toBe(activations);
  await sleep(page); expect(performance.now() - began).toBeLessThanOrEqual(1500);
  const settled = await graph(page), tickCount = await page.locator('.graph-canvas').getAttribute('data-physics-ticks');
  await page.waitForTimeout(550);
  expect(await graph(page)).toEqual(settled);
  expect(await page.locator('.graph-canvas').getAttribute('data-physics-ticks')).toBe(tickCount);
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /task Build adapter/ }).click();
  // Exercise the browser visibility handler with a controlled visibility signal;
  // fixed-clock unit tests separately assert the exact two-step resume budget.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
  const hidden = await graph(page), hiddenTicks = await page.locator('.graph-canvas').getAttribute('data-physics-ticks');
  await page.waitForTimeout(1600);
  expect(await graph(page)).toEqual(hidden);
  expect(await page.locator('.graph-canvas').getAttribute('data-physics-ticks')).toBe(hiddenTicks);
  await page.evaluate(() => { delete (document as unknown as { hidden?: boolean }).hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(page);
  expect(await page.locator('.graph-canvas').getAttribute('data-physics-ticks')).toBe(hiddenTicks);
  await page.unroute('**/api/stream');
});
