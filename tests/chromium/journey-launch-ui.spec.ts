import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';

const bundle = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
  import { mount } from './src/content';
  import styles from './src/panel.css';
  window.launchCalls = 0;
  mount({
    store: { read: async () => undefined, readAll: async () => ({}), write: async () => {}, remove: async () => {}, subscribe: () => () => {} },
    attachStyles: shadow => { const style = document.createElement('style'); style.textContent = styles; shadow.append(style); },
    storageError: 'Storage unavailable', settingsLabel: 'Settings',
    openJourney: async () => { window.launchCalls++; if (window.rejectLaunch) throw new Error('private backend detail'); },
  });
` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;

// Exercises the real journey page module (src/journey-page.ts) with a stubbed
// extension API: the launch intent in the hash is already consumed, so Start
// rejects with a launch-expired code and the page must swap to guidance.
const journeyPageBundle = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
  import './src/journey-page';
` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text' }, define: { __ANMERKO_JOURNEYS__: 'true' } }).outputFiles[0].text;

test('page overlays request a trusted journey surface without mounting raw review', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.addScriptTag({ content: bundle });
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await panel.getByRole('button', { name: 'More Comment Options' }).click();
  await panel.getByRole('menuitem', { name: 'Record journey', exact: true }).click();
  expect(await page.evaluate('window.launchCalls')).toBe(1);
  await expect(page.getByRole('region', { name: 'Journey recording and review' })).toHaveCount(0);
  await expect(page.locator('.journey-view')).toHaveCount(0);
  await page.evaluate('window.rejectLaunch = true');
  await panel.getByRole('button', { name: 'More Comment Options' }).click();
  await panel.getByRole('menuitem', { name: 'Record journey', exact: true }).click();
  await expect(panel.getByText('Could not open the journey. Reopen anmerko from the toolbar and try again.', { exact: true })).toBeVisible();
  await expect(page.getByText('private backend detail')).toHaveCount(0);
});

test('consumed launch intent shows guidance instead of a dead start', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body><main id="journey"></main></body></html>');
  await page.evaluate(`location.hash = '#launch=${'a'.repeat(16)}'`);
  await page.evaluate(`window.chrome = {
    runtime: {
      sendMessage: async message => {
        if (message && message.type === 'ANMERKO_JOURNEY_STATE') return { ok: true, value: { phase: 'idle', epoch: 0 } };
        if (message && message.type === 'ANMERKO_JOURNEY_START') return { ok: false, code: 'launch-expired' };
        return { ok: false };
      },
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
    permissions: { request: async () => true },
  };`);
  await page.addScriptTag({ content: journeyPageBundle });
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'This journey link already opened' })).toBeVisible();
  await expect(page.getByText('Each journey link works once. Return to the website tab and choose Record journey to start a fresh journey.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toHaveCount(0);
});
