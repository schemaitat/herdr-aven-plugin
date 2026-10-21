import type { Page } from '@playwright/test';

export async function projectDiscovery(page: Page, startup: string) {
  await page.route('**/api/projects', route => route.fulfill({ json: { workspace: 'default', startup, projects: [{ key: startup, name: startup }], status: 'ok', message: 'Fixture project discovery' } }));
}
