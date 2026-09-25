import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';

const bundle = buildSync({ entryPoints: ['tests/chromium/fixtures/sidebar-runtime-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
// Every docking build ships journeys, whose toolbar branch differs: bundles
// without the define above cover only the branch that no docking build ships.
const journeyBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/sidebar-runtime-harness.ts'], bundle: true, write: false, format: 'iife',
  loader: { '.css': 'text' }, define: { __TARGET_JOURNEYS__: 'true' } }).outputFiles[0].text;
const run = (page: import('@playwright/test').Page, expression: string) => page.evaluate(expression);

async function loadHarness(page: import('@playwright/test').Page, content: string, holdJourneyRestore = false) {
  await page.goto('http://127.0.0.1:4173');
  if (holdJourneyRestore) await page.evaluate('globalThis.holdJourneyRestore = true');
  await page.addScriptTag({ content });
  await page.waitForFunction('!!globalThis.sidebarHarness');
}

test.beforeEach(async ({ page }) => {
  await loadHarness(page, bundle);
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

test('a successful explicit Dock notifies only the snapshotted live sidebar owner', async ({ page }) => {
  await run(page, 'sidebarHarness.start(1)');
  await expect.poll(() => run(page, 'sidebarHarness.snapshotPending()')).toBe(true);
  await run(page, 'sidebarHarness.releaseSnapshot()');
  await expect.poll(() => run(page, 'sidebarHarness.replies.length')).toBe(1);
  expect(await run(page, 'sidebarHarness.dock()')).toEqual({ ok: true });
  await expect.poll(() => run(page, 'sidebarHarness.replies.length')).toBe(2);
  expect(await run(page, 'sidebarHarness.replies.at(-1)')).toEqual({
    type: 'ANMERKO_SIDEBAR_REOPENED', version: 1,
  });

  await run(page, 'sidebarHarness.start(2)');
  await expect.poll(() => run(page, 'sidebarHarness.snapshotPending()')).toBe(true);
  await run(page, 'sidebarHarness.releaseSnapshot(); sidebarHarness.toolbarAction()');
  await expect.poll(() => run(page, 'sidebarHarness.replies.length')).toBe(4);
  expect(await run(page, 'sidebarHarness.replies.at(-1)')).toEqual({
    type: 'ANMERKO_SIDEBAR_REOPENED', version: 2,
  });
});

test('a delayed Dock cannot notify an owner superseded during the open', async ({ page }) => {
  await run(page, 'sidebarHarness.start(1)');
  await expect.poll(() => run(page, 'sidebarHarness.snapshotPending()')).toBe(true);
  await run(page, 'sidebarHarness.releaseSnapshot()');
  await expect.poll(() => run(page, 'sidebarHarness.replies.length')).toBe(1);

  await run(page, 'sidebarHarness.delayDock(); void (globalThis.pendingDock = sidebarHarness.dock())');
  await expect.poll(() => run(page, 'sidebarHarness.dockPending()')).toBe(true);
  await run(page, 'sidebarHarness.start(2)');
  await expect.poll(() => run(page, 'sidebarHarness.snapshotPending()')).toBe(true);
  await run(page, 'sidebarHarness.releaseSnapshot()');
  await expect.poll(() => run(page, 'sidebarHarness.replies.length')).toBe(2);
  await run(page, 'sidebarHarness.releaseDock()');
  expect(await run(page, 'globalThis.pendingDock')).toEqual({ ok: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await run(page, 'sidebarHarness.replies')).toHaveLength(2);
});

test('an explicit Dock does not notify a disconnected sidebar port', async ({ page }) => {
  await run(page, 'sidebarHarness.start(1)');
  await expect.poll(() => run(page, 'sidebarHarness.snapshotPending()')).toBe(true);
  await run(page, 'sidebarHarness.releaseSnapshot()');
  await expect.poll(() => run(page, 'sidebarHarness.replies.length')).toBe(1);
  await run(page, 'sidebarHarness.disconnect()');
  expect(await run(page, 'sidebarHarness.dock()')).toEqual({ ok: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await run(page, 'sidebarHarness.replies')).toHaveLength(1);
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

test('a toolbar click on a protected page explains it without opening the side panel', async ({ page }) => {
  for (const content of [bundle, journeyBundle]) {
    await loadHarness(page, content);
    for (const url of ['chrome://newtab/', 'about:blank', 'file:///tmp/page.html', 'chrome-extension://test-extension/sidebar.html']) {
      expect(await run(page, `sidebarHarness.toolbarAction(${JSON.stringify(url)})`), url).toEqual([]);
    }
    await expect.poll(() => run(page, 'sidebarHarness.createdTabs.length')).toBe(4);
    expect(await run(page, 'sidebarHarness.createdTabs')).toEqual(Array(4).fill('http://127.0.0.1:4173/extension/unavailable.html'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await run(page, `sidebarHarness.sequence.filter(item => item === 'dock')`)).toEqual([]);
    // A web page still requests the side panel within the click.
    expect(await run(page, 'sidebarHarness.toolbarAction()')).toEqual(['dock']);
  }
});

test('with journeys, the toolbar requests the side panel in the click and notifies the sidebar only after classifying it', async ({ page }) => {
  await loadHarness(page, journeyBundle, true);
  await expect.poll(() => run(page, 'sidebarHarness.restorePending()')).toBe(true);
  await run(page, 'sidebarHarness.start(1)');
  await expect.poll(() => run(page, 'sidebarHarness.snapshotPending()')).toBe(true);
  await run(page, 'sidebarHarness.releaseSnapshot()');
  await expect.poll(() => run(page, 'sidebarHarness.replies.length')).toBe(1);

  // The dock request is made synchronously in the click, before the journey
  // restore that decides whether the click is Stop has finished.
  expect(await run(page, 'sidebarHarness.toolbarAction()')).toEqual(['dock']);
  expect(await run(page, 'sidebarHarness.restorePending()')).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(await run(page, 'sidebarHarness.replies')).toHaveLength(1);
  // Once the click is known not to be Stop, the reopened sidebar is notified.
  await run(page, 'sidebarHarness.releaseRestore()');
  await expect.poll(() => run(page, 'sidebarHarness.replies.length')).toBe(2);
  expect(await run(page, 'sidebarHarness.replies.at(-1)')).toEqual({ type: 'ANMERKO_SIDEBAR_REOPENED', version: 1 });
  expect(await run(page, 'sidebarHarness.sequence')).toEqual(['restore', 'dock']);
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
  const capture = panel.getByRole('button', { name: 'Take Screenshot', exact: true });
  const globalComment = panel.getByRole('button', { name: 'New Global Comment', exact: true });
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
  await expect(capture).toBeDisabled();
  await expect(globalComment).toBeDisabled();
  await run(page, 'nativeHarness.reconnect()');
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(2);
  await run(page, 'nativeHarness.reply()');
  await expect(prompt).toBeHidden();
  await expect(select).toBeEnabled();
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
  await expect(panel.locator('.status')).toContainText('Could not change layout');
  // The background restored the page, so the panel asks to reconnect.
  await expect(panel.locator('.connection-prompt')).toBeVisible();
  await run(page, 'nativeHarness.delayNextQuery(); nativeHarness.reopen()');
  await expect.poll(() => run(page, 'nativeHarness.queryPending()')).toBe(true);
  await run(page, 'nativeHarness.releaseQuery()');
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(2);
  await run(page, 'nativeHarness.reply()');
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  expect(await run(page, `nativeHarness.requests.filter(request => request.type === 'ANMERKO_SIDEBAR_LAYOUT').length`)).toBe(2);
});

test('native Float after idle shutdown reopens the port with its startup request before the layout, in the click', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.reply()');
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await expect(panel.locator('.connection-prompt')).toBeHidden();
  // The idle background drops the port; the sidebar still shows its page.
  await run(page, 'nativeHarness.disconnect()');
  expect(await run(page, 'nativeHarness.connections')).toBe(1);

  await run(page, 'nativeHarness.resetLayoutSequence()');
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  // Firefox still closes the sidebar within the click, after both port posts.
  expect(await run(page, 'nativeHarness.layoutSequence')).toEqual(['port-post', 'close']);
  expect(await run(page, 'nativeHarness.connections')).toBe(2);
  const [startup, layout] = await run(page, 'nativeHarness.requests.slice(-2)') as any[];
  expect(startup).toEqual({ tabId: 1, windowId: 1, version: expect.any(Number) });
  expect(layout).toEqual({
    type: 'ANMERKO_SIDEBAR_LAYOUT', version: startup.version, mode: 'overlay',
    state: expect.objectContaining({ url: 'http://127.0.0.1:4173/page' }),
  });
  expect(await run(page, 'nativeHarness.layoutMessages')).toEqual([]);
  await expect(panel.locator('.status')).not.toContainText('Could not change layout');
  // The woken background activates the page for the new request, then applies the layout.
  await run(page, 'nativeHarness.bindBackground()');
  await expect.poll(() => run(page, 'nativeHarness.backgroundModes')).toEqual(['remote', 'overlay']);
});

test('native Minimize after the background stops, before the sidebar sees the disconnect, reopens the port in the click', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.reply()');
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await expect(panel.locator('.connection-prompt')).toBeHidden();
  // The port is dead, and its disconnect event has not reached the sidebar yet.
  await run(page, 'nativeHarness.stop()');

  await run(page, 'nativeHarness.resetLayoutSequence()');
  await panel.getByRole('button', { name: 'Minimize comments', exact: true }).click();
  expect(await run(page, 'nativeHarness.layoutSequence')).toEqual(['port-post', 'close']);
  expect(await run(page, 'nativeHarness.connections')).toBe(2);
  const [startup, layout] = await run(page, 'nativeHarness.requests.slice(-2)') as any[];
  expect(startup).toEqual({ tabId: 1, windowId: 1, version: expect.any(Number) });
  expect(layout).toEqual({
    type: 'ANMERKO_SIDEBAR_LAYOUT', version: startup.version, mode: 'minimized',
    state: expect.objectContaining({ url: 'http://127.0.0.1:4173/page' }),
  });
  await expect(panel.locator('.status')).not.toContainText(/Could not change layout|Disconnected/);
  // The old port's late disconnect event leaves the new one in place.
  await run(page, 'nativeHarness.deliverLateDisconnect()');
  await run(page, 'nativeHarness.bindBackground()');
  await expect.poll(() => run(page, 'nativeHarness.backgroundModes')).toEqual(['remote', 'minimized']);
});

test('page lifecycle fallback reconnects a reused sidebar document', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.reply()');
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  await run(page, `Object.defineProperty(document, 'hidden', { configurable: true, value: true }); nativeHarness.reopenFallback(); delete document.hidden`);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.reopenFallback()');
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(2);
});

test('a versioned background reopen recovers a reused sidebar without lifecycle events', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.reply()');
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });

  await run(page, 'nativeHarness.delayNextQuery(); nativeHarness.reconnect()');
  await expect.poll(() => run(page, 'nativeHarness.queryPending()')).toBe(true);
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  expect(await run(page, 'nativeHarness.requests.at(-1)')).toEqual(expect.objectContaining({
    type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'overlay',
  }));
  await run(page, 'nativeHarness.reopened()');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.reopened(1)');
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(2);
  await run(page, 'nativeHarness.reply()');
  const freshVersion = await run(page, 'nativeHarness.startupRequests.at(-1).version');
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  expect(await run(page, 'nativeHarness.requests.at(-1)')).toEqual(expect.objectContaining({
    type: 'ANMERKO_SIDEBAR_LAYOUT', version: freshVersion, mode: 'overlay',
  }));

  await run(page, 'nativeHarness.reopened(1)');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await run(page, 'nativeHarness.startupRequests.length')).toBe(2);
  await run(page, `nativeHarness.reopened(${freshVersion})`);
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(3);
  await run(page, 'nativeHarness.releaseQuery()');
});

test('an explicit reopen while already open refreshes the owner for the next Float cycle', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.reply(); nativeHarness.reopened(1)');
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(2);
  await run(page, 'nativeHarness.reply()');
  const freshVersion = await run(page, 'nativeHarness.startupRequests.at(-1).version');
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  await run(page, `nativeHarness.reopened(${freshVersion})`);
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(3);
});

