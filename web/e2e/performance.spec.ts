import { test, expect } from '@playwright/test';
import type { Core } from 'cytoscape';
import { largeGraph } from '../test/fixtures/large-graph.js';

test('500 nodes / 1,000 edges: interactivity, rendered pan/zoom FPS and status-update stability', async ({ page }, info) => {
  let snapshot = largeGraph();
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  const started = performance.now();
  await page.goto('/');
  await expect(page.locator('.graph-status')).toContainText('500 entities · 1000 connections');
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /epic Orbit 000/ }).click();
  await expect(page.getByRole('complementary').getByRole('heading', { name: 'Orbit 000', exact: true })).toBeVisible();
  await page.locator('.graph-canvas').evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const interactiveMs = performance.now() - started;
  const initialCosts = await page.evaluate(() => Object.fromEntries(['graph.initial-layout', 'graph.initial-sync'].map(name => [name, performance.getEntriesByName(name).at(-1)?.duration])));
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
    return { camera: { zoom: cy.zoom(), pan: cy.pan() }, positions: cy.nodes().map(node => [node.id(), node.position()]), layoutComputed: layout.detail.computed, updateSyncMs: performance.getEntriesByName('graph.sync').at(-1)?.duration };
  });
  expect(after.camera).toEqual(measurement.camera); expect(after.positions).toEqual(measurement.positions);
  expect(after.layoutComputed).toBe(false);
  const { positions: _, ...baseline } = measurement;
  const result = { interactiveMs, initialCosts, statusUpdateSyncMs: after.updateSyncMs, ...baseline, viewport: page.viewportSize(), node: process.version, platform: process.platform, mode: process.env.UI_TEST_DEV === '1' ? 'development middleware' : 'production build', method: 'navigation through graph render + real list selection/details + two paint frames; 3s rAF-driven simultaneous viewport pan/zoom at zoom 0.35, all elements unmuted; FPS counts Cytoscape render events (not just rAF); sync cost includes mutation/style/fit, not asynchronous paint' };
  console.log('PERFORMANCE_BASELINE', JSON.stringify(result));
  await info.attach('performance-baseline', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('large-graph.png') });
  expect(interactiveMs).toBeLessThanOrEqual(3000);
  expect(measurement.renderFps).toBeGreaterThanOrEqual(45);
});
