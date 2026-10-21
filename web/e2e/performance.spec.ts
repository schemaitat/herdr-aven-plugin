import { test, expect } from '@playwright/test';
import type { Core } from 'cytoscape';
import { largeGraph } from '../test/fixtures/large-graph.js';
import { allTypes } from './filter-controls.js';
import { projectDiscovery } from './project-fixture.js';

test('500 nodes / 1,000 edges: interactivity, rendered pan/zoom FPS and status-update stability', async ({ page }, info) => {
  let snapshot = largeGraph();
  await projectDiscovery(page, snapshot.scope.project);
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.goto('/');
  await allTypes(page);
  await expect(page.locator('.graph-status')).toContainText('500 entities · 1000 connections');
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /epic Orbit 000/ }).click();
  const interactiveMs = await page.locator('.graph-canvas').evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    // Browser navigation-to-interaction time excludes Playwright's RPC latency.
    return performance.now() - (performance.getEntriesByType('navigation').at(-1)?.startTime ?? 0);
  });
  // Selection is interactive without opening info. The separate i-only inspection
  // action remains verified, but is not part of the navigation-to-interaction gate.
  await page.keyboard.press('i');
  await expect(page.getByRole('complementary').getByRole('heading', { name: 'Orbit 000', exact: true })).toBeVisible();
  const initialCosts = await page.evaluate(() => Object.fromEntries(['graph.initial-layout', 'graph.initial-sync'].map(name => [name, performance.getEntriesByName(name).at(-1)?.duration])));
  await page.getByRole('button', { name: 'Pause motion', exact: true }).click();
  await page.getByRole('button', { name: 'Resume motion', exact: true }).click();
  const activePhysics = await page.locator('.graph-canvas').evaluate(async element => {
    const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
    cy.elements().removeClass('muted selected neighbor');
    cy.zoom({ level: .35, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    const host = element as HTMLElement, base = { zoom: cy.zoom(), pan: { ...cy.pan() } };
    let renders = 0, activeFrames = 0, clearance = Infinity;
    const startTicks = Number(host.dataset.physicsTicks ?? 0), onRender = () => renders++;
    cy.on('render', onRender);
    const start = performance.now();
    await new Promise<void>(resolve => {
      const step = () => {
        const elapsed = performance.now() - start;
        if (elapsed >= 1000 || elapsed > 100 && host.dataset.motion === 'sleeping') { resolve(); return; }
        if (host.dataset.motion === 'active') activeFrames++;
        cy.viewport({ zoom: base.zoom * (1 + .1 * Math.sin(elapsed / 400)), pan: { x: base.pan.x + 70 * Math.sin(elapsed / 350), y: base.pan.y + 50 * Math.cos(elapsed / 450) } });
        requestAnimationFrame(step);
      }; requestAnimationFrame(step);
    });
    cy.off('render', onRender);
    const elapsed = performance.now() - start;
    for (const a of cy.nodes()) for (const b of cy.nodes()) if (a.id() < b.id()) {
      const p = a.position(), q = b.position(); clearance = Math.min(clearance, Math.hypot(p.x - q.x, p.y - q.y) - (a.width() + b.width()) / 2);
    }
    return { renderFps: renders * 1000 / elapsed, activeFrames, physicsTicks: Number(host.dataset.physicsTicks) - startTicks, durationMs: elapsed, minimumClearance: clearance };
  });
  await expect(page.locator('.graph-canvas')).toHaveAttribute('data-motion', 'sleeping', { timeout: 1800 });
  await page.locator('.graph-canvas').scrollIntoViewIfNeeded();
  const measurement = await page.locator('.graph-canvas').evaluate(async element => {
    const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
    cy.elements().removeClass('muted selected neighbor');
    // A meaningful close overview (not a single-node view). Warm renderer first.
    cy.zoom({ level: 0.35, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const base = { zoom: cy.zoom(), pan: { ...cy.pan() } };
    const frames: number[] = [];
    let ticks = 0;
    const onRender = () => frames.push(performance.now());
    cy.on('render', onRender);
    const start = performance.now();
    await new Promise<void>(resolve => {
      const step = (now: number) => {
        const elapsed = now - start;
        if (elapsed >= 3000) { resolve(); return; }
        ticks++;
        cy.viewport({ zoom: base.zoom * (1 + 0.1 * Math.sin(elapsed / 400)), pan: { x: base.pan.x + 70 * Math.sin(elapsed / 350), y: base.pan.y + 50 * Math.cos(elapsed / 450) } });
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    cy.off('render', onRender);
    const elapsed = performance.now() - start;
    const gaps = frames.slice(1).map((time, index) => time - frames[index]!).sort((a, b) => a - b);
    return { renderFps: frames.length * 1000 / elapsed, rafFps: ticks * 1000 / elapsed, renderedFrames: frames.length, durationMs: elapsed, p95RenderGapMs: gaps[Math.floor(gaps.length * .95)], camera: { zoom: cy.zoom(), pan: cy.pan() }, positions: cy.nodes().map(node => [node.id(), node.position()]), userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, devicePixelRatio };
  });
  snapshot = { ...snapshot, nodes: snapshot.nodes.map(node => ({ ...node, state: 'done', details: { ...node.details, avenStatus: 'done' } })) };
  await expect(page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /epic Orbit 000/ })).toContainText('Task status: done', { timeout: 5000 });
  await expect.poll(() => page.locator('.graph-canvas').evaluate(element => (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy.getElementById('epic:000').data('state'))).toBe('done');
  const after = await page.locator('.graph-canvas').evaluate(element => {
    const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
    const layout = performance.getEntriesByName('graph.layout').at(-1) as PerformanceMeasure;
    const nodes = cy.nodes().map(node => ({ position: node.position(), radius: node.outerWidth() / 2 }));
    let minimumClearance = Infinity;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j]; minimumClearance = Math.min(minimumClearance, Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y) - a.radius - b.radius);
    }
    return { camera: { zoom: cy.zoom(), pan: cy.pan() }, positions: cy.nodes().map(node => [node.id(), node.position()]), minimumClearance, layoutComputed: layout.detail.computed, updateSyncMs: performance.getEntriesByName('graph.sync').at(-1)?.duration };
  });
  expect(after.camera).toEqual(measurement.camera); expect(after.positions).toEqual(measurement.positions);
  expect(after.layoutComputed).toBe(false);
  const { positions: _, ...baseline } = measurement;
  const result = { interactiveMs, initialCosts, activePhysics, settledMinimumClearance: after.minimumClearance, statusUpdateSyncMs: after.updateSyncMs, ...baseline, viewport: page.viewportSize(), node: process.version, platform: process.platform, mode: process.env.UI_TEST_DEV === '1' ? 'development middleware' : 'production build', method: 'browser navigationStart through graph render + real list selection + two paint frames; excludes Playwright RPC latency and separately verifies i-only details. Separate active-physics (up to 1s or sleep) and 3s settled rAF-driven simultaneous viewport pan/zoom at zoom 0.35, all elements unmuted; FPS counts Cytoscape render events (not just rAF); sync cost includes mutation/style/fit, not asynchronous paint' };
  console.log('PERFORMANCE_BASELINE', JSON.stringify(result));
  await info.attach('performance-baseline', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('large-graph.png') });
  expect(interactiveMs).toBeLessThanOrEqual(3000);
  expect(measurement.renderFps).toBeGreaterThanOrEqual(45);
  expect(activePhysics.renderFps).toBeGreaterThanOrEqual(45);
  expect(activePhysics.activeFrames).toBeGreaterThan(25);
  expect(activePhysics.physicsTicks).toBeGreaterThan(30);
  expect(after.minimumClearance).toBeGreaterThanOrEqual(0);
});

test('component selection promotes its eligible anchor within the fixed canvas cap', async ({ page }) => {
  const snapshot = largeGraph(560);
  await projectDiscovery(page, snapshot.scope.project);
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: snapshot }));
  await page.goto('/'); await allTypes(page);
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  for (let i = 0; i < 13; i++) await page.getByRole('button', { name: 'Next entities', exact: true }).click();
  await page.getByRole('button', { name: /Task 559/ }).click();
  await page.keyboard.press('i');
  await page.getByRole('button', { name: 'Focus component', exact: true }).click();
  await page.waitForTimeout(100);
  const displayed = await page.locator('.graph-canvas').evaluate(element => (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy.nodes().length);
  expect(displayed).toBeLessThanOrEqual(500);
  await expect(page.locator('.graph-canvas').evaluate(element => (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy.getElementById('task:559').length)).resolves.toBe(1);
});
