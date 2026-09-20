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

test('an accepted port layout survives the intentional sidebar disconnect', async ({ page }) => {
  await run(page, 'sidebarHarness.start(1)');
  await expect.poll(() => run(page, 'sidebarHarness.snapshotPending()')).toBe(true);
  await run(page, 'sidebarHarness.releaseSnapshot()');
  await expect.poll(() => run(page, 'sidebarHarness.replies.length')).toBe(1);
  await run(page, 'sidebarHarness.clearPageCommands()');
  await run(page, 'sidebarHarness.layout(1); sidebarHarness.disconnect()');
  await expect.poll(() => run(page, `sidebarHarness.pageCommands.some(message => message.type === 'ANMERKO_PRESENT' && message.mode === 'overlay')`)).toBe(true);
  expect(await run(page, `sidebarHarness.pageCommands.some(message => message.type === 'ANMERKO_SIDEBAR_CLOSED')`)).toBe(false);
});

test('an exact current layout waits for startup when live page state arrives before the snapshot', async ({ page }) => {
  await run(page, 'sidebarHarness.start(1)');
  await expect.poll(() => run(page, 'sidebarHarness.snapshotPending()')).toBe(true);
  await run(page, 'sidebarHarness.toolbar()');
  await expect.poll(() => run(page, `sidebarHarness.broadcasts.some(message => message.type === 'ANMERKO_VIEW_CHANGED')`)).toBe(true);
  await run(page, 'sidebarHarness.clearPageCommands(); sidebarHarness.layout(1); sidebarHarness.disconnect()');
  await expect.poll(() => run(page, `sidebarHarness.pageCommands.some(message => message.type === 'ANMERKO_PRESENT' && message.mode === 'overlay')`)).toBe(true);
  expect(await run(page, `sidebarHarness.pageCommands.some(message => message.type === 'ANMERKO_SIDEBAR_CLOSED')`)).toBe(false);
});

test('background rejects sidebar ports without the exact extension-page sender', async ({ page }) => {
  expect(await run(page, 'sidebarHarness.probeUntrustedConnections()')).toBe(0);
});

test('background revalidates the port-owned tab and window before changing layout', async ({ page }) => {
  await run(page, 'sidebarHarness.start(1)');
  await expect.poll(() => run(page, 'sidebarHarness.snapshotPending()')).toBe(true);
  await run(page, 'sidebarHarness.releaseSnapshot()');
  await expect.poll(() => run(page, 'sidebarHarness.replies.length')).toBe(1);
  await run(page, 'sidebarHarness.clearPageCommands(); sidebarHarness.setTabState(2, true); sidebarHarness.layout(1)');
  await expect.poll(() => run(page, 'sidebarHarness.replies.length')).toBe(2);
  expect(await run(page, 'sidebarHarness.replies.at(-1)')).toEqual({
    type: 'ANMERKO_SIDEBAR_LAYOUT_ERROR', version: 1,
    code: 'layout-failed', error: 'Could not change layout.',
  });
  expect(await run(page, `sidebarHarness.pageCommands.some(message => message.type === 'ANMERKO_PRESENT' && message.mode === 'overlay')`)).toBe(false);
  expect(await run(page, `sidebarHarness.pageCommands.some(message => message.type === 'ANMERKO_SIDEBAR_CLOSED')`)).toBe(true);
});

