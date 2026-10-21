import { test, expect } from '@playwright/test';
import type { Core } from 'cytoscape';
import { graphFixture } from '../test/fixtures/graph-snapshot.js';
import { projectDiscovery } from './project-fixture.js';

test.beforeEach(async ({ page }) => { await projectDiscovery(page, 'graph-fixture'); });

test('keyboard bypass, visible focus, non-color relationship cues and reduced-motion narrow layout', async ({ page }, info) => {
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: graphFixture }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.graph-status')).toContainText('10 entities');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip graph to entities' });
  await expect(skip).toBeFocused(); await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Entities', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
  await expect(page.getByRole('complementary').getByRole('heading', { name: 'Aurora epic', exact: true })).toBeVisible();
  const focusStyle = await page.locator(':focus').evaluate(element => ({ width: getComputedStyle(element).outlineWidth, transition: getComputedStyle(element).transitionDuration }));
  expect(focusStyle.width).toBe('3px'); expect(focusStyle.transition).toBe('0s');
  const styles = await page.locator('.graph-canvas').evaluate(element => {
    const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
    return { epicFill: cy.getElementById('epic:a').style('background-fill'), blocksArrow: cy.edges('[kind = "blocks"]').first().style('target-arrow-shape'), assignedPattern: cy.edges('[kind = "assigned"]').first().style('line-style'), nodeLabel: cy.getElementById('task:b').data('label') };
  });
  expect(styles).toMatchObject({ epicFill: 'radial-gradient', blocksArrow: 'triangle', assignedPattern: 'dashed' });
  expect(styles.nodeLabel).toContain('active');
  await page.screenshot({ path: info.outputPath('cosmos-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  // Resize intentionally preserves the camera; explicitly fit the narrow view.
  await expect.poll(() => page.locator('.graph-canvas').evaluate(element => (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy.width())).toBeLessThan(390);
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await expect.poll(() => page.locator('.graph-canvas').evaluate(element => {
    const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
    return Number.parseFloat(cy.getElementById('task:b').style('font-size')) * cy.zoom();
  })).toBeGreaterThanOrEqual(9.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByLabel('Search entities')).toBeVisible();
  await page.screenshot({ path: info.outputPath('cosmos-narrow.png'), fullPage: true });
});

test('viewport shell has no overflow; drawers return focus, leave background controls reachable and support list-only use', async ({ page }, info) => {
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: graphFixture }));
  await page.goto('/');
  const entities = page.getByRole('button', { name: 'Entities & details', exact: true });
  await expect(page.locator('.graph-status')).toContainText('10 entities');
  const camera = () => page.locator('.graph-canvas').evaluate(element => {
    const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
    return { zoom: cy.zoom(), pan: cy.pan() };
  });
  for (const size of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const beforeResize = await camera();
    await page.setViewportSize(size);
    await expect.poll(camera).toEqual(beforeResize);
    await expect(page.getByRole('region', { name: 'Entities', exact: true })).toHaveCount(0);
    await page.getByText('Filters', { exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('checkbox', { name: 'epic', exact: true })).toBeFocused();
    for (const name of ['Recent source changes', 'Source state', 'Epic scope']) {
      const control = await page.getByLabel(name).boundingBox();
      expect(control!.width).toBeGreaterThanOrEqual(100);
      expect(control!.x).toBeGreaterThanOrEqual(0);
      expect(control!.x + control!.width).toBeLessThanOrEqual(size.width);
    }
    await page.screenshot({ path: info.outputPath(`filters-${size.width}.png`) });
    await page.keyboard.press('Escape');
    await expect(page.getByText('Filters', { exact: true })).toBeFocused();
    await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
    await expect.poll(() => page.locator('.graph-canvas').evaluate(element => {
      const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
      return Number.parseFloat(cy.getElementById('task:b').style('font-size')) * cy.zoom();
    })).toBeGreaterThanOrEqual(9.5);
    await page.screenshot({ path: info.outputPath(`shell-${size.width}.png`) });
    const canvas = await page.locator('.graph-canvas').boundingBox();
    expect(canvas!.height).toBeGreaterThan(size.height * .45);
    await entities.click();
    await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /Standalone investigation/ }).click();
    await expect(page.getByRole('complementary').getByRole('heading', { name: 'Standalone investigation', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Fit graph', exact: true }).focus();
    await expect(page.getByRole('button', { name: 'Fit graph', exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    await page.keyboard.press('Escape'); await expect(entities).toBeFocused();
  }
  await page.getByRole('button', { name: 'Hide graph', exact: true }).click();
  await expect(page.locator('.graph-canvas')).toHaveCount(0);
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /Standalone investigation/ }).click();
  await expect(page.getByRole('complementary').getByRole('heading', { name: 'Standalone investigation', exact: true })).toBeVisible();
});

test('failed lazy canvas exposes the list/details fallback', async ({ page }) => {
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: graphFixture }));
  await page.route('**/assets/GraphView-*.js', route => route.abort());
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Entities', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /Standalone investigation/ }).click();
  await expect(page.getByRole('complementary').getByRole('heading', { name: 'Standalone investigation', exact: true })).toBeVisible();
});
