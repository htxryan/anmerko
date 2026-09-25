import { test as base, expect, chromium } from '@playwright/test';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sidebar } from '../shared/chromium-sidebar';
import type { JourneyDraftStep, JourneyDraftV1, JourneySession } from '../../src/journey-core';

// What the recorder makes of common page behavior, in an unmodified copy of
// the production Chrome build recording through the toolbar's activeTab
// grant, as journey-real-extension.spec.ts does: routers that stamp
// history.state, single-page app forms submitted with Enter, and elements
// with unusual names.
const SHOP = 'https://shop.example';
const PAYLOAD_KEY = 'anmerko:journey-session:v1:payload';
const pageHtml = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:rgb(255,200,0);font:16px sans-serif}main{padding:24px;display:grid;gap:12px;justify-items:start}</style></head>
<body><main>${body}</main></body></html>`;
const shopHtml = pageHtml('Journey shop', `<h1>Shop</h1><output id="status">Ready</output>
<button id="stamp" type="button">Remember tab</button>
<svg width="240" height="48"><foreignObject width="240" height="48"><div><button id="node" type="button">Diagram node</button></div></foreignObject></svg>
<form id="spa" role="search"><input id="q" name="q" aria-label="Search"></form>
<form id="spa-button"><input id="q2" name="q" aria-label="Search again"> <button id="go" type="submit">Go</button></form>
<form id="get" action="/results"><input id="g" name="g" aria-label="Gift search"></form>
<button id="add" type="button">Add to cart</button>
<textarea id="note" aria-label="Gift note"></textarea>
<a id="app" href="/app?boot=0">Open app</a>
<script>
const status = document.querySelector('#status');
let stamps = 0;
// Apps commonly stamp history.state after a click without changing the URL.
document.querySelector('#stamp').addEventListener('click', () => {
  history.replaceState({ tab: Math.random() }, '');
  status.textContent = 'Remembered ' + ++stamps;
});
document.querySelector('#node').addEventListener('click', () => { status.textContent = 'Node opened'; });
document.querySelector('#add').addEventListener('click', () => { status.textContent = 'Added to cart'; });
// Single-page app searches: Enter submits, and the app routes instead of loading a page.
for (const form of document.querySelectorAll('#spa, #spa-button')) {
  form.addEventListener('submit', event => {
    event.preventDefault();
    const query = new FormData(form).get('q');
    history.pushState({}, '', '/search?q=' + encodeURIComponent(query));
    status.textContent = 'Results for ' + query;
  });
}
</script>`);
// React Router writes history.replaceState({ idx: 0 }) as each page loads.
const appHtml = pageHtml('Journey app', `<h1>App</h1><a id="next" href="/app?boot=150">Next app page</a>
<script>
const boot = () => history.replaceState({ idx: 0 }, '');
const delay = Number(new URLSearchParams(location.search).get('boot'));
if (delay) setTimeout(boot, delay); else boot();
</script>`);
const resultsHtml = pageHtml('Journey results', '<h1>Results</h1>');

async function launch() {
  const temp = await mkdtemp(path.join(tmpdir(), 'anmerko-journey-'));
  const extension = path.join(temp, 'extension');
  await cp('dist', extension, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  expect(manifest.host_permissions).toBeUndefined();
  // Reduced motion opens the side panel in one step instead of animating the
  // page narrower. A screenshot taken while the viewport changes is rejected.
  const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium', headless: true, viewport: null, ignoreDefaultArgs: ['--disable-extensions'],
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
    await context.route(`${SHOP}/**`, route => {
      const { pathname } = new URL(route.request().url());
      const body = pathname === '/app' ? appHtml : pathname === '/results' ? resultsHtml : shopHtml;
      return route.fulfill({ contentType: 'text/html', body });
    });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`${SHOP}/`);
    const worker = () => {
      const current = context.serviceWorkers().find(candidate => candidate.url() === background);
      if (!current) throw new Error('The extension service worker is not running.');
      return current;
    };
    // The journey the background persisted, read from its own storage.session.
    const state = async (): Promise<JourneySession | undefined> => {
      const stored = await worker().evaluate(key => chrome.storage.session.get(key), PAYLOAD_KEY);
      return (stored?.[PAYLOAD_KEY] as { state?: JourneySession } | undefined)?.state;
    };
    // Click anmerko in the toolbar: the activeTab grant and user gesture.
    const activate = async () => {
      await page.bringToFront();
      const fullWidth = await page.evaluate(() => innerWidth);
      const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
      const target = targetInfos.find(target => target.url === page.url() && target.embedderData?.tabActive)!;
      await cdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
      const dock = await sidebar(context, page);
      await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(fullWidth);
      return dock;
    };
    return { page, state, activate, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type Journey = Awaited<ReturnType<typeof launch>>;
type State = Journey['state'];
type Dock = Awaited<ReturnType<typeof sidebar>>;

// A fixture, so the browser and its temporary profile go even when a test times out.
const test = base.extend<{ journey: Journey }>({
  journey: async ({ browserName: _browserName }, use) => {
    const journey = await launch();
    try { await use(journey); } finally { await journey.close(); }
  },
});

const draftOf = (session: JourneySession | undefined): JourneyDraftV1 | undefined =>
  session && 'draft' in session ? session.draft : undefined;
const control = (id: string) => `[data-focus-id="${id}"]`;
const heading = (dock: Dock) => dock.evaluate("return root.querySelector('.journey-view h1')?.textContent");
const where = (url: string) => { const { pathname, search } = new URL(url); return `${pathname}${search}`; };

// A step as its kind, what it names, and its screenshot: a click's label, an
// entered value, a navigation's path and query with the step it names as its
// cause, if any.
function summarize(step: JourneyDraftStep, steps: JourneyDraftStep[]): string {
  const image = step.image.status === 'unavailable' ? `unavailable(${step.image.reason})` : step.image.status;
  if (step.kind === 'click') return `click ${step.target.label} ${image}`;
  if (step.kind === 'field-change') {
    return `field-change ${step.enteredValue.kind === 'text' ? step.enteredValue.value : step.enteredValue.kind} ${image}`;
  }
  if (step.kind === 'navigation') {
    const cause = steps.find(candidate => candidate.id === step.navigation.causedByStepId);
    const causedBy = cause ? ` caused by ${cause.kind === 'click' ? cause.target.label : cause.kind}` : '';
    return `navigation ${where(step.sourceUrl)} -> ${where(step.navigation.toUrl)}${causedBy} ${image}`;
  }
  return `${step.kind} ${image}`;
}

async function steps(state: State) {
  const draft = draftOf(await state());
  return draft?.steps.map(step => summarize(step, draft.steps)) ?? [];
}

// Once every screenshot has settled, whatever happened last.
async function settled(state: State) {
  const draft = draftOf(await state());
  return draft && !draft.steps.some(step => step.image.status === 'pending') ? summarize(draft.steps.at(-1)!, draft.steps) : undefined;
}

// Steps without how their screenshots settled, which depends on timing.
const outline = (described: string[]) => described.map(step => step.replace(/ (unavailable\(superseded\)|retained)$/, ''));

// More Comment Options → Record journey → Start journey, all in the side panel.
async function startJourney(dock: Dock, state: State, { enteredValues = false } = {}) {
  await expect.poll(() => dock.evaluate("return root.querySelector('.comment-options')?.disabled")).toBe(false);
  await dock.press('.comment-options');
  await expect.poll(() => dock.evaluate("return root.querySelector('#comment-menu').hidden")).toBe(false);
  // Record journey ignores untrusted clicks, so this is a real mouse click.
  await dock.press('.journey-record');
  await expect.poll(() => dock.evaluate(`return root.querySelector('${control('journey-start')}')?.disabled`)).toBe(false);
  if (enteredValues) {
    await dock.click(control('journey-include-values'));
    await expect.poll(() => dock.evaluate(`return root.querySelector('${control('journey-include-values')}')?.checked`)).toBe(true);
  }
  await dock.click(control('journey-start'));
  await expect.poll(async () => `${(await state())?.phase}: ${(await steps(state)).join(', ')}`).toBe('recording: initial retained');
  expect(draftOf(await state())?.includeEnteredValues).toBe(enteredValues);
  await expect.poll(() => heading(dock)).toBe('Recording journey');
}

async function stopJourney(dock: Dock, state: State) {
  await dock.click(control('journey-stop'));
  await expect.poll(async () => { const current = await state(); return current?.phase === 'reviewing' && current.draft.stopReason; }).toBe('user');
  await expect.poll(() => heading(dock)).toBe('Review journey');
}

test('a history update that keeps the URL adds no step, and a click inside SVG foreignObject records', async ({ journey }) => {
  const { page, state, activate } = journey;
  const dock = await activate();
  await startJourney(dock, state);

  // Each click stamps history.state with replaceState, which the browser
  // reports as a same-document navigation to the same URL.
  for (let stamp = 1; stamp <= 4; stamp += 1) {
    await page.locator('#stamp').click();
    await expect(page.locator('#status')).toHaveText(`Remembered ${stamp}`);
    await expect.poll(() => steps(state)).toEqual(['initial retained', ...Array(stamp).fill('click Remember tab retained')]);
  }

  // Mermaid draws node labels as HTML inside SVG foreignObject.
  await page.locator('#node').click();
  await expect.poll(() => settled(state)).toBe('click Diagram node retained');
  const node = draftOf(await state())!.steps.at(-1)!;
  expect(node.kind === 'click' && node.target.selectorPath)
    .toEqual(['html', 'body', 'main', 'svg', 'foreignobject', 'div', 'button']);
  await stopJourney(dock, state);
  expect(await steps(state)).toHaveLength(6);
});

test('a router stamping history.state as each page loads keeps the page load\'s step and screenshot', async ({ journey }) => {
  const { page, state, activate } = journey;
  const dock = await activate();
  await startJourney(dock, state);

  // The router stamps at once on the first page and 150 ms after loading the second.
  const load = async () => (await settled(state))?.replace(/ caused by [^/]+ (\w+)$/, ' $1');
  await page.locator('#app').click();
  await expect(page).toHaveURL(`${SHOP}/app?boot=0`);
  await expect.poll(load).toBe('navigation / -> /app?boot=0 retained');
  await page.locator('#next').click();
  await expect(page).toHaveURL(`${SHOP}/app?boot=150`);
  await expect.poll(load).toBe('navigation /app?boot=0 -> /app?boot=150 retained');
  await stopJourney(dock, state);
  // The link clicks, when their batches beat the page load, keep no
  // screenshot of their own: each page load's replaces it.
  expect((await steps(state)).filter(step => !step.startsWith('click ')).map(step => step.replace(/ caused by [^/]+ (\w+)$/, ' $1'))).toEqual([
    'initial retained',
    'navigation / -> /app?boot=0 retained',
    'navigation /app?boot=0 -> /app?boot=150 retained',
  ]);
});

test('with entered values on, a value is kept before the route change or page load that follows it', async ({ journey }) => {
  test.setTimeout(60_000);
  const { page, state, activate } = journey;
  const dock = await activate();
  await startJourney(dock, state, { enteredValues: true });

  // A search form without a submit button: Enter submits, and the app routes.
  await page.locator('#q').click();
  await page.locator('#q').fill('shoes');
  await page.locator('#q').press('Enter');
  await expect(page).toHaveURL(`${SHOP}/search?q=shoes`);
  await expect.poll(() => settled(state)).toBe('navigation / -> /search?q=shoes retained');
  await page.locator('#add').click();
  await expect.poll(() => settled(state)).toBe('click Add to cart retained');

  // A value finished before Back goes before the route change Back makes.
  await page.locator('#note').click();
  await page.locator('#note').fill('wrap it');
  await page.locator('#note').press('Tab');
  await page.goBack();
  await expect(page).toHaveURL(`${SHOP}/`);
  await expect.poll(() => settled(state)).toBe('navigation /search?q=shoes -> / retained');

  // So does one finished before the page changes its own route, as a timer
  // might: it is sent as the route changes, not only with the next click.
  await page.locator('#note').click();
  await page.locator('#note').fill('ribbon');
  await page.locator('#note').press('Tab');
  await page.evaluate(() => { setTimeout(() => history.pushState({}, '', '/gift'), 50); });
  await expect(page).toHaveURL(`${SHOP}/gift`);
  await expect.poll(() => settled(state)).toBe('navigation / -> /gift retained');
  expect(outline(await steps(state)).slice(-3)).toEqual(['click text field', 'field-change ribbon', 'navigation / -> /gift']);

  // The same with a form that loads a new page.
  await page.locator('#g').click();
  await page.locator('#g').fill('boots');
  await page.locator('#g').press('Enter');
  await expect(page).toHaveURL(`${SHOP}/results?g=boots`);
  await expect.poll(() => settled(state)).toBe('navigation /gift -> /results?g=boots retained');
  await stopJourney(dock, state);

  // Each value comes before the navigation it submitted, and neither
  // navigation is put down to the click that only focused the field.
  expect(outline(await steps(state))).toEqual([
    'initial',
    'click text field',
    'field-change shoes',
    'navigation / -> /search?q=shoes',
    'click Add to cart',
    'click text field',
    'field-change wrap it',
    'navigation /search?q=shoes -> /',
    'click text field',
    'field-change ribbon',
    'navigation / -> /gift',
    'click text field',
    'field-change boots',
    'navigation /gift -> /results?g=boots',
  ]);
});

test('with entered values off, a click into a text field never causes the route change Enter makes, and a submit button does', async ({ journey }) => {
  const { page, state, activate } = journey;
  const dock = await activate();
  await startJourney(dock, state);

  await page.locator('#q').click();
  await page.locator('#q').fill('shoes');
  await page.locator('#q').press('Enter');
  await expect(page).toHaveURL(`${SHOP}/search?q=shoes`);
  await expect.poll(() => settled(state)).toBe('navigation / -> /search?q=shoes retained');

  // Enter in a form with a submit button presses that button, and the button
  // caused the route change.
  await page.locator('#q2').click();
  await page.locator('#q2').fill('socks');
  await page.locator('#q2').press('Enter');
  await expect(page).toHaveURL(`${SHOP}/search?q=socks`);
  await expect.poll(() => settled(state)).toBe('navigation /search?q=shoes -> /search?q=socks caused by Go retained');
  await stopJourney(dock, state);
  expect(outline(await steps(state))).toEqual([
    'initial',
    'click text field',
    'navigation / -> /search?q=shoes',
    'click text field',
    'click Go',
    'navigation /search?q=shoes -> /search?q=socks caused by Go',
  ]);
  expect(JSON.stringify(draftOf(await state()))).not.toMatch(/"field-change"/);
});
