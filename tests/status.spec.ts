import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import type { statusMessage } from '../src/status';

type StatusWindow = typeof globalThis & {
  anmerkoStatus: { statusMessage: typeof statusMessage };
  show: ReturnType<typeof statusMessage>;
  showSettings: ReturnType<typeof statusMessage>;
  stopStatus: AbortController;
};

test.beforeEach(async ({ page }) => {
  await page.clock.install();
  await page.setContent('<p id="status" role="status"></p><p id="settings" role="status"></p>');
  const bundle = await build({ entryPoints: ['src/status.ts'], bundle: true, format: 'iife', globalName: 'anmerkoStatus', write: false });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    const state = globalThis as StatusWindow;
    state.stopStatus = new AbortController();
    state.show = state.anmerkoStatus.statusMessage(document.getElementById('status')!, state.stopStatus.signal);
    state.showSettings = state.anmerkoStatus.statusMessage(document.getElementById('settings')!, state.stopStatus.signal);
  });
});

test('each new toast gets four seconds, independently of other status regions', async ({ page }) => {
  const status = page.locator('#status');
  const settings = page.locator('#settings');
  await page.evaluate(() => {
    (globalThis as StatusWindow).show('Copied 1 comment.');
    (globalThis as StatusWindow).showSettings('Default restored.');
  });
  await page.clock.runFor(3_000);
  await expect(status).toHaveText('Copied 1 comment.');
  await page.evaluate(() => (globalThis as StatusWindow).show('Comment saved.'));
  await page.clock.runFor(1_000);
  await expect(settings).toBeEmpty();
  await expect(status).toHaveText('Comment saved.');
  await page.clock.runFor(3_000);
  await expect(status).toBeEmpty();
});

test('errors and unsaved changes survive old timers; clearing and closing cancel pending feedback', async ({ page }) => {
  const status = page.locator('#status');
  await page.evaluate(() => (globalThis as StatusWindow).show('Saved.'));
  await page.clock.runFor(3_000);
  await page.evaluate(() => (globalThis as StatusWindow).show('Could not save.', { error: true }));
  await page.clock.runFor(10_000);
  await expect(status).toHaveText('Could not save.');
  await expect(status).toHaveClass('error');
  await page.evaluate(() => (globalThis as StatusWindow).show('Unsaved changes.', { persistent: true }));
  await page.clock.runFor(10_000);
  await expect(status).toHaveText('Unsaved changes.');
  await expect(status).not.toHaveClass('error');
  await page.evaluate(() => {
    (globalThis as StatusWindow).show('Saved.');
    (globalThis as StatusWindow).show();
  });
  await page.clock.runFor(4_000);
  await expect(status).toBeEmpty();
  await page.evaluate(() => {
    const state = globalThis as StatusWindow;
    state.show('Saved.');
    state.stopStatus.abort();
    state.show('Late async result.');
  });
  await page.clock.runFor(4_000);
  // A closed panel is removed by its owner; its status must no longer be mutated.
  await expect(status).toHaveText('Saved.');
});
