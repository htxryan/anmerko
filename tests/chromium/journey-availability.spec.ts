import { chromium, expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { iPhoneOrIPad, journeyApisPresent } from '../../src/journey-feature';
import { addJourneyApis } from './fixtures/journey-apis';

// Journeys are this build target's capability; every surface also checks that
// the platform and browser support them before offering or binding anything.
const ORIGIN = 'http://127.0.0.1:4173';
const define = { __TARGET_JOURNEYS__: 'true' };
const build = (contents: string, globalName?: string) => buildSync({
  stdin: { resolveDir: process.cwd(), contents }, bundle: true, write: false, format: 'iife',
  loader: { '.css': 'text' }, define, globalName,
}).outputFiles[0].text;
const backgroundBundle = build(`export * from './src/background';`, 'backgroundModule');
const overlayBundle = build(`import './src/extension-content';`);
const observerBundle = build(`import './src/journey-observer';`);
const sidebarBundle = build(`
  import { mount } from './src/content';
  import { extensionRuntime } from './src/extension-runtime';
  mount(extensionRuntime(() => {}));
`);
const journeyPageBundle = build(`import './src/journey-page';`);

const agents = {
  iPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  edgeIPhone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/140.0.3485.94 Mobile/15E148 Safari/605.1.15',
  iPad: 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  iPod: 'Mozilla/5.0 (iPod touch; CPU iPhone OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1',
  // iPadOS asks for desktop sites with a Mac user agent.
  iPadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  edgeIPadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/140.0.3485.94 Safari/605.1.15',
  chromeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
  headlessMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.0.0 Safari/537.36',
  edgeMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
  firefoxMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) Gecko/20100101 Firefox/142.0',
  edgeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0',
  edgeAndroid: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36 EdgA/142.0.0.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 15; Mobile; rv:142.0) Gecko/142.0 Firefox/142.0',
  firefoxLinux: 'Mozilla/5.0 (X11; Linux x86_64; rv:142.0) Gecko/20100101 Firefox/142.0',
};
type Agent = keyof typeof agents;
const apple: Agent[] = ['iPhone', 'edgeIPhone', 'iPad', 'iPod', 'iPadDesktop', 'edgeIPadDesktop'];
const supported: Agent[] = ['chromeMac', 'headlessMac', 'edgeMac', 'firefoxMac', 'edgeWindows', 'edgeAndroid', 'firefoxAndroid', 'firefoxLinux'];
// Members of the extension API a recording needs.
const journeyMembers = ['alarms', 'alarms.onAlarm', 'webNavigation', 'webNavigation.onCommitted', 'tabs.onActivated',
  'tabs.onUpdated', 'tabs.onRemoved', 'scripting', 'storage.session'];

async function emulate(page: Page, agent: Agent, maxTouchPoints?: number) {
  await page.evaluate(({ userAgent, maxTouchPoints }) => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, get: () => userAgent });
    if (maxTouchPoints !== undefined) Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => maxTouchPoints });
  }, { userAgent: agents[agent], maxTouchPoints });
}

function omitMembers(paths: string[]) {
  const api = (globalThis as unknown as { chrome: Record<string, any> }).chrome;
  for (const path of paths) {
    const [area, member] = path.split('.');
    if (member) delete api[area]?.[member];
    else delete api[area];
  }
}

test('platform signals exclude iPhone and iPad in every browser, including desktop-class iPad browsing', () => {
  for (const agent of apple) expect(iPhoneOrIPad({ userAgent: agents[agent] }), agent).toBe(true);
  for (const agent of supported) expect(iPhoneOrIPad({ userAgent: agents[agent], maxTouchPoints: 0 }), agent).toBe(false);
  // A page sees an iPad's touch screen even when its user agent names a Chromium engine.
  expect(iPhoneOrIPad({ userAgent: agents.chromeMac, maxTouchPoints: 5 })).toBe(true);
  // Touch emulation on a Mac reports one touch point; iPadOS reports five.
  expect(iPhoneOrIPad({ userAgent: agents.headlessMac, maxTouchPoints: 1 })).toBe(false);
  expect(iPhoneOrIPad({ userAgent: agents.edgeWindows, maxTouchPoints: 10 })).toBe(false);
  // Gecko never runs on iPadOS: Firefox for Android can ask for a desktop site.
  expect(iPhoneOrIPad({ userAgent: agents.firefoxMac, maxTouchPoints: 5 })).toBe(false);
  expect(iPhoneOrIPad({ userAgent: agents.chromeMac, os: 'ios' })).toBe(true);
  expect(iPhoneOrIPad({ userAgent: agents.chromeMac, userAgentPlatform: 'iOS' })).toBe(true);
  expect(iPhoneOrIPad({ userAgent: agents.chromeMac, os: 'mac', userAgentPlatform: 'macOS' })).toBe(false);
  expect(iPhoneOrIPad({})).toBe(false);
});