test('a versioned reopen can recover after a closing layout error retired the owner', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.reply()');
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  await run(page, 'nativeHarness.failLayout(); nativeHarness.reopened(1)');
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
  await run(page, `nativeHarness.delayNextQuery(); nativeHarness.reopen(2); nativeHarness.reopen(1, '/other.html')`);
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

test('a Floated sidebar document stays disconnected until a fresh owner answers its reopen', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.reply()');
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  const prompt = panel.locator('.connection-prompt');
  const select = panel.getByRole('button', { name: 'Select Element', exact: true });
  const float = panel.getByRole('button', { name: 'Float panel', exact: true });
  await expect(prompt).toBeHidden();
  await float.click();
  expect(await run(page, `nativeHarness.requests.filter(request => request.type === 'ANMERKO_SIDEBAR_LAYOUT').length`)).toBe(1);
  // Chrome can show this same document again. It handed its view to the page
  // and its request is retired, so its controls must not look connected.
  await expect(prompt).toBeVisible();
  await expect(select).toBeDisabled();
  // A toolbar activation makes the page broadcast before the reopen arrives.
  await run(page, 'nativeHarness.broadcast()');
  await expect(prompt).toBeVisible();
  await expect(select).toBeDisabled();
  await run(page, 'nativeHarness.delayNextQuery(); nativeHarness.reopen()');
  await expect.poll(() => run(page, 'nativeHarness.queryPending()')).toBe(true);
  await expect(prompt).toBeVisible();
  await run(page, 'nativeHarness.releaseQuery()');
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(2);
  await run(page, 'nativeHarness.reply()');
  await expect(prompt).toBeHidden();
  await expect(select).toBeEnabled();
  const freshVersion = await run(page, 'nativeHarness.startupRequests.at(-1).version');
  await float.click();
  expect(await run(page, 'nativeHarness.requests.at(-1)')).toEqual(expect.objectContaining({
    type: 'ANMERKO_SIDEBAR_LAYOUT', version: freshVersion, mode: 'overlay',
  }));
});

