import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e', testMatch: ['**/smoke.ts', '**/graph.spec.ts'], workers: 1,
  use: { baseURL: 'http://127.0.0.1:4320', viewport: { width: 1440, height: 1000 }, launchOptions: { executablePath: process.env.UI_CHROME } },
  webServer: {
    command: process.env.UI_TEST_DEV === '1' ? 'npm run dev' : 'npm start',
    url: 'http://127.0.0.1:4320', reuseExistingServer: false, timeout: 30000,
    env: { UI_PORT: '4320' },
  },
});