test('the API check requires every extension API a recording uses', () => {
  const complete = () => {
    const event = () => ({ addListener() {}, removeListener() {} });
    return {
      alarms: { onAlarm: event(), create() {}, clear() {} },
      webNavigation: { onCommitted: event(), onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event() },
      tabs: { onActivated: event(), onUpdated: event(), onRemoved: event() },
      scripting: { executeScript() {} },
      storage: { session: { get() {}, set() {}, remove() {} } },
    } as Record<string, any>;
  };
  expect(journeyApisPresent(complete())).toBe(true);
  expect(journeyApisPresent(undefined)).toBe(false);
  for (const path of [...journeyMembers, 'alarms.create', 'alarms.clear', 'webNavigation.onHistoryStateUpdated',
    'webNavigation.onReferenceFragmentUpdated', 'scripting.executeScript', 'storage.session']) {
    const api = complete();
    const [area, member] = path.split('.');
    if (member) delete api[area][member]; else delete api[area];
    expect(journeyApisPresent(api), path).toBe(false);
  }
});

type BackgroundLog = { kind: string; files?: string[]; args?: unknown[]; type?: string; url?: string };
type BackgroundWindow = typeof globalThis & {
  backgroundModule: { activateTab(tabId: number): Promise<void> };
  backgroundHarness: { log: BackgroundLog[]; listeners: Record<string, number>; added: Record<string, number>; click(tab: unknown): void };
};

async function loadBackground(page: Page, options: { agent?: Agent; omit?: string[]; os?: string } = {}) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(ORIGIN);
  if (options.agent) await emulate(page, options.agent);
  await page.evaluate(({ os }) => {
    const listeners: Record<string, Array<(...args: any[]) => void>> = {};
    // The background prunes idle journey listeners after startup, so count registrations too.
    const added: Record<string, number> = {};
    const event = (name: string) => ({
      addListener(listener: (...args: any[]) => void) { (listeners[name] ??= []).push(listener); added[name] = (added[name] ?? 0) + 1; },
      removeListener(listener: (...args: any[]) => void) { listeners[name] = (listeners[name] ?? []).filter(item => item !== listener); },
    });
    const log: BackgroundLog[] = [];
    const tab = (id: number) => ({ id, windowId: 1, active: true, url: 'https://example.com/' });
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        getManifest: () => ({ background: { service_worker: 'background.js' } }),
        onMessage: event('runtime.onMessage'), onConnect: event('runtime.onConnect'), sendMessage: async () => {},
        ...(os ? { getPlatformInfo: async () => ({ os, arch: 'arm64', nacl_arch: 'arm' }) } : {}),
      },
      action: { onClicked: event('action.onClicked'), setTitle: async () => {}, setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
      storage: {
        local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: event('storage.onChanged'),
      },
      tabs: {
        onActivated: event('tabs.onActivated'), onUpdated: event('tabs.onUpdated'), onRemoved: event('tabs.onRemoved'), onReplaced: event('tabs.onReplaced'),
        get: async (id: number) => tab(id), query: async () => [], update: async (id: number) => tab(id), remove: async () => {},
        create: async (details: { url: string }) => { log.push({ kind: 'create', url: details.url }); return tab(99); },
        sendMessage: async (_tabId: number, message: { type: string }) => { log.push({ kind: 'message', type: message.type }); return true; },
        captureVisibleTab: async () => 'data:image/png;base64,',
      },
      scripting: {
        executeScript: async (details: { files?: string[]; func?: unknown; args?: unknown[] }) => {
          log.push({ kind: details.files ? 'files' : 'func', files: details.files, args: details.args });
          return [];
        },
      },
      alarms: { onAlarm: event('alarms.onAlarm'), create: async () => {}, clear: async () => true, get: async () => undefined, getAll: async () => [] },
      webNavigation: {
        onCommitted: event('webNavigation.onCommitted'), onHistoryStateUpdated: event('webNavigation.onHistoryStateUpdated'),
        onReferenceFragmentUpdated: event('webNavigation.onReferenceFragmentUpdated'),
      },
      windows: { onFocusChanged: event('windows.onFocusChanged') },
    };
    (globalThis as any).backgroundHarness = {
      log,
      get listeners() { return Object.fromEntries(Object.entries(listeners).map(([name, list]) => [name, list.length])); },
      get added() { return { ...added }; },
      click(clicked: unknown) { for (const listener of listeners['action.onClicked'] ?? []) listener(clicked); },
    };
  }, { os: options.os });
  if (options.omit) await page.evaluate(omitMembers, options.omit);
  await page.addScriptTag({ content: backgroundBundle });
  return errors;
}

