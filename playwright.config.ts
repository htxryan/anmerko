import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: 'list',
  webServer: { command: 'node scripts/demo.mjs', url: 'http://127.0.0.1:4173', reuseExistingServer: !process.env.CI },
});
