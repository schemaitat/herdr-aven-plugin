import { test, expect } from '@playwright/test';
import type { Core } from 'cytoscape';
import { graphFixture } from '../test/fixtures/graph-snapshot.js';

test('keyboard bypass, visible focus, non-color relationship cues and reduced-motion narrow layout', async ({ page }, info) => {
  await page.route('**/bootstrap', route => route.fulfill({ json: { token: 'fixture-token' } }));
  await page.route('**/api/stream', route => route.fulfill({ status: 404 }));
  await page.route('**/api/snapshot', route => route.fulfill({ json: graphFixture }));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.locator('.graph-status')).toContainText('14 entities');
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