const harness = (page: Page) => page.evaluate(() => {
  const { log, listeners, added } = (globalThis as BackgroundWindow).backgroundHarness;
  return { log: structuredClone(log), listeners, added };
});
const declinedMarker = { kind: 'func', files: undefined, args: ['__anmerkoJourneysDeclined'] };
const overlay = [{ kind: 'files', files: ['content.js'], args: undefined }, { kind: 'message', type: 'ANMERKO_PRESENT' }];

test('a supported browser binds journeys at startup and leaves pages unmarked', async ({ page }) => {
  const errors = await loadBackground(page, { agent: 'chromeMac', os: 'mac' });
  const { listeners, added } = await harness(page);
  // Comments add one runtime message listener; journeys add their own and register their
  // startup listeners synchronously, then drop the ones an idle journey does not need.
  expect(listeners).toMatchObject({ 'runtime.onMessage': 2, 'alarms.onAlarm': 1 });
  expect(added).toMatchObject({
    'runtime.onMessage': 2, 'alarms.onAlarm': 1, 'tabs.onRemoved': 1,
    'webNavigation.onCommitted': 1, 'webNavigation.onHistoryStateUpdated': 1, 'webNavigation.onReferenceFragmentUpdated': 1,
  });
  await page.evaluate(() => (globalThis as BackgroundWindow).backgroundModule.activateTab(7));
  expect((await harness(page)).log).toEqual(overlay);
  expect(errors).toEqual([]);
});

const unavailable: Array<{ name: string; agent?: Agent; omit?: string[] }> = [
  ...journeyMembers.map(member => ({ name: `without ${member}`, omit: [member] })),
  { name: 'on iPhone', agent: 'iPhone' },
  { name: 'in Edge on iPhone', agent: 'edgeIPhone' },
  { name: 'in desktop-class iPad browsing', agent: 'iPadDesktop' },
];
for (const { name, agent, omit } of unavailable) {
  test(`a background ${name} binds no journey listeners and still serves comments`, async ({ page }) => {
    const errors = await loadBackground(page, { agent: agent ?? 'chromeMac', omit });
    const { listeners, added } = await harness(page);
    expect(listeners['runtime.onMessage']).toBe(1);
    for (const journeyOnly of ['alarms.onAlarm', 'tabs.onRemoved', 'webNavigation.onCommitted', 'windows.onFocusChanged']) {
      expect(added[journeyOnly] ?? 0, journeyOnly).toBe(0);
    }
    // The toolbar still opens the comment overlay, telling the page first that
    // journeys are off. Without scripting it reports an inaccessible page.
    await page.evaluate(() => (globalThis as BackgroundWindow).backgroundHarness.click({ id: 7, windowId: 1, url: 'https://example.com/' }));
    await expect.poll(async () => (await harness(page)).log).toEqual(omit?.includes('scripting')
      ? [{ kind: 'create', url: 'chrome-extension://test-extension/unavailable.html' }] : [declinedMarker, ...overlay]);
    expect(errors).toEqual([]);
  });
}

test('getPlatformInfo reporting iOS keeps pages from offering journeys', async ({ page }) => {
  const errors = await loadBackground(page, { agent: 'chromeMac', os: 'ios' });
  await page.evaluate(() => (globalThis as BackgroundWindow).backgroundModule.activateTab(7));
  expect((await harness(page)).log).toEqual([declinedMarker, ...overlay]);
  expect(errors).toEqual([]);
});

