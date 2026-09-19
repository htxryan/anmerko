import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './site/tests', workers: 1, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4175' },
  webServer: { command: 'wrangler dev --config site/wrangler.jsonc --port 4175', url: 'http://127.0.0.1:4175', reuseExistingServer: false },
});
