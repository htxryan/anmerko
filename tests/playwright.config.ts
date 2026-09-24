import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: './chromium',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  webServer: [
    { command: 'node scripts/browsers/demo.mjs', cwd: repositoryRoot, url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
    { command: 'node tests/fixtures/component-context/server.mjs --port 4177', cwd: repositoryRoot,
      url: 'http://127.0.0.1:4177/healthz', reuseExistingServer: false },
  ],
});
