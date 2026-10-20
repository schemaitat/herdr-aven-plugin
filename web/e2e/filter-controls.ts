import type { Page } from '@playwright/test';

export async function allTypes(page: Page) {
  await page.getByText('Filters', { exact: true }).click();
  await page.getByRole('button', { name: 'All types', exact: true }).click();
  await page.keyboard.press('Escape');
}

export async function onlyTypes(page: Page, kinds: string[]) {
  for (const checkbox of await page.getByRole('group', { name: 'Entity types', exact: true }).getByRole('checkbox').all()) {
    await checkbox.setChecked(kinds.includes(await checkbox.evaluate(element => element.parentElement!.textContent!)));
  }
}
