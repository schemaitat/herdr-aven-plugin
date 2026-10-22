import type { Page } from '@playwright/test';

export async function allTypes(page: Page) {
  await page.getByText('Filters', { exact: true }).click();
  await page.getByRole('button', { name: 'Select all types', exact: true }).click();
  await page.getByRole('button', { name: 'Select all relationships', exact: true }).click();
  await page.keyboard.press('Escape');
}

export async function graphTools(page: Page) {
  const tools = page.locator('details.graph-options');
  if (!(await tools.evaluate(element => (element as HTMLDetailsElement).open))) await page.getByText('Graph tools', { exact: true }).click();
}

export async function onlyTypes(page: Page, kinds: string[]) {
  for (const checkbox of await page.getByRole('group', { name: 'Entity types', exact: true }).getByRole('checkbox').all()) {
    await checkbox.setChecked(kinds.includes(await checkbox.evaluate(element => element.parentElement!.textContent!)));
  }
}

export async function onlyRelationships(page: Page, kinds: string[]) {
  for (const checkbox of await page.getByRole('group', { name: 'Relationship kinds', exact: true }).getByRole('checkbox').all()) {
    await checkbox.setChecked(kinds.includes(await checkbox.evaluate(element => element.parentElement!.textContent!)));
  }
}