async function loadOverlay(page: Page, options: { agent: Agent; maxTouchPoints?: number; declined?: boolean; bundle?: string }) {
  await page.goto(ORIGIN);
  await emulate(page, options.agent, options.maxTouchPoints);
  await page.evaluate(declined => {
    const event = () => ({ addListener() {}, removeListener() {} });
    // A content script sees only these extension APIs.
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`, getManifest: () => ({}),
        sendMessage: async () => ({ ok: true }), onMessage: event(), connect: () => ({ onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() {} }),
      },
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: event() },
    };
    if (declined) (globalThis as any).__anmerkoJourneysDeclined = true;
  }, !!options.declined);
  await page.addScriptTag({ content: options.bundle ?? overlayBundle });
}

const commentActions = (page: Page) => page.getByRole('complementary', { name: 'anmerko feedback panel' })
  .getByRole('group', { name: 'Comment Actions' }).getByRole('button');
const threeActions = ['Select Element', 'Take Screenshot', 'New Global Comment'];
const journeyBridge = (page: Page) => page.evaluate(() => typeof (globalThis as any).__anmerkoJourneyPage);

// A page's user agent is not the browser's: DevTools device mode and desktop-site
// requests rewrite it for one tab. Page scripts trust the background's verdict.
const offeredCases: Array<{ name: string; agent: Agent; maxTouchPoints?: number }> = [
  { name: 'in a supported browser', agent: 'chromeMac', maxTouchPoints: 0 },
  { name: 'emulating an iPhone in a supported browser', agent: 'iPhone', maxTouchPoints: 5 },
  { name: 'emulating an iPad in a supported browser', agent: 'iPadDesktop', maxTouchPoints: 5 },
  { name: 'asking for a desktop site on a touch screen', agent: 'chromeMac', maxTouchPoints: 5 },
];
for (const { name, ...options } of offeredCases) {
  test(`a page overlay ${name} offers Record journey and binds its page bridge`, async ({ page }) => {
    await loadOverlay(page, options);
    await expect(commentActions(page).first()).toBeVisible();
    expect(await commentActions(page).evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))))
      .toEqual([...threeActions, 'More Comment Options']);
    expect(await journeyBridge(page)).toBe('function');
  });
}

const declinedCases: Array<{ name: string; agent: Agent; maxTouchPoints?: number }> = [
  { name: 'on iPhone', agent: 'iPhone', maxTouchPoints: 5 },
  { name: 'in Edge on iPhone', agent: 'edgeIPhone', maxTouchPoints: 5 },
  { name: 'in desktop-class iPad browsing', agent: 'iPadDesktop', maxTouchPoints: 5 },
  { name: 'with a desktop user agent', agent: 'chromeMac', maxTouchPoints: 0 },
];
for (const { name, ...options } of declinedCases) {
  test(`a page overlay ${name} keeps the original three-button comment bar once the background declined journeys`, async ({ page }) => {
    await loadOverlay(page, { ...options, declined: true });
    await expect(commentActions(page).first()).toBeAttached();
    expect(await commentActions(page).evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))))
      .toEqual(threeActions);
    await expect(page.locator('anmerko-overlay').locator('#comment-menu')).toHaveCount(0);
    expect(await journeyBridge(page)).toBe('undefined');
  });
}

test('the injected journey observer binds on an emulated iPhone page unless the background declined journeys', async ({ page }) => {
  await loadOverlay(page, { agent: 'iPhone', maxTouchPoints: 5, bundle: observerBundle });
  expect(await journeyBridge(page)).toBe('function');
  await loadOverlay(page, { agent: 'chromeMac', maxTouchPoints: 0, declined: true, bundle: observerBundle });
  expect(await journeyBridge(page)).toBe('undefined');
});

// DevTools device mode emulates a phone in one tab of a desktop browser. The
// background still records there, so that tab must offer journeys and answer
// the handshake a recording starts with.
test('a desktop browser emulating an iPhone in one tab still offers journeys and connects the recording', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'anmerko-emulation-'));
  const extension = path.join(temp, 'extension');
  await cp('dist', extension, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  // Automation cannot click the toolbar to grant activeTab.
  manifest.host_permissions = [`${ORIGIN}/*`];
  manifest.background.service_worker = 'test-bootstrap.js';
  await writeFile(path.join(extension, 'test-bootstrap.js'),
    "import { activateTab } from './background.js'; globalThis.__testActivateTab = activateTab;");
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium', headless: !process.env.HEADED, viewport: { width: 390, height: 844 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: agents.iPhone });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.goto(ORIGIN);
    expect(await page.evaluate(() => [navigator.userAgent, navigator.maxTouchPoints])).toEqual([agents.iPhone, 5]);
    const identified = await worker.evaluate(async url => {
      const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
      if (!tab?.id) throw new Error('Test tab not found');
      await (globalThis as typeof globalThis & { __testActivateTab: (id: number) => Promise<void> }).__testActivateTab(tab.id);
      // What connect() in journey-extension.ts does when a recording starts.
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['journey-observer.js'], injectImmediately: true });
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'ANMERKO_JOURNEY_PAGE_IDENTIFY' }, { frameId: 0 });
      return (response as { ok?: boolean } | undefined)?.ok;
    }, page.url());
    await expect(commentActions(page).first()).toBeVisible();
    expect(await commentActions(page).evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))))
      .toEqual([...threeActions, 'More Comment Options']);
    expect(identified).toBe(true);
  } finally {
    await context.close();
    await rm(temp, { recursive: true, force: true });
  }
});

async function loadSidebar(page: Page, options: { agent: Agent; omit?: string[] }) {
  await page.goto(`${ORIGIN}/sidebar.html`);
  await emulate(page, options.agent, 0);
  await page.evaluate(() => {
    const event = () => ({ addListener() {}, removeListener() {} });
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-extension', getURL: (path: string) => `${location.origin}/${path}`,
        getManifest: () => ({ side_panel: { default_path: 'sidebar.html' } }),
        sendMessage: async () => ({ ok: true }), onMessage: event(),
        connect: () => ({ onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() {} }),
      },
      tabs: { query: async () => [{ id: 1 }], onActivated: event(), onUpdated: event(), sendMessage: async () => {} },
      windows: { getCurrent: async () => ({ id: 1 }) },
      storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} }, onChanged: event() },
    };
  });
  await page.evaluate(addJourneyApis);
  if (options.omit) await page.evaluate(omitMembers, options.omit);
  await page.addScriptTag({ content: sidebarBundle });
}

test('the native sidebar offers Record journey when the browser has every journey API', async ({ page }) => {
  await loadSidebar(page, { agent: 'chromeMac' });
  await expect(commentActions(page).first()).toBeAttached();
  expect(await commentActions(page).evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))))
    .toEqual([...threeActions, 'More Comment Options']);
});

// The sidebar itself follows tab activation and loads, so those stay.
for (const member of journeyMembers.filter(member => !['tabs.onActivated', 'tabs.onUpdated'].includes(member))) {
  test(`the native sidebar without ${member} keeps the original three-button comment bar`, async ({ page }) => {
    await loadSidebar(page, { agent: 'chromeMac', omit: [member] });
    await expect(commentActions(page).first()).toBeAttached();
    expect(await commentActions(page).evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label'))))
      .toEqual(threeActions);
  });
}

async function loadJourneyPage(page: Page, options: { agent: Agent; maxTouchPoints?: number; omit?: string[] }) {
  await page.goto(ORIGIN);
  await page.setContent('<!doctype html><html><head></head><body><main id="journey"></main></body></html>');
  await page.evaluate(() => { location.hash = 'launch=valid_nonce-1234567890'; });
  await emulate(page, options.agent, options.maxTouchPoints ?? 0);
  await page.evaluate(() => {
    const sent: unknown[] = [];
    (globalThis as any).journeyMessages = sent;
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        getManifest: () => ({ background: { service_worker: 'background.js' } }),
        sendMessage: async (message: unknown) => { sent.push(message); return { ok: true, value: { phase: 'idle', epoch: 0 } }; },
        onMessage: { addListener() {}, removeListener() {} },
      },
    };
  });
  await page.evaluate(addJourneyApis);
  if (options.omit) await page.evaluate(omitMembers, options.omit);
  await page.addScriptTag({ content: journeyPageBundle });
}

const journeyPageOffered: Array<{ name: string; agent: Agent; maxTouchPoints?: number }> = [
  { name: 'in a supported browser', agent: 'chromeMac' },
  { name: 'in Firefox for Android asking for a desktop site', agent: 'firefoxMac', maxTouchPoints: 5 },
];
for (const { name, ...options } of journeyPageOffered) {
  test(`the journey tab offers recording ${name}`, async ({ page }) => {
    await loadJourneyPage(page, options);
    await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  });
}

const journeyPageCases: Array<{ name: string; agent: Agent; maxTouchPoints?: number; omit?: string[] }> = [
  { name: 'on iPhone', agent: 'iPhone', maxTouchPoints: 5 },
  { name: 'in Edge on iPhone', agent: 'edgeIPhone', maxTouchPoints: 5 },
  { name: 'in desktop-class iPad browsing', agent: 'iPadDesktop', maxTouchPoints: 5 },
  { name: 'without alarms', agent: 'chromeMac', omit: ['alarms'] },
  { name: 'without webNavigation', agent: 'chromeMac', omit: ['webNavigation'] },
];
for (const { name, ...options } of journeyPageCases) {
  test(`the journey tab ${name} says journeys are not available without contacting the background`, async ({ page }) => {
    await loadJourneyPage(page, options);
    await expect(page.getByRole('heading', { name: 'Journey recording unavailable' })).toBeVisible();
    await expect(page.getByText('Journeys are not available in this browser. They work in Chrome, Edge, and Firefox on computers and in Edge and Firefox on Android, but not on iPhone or iPad. Comments still work on the website tab.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button')).toHaveCount(0);
    expect(await page.evaluate(() => (globalThis as any).journeyMessages)).toEqual([]);
  });
}
