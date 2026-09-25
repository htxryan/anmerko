import { test as base, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sidebar } from '../shared/chromium-sidebar';
import { archiveEntries } from '../shared/expected-feedback';
import type { JourneyDraftStep, JourneyDraftV1, JourneySession } from '../../src/journey-core';
import { journeyArchiveName, journeyImageFilename } from '../../src/journey-export';

// The other journey specs drive src modules against a chrome mock. These load
// an unmodified copy of the production Chrome build, which has no host
// permissions: recording relies on the activeTab grant of a toolbar click.
const SHOP = 'https://shop.example';
const ELSEWHERE = 'https://elsewhere.example';
const SECRET = 'coupon-do-not-export-7431';
const shopHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Journey shop</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:rgb(255,200,0);font:16px sans-serif}main{padding:24px;display:grid;gap:12px;justify-items:start}</style></head>
<body><main><h1 id="title">Shop</h1>
<button id="add" type="button">Add to cart</button><output id="cart">Cart empty</output>
<label>Coupon code <input id="coupon" autocomplete="off"></label>
<a id="pricing" href="/pricing">Pricing</a>
<button id="annual" type="button">Annual plans</button>
<a id="leave" href="${ELSEWHERE}/">Partner site</a></main>
<script>
const title = document.querySelector('#title');
const route = () => { title.textContent = location.pathname; };
// Adding to the cart shows, so its screenshot differs from the initial view.
document.querySelector('#add').addEventListener('click', () => { document.querySelector('#cart').textContent = '1 item in cart'; });
// A single-page app route change: no document load.
document.querySelector('#annual').addEventListener('click', () => { history.pushState({}, '', '/pricing/annual'); route(); });
route();
</script></body></html>`;
const PAYLOAD_KEY = 'anmerko:journey-session:v1:payload';

async function launch() {
  const temp = await mkdtemp(path.join(tmpdir(), 'anmerko-journey-'));
  const extension = path.join(temp, 'extension');
  await cp('dist', extension, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.optional_host_permissions).toBeUndefined();
  expect(manifest.permissions).toEqual(expect.arrayContaining(['activeTab', 'alarms', 'webNavigation', 'sidePanel']));
  // Reduced motion opens the side panel in one step instead of animating the
  // page narrower. A screenshot taken while the viewport changes is rejected.
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
    await context.route(`${ELSEWHERE}/**`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Partner</title><h1>Partner site</h1>' }));
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
    // Every PNG the extension still holds: in extension storage (the journey
    // session and anything else), and in any IndexedDB database of its origin.
    const heldImages = () => worker().evaluate(async () => {
      const collect = (value: unknown, found: string[]): string[] => {
        if (typeof value === 'string' && value.startsWith('data:image/png')) found.push(value);
        else if (value && typeof value === 'object') for (const entry of Object.values(value)) collect(entry, found);
        return found;
      };
      const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const databases: string[] = [];
      for (const { name, version } of await indexedDB.databases()) {
        const database = await result(indexedDB.open(name!, version));
        for (const store of Array.from(database.objectStoreNames)) collect(await result(database.transaction(store).objectStore(store).getAll()), databases);
        database.close();
      }
      return { storage: collect([await chrome.storage.session.get(null), await chrome.storage.local.get(null)], []), databases };
    });
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
    return { temp, context, cdp, page, state, heldImages, activate, close };
  } catch (error) {
    await close();
    throw error;
  }
}

// A fixture, so the browser and its temporary profile go even when a test times out.
const test = base.extend<{ journey: Awaited<ReturnType<typeof launch>> }>({
  journey: async ({ browserName: _browserName }, use) => {
    const journey = await launch();
    try { await use(journey); } finally { await journey.close(); }
  },
});

type Dock = Awaited<ReturnType<typeof sidebar>>;
type Image = { width: number; height: number };
type Clip = Image & { x: number; y: number };
// Where a journey is reviewed: the side panel, or a journey tab when it began
// in the floating panel. Expressions see the view's container as `root`.
type Surface = { evaluate(expression: string): Promise<any>; capture(clip: Clip): Promise<Buffer> };
const sidePanel = (dock: Dock): Surface => ({
  evaluate: dock.evaluate,
  capture: async clip => Buffer.from((await dock.command('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } })).data, 'base64'),
});
async function journeyTab(context: BrowserContext, tab: Page): Promise<Surface> {
  const cdp = await context.newCDPSession(tab);
  return {
    evaluate: expression => tab.evaluate(`(() => { const root = document; ${expression} })()`),
    capture: async clip => Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } })).data, 'base64'),
  };
}
const draftOf = (session: JourneySession | undefined): JourneyDraftV1 | undefined =>
  session && 'draft' in session ? session.draft : undefined;
const heading = (view: Pick<Surface, 'evaluate'>) => view.evaluate("return root.querySelector('.journey-view h1')?.textContent");
const control = (id: string) => `[data-focus-id="${id}"]`;
// Enter a value in one task, so a re-render cannot drop part of it.
const type = (dock: Dock, selector: string, text: string) => dock.evaluate(`const field = root.querySelector('${selector}');
  field.focus(); field.value = ${JSON.stringify(text)}; field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));`);

// More Comment Options → Record journey → Start journey, all in the side panel.
async function startJourney(dock: Dock, state: () => Promise<JourneySession | undefined>) {
  await expect.poll(() => dock.evaluate("return root.querySelector('.comment-options')?.disabled")).toBe(false);
  await dock.press('.comment-options');
  await expect.poll(() => dock.evaluate("return root.querySelector('#comment-menu').hidden")).toBe(false);
  // Record journey ignores untrusted clicks, so this is a real mouse click.
  await dock.press('.journey-record');
  await expect.poll(() => dock.evaluate(`return root.querySelector('${control('journey-start')}')?.disabled`)).toBe(false);
  // The journey view re-renders as its state arrives. A synchronous click
  // cannot be split across a re-render the way a press and release can.
  await dock.click(control('journey-start'));
  await expect.poll(async () => {
    const current = await state();
    const error = await dock.evaluate("return root.querySelector('#journey-start-error')?.textContent");
    return `${current?.phase}: ${draftOf(current)?.steps.map(step => `${step.kind} ${step.image.status}`).join(', ')}${error ? ` (${error})` : ''}`;
  }).toBe('recording: initial retained');
  await expect.poll(() => heading(dock)).toBe('Recording journey');
}

async function lastStep(state: () => Promise<JourneySession | undefined>) {
  const step = draftOf(await state())?.steps.at(-1);
  return step && `${step.kind} ${step.kind === 'navigation' ? step.navigation.toUrl : step.sourceUrl} ${step.image.status}`;
}

const stepTitle = (step: JourneyDraftStep) => `Step ${step.seq} · ${step.kind === 'initial' ? 'Initial view'
  : step.kind === 'navigation' ? 'Navigation' : `${step.kind === 'click' ? 'Click' : 'Entered value'}: ${step.target.label}`}`;
const reviewTitles = (view: Pick<Surface, 'evaluate'>) => view.evaluate("return [...root.querySelectorAll('.journey-steps > li > h2')].map(title => title.textContent)");
const imageOf = (draft: JourneyDraftV1, step: JourneyDraftStep) => step.image.status === 'retained' ? draft.images[step.image.imageId] : undefined;
const png = (dataUrl: string) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
// Near the bottom-right corner, clear of the shop's content: its yellow background.
const corner = (image: Image): Array<[number, number]> => [[image.width - 20, image.height - 20]];

// Decode PNG pixels in the browser, independently of the extension, and name
// each sampled colour: the shop's yellow background or the opaque black mask.
async function colors(page: Page, image: Buffer, points: Array<[number, number]>) {
  const decoded = await page.evaluate(async ({ base64, points }) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    return { width: bitmap.width, height: bitmap.height, samples: points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data)) };
  }, { base64: image.toString('base64'), points });
  const near = (actual: number[], expected: number[]) => expected.every((value, index) => Math.abs(actual[index] - value) <= 3);
  return {
    width: decoded.width, height: decoded.height,
    colors: decoded.samples.map(sample => near(sample, [255, 200, 0, 255]) ? 'yellow' : near(sample, [0, 0, 0, 255]) ? 'black' : `rgba(${sample})`),
  };
}

// What the review shows as a step's screenshot, taken from its own rendering
// rather than the stored image. Points are in the image's pixels; null means
// the step shows no screenshot.
async function shown(view: Surface, page: Page, step: JourneyDraftStep, image?: Image, points = image ? corner(image) : []) {
  // Clip coordinates are relative to the document, not the viewport.
  const box: Clip | null = await view.evaluate(`const preview = root.querySelector('${control(`step-${step.id}`)}')?.closest('li')?.querySelector('anmerko-image.journey-image');
    if (!preview) return null;
    preview.scrollIntoView({ block: 'center', behavior: 'instant' });
    const { left, top } = preview.getBoundingClientRect();
    return { x: left + preview.clientLeft + scrollX, y: top + preview.clientTop + scrollY, width: preview.clientWidth, height: preview.clientHeight };`);
  if (!box) return null;
  const scaled = points.map(([x, y]): [number, number] => [Math.round(x * box.width / image!.width), Math.round(y * box.height / image!.height)]);
  return (await colors(page, await view.capture(box), scaled)).colors;
}

// Every kept screenshot is of the shop, both stored and as the review shows
// it, and a step without one shows none.
async function expectShopScreenshots(view: Surface, page: Page, draft: JourneyDraftV1) {
  for (const step of draft.steps) {
    const image = imageOf(draft, step);
    if (image) expect(await colors(page, png(image.dataUrl!), corner(image))).toEqual({ width: image.width, height: image.height, colors: ['yellow'] });
    await expect.poll(() => shown(view, page, step, image)).toEqual(image ? ['yellow'] : null);
  }
}

// The PNG that journeys.md names for each step, by step ID.
const screenshotNames = (journeysMd: string) => new Map(journeysMd.split(/^### Step /m).slice(1).flatMap(section => {
  const id = section.match(/^Step ID: `([^`]+)`$/m)?.[1];
  const name = section.match(/^Screenshot: `([^`]+\.png)`$/m)?.[1];
  return id && name ? [[id, name] as const] : [];
}));

test('the native side panel records, masks, saves and exports a same-origin journey', async ({ journey }) => {
  test.setTimeout(60_000);
  const { temp, context, cdp, page, state, heldImages, activate } = journey;
  const dock = await activate();
  await startJourney(dock, state);

  // A click, a same-origin page load, and a single-page app route change.
  await page.locator('#add').click();
  await expect.poll(() => lastStep(state)).toBe(`click ${SHOP}/ retained`);
  // Typed without a click while entered values are off: never recorded.
  await page.locator('#coupon').fill(SECRET);
  await page.locator('#pricing').click();
  await expect.poll(() => lastStep(state)).toBe(`navigation ${SHOP}/pricing retained`);
  await page.locator('#annual').click();
  await expect(page.locator('#title')).toHaveText('/pricing/annual');
  await expect.poll(() => lastStep(state)).toBe(`navigation ${SHOP}/pricing/annual retained`);
  await dock.click(control('journey-stop'));
  await expect.poll(async () => { const current = await state(); return current?.phase === 'reviewing' && current.draft.stopReason; }).toBe('user');

  // The side panel lists every step in order, each with its screenshot. A
  // link or route click can be superseded by its navigation's screenshot.
  const draft = draftOf(await state())!;
  expect(JSON.stringify(draft)).not.toContain(SECRET);
  const review = sidePanel(dock);
  await expect.poll(() => heading(review)).toBe('Review journey');
  const titles = await reviewTitles(review);
  expect(titles).toEqual(draft.steps.map(stepTitle));
  expect(titles.join('\n')).toMatch(/^Step 1 · Initial view\nStep 2 · Click: Add to cart\n(Step 3 · Click: Pricing\n)?Step \d · Navigation\n(Step \d · Click: Annual plans\n)?Step \d · Navigation$/);
  expect(draft.steps.flatMap(step => step.kind === 'navigation' ? [[step.sourceUrl, step.navigation.toUrl]] : [])).toEqual([
    [`${SHOP}/`, `${SHOP}/pricing`], [`${SHOP}/pricing`, `${SHOP}/pricing/annual`],
  ]);
  const essential = draft.steps.filter(step => step.kind !== 'click' || step.target.label === 'Add to cart');
  expect(essential.map(step => `${step.kind} ${step.image.status}`)).toEqual(['initial retained', 'click retained', 'navigation retained', 'navigation retained']);
  const retained = draft.steps.filter(step => step.image.status === 'retained');
  await expectShopScreenshots(review, page, draft);

  // Mask part of the click's screenshot in the review.
  const click = essential[1];
  const original = imageOf(draft, click)!;
  // No other step has these pixels, so any copy found later is the original.
  expect(retained.some(step => step !== click && imageOf(draft, step)!.dataUrl === original.dataUrl)).toBe(false);
  const mask = { x: original.width - 220, y: original.height - 160, width: 120, height: 90 };
  const inside: [number, number] = [mask.x + mask.width / 2, mask.y + mask.height / 2];
  const outside: [number, number] = [mask.x - 20, mask.y + mask.height / 2];
  expect(await colors(page, png(original.dataUrl!), [inside, outside])).toMatchObject({ colors: ['yellow', 'yellow'] });
  const dialog = 'dialog.journey-image-review[open]';
  await dock.click(control(`mask-image-${click.id}`));
  await expect.poll(() => dock.evaluate(`return !!root.querySelector('${dialog}')`)).toBe(true);
  for (const [label, value] of Object.entries({ X: mask.x, Y: mask.y, Width: mask.width, Height: mask.height })) {
    await type(dock, `${dialog} input[aria-label="${label}"]`, String(value));
  }
  const apply = `${dialog} .journey-image-review__button--primary`;
  await expect.poll(() => dock.evaluate(`return root.querySelector('${apply}').disabled`)).toBe(false);
  await dock.click(apply);
  await expect.poll(async () => imageOf(draftOf(await state())!, click)?.redacted).toBe(true);
  await expect.poll(() => dock.evaluate(`return !!root.querySelector('#journey-image-masked-${click.id}')`)).toBe(true);
  await expect.poll(() => shown(review, page, click, original, [inside, outside])).toEqual(['black', 'yellow']);

  // Summaries, acknowledgement and Save.
  await type(dock, '#journey-expected', 'The annual plan is in the cart.');
  await type(dock, '#journey-actual', 'The cart is empty.');
  await dock.click(control('journey-ack'));
  await expect.poll(() => dock.evaluate(`return root.querySelector('${control('journey-save')}')?.disabled`)).toBe(false);
  await dock.click(control('journey-save'));
  await expect.poll(async () => (await state())?.phase).toBe('saved');
  await expect.poll(() => heading(dock)).toBe('Journey saved');

  // Copy Prompt from the side panel.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SHOP });
  await page.evaluate(() => navigator.clipboard.writeText(''));
  // Writing the clipboard needs the side panel focused, as clicking it does.
  await dock.press('.journey-view h1');
  await dock.click(control('journey-copy'));
  let prompt = '';
  await expect.poll(async () => prompt = (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n')).not.toBe('');
  expect(prompt).toContain(draft.id);
  expect(prompt).toContain('journeys.md');
  expect(prompt).toContain('The annual plan is in the cart.');
  expect(prompt).toContain('The cart is empty.');
  expect(prompt).not.toContain(SECRET);

  // Download Markdown + Images from the side panel.
  const downloads = path.join(temp, 'downloads');
  await mkdir(downloads);
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: downloads, eventsEnabled: true });
  let filename = '';
  const downloaded = new Promise<string>((resolve, reject) => {
    cdp.on('Browser.downloadWillBegin', event => { filename = event.suggestedFilename; });
    cdp.on('Browser.downloadProgress', event => {
      if (event.state === 'completed') resolve(event.guid);
      if (event.state === 'canceled') reject(new Error('The journey download was canceled.'));
    });
  });
  await dock.click(control('journey-download'));
  const files = archiveEntries(await readFile(path.join(downloads, await downloaded)));
  // The archive is named for the journey, not as a comments export.
  expect(filename).toMatch(/^anmerko-journey-[\w.~-]{1,8}\.zip$/);
  expect(filename).toBe(journeyArchiveName(draft.id));
  // journeys.md, prompt.md (the copied prompt), and the PNGs journeys.md names.
  const journeysMd = files.get('journeys.md')!.toString('utf8');
  const names = screenshotNames(journeysMd);
  const pngs = new Set(names.values());
  expect([...names.keys()].sort()).toEqual(retained.map(step => step.id).sort());
  const documents = [...files.keys()].filter(name => !pngs.has(name));
  expect(documents.sort()).toEqual(['journeys.md', 'prompt.md']);
  expect(files.get('prompt.md')!.toString('utf8')).toContain(prompt.trim());
  expect(files.size).toBe(documents.length + pngs.size);
  // Each screenshot is named for the journey and the first step that kept it,
  // as the prompt and journeys.md number the steps.
  for (const step of retained) {
    const first = retained.find(candidate => candidate.image.status === 'retained' && step.image.status === 'retained'
      && candidate.image.imageId === step.image.imageId)!;
    expect(names.get(step.id)).toBe(journeyImageFilename(draft.id, first.seq));
    expect(prompt).toContain(names.get(step.id)!);
  }
  expect(journeysMd).toContain(`${SHOP}/pricing/annual`);
  expect(journeysMd).toContain('Add to cart');
  expect(journeysMd).not.toContain(SECRET);

  // Saved and exported screenshots are the captures, except the masked one,
  // which now covers its region with opaque black. Nothing keeps the original.
  for (const step of retained) {
    expect(files.get(names.get(step.id)!)!.equals(png(imageOf(draft, step)!.dataUrl!))).toBe(step !== click);
  }
  const masked = files.get(names.get(click.id)!)!;
  expect(await colors(page, masked, [inside, outside])).toEqual({ width: original.width, height: original.height, colors: ['black', 'yellow'] });
  // The saved journey holds exactly the exported screenshots.
  const held = await heldImages();
  const base64 = (images: Buffer[]) => images.map(image => image.toString('base64')).sort();
  expect(base64(held.databases.map(png))).toEqual(base64([...pngs].map(name => files.get(name)!)));
  expect(base64([...held.databases, ...held.storage].map(png))).not.toContain(png(original.dataUrl!).toString('base64'));
});

test('leaving the starting website ends the journey as left-site and keeps earlier steps', async ({ journey }) => {
  const { page, state, activate } = journey;
  const dock = await activate();
  await startJourney(dock, state);
  await page.locator('#add').click();
  await expect.poll(() => lastStep(state)).toBe(`click ${SHOP}/ retained`);
  await page.locator('#leave').click();
  await expect(page).toHaveURL(`${ELSEWHERE}/`);
  await expect.poll(async () => { const current = await state(); return current?.phase === 'reviewing' && current.draft.stopReason; }).toBe('left-site');

  // Nothing from the other website is recorded; the earlier steps and their
  // screenshots of the shop stay for review in the side panel.
  const draft = draftOf(await state())!;
  expect(draft.steps.every(step => step.sourceUrl.startsWith(`${SHOP}/`) && step.kind !== 'navigation')).toBe(true);
  expect(draft.steps.slice(0, 2).map(step => `${step.kind} ${step.image.status}`)).toEqual(['initial retained', 'click retained']);
  const review = sidePanel(dock);
  await expect.poll(() => heading(review)).toBe('Review journey');
  expect(await review.evaluate("return root.querySelector('.journey-stop-reason')?.textContent")).toMatch(/^Recording ended because the page left the website you started on\./);
  const titles = await reviewTitles(review);
  expect(titles).toEqual(draft.steps.map(stepTitle));
  expect(titles.slice(0, 2)).toEqual(['Step 1 · Initial view', 'Step 2 · Click: Add to cart']);
  await expectShopScreenshots(review, page, draft);
});

// The floating panel lives in the page and goes with it, so after a page load
// only the observer the background injects keeps the journey recording.
test('a floating panel journey records past a page load and is reviewed in a journey tab', async ({ journey }) => {
  const { context, page, state, activate } = journey;
  const dock = await activate();
  await dock.click('.dock');
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'More Comment Options' }).click();
  const opened = context.waitForEvent('page', { predicate: tab => tab.url().includes('/journey.html#launch='), timeout: 5_000 });
  await panel.getByRole('menuitem', { name: 'Record journey' }).click();
  // Record journey opens a journey tab, which starts the journey.
  const tab = await opened;
  await tab.locator(control('journey-start')).click();
  await expect.poll(async () => {
    const current = await state();
    return `${current?.phase}: ${draftOf(current)?.steps.map(step => `${step.kind} ${step.image.status}`).join(', ')}`;
  }).toBe('recording: initial retained');
  const strip = page.locator('anmerko-journey-strip');
  await expect(strip).toBeVisible();
  await page.locator('#add').click();
  await expect.poll(() => lastStep(state)).toBe(`click ${SHOP}/ retained`);
  await page.locator('#pricing').click();
  await expect.poll(() => lastStep(state)).toBe(`navigation ${SHOP}/pricing retained`);
  // The new document records clicks and shows the recording strip again.
  await expect(strip).toBeVisible();
  await page.locator('#add').click();
  await expect.poll(() => lastStep(state)).toBe(`click ${SHOP}/pricing retained`);
  // The website tab records in front; the journey tab waits behind it.
  const tabActive = () => tab.evaluate(async () => (await chrome.tabs.getCurrent())?.active);
  expect(await tabActive()).toBe(false);
  // Stop is the strip's last control, inside a closed shadow root.
  const box = (await strip.boundingBox())!;
  await page.mouse.click(box.x + box.width - 30, box.y + box.height / 2);
  await expect.poll(async () => { const current = await state(); return current?.phase === 'reviewing' && current.draft.stopReason; }).toBe('user');
  // No side panel shows this journey, so its end brings the journey tab forward as the review.
  await expect.poll(tabActive).toBe(true);

  // The journey tab reviews every step with its screenshot.
  const draft = draftOf(await state())!;
  const review = await journeyTab(context, tab);
  await expect.poll(() => heading(review)).toBe('Review journey');
  const titles = await reviewTitles(review);
  expect(titles).toEqual(draft.steps.map(stepTitle));
  expect(titles.join('\n')).toMatch(/^Step 1 · Initial view\nStep 2 · Click: Add to cart\n(Step 3 · Click: Pricing\n)?Step \d · Navigation\nStep \d · Click: Add to cart$/);
  expect(draft.steps.at(-1)?.sourceUrl).toBe(`${SHOP}/pricing`);
  await expectShopScreenshots(review, page, draft);
});

// A floating panel reviews in a journey tab. Each later Record journey reuses
// that tab once its journey is discarded or saved, so journeys never leave a
// trail of tabs behind (as they did on Android, one per journey).
test('each Record journey from a floating panel reuses the journey tab of the last one', async ({ journey }) => {
  test.setTimeout(60_000);
  const { context, page, state, activate } = journey;
  const dock = await activate();
  await dock.click('.dock');
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  await expect(panel).toBeVisible();
  const journeyTabs = () => context.pages().filter(tab => tab.url().includes('/journey.html'));
  // An idle journey leaves nothing in session storage.
  const phase = async () => (await state())?.phase ?? 'idle';
  const recordJourney = async () => {
    await page.bringToFront();
    await expect(panel).toBeVisible();
    await panel.getByRole('button', { name: 'More Comment Options' }).click();
    await panel.getByRole('menuitem', { name: 'Record journey', exact: true }).click();
  };
  // Start in the journey tab, click once on the website, then return to the
  // journey tab, which stops the recording for review there.
  const recordIn = async (tab: Page) => {
    await expect(tab.locator(control('journey-start'))).toBeEnabled();
    await tab.locator(control('journey-start')).click();
    await expect.poll(phase).toBe('recording');
    await page.locator('#add').click();
    await expect.poll(() => lastStep(state)).toBe(`click ${SHOP}/ retained`);
    await tab.bringToFront();
    await expect.poll(async () => { const current = await state(); return current?.phase === 'reviewing' && current.draft.stopReason; }).toBe('user');
    const review = await journeyTab(context, tab);
    await expect.poll(() => heading(review)).toBe('Review journey');
  };

  const opened = context.waitForEvent('page', { predicate: tab => tab.url().includes('/journey.html#launch='), timeout: 5_000 });
  await recordJourney();
  const tab = await opened;
  const firstLink = tab.url();
  await recordIn(tab);
  // Discard it in the journey tab.
  await tab.locator(control('journey-discard')).click();
  await tab.locator(control('journey-confirm-discard')).click();
  await expect.poll(phase).toBe('idle');

  // No new tab opens: the journey tab takes a fresh link and offers Start.
  let extraTabs = 0;
  context.on('page', () => { extraTabs += 1; });
  await recordJourney();
  await expect.poll(() => tab.url()).not.toBe(firstLink);
  expect(tab.url()).toMatch(/\/journey\.html#launch=[\w-]+$/);
  const secondLink = tab.url();
  await expect.poll(() => tab.evaluate(async () => (await chrome.tabs.getCurrent())?.active)).toBe(true);
  await recordIn(tab);
  // Save it there; the saved confirmation stays until the next Record journey.
  await tab.locator('#journey-expected').fill('The cart shows one item.');
  await tab.locator('#journey-actual').fill('The cart shows one item.');
  await tab.locator(control('journey-ack')).check();
  await expect(tab.locator(control('journey-save'))).toBeEnabled({ timeout: 10_000 });
  await tab.locator(control('journey-save')).click();
  await expect.poll(phase).toBe('saved');
  await expect(tab.getByRole('heading', { name: 'Journey saved' })).toBeVisible();

  await recordJourney();
  await expect.poll(() => tab.url()).not.toBe(secondLink);
  expect(tab.url()).toMatch(/\/journey\.html#launch=[\w-]+$/);
  await expect(tab.locator(control('journey-start'))).toBeEnabled();
  await expect.poll(phase).toBe('idle');
  expect(extraTabs).toBe(0);
  expect(journeyTabs()).toHaveLength(1);
  expect(journeyTabs()[0]).toBe(tab);
});
