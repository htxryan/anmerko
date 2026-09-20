import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';

const bundle = buildSync({ entryPoints: ['tests/chromium/fixtures/sidebar-runtime-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
const run = (page: import('@playwright/test').Page, expression: string) => page.evaluate(expression);

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.addScriptTag({ content: bundle });
  await page.waitForFunction('!!globalThis.sidebarHarness');
});

test('port-owned sidebar startup sends one state handoff even when its snapshot is delayed', async ({ page }) => {
  for (const version of [1, 2]) {
    await run(page, `sidebarHarness.start(${version})`);
    await expect.poll(() => run(page, 'sidebarHarness.snapshotPending()')).toBe(true);
    // No early broadcast may mount the editor before the port snapshot arrives.
    expect(await run(page, 'sidebarHarness.broadcasts')).toEqual([]);
    expect(await run(page, 'sidebarHarness.replies.length')).toBe(version - 1);
    await run(page, 'sidebarHarness.releaseSnapshot()');
    await expect.poll(() => run(page, 'sidebarHarness.replies.length')).toBe(version);
    expect(await run(page, 'sidebarHarness.replies.at(-1)')).toEqual({
      version, ok: true, value: await run(page, 'sidebarHarness.state()'),
    });
    // There is no second runtime-message delivery to reorder after the snapshot.
    expect(await run(page, 'sidebarHarness.broadcasts')).toEqual([]);
  }
});

test('toolbar activation still broadcasts state to reconnect an already open sidebar', async ({ page }) => {
  await run(page, 'sidebarHarness.toolbar()');
  expect(await run(page, 'sidebarHarness.broadcasts')).toEqual([{
    type: 'ANMERKO_VIEW_CHANGED', state: await run(page, 'sidebarHarness.state()'),
  }]);
});

test('native controls wait for a page snapshot and disconnected settings cannot overwrite page state', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.requests.length')).toBe(1);
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  const prompt = panel.locator('.connection-prompt');
  const select = panel.getByRole('button', { name: 'Select Element', exact: true });
  await expect(prompt).toBeVisible();
  await expect(select).toBeDisabled();
  const options = panel.getByRole('button', { name: 'More Comment Options', exact: true });
  const capture = panel.getByRole('menuitem', { name: 'Take Screenshot', exact: true, includeHidden: true });
  const globalComment = panel.getByRole('menuitem', { name: 'New Global Comment', exact: true, includeHidden: true });
  await expect(options).toBeDisabled();
  await expect(capture).toBeDisabled();
  await expect(globalComment).toBeDisabled();
  await expect(panel.getByLabel('Comment scope')).toBeDisabled();
  await panel.getByRole('button', { name: 'Extension settings', exact: true }).click();
  await expect(panel.getByLabel('Prompt Preamble')).toBeVisible();
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
  expect(await run(page, 'nativeHarness.pageMessages')).toEqual([]);
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  expect(await run(page, 'nativeHarness.layoutMessages')).toEqual([expect.objectContaining({ type: 'ANMERKO_LAYOUT', mode: 'overlay', state: undefined })]);
  await run(page, 'nativeHarness.fail()');
  await expect(prompt).toBeVisible();
  await expect(select).toBeDisabled();
  await expect(options).toBeDisabled();
  await expect(globalComment).toBeDisabled();
  await run(page, 'nativeHarness.reconnect()');
  await expect.poll(() => run(page, 'nativeHarness.requests.length')).toBe(2);
  await run(page, 'nativeHarness.reply()');
  await expect(prompt).toBeHidden();
  await expect(select).toBeEnabled();
  await expect(options).toBeEnabled();
  await expect(capture).toBeEnabled();
  await expect(globalComment).toBeEnabled();
  await run(page, 'nativeHarness.disconnect()');
  await expect(prompt).toBeHidden();
  await expect(select).toBeEnabled();
  // Idle shutdown must not immediately wake the background with another port.
  expect(await run(page, 'nativeHarness.connections')).toBe(1);
  await run(page, 'nativeHarness.reconnect()');
  await expect.poll(() => run(page, 'nativeHarness.connections')).toBe(2);
  await run(page, 'nativeHarness.reply()');
  await expect(prompt).toBeHidden();
  await expect(select).toBeEnabled();
  await run(page, 'nativeHarness.staleReply()');
  await expect(prompt).toBeHidden();
  await expect(select).toBeEnabled();
  await select.click();
  expect(await run(page, 'nativeHarness.pageMessages')).toEqual([{
    type: 'ANMERKO_SET_VIEW', state: expect.objectContaining({ url: 'http://127.0.0.1:4173/page', picking: true }),
  }]);
});

test('native Float attaches teardown handling before close and preserves unrelated layout failures', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.requests.length')).toBe(1);
  await run(page, 'nativeHarness.reply()');
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });

  await run(page, 'nativeHarness.deferLayout()');
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  expect(await run(page, 'nativeHarness.layoutSequence')).toEqual(['request-catch', 'close']);
  await run(page, `nativeHarness.rejectLayout("Actor 'Conduits' destroyed before query 'RuntimeMessage' was resolved")`);
  await expect(panel.getByRole('status')).not.toContainText('Could not change layout');

  await run(page, 'nativeHarness.deferLayout()');
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  await run(page, `nativeHarness.rejectLayout('A different layout failure')`);
  await expect(panel.getByRole('status')).toContainText('Could not change layout');
});

test('idle port shutdown preserves the current page, draft and unsaved settings without a keepalive', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.requests.length')).toBe(1);
  await run(page, `nativeHarness.reply({
    draft: { id: 'unsaved', kind: 'page', pageUrl: location.origin + '/page', pageTitle: 'Review page', comment: 'Keep my unfinished comment', createdAt: '2026-09-15T00:00:00Z', updatedAt: '2026-09-15T00:00:00Z' },
    settings: true, preambleDraft: 'Keep my unfinished preamble'
  })`);
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await expect(panel.getByLabel('Prompt Preamble')).toHaveValue('Keep my unfinished preamble');
  const before = await run(page, 'nativeHarness.snapshot()');
  await run(page, 'nativeHarness.disconnect()');
  expect(await run(page, 'nativeHarness.snapshot()')).toEqual(before);
  expect(await run(page, 'nativeHarness.connections')).toBe(1);
  await expect(panel.getByLabel('Prompt Preamble')).toHaveValue('Keep my unfinished preamble');
  await panel.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(panel.locator('#comment')).toHaveValue('Keep my unfinished comment');
  await expect(panel.locator('.connection-prompt')).toBeHidden();
});
