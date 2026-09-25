import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';

const bundle = () => buildSync({ stdin: { contents: `
  import { mountJourneyUI } from './src/journey-ui';
  import styles from './src/journey.css';
  const style = document.createElement('style');
  style.textContent = styles;
  document.head.append(style);
  let state = { phase: 'idle', epoch: 0 };
  let changed = () => {};
  const calls = [];
  let pendingStart = false;
  let failAfterStarting = false;
  let readError = false;
  let discardCalls = 0;
  const client = {
    read: async () => {
      if (readError) throw new Error('Journey storage failed. Reset journey storage to continue. A previous draft or the latest action may be lost.');
      return state;
    },
    start: async includeEnteredValues => {
      calls.push(includeEnteredValues);
      if (pendingStart) { state = {phase:'starting', draft:{steps:[]}}; changed(); return new Promise(() => {}); }
      if (failAfterStarting) {
        state = {phase:'starting', draft:{steps:[]}}; changed();
        await new Promise(resolve => setTimeout(resolve, 50));
        state = { phase: 'idle', epoch: 4 }; changed();
      }
      throw new Error('Initial screenshot failed. Try again.');
    },
    stop: async () => { state = { phase:'idle',epoch:3 }; changed(); },
    discard: async () => { discardCalls++; readError = false; state = { phase: 'idle', epoch: 3 }; changed(); },
    subscribe: listener => { changed = listener; return () => {}; },
  };
  mountJourneyUI(document.body, client);
  window.journeyHarness = {
    calls,
    discardCalls: () => discardCalls,
    failRead: () => { readError = true; changed(); },
    pending: () => { pendingStart = true; },
    failAfterStarting: () => { failAfterStarting = true; },
    set: next => { state = next; changed(); },
  };
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;

test('launch is explicit, entered values stay off, and failed initial capture offers retry', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
  expect(await page.evaluate('journeyHarness.calls')).toEqual([]);
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Initial screenshot failed. Try again.');
  expect(await page.evaluate('journeyHarness.calls')).toEqual([false]);
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeFocused();
});

test('a start that reaches the first screenshot and then fails returns focus to Start', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyHarness.failAfterStarting()');
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Initial screenshot failed. Try again.');
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeFocused();
});

test('a successful start moves focus to the recording heading once the first screenshot is taken', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyHarness.pending()');
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  // Focus stays put while the first screenshot is taken, so Firefox keeps the capture.
  await expect(page.getByRole('heading', { name: 'Taking the first screenshot…' })).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.evaluate(() => (window as any).journeyHarness.set({ phase: 'recording', draft: { steps: [{}] } }));
  await expect(page.getByRole('heading', { name: 'Recording journey' })).toBeFocused();
});

test('a surface without document focus never pulls focus from the page beside it', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
  // A sidebar whose web page holds focus reports no document focus.
  await page.evaluate(() => { document.hasFocus = () => false; });
  await page.evaluate(() => (window as any).journeyHarness.set({ phase: 'recording', draft: { steps: [{}] } }));
  await expect(page.getByRole('heading', { name: 'Recording journey' })).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.evaluate(() => (window as any).journeyHarness.set({ phase: 'idle', epoch: 5 }));
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('initial capture can be cancelled while its promise remains pending', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyHarness.pending()');
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  const cancel = page.getByRole('button', { name: 'Cancel start', exact: true });
  await expect(cancel).toBeEnabled();
  await cancel.click();
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeEnabled();
});

test('stopped review shows complete URLs as text and explains missing screenshots', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate(`journeyHarness.set({phase:'reviewing',epoch:2,draft:{
    id:'J1',includeEnteredValues:false,stopReason:'user',steps:[
      {id:'S1',seq:1,kind:'click',elapsedMs:1234,sourceUrl:'https://example.test:8443/a%2Fb?x=1&x=2#part',
       target:{label:'<img src=x onerror=alert(1)>'},image:{status:'unavailable',reason:'superseded'}}
    ],images:{},expected:'',actual:''
  }})`);
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await expect(page.getByText('https://example.test:8443/a%2Fb?x=1&x=2#part', { exact: true })).toBeVisible();
  await expect(page.getByText('Screenshot unavailable: superseded by a later action.', { exact: true })).toBeVisible();
  expect(await page.locator('img').count()).toBe(0);
  expect(await page.locator('a[href]').count()).toBe(0);
  await page.getByRole('button', { name: 'Discard journey', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm discard journey', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
});

test('stopped review explains that a storage failure may lose the latest draft', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate(`journeyHarness.set({phase:'reviewing',epoch:2,draft:{
    id:'J1',includeEnteredValues:false,stopReason:'session-storage-limit',steps:[],images:{},expected:'',actual:''
  }})`);
  const text = 'Journey storage failed while recording. Review this draft now because the latest action or the draft may be lost if the extension closes.';
  await expect(page.locator('.journey-stop-reason.journey-notice-error')).toHaveText(text);
  await expect(page.locator('.journey-live [aria-live="assertive"]')).toHaveText(text);
});

test('failed session loading offers an explicit storage reset', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyHarness.failRead()');
  await expect(page.getByRole('alert')).toHaveText(
    'Journey storage failed. Reset journey storage to continue. A previous draft or the latest action may be lost.',
  );
  await page.getByRole('button', { name: 'Reset journey storage', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
  expect(await page.evaluate('journeyHarness.discardCalls()')).toBe(1);
});
