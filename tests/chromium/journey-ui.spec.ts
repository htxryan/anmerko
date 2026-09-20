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
  const client = {
    read: async () => state,
    start: async includeEnteredValues => {
      calls.push(includeEnteredValues);
      if (pendingStart) { state = {phase:'starting', draft:{steps:[]}}; changed(); return new Promise(() => {}); }
      throw new Error('Initial screenshot failed. Try again.');
    },
    stop: async () => { state = { phase:'idle',epoch:3 }; changed(); },
    discard: async () => { state = { phase: 'idle', epoch: 3 }; changed(); },
    subscribe: listener => { changed = listener; return () => {}; },
  };
  mountJourneyUI(document.body, client);
  window.journeyHarness = { calls, pending: () => { pendingStart = true; }, set: next => { state = next; changed(); } };
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
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
});
