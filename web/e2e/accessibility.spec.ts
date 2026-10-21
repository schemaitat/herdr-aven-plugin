import { test, expect } from '@playwright/test';
import type { Core } from 'cytoscape';
import { graphFixture } from '../test/fixtures/graph-snapshot.js';
import { projectDiscovery } from './project-fixture.js';
import { allTypes } from './filter-controls.js';

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
  await expect(page.getByRole('complementary', { name: 'Entity details' })).toHaveCount(0);
  await page.keyboard.press('i');
  await expect(page.getByRole('complementary').getByRole('heading', { name: 'Aurora epic', exact: true })).toBeVisible();
  // This legacy all-edge assertion explicitly requests the complete relation scope.
  await allTypes(page);
  const focusStyle = await page.locator(':focus').evaluate(element => ({ width: getComputedStyle(element).outlineWidth, transition: getComputedStyle(element).transitionDuration }));
  expect(focusStyle.width).toBe('3px'); expect(focusStyle.transition).toBe('0s');
  const styles = await page.locator('.graph-canvas').evaluate(element => {
    const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
    return { epicFill: cy.getElementById('epic:a').style('background-fill'), blocksArrow: cy.edges('[kind = "blocks"]').first().style('target-arrow-shape'), assignedPattern: cy.edges('[kind = "assigned"]').first().style('line-style'), nodeLabel: cy.getElementById('task:b').data('label') };
  });
  expect(styles).toMatchObject({ epicFill: 'radial-gradient', blocksArrow: 'triangle', assignedPattern: 'dashed' });
  expect(styles.nodeLabel).toContain('Build graph');
  const motion = page.getByRole('button', { name: 'Pause motion', exact: true });
  await motion.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Resume motion', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  await expect(motion).toHaveAttribute('aria-pressed', 'false');
  expect(await page.locator('.graph-canvas').getAttribute('data-physics-ticks')).toBe('0');
  await page.screenshot({ path: info.outputPath('cosmos-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  // Resize intentionally preserves the camera; explicitly fit the narrow view.
  await expect.poll(() => page.locator('.graph-canvas').evaluate(element => (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy.width())).toBeLessThan(390);
  await page.getByText('Graph tools', { exact: true }).click();
  await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
  await expect.poll(() => page.locator('.graph-canvas').evaluate(element => {
    const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
    return Number.parseFloat(cy.getElementById('task:b').style('font-size')) * cy.zoom();
  })).toBeGreaterThanOrEqual(9.5);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByLabel('Search entities')).toBeVisible();
  await page.screenshot({ path: info.outputPath('cosmos-narrow.png'), fullPage: true });
});

test('one-hop relationship cue has a textual equivalent and reduced motion leaves its static glow', async ({ page }) => {
  await projectDiscovery(page, 'graph-fixture');
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: graphFixture }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/');
  await page.getByRole('button', { name: 'Entities & details', exact: true }).click();
  await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /Build graph/ }).click();
  await expect(page.getByText('1 hop', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.graph-cue[data-cue~="one-hop"]')).not.toHaveCount(0);
  await expect(page.locator('.graph-cue.neighbor').evaluateAll(items => items.every(item => getComputedStyle(item).animationName === 'none'))).resolves.toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Close panel', exact: true }).click();
  await page.screenshot({ path: '/tmp/opencode/hap-nrfe-narrow-chrome.png' });
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
    const header = (await page.locator('.graph-header').boundingBox())!;
    expect(header.y).toBeGreaterThanOrEqual(0);
    expect(header.height).toBeLessThanOrEqual(size.width < 650 ? 200 : 120);
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
    if (size.width < 650) await page.getByText('Graph tools', { exact: true }).click();
    await page.getByRole('button', { name: 'Fit graph', exact: true }).click();
    await expect.poll(() => page.locator('.graph-canvas').evaluate(element => {
      const cy = (element as HTMLElement & { _cyreg: { cy: Core } })._cyreg.cy;
      return Number.parseFloat(cy.getElementById('task:b').style('font-size')) * cy.zoom();
    })).toBeGreaterThanOrEqual(9.5);
    await page.screenshot({ path: info.outputPath(`shell-${size.width}.png`) });
    const canvas = await page.locator('.graph-canvas').boundingBox();
    // The canvas owns the remaining viewport; pinned selection/compact controls
    // deliberately take space without creating a side-by-side inspector crop.
    expect(canvas!.height).toBeGreaterThan(size.height * .33);
    if (size.width < 650) await page.getByText('Panels', { exact: true }).click();
    await entities.click();
    await page.getByRole('region', { name: 'Entities', exact: true }).getByRole('button', { name: /Standalone investigation/ }).click();
    if (!await page.getByRole('complementary', { name: 'Entity details' }).count()) await page.keyboard.press('i');
    await expect(page.getByRole('complementary').getByRole('heading', { name: 'Standalone investigation', exact: true })).toBeVisible();
    if (size.width < 650) {
      const information = (await page.locator('.entity-info').boundingBox())!;
      const inspector = (await page.locator('.inspector').boundingBox())!;
      expect(information.y + information.height).toBeLessThanOrEqual(inspector.y);
    }
    await page.getByRole('button', { name: 'Fit graph', exact: true }).focus();
    await expect(page.getByRole('button', { name: 'Fit graph', exact: true })).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
    await page.keyboard.press('Escape');
    if (size.width < 650) {
      await expect(page.getByText('Graph tools', { exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByText('Panels', { exact: true })).toBeFocused();
    }
    else await expect(entities).toBeFocused();
  }
  await page.getByText('Graph tools', { exact: true }).click();
  await page.getByRole('button', { name: 'List only', exact: true }).click();
  await expect(page.locator('.graph-canvas')).toHaveCount(0);
  const infoBounds = (await page.locator('.entity-info').boundingBox())!;
  const listPanel = (await page.locator('.inspector').boundingBox())!;
  expect(infoBounds.y + infoBounds.height).toBeLessThanOrEqual(listPanel.y);
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
  await page.keyboard.press('i');
  await expect(page.getByRole('complementary').getByRole('heading', { name: 'Standalone investigation', exact: true })).toBeVisible();
});