test('native controls wait for a page snapshot and disconnected settings cannot overwrite page state', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
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
  expect(await run(page, 'nativeHarness.layoutMessages')).toEqual([]);
  expect(await run(page, 'nativeHarness.requests.at(-1)')).toEqual(expect.objectContaining({
    type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'overlay', state: undefined,
  }));
  await run(page, 'nativeHarness.failLayout()');
  await expect(prompt).toBeVisible();
  await expect(select).toBeDisabled();
  await expect(options).toBeDisabled();
  await expect(globalComment).toBeDisabled();
  await run(page, 'nativeHarness.reconnect()');
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(2);
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

test('native Float posts a one-way port command before close and reports a live-port failure', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.reply()');
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });

  await run(page, 'nativeHarness.resetLayoutSequence()');
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  expect(await run(page, 'nativeHarness.layoutSequence')).toEqual(['port-post', 'close']);
  expect(await run(page, 'nativeHarness.layoutMessages')).toEqual([]);
  expect(await run(page, 'nativeHarness.requests.at(-1)')).toEqual({
    type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'overlay',
    state: expect.objectContaining({ url: 'http://127.0.0.1:4173/page' }),
  });
  await run(page, 'nativeHarness.failLayout()');
  await expect(panel.getByRole('status')).toContainText('Could not change layout');
  await run(page, 'nativeHarness.delayNextQuery(); nativeHarness.reopen()');
  await expect.poll(() => run(page, 'nativeHarness.queryPending()')).toBe(true);
  await run(page, 'nativeHarness.releaseQuery()');
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(2);
  await run(page, 'nativeHarness.reply()');
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  expect(await run(page, `nativeHarness.requests.filter(request => request.type === 'ANMERKO_SIDEBAR_LAYOUT').length`)).toBe(2);
});

test('page lifecycle fallback reconnects a reused sidebar document', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.reply()');
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  await run(page, 'nativeHarness.reopenFallback()');
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(2);
});

test('a pending fresh connection cannot send page commands to the previous tab', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.reply(); nativeHarness.setActiveTab(2); nativeHarness.delayNextQuery(); nativeHarness.reconnect()');
  await expect.poll(() => run(page, 'nativeHarness.queryPending()')).toBe(true);
  await run(page, 'nativeHarness.pageCommand()');
  expect(await run(page, 'nativeHarness.pageTargets')).toEqual([]);
  await run(page, 'nativeHarness.releaseQuery()');
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(2);
  await run(page, 'nativeHarness.reply(); nativeHarness.pageCommand()');
  expect(await run(page, 'nativeHarness.pageTargets')).toEqual([2]);
});

test('native Float cancels a pending replacement after posting with the current owner', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.bindBackground()');
  await expect.poll(() => run(page, 'nativeHarness.backgroundModes.join()')).toBe('remote');
  await run(page, 'nativeHarness.delayNextQuery(); nativeHarness.reconnect()');
  await expect.poll(() => run(page, 'nativeHarness.queryPending()')).toBe(true);

  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  expect(await run(page, 'nativeHarness.requests.at(-1)')).toEqual(expect.objectContaining({
    type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'overlay',
  }));
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  expect(await run(page, `nativeHarness.requests.filter(request => request.type === 'ANMERKO_SIDEBAR_LAYOUT').length`)).toBe(1);
  await run(page, 'nativeHarness.releaseQuery()');
  await run(page, 'nativeHarness.reconnect()');
  await run(page, 'nativeHarness.disconnect()');
  await run(page, 'nativeHarness.reconnect()');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  expect(await run(page, 'nativeHarness.backgroundModes')).toEqual(['remote', 'overlay']);
  await run(page, `nativeHarness.delayNextQuery(); nativeHarness.reopen(2); nativeHarness.reopen(1, 'other.html')`);
  expect(await run(page, 'nativeHarness.queryPending()')).toBe(false);
  await run(page, 'nativeHarness.reopen()');
  await expect.poll(() => run(page, 'nativeHarness.queryPending()')).toBe(true);
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  expect(await run(page, `nativeHarness.requests.filter(request => request.type === 'ANMERKO_SIDEBAR_LAYOUT').length`)).toBe(1);
  await run(page, 'nativeHarness.releaseQuery()');
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(2);
  await run(page, 'nativeHarness.reply()');
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  expect(await run(page, `nativeHarness.requests.filter(request => request.type === 'ANMERKO_SIDEBAR_LAYOUT').length`)).toBe(2);
});

test('idle port shutdown preserves the current page, draft and unsaved settings without a keepalive', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
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
