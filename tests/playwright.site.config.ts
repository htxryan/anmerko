import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: './site', workers: 1, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:4175' },
  webServer: { command: 'wrangler dev --config site/wrangler.jsonc --port 4175', cwd: repositoryRoot, url: 'http://127.0.0.1:4175', reuseExistingServer: false },
});
