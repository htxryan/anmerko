import { test as base, expect, chromium, type BrowserContext, type CDPSession, type Page } from '@playwright/test';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sidebar } from '../shared/chromium-sidebar';
import type { JourneySession } from '../../src/journey-core';

// Background lifecycle against an unmodified copy of the production Chrome
// build: a worker that stops while nothing keeps it awake, as Chrome stops an
// idle worker after about 30 seconds. Recording relies on the activeTab grant
// of a toolbar click, as in journey-real-extension.spec.ts.
const SHOP = 'https://shop.example';
const shopHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Journey shop</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:rgb(255,200,0);font:16px sans-serif}main{padding:24px;display:grid;gap:12px;justify-items:start}</style></head>
<body><main><h1>Shop</h1><button id="add" type="button">Add to cart</button><output id="cart">Cart empty</output></main>
<script>document.querySelector('#add').addEventListener('click', () => { document.querySelector('#cart').textContent = '1 item in cart'; });</script>
</body></html>`;
const CONTROL_KEY = 'anmerko:journey-session:v1:control';
const PAYLOAD_KEY = 'anmerko:journey-session:v1:payload';
const control = (id: string) => `[data-focus-id="${id}"]`;

async function launch() {
  const temp = await mkdtemp(path.join(tmpdir(), 'anmerko-journey-'));
  const extension = path.join(temp, 'extension');
  await cp('dist', extension, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  expect(manifest.host_permissions).toBeUndefined();
  const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium', headless: !process.env.HEADED, viewport: null, ignoreDefaultArgs: ['--disable-extensions'],
    args: ['--enable-unsafe-extension-debugging', '--window-size=1280,900', '--force-prefers-reduced-motion'],
  });
  const close = async () => { await context.close(); await rm(temp, { recursive: true, force: true }); };
  try {
    const cdp = await context.browser()!.newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
    const background = `chrome-extension://${id}/background.js`;
    const first = context.serviceWorkers().find(worker => worker.url() === background)
      || await context.waitForEvent('serviceworker', { predicate: worker => worker.url() === background });
    // Chrome drops a toolbar click that arrives before the new worker registers onClicked.
    await expect.poll(() => first.evaluate(() => chrome.action.onClicked.hasListeners())).toBe(true);
    await context.route(`${SHOP}/**`, route => route.fulfill({ contentType: 'text/html', body: shopHtml }));
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${SHOP}/`);
    // The worker running now, which a stop replaces with a new one.
    const worker = async () => {
      const current = context.serviceWorkers().find(candidate => candidate.url() === background)
        ?? await context.waitForEvent('serviceworker', { predicate: candidate => candidate.url() === background });
      return current;
    };
    // The journey the background persisted, read from its own storage.session.
    const state = async (): Promise<JourneySession | undefined> => {
      const stored = await (await worker()).evaluate(key => chrome.storage.session.get(key), PAYLOAD_KEY);
      return (stored?.[PAYLOAD_KEY] as { state?: JourneySession } | undefined)?.state;
    };
    // Click anmerko in the toolbar: the activeTab grant and user gesture.
    const activate = async () => {
      await page.bringToFront();
      const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
      const target = targetInfos.find(target => target.url === page.url() && target.embedderData?.tabActive)!;
      await cdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
      return sidebar(context, page);
    };
    // Stops the worker as Chrome does once it idles, observed from one of the
    // extension's own pages, and waits until it has stopped.
    const stopWorker = async (extensionPage: Page) => {
      const session: CDPSession = await context.newCDPSession(extensionPage);
      let status = 'unknown';
      session.on('ServiceWorker.workerVersionUpdated', ({ versions }) => {
        for (const version of versions) if (version.scriptURL === background) status = version.runningStatus;
      });
      await session.send('ServiceWorker.enable');
      await expect.poll(() => status).toBe('running');
      await session.send('ServiceWorker.stopAllWorkers');
      await expect.poll(() => status).toBe('stopped');
      return { status: () => status, detach: () => session.detach() };
    };
    return { context, page, worker, state, activate, stopWorker, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type Journey = Awaited<ReturnType<typeof launch>>;

const test = base.extend<{ journey: Journey }>({
  journey: async ({ browserName: _browserName }, use) => {
    const journey = await launch();
    try { await use(journey); } finally { await journey.close(); }
  },
});

// The floating panel's Record journey opens a journey tab, whose Start is the
// only way to start a journey there and on Android.
async function recordJourney(journey: Journey, context: BrowserContext) {
  const { page } = journey;
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await page.bringToFront();
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'More Comment Options' }).click();
  const opened = context.waitForEvent('page', { predicate: tab => tab.url().includes('/journey.html#launch='), timeout: 5_000 });
  await panel.getByRole('menuitem', { name: 'Record journey', exact: true }).click();
  return opened;
}

async function floatPanel(journey: Journey) {
  const dock = await journey.activate();
  await dock.click('.dock');
  await expect(journey.page.getByRole('complementary', { name: 'anmerko feedback panel' })).toBeVisible();
}

const recordingSummary = async (journey: Journey) => {
  const current = await journey.state();
  const steps = current && 'draft' in current ? current.draft.steps.map(step => `${step.kind} ${step.image.status}`).join(', ') : '';
  return `${current?.phase ?? 'idle'}: ${steps}`;
};

test('a journey tab still starts its journey after the idle worker stopped', async ({ journey }) => {
  const { context } = journey;
  await floatPanel(journey);
  const tab = await recordJourney(journey, context);
  await expect(tab.locator(control('journey-start'))).toBeEnabled();
  // The journey tab keeps nothing awake while the reader reads it.
  const stopped = await journey.stopWorker(tab);
  await tab.locator(control('journey-start')).click();
  await expect.poll(() => recordingSummary(journey)).toBe('recording: initial retained');
  await expect(tab.getByRole('heading', { name: 'Recording journey' })).toBeVisible();
  await expect(tab.getByText('This journey link already opened')).toHaveCount(0);
  await stopped.detach();
});

test('a recording whose deadline passes while the worker is stopped ends on waking like a live stop', async ({ journey }) => {
  const { context, page } = journey;
  await floatPanel(journey);
  const tab = await recordJourney(journey, context);
  await tab.locator(control('journey-start')).click();
  await expect.poll(() => recordingSummary(journey)).toBe('recording: initial retained');
  await page.locator('#add').click();
  await expect.poll(() => recordingSummary(journey)).toBe('recording: initial retained, click retained');
  const recording = await journey.state();
  if (recording?.phase !== 'recording') throw new Error('The journey is not recording.');
  const toolbar = async () => (await journey.worker()).evaluate(async tabId => [
    await chrome.action.getBadgeText({ tabId }), await chrome.action.getTitle({ tabId }),
  ], recording.ownerTabId);
  expect(await toolbar()).toEqual(['REC', 'Stop journey recording']);
  expect(await tab.evaluate(async () => (await chrome.tabs.getCurrent())?.active)).toBe(false);

  // Its deadline passes while the worker is stopped: stored as one second
  // after it started, which is already over.
  await (await journey.worker()).evaluate(async ({ controlKey, payloadKey, deadlineAt }) => {
    const stored = await chrome.storage.session.get([controlKey, payloadKey]);
    const payload = stored[payloadKey] as { state: { deadlineAt: string } };
    const committed = stored[controlKey] as { lifecycleAt: string };
    payload.state.deadlineAt = deadlineAt;
    committed.lifecycleAt = deadlineAt;
    await chrome.storage.session.set({ [payloadKey]: payload });
    await chrome.storage.session.set({ [controlKey]: committed });
  }, { controlKey: CONTROL_KEY, payloadKey: PAYLOAD_KEY, deadlineAt: new Date(Date.parse(recording.draft.startedAt) + 1_000).toISOString() });
  const stopped = await journey.stopWorker(tab);
  // Any event wakes it: here, the journey tab asking for the phase.
  await tab.evaluate(() => chrome.runtime.sendMessage({ type: 'ANMERKO_JOURNEY_PHASE' }));
  await expect.poll(async () => {
    const current = await journey.state();
    return current?.phase === 'reviewing' && current.draft.stopReason;
  }).toBe('duration-limit');
  // The owner tab loses its recording badge, and the journey tab comes forward for review.
  await expect.poll(toolbar).toEqual(['', 'Annotate with anmerko']);
  await expect.poll(() => tab.evaluate(async () => (await chrome.tabs.getCurrent())?.active)).toBe(true);
  await expect(tab.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await expect(page.locator('anmerko-journey-strip')).toBeHidden();
  await stopped.detach();
});

// Record journey gives the spent journey tab a new link, which adds a history
// entry: Back reloads the old link, which no longer offers Start.
test('Back to a replaced launch link in a reused journey tab offers no Start', async ({ journey }) => {
  const { context, page } = journey;
  await floatPanel(journey);
  const tab = await recordJourney(journey, context);
  const firstLink = tab.url();
  // Discard a journey that never started: Record journey again replaces the link in the same tab.
  await page.bringToFront();
  await page.reload();
  await floatPanel(journey);
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await panel.getByRole('button', { name: 'More Comment Options' }).click();
  await panel.getByRole('menuitem', { name: 'Record journey', exact: true }).click();
  await expect.poll(() => tab.url()).not.toBe(firstLink);
  const secondLink = tab.url();
  await expect(tab.locator(control('journey-start'))).toBeEnabled();

  await tab.goBack();
  await expect.poll(() => tab.url()).toBe(firstLink);
  await expect(tab.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  await expect(tab.getByText(/^To record a new journey, go to the website tab/)).toBeVisible();
  await expect(tab.locator(control('journey-start'))).toHaveCount(0);

  await tab.goForward();
  await expect.poll(() => tab.url()).toBe(secondLink);
  await expect(tab.locator(control('journey-start'))).toBeEnabled();
  await tab.locator(control('journey-start')).click();
  await expect.poll(() => recordingSummary(journey)).toBe('recording: initial retained');
});

// The native side panel's Record journey after a save opens a new journey, as
// the floating panel's does, instead of the old journey's confirmation.
test('Record journey in the side panel after a save starts a new journey', async ({ journey }) => {
  const dock = await journey.activate();
  const heading = () => dock.evaluate("return root.querySelector('.journey-view h1')?.textContent");
  const type = (selector: string, text: string) => dock.evaluate(`const field = root.querySelector('${selector}');
    field.focus(); field.value = ${JSON.stringify(text)}; field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));`);
  const enabled = (id: string) => expect.poll(() => dock.evaluate(`return root.querySelector('${control(id)}')?.disabled`)).toBe(false);
  const recordJourney = async () => {
    await expect.poll(() => dock.evaluate("return root.querySelector('.comment-options')?.disabled")).toBe(false);
    await dock.press('.comment-options');
    await expect.poll(() => dock.evaluate("return root.querySelector('#comment-menu').hidden")).toBe(false);
    // Record journey ignores untrusted clicks, so this is a real mouse click.
    await dock.press('.journey-record');
  };
  await recordJourney();
  await enabled('journey-start');
  await dock.click(control('journey-start'));
  await expect.poll(() => recordingSummary(journey)).toBe('recording: initial retained');
  await dock.click(control('journey-stop'));
  await expect.poll(() => heading()).toBe('Review journey');
  await type('#journey-expected', 'The cart keeps its item.');
  await type('#journey-actual', 'The cart is empty.');
  await dock.click(control('journey-ack'));
  await enabled('journey-save');
  await dock.click(control('journey-save'));
  await expect.poll(async () => (await journey.state())?.phase).toBe('saved');
  await expect.poll(() => heading()).toBe('Journey saved');

  await dock.click('.journey-return');
  await recordJourney();
  await expect.poll(() => heading()).toBe('Record a journey');
  await enabled('journey-start');
  // The confirmation closed; the journey stays saved.
  expect((await journey.state())?.phase ?? 'idle').toBe('idle');
  expect(await dock.evaluate("return root.querySelectorAll('.saved-journey').length")).toBe(1);
});