// WCAG relative luminance of an sRGB colour given as 0-255 channels.
function luminance([r, g, b]: number[]) {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

test('a handed-off sidebar offers Float like a fresh one and shows its refusal above the shade', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.setViewportSize({ width: 360, height: 720 });
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  const float = panel.getByRole('button', { name: 'Float panel', exact: true });
  // A fresh sidebar shows Float while its connection prompt is up.
  await expect(panel.locator('.connection-prompt')).toBeVisible();
  await expect(float).toBeEnabled();
  await run(page, 'nativeHarness.reply()');
  await float.click();
  await expect(panel.locator('.connection-prompt')).toBeVisible();
  const layouts = `nativeHarness.requests.filter(request => request.type === 'ANMERKO_SIDEBAR_LAYOUT').length`;
  expect(await run(page, layouts)).toBe(1);
  const status = panel.locator('.status');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => {
      document.querySelector('anmerko-overlay')!.shadowRoot!.querySelector<HTMLElement>('.app')!.dataset.theme = value;
    }, theme);
    // The handed-off document still offers Float and refuses it with guidance.
    await expect(float).toBeEnabled();
    await float.click();
    await expect(status).toHaveText('Could not change layout. Click anmerko in the browser toolbar to open the sidebar.');
    expect(await run(page, layouts)).toBe(1);
    const colors = await status.evaluate(element => {
      const style = getComputedStyle(element);
      const channels = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
      return { text: channels(style.color), background: channels(style.backgroundColor) };
    });
    // The shade must not dim the status: its rendered background is its own.
    const shot = await status.screenshot();
    const rendered = await page.evaluate(async data => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(3, 3, 1, 1).data).slice(0, 3);
    }, shot.toString('base64'));
    for (const [index, channel] of rendered.entries()) {
      expect(Math.abs(channel - colors.background[index]), `${theme} background ${rendered} vs ${colors.background}`).toBeLessThanOrEqual(2);
    }
    const [lighter, darker] = [luminance(colors.text), luminance(rendered)].sort((a, b) => b - a);
    expect((lighter + 0.05) / (darker + 0.05), theme).toBeGreaterThanOrEqual(4.5);
  }
});

test('an explicit reopen of a live sidebar keeps Float on the current owner while its replacement is pending', async ({ page }) => {
  const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.startupRequests.length')).toBe(1);
  await run(page, 'nativeHarness.reply()');
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  // A toolbar click on an open sidebar sends a versioned reopen for its live owner.
  await run(page, 'nativeHarness.delayNextQuery(); nativeHarness.reopened(1)');
  await expect.poll(() => run(page, 'nativeHarness.queryPending()')).toBe(true);
  await expect(panel.locator('.connection-prompt')).toBeHidden();
  await panel.getByRole('button', { name: 'Float panel', exact: true }).click();
  expect(await run(page, 'nativeHarness.requests.at(-1)')).toEqual(expect.objectContaining({
    type: 'ANMERKO_SIDEBAR_LAYOUT', version: 1, mode: 'overlay',
  }));
  await expect(panel.getByRole('status').filter({ hasText: 'Could not change layout' })).toHaveCount(0);
  await run(page, 'nativeHarness.releaseQuery()');
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await run(page, 'nativeHarness.startupRequests.length')).toBe(1);
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
