import { test as base, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
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
// Recorded, then taken out in review: none may reach a saved or exported copy.
const VALUE_SECRET = 'value-edited-away-5286';
const LABEL_SECRET = 'label-redacted-away-3094';
const REMOVED_SECRET = 'step-removed-away-8817';
const URL_SECRET = 'url-redacted-away-6620';
const EDITED_VALUE = 'SPRING-10';
const shopHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Journey shop</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:rgb(255,200,0);font:16px sans-serif}main{padding:24px;display:grid;gap:12px;justify-items:start}</style></head>
<body><main><h1 id="title">Shop</h1>
<button id="add" type="button">Add to cart</button><output id="cart">Cart empty</output>
<label>Coupon code <input id="coupon" autocomplete="off"></label>
<a id="pricing" href="/pricing">Pricing</a>
<button id="annual" type="button">Annual plans</button>
<button id="suggest" type="button">Show ${LABEL_SECRET}</button>
<button id="wrap" type="button">Gift wrap ${REMOVED_SECRET}</button>
<button id="orders" type="button">Orders</button>
<a id="leave" href="${ELSEWHERE}/">Partner site</a></main>
<script>
const title = document.querySelector('#title');
const cart = document.querySelector('#cart');
const route = () => { title.textContent = location.pathname; };
// Each click changes what shows, so every click's screenshot differs.
document.querySelector('#add').addEventListener('click', () => { cart.textContent = '1 item in cart'; });
document.querySelector('#suggest').addEventListener('click', () => { cart.textContent = 'Suggestion shown'; });
document.querySelector('#wrap').addEventListener('click', () => { cart.textContent = 'Gift wrap added'; });
// Single-page app route changes: no document load.
document.querySelector('#annual').addEventListener('click', () => { history.pushState({}, '', '/pricing/annual'); route(); });
document.querySelector('#orders').addEventListener('click', () => { history.pushState({}, '', '/orders/${URL_SECRET}'); route(); });
route();
</script></body></html>`;
// The partner site is blue throughout, so a capture of it is never taken for the shop's yellow.
const partnerHtml = `<!doctype html><title>Partner</title>
<style>html,body{margin:0;height:100%;background:rgb(0,90,200)}</style><h1>Partner site</h1>`;
const PAYLOAD_KEY = 'anmerko:journey-session:v1:payload';

// Where a PNG was found in the extension's storage, and its bytes as base64.
type HeldImage = { where: string; base64: string };
// A saved journey as the journey store holds it: the snapshot record, and the
// screenshots stored beside it as data URLs by image ID.
type SavedJourney = { record?: { draft: JourneyDraftV1; blobIds: string[] }; images: Record<string, string> };

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
    await context.route(`${ELSEWHERE}/**`, route => route.fulfill({ contentType: 'text/html', body: partnerHtml }));
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
    // Everything the extension keeps, walked value by value: chrome.storage
    // (session, local and sync) and every IndexedDB database of its origin,
    // keys included. Strings, Blobs and buffers are all searched, so a copy
    // hides neither as a data URL, bare base64 nor bytes. Returns where each
    // needle occurs, and every PNG found.
    const held = (needles: string[] = []) => worker().evaluate(async needles => {
      const found: Array<{ needle: string; where: string }> = [];
      const images: HeldImage[] = [];
      const signature = [137, 80, 78, 71, 13, 10, 26, 10];
      const base64 = (bytes: Uint8Array) => {
        let binary = '';
        for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
        return btoa(binary);
      };
      const text = (value: string, where: string) => {
        for (const needle of needles) if (value.includes(needle)) found.push({ needle, where });
        // A PNG's base64 begins with its signature, with or without a data URL prefix.
        for (let at = value.indexOf('iVBORw0KGgo'); at >= 0; at = value.indexOf('iVBORw0KGgo', at + 1)) {
          images.push({ where, base64: /^[A-Za-z0-9+/]+=*/.exec(value.slice(at))![0] });
        }
      };
      const bytes = (value: Uint8Array, where: string) => {
        text(new TextDecoder().decode(value), where);
        for (let at = 0; at + signature.length <= value.length; at++) {
          if (signature.every((byte, index) => value[at + index] === byte)) images.push({ where, base64: base64(value.subarray(at)) });
        }
      };
      const walk = async (value: unknown, where: string): Promise<void> => {
        if (typeof value === 'string') text(value, where);
        else if (value instanceof Blob) bytes(new Uint8Array(await value.arrayBuffer()), where);
        else if (value instanceof ArrayBuffer) bytes(new Uint8Array(value), where);
        else if (ArrayBuffer.isView(value)) bytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), where);
        else if (value instanceof Map || value instanceof Set || Array.isArray(value)) {
          let index = 0;
          for (const entry of value as Iterable<unknown>) await walk(entry, `${where}[${index++}]`);
        } else if (value && typeof value === 'object') {
          for (const [key, entry] of Object.entries(value)) {
            text(key, `${where} key`);
            await walk(entry, `${where}.${key}`);
          }
        }
      };
      for (const area of ['session', 'local', 'sync'] as const) await walk(await chrome.storage[area].get(null), `storage.${area}`);
      const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      for (const { name, version } of await indexedDB.databases()) {
        const database = await result(indexedDB.open(name!, version));
        for (const store of Array.from(database.objectStoreNames)) {
          const objects = database.transaction(store).objectStore(store);
          const [keys, values] = await Promise.all([result(objects.getAllKeys()), result(objects.getAll())]);
          for (const [index, value] of values.entries()) {
            const where = `indexedDB ${name}/${store}[${index}]`;
            await walk(keys[index], `${where} key`);
            await walk(value, where);
          }
        }
        database.close();
      }
      return { found, images };
    }, needles);
    // A saved journey, read from the journey store directly.
    const saved = (journeyId: string): Promise<SavedJourney> => worker().evaluate(async journeyId => {
      const result = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const database = await result(indexedDB.open('anmerko:journey-store:v1'));
      try {
        const transaction = database.transaction(['snapshots', 'blobs']);
        const record = await result(transaction.objectStore('snapshots').get(journeyId));
        const blobs: Array<{ key: string; dataUrl: string }> = await result(transaction.objectStore('blobs')
          .getAll(IDBKeyRange.bound(`${journeyId}\u0000`, `${journeyId}\u0000\uffff`)));
        return { record, images: Object.fromEntries(blobs.map(blob => [blob.key.slice(journeyId.length + 1), blob.dataUrl])) };
      } finally {
        database.close();
      }
    }, journeyId);
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
    return { temp, context, cdp, page, state, held, saved, activate, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type Journey = Awaited<ReturnType<typeof launch>>;
type State = Journey['state'];

// A fixture, so the browser and its temporary profile go even when a test times out.
const test = base.extend<{ journey: Journey }>({
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
  // The journey view re-renders as its state arrives. A synchronous click
  // cannot be split across a re-render the way a press and release can.
  await dock.click(control('journey-start'));
  await expect.poll(async () => {
    const current = await state();
    const error = await dock.evaluate("return root.querySelector('#journey-start-error')?.textContent");
    return `${current?.phase}: ${draftOf(current)?.steps.map(step => `${step.kind} ${step.image.status}`).join(', ')}${error ? ` (${error})` : ''}`;
  }).toBe('recording: initial retained');
  expect(draftOf(await state())?.includeEnteredValues).toBe(enteredValues);
  await expect.poll(() => heading(dock)).toBe('Recording journey');
}

async function lastStep(state: State) {
  const step = draftOf(await state())?.steps.at(-1);
  return step && `${step.kind} ${step.kind === 'navigation' ? step.navigation.toUrl : step.sourceUrl} ${step.image.status}`;
}

// The last step as its kind and what it names: a click's label, a navigation's destination.
async function lastAction(state: State) {
  const step = draftOf(await state())?.steps.at(-1);
  return step && `${step.kind}${step.kind === 'click' ? ` ${step.target.label}` : step.kind === 'navigation' ? ` ${step.navigation.toUrl}` : ''} ${step.image.status}`;
}

async function stopJourney(dock: Dock, state: State) {
  await dock.click(control('journey-stop'));
  await expect.poll(async () => { const current = await state(); return current?.phase === 'reviewing' && current.draft.stopReason; }).toBe('user');
  await expect.poll(() => heading(dock)).toBe('Review journey');
}

// Press a side panel control once it is there and enabled.
async function press(dock: Dock, id: string) {
  await expect.poll(() => dock.evaluate(`return root.querySelector('${control(id)}')?.disabled`)).toBe(false);
  await dock.click(control(id));
}

// Press a review control and wait for the background to accept the edit as
// a new revision. A control that arms a confirmation is pressed again once it
// reads `confirm`.
async function reviewEdit(dock: Dock, state: State, id: string, confirm?: string) {
  const revision = draftOf(await state())!.revision;
  await press(dock, id);
  if (confirm) {
    await expect.poll(() => dock.evaluate(`return root.querySelector('${control(id)}')?.textContent`)).toBe(confirm);
    await press(dock, id);
  }
  await expect.poll(async () => draftOf(await state())?.revision).toBeGreaterThan(revision);
}

// Summaries, acknowledgement and Save, in the side panel.
async function saveReview(dock: Dock, state: State) {
  await type(dock, '#journey-expected', 'The annual plan is in the cart.');
  await type(dock, '#journey-actual', 'The cart is empty.');
  await dock.click(control('journey-ack'));
  await expect.poll(() => dock.evaluate(`return root.querySelector('${control('journey-save')}')?.disabled`)).toBe(false);
  await dock.click(control('journey-save'));
  await expect.poll(async () => (await state())?.phase).toBe('saved');
  await expect.poll(() => heading(dock)).toBe('Journey saved');
}

// Copy Prompt from the side panel, read back from the clipboard.
async function copyPrompt(journey: Journey, dock: Dock) {
  const { context, page } = journey;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: SHOP });
  await page.evaluate(() => navigator.clipboard.writeText(''));
  // Writing the clipboard needs the side panel focused, as clicking it does.
  await dock.press('.journey-view h1');
  await dock.click(control('journey-copy'));
  let prompt = '';
  await expect.poll(async () => prompt = (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n')).not.toBe('');
  return prompt;
}

// Download Markdown + Images from the side panel: the archive's name and entries.
async function download(journey: Journey, dock: Dock) {
  const { temp, cdp } = journey;
  const downloads = await mkdtemp(path.join(temp, 'downloads-'));
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
  return { filename, files };
}

const stepTitle = (step: JourneyDraftStep) => `Step ${step.seq} · ${step.kind === 'initial' ? 'Initial view'
  : step.kind === 'navigation' ? 'Navigation' : `${step.kind === 'click' ? 'Click' : 'Entered value'}: ${step.target.label}`}`;
const reviewTitles = (view: Pick<Surface, 'evaluate'>) => view.evaluate("return [...root.querySelectorAll('.journey-steps > li > h2')].map(title => title.textContent)");
const imageOf = (draft: JourneyDraftV1, step: JourneyDraftStep) => step.image.status === 'retained' ? draft.images[step.image.imageId] : undefined;
const png = (dataUrl: string) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
// Near the bottom-right corner, clear of the shop's content: its yellow background.
const corner = (image: Image): Array<[number, number]> => [[image.width - 20, image.height - 20]];
// Near the top-right and bottom-right corners, counting negative coordinates
// from the far edge: clear of the shop's content at any image size.
const rightCorners: Array<[number, number]> = [[-20, 20], [-20, -20]];

// Decode PNG pixels in the browser, independently of the extension, and name
// each sampled colour: the shop's yellow background, the partner site's blue,
// or the opaque black mask.
async function colors(page: Page, image: Buffer, points: Array<[number, number]>) {
  const decoded = await page.evaluate(async ({ base64, points }) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    const at = (value: number, size: number) => value < 0 ? size + value : value;
    return {
      width: bitmap.width, height: bitmap.height,
      samples: points.map(([x, y]) => Array.from(context.getImageData(at(x, bitmap.width), at(y, bitmap.height), 1, 1).data)),
    };
  }, { base64: image.toString('base64'), points });
  const near = (actual: number[], expected: number[]) => expected.every((value, index) => Math.abs(actual[index] - value) <= 3);
  return {
    width: decoded.width, height: decoded.height,
    colors: decoded.samples.map(sample => near(sample, [255, 200, 0, 255]) ? 'yellow' : near(sample, [0, 90, 200, 255]) ? 'blue'
      : near(sample, [0, 0, 0, 255]) ? 'black' : `rgba(${sample})`),
  };
}

// Compare two PNGs pixel by pixel, decoded in the browser independently of
// the extension. Outside `mask`, count the pixels that differ from the
// reference; inside it, count the pixels that are not opaque black. Images of
// different sizes share no pixels, and count as differing throughout.
async function comparePixels(page: Page, image: Buffer, reference: Buffer, mask?: Clip) {
  return page.evaluate(async ({ image, reference, mask }) => {
    const decode = async (base64: string) => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    };
    const [actual, expected] = await Promise.all([decode(image), decode(reference)]);
    const { width, height } = actual;
    if (width !== expected.width || height !== expected.height) return { width, height, differing: width * height, unmasked: 0 };
    let differing = 0;
    let unmasked = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;
        const pixel = actual.data.subarray(at, at + 4);
        if (mask && x >= mask.x && x < mask.x + mask.width && y >= mask.y && y < mask.y + mask.height) {
          if (pixel[0] !== 0 || pixel[1] !== 0 || pixel[2] !== 0 || pixel[3] !== 255) unmasked++;
        } else if (pixel.some((value, channel) => Math.abs(value - expected.data[at + channel]) > 2)) differing++;
      }
    }
    return { width, height, differing, unmasked };
  }, { image: image.toString('base64'), reference: reference.toString('base64'), mask });
}

// Where the extension still keeps `original` in any form: its base64 in any
// string, or any PNG with its bytes or, re-encoded, its pixels.
async function copiesOf(journey: Journey, original: Buffer) {
  const { found, images } = await journey.held([original.toString('base64')]);
  const copies = found.map(({ where }) => `base64 in ${where}`);
  for (const image of images) {
    const bytes = Buffer.from(image.base64, 'base64');
    if (sha256(bytes) === sha256(original)) copies.push(`bytes in ${image.where}`);
    else if ((await comparePixels(journey.page, bytes, original)).differing === 0) copies.push(`pixels in ${image.where}`);
  }
  return copies;
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
  const { page, state, held, saved, activate } = journey;
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
  await stopJourney(dock, state);

  // The side panel lists every step in order, each with its screenshot. A
  // link or route click can be superseded by its navigation's screenshot.
  const draft = draftOf(await state())!;
  expect(JSON.stringify(draft)).not.toContain(SECRET);
  const review = sidePanel(dock);
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
  const imageId = click.image.status === 'retained' ? click.image.imageId : '';
  const original = imageOf(draft, click)!;
  const originalPng = png(original.dataUrl!);
  // No other screenshot has these pixels, so any copy found later is the original.
  for (const step of retained.filter(step => step !== click)) {
    expect((await comparePixels(page, png(imageOf(draft, step)!.dataUrl!), originalPng)).differing).toBeGreaterThan(0);
  }
  const mask = { x: original.width - 220, y: original.height - 160, width: 120, height: 90 };
  const inside: [number, number] = [mask.x + mask.width / 2, mask.y + mask.height / 2];
  const outside: [number, number] = [mask.x - 20, mask.y + mask.height / 2];
  expect(await colors(page, originalPng, [inside, outside])).toMatchObject({ colors: ['yellow', 'yellow'] });
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
  // The mask replaced the original in the review the extension keeps.
  expect(await copiesOf(journey, originalPng)).toEqual([]);

  await saveReview(dock, state);
  // The saved snapshot keeps the masked screenshot: opaque black inside the
  // mask and the capture everywhere else. Nothing the extension keeps holds
  // the unmasked original: not its base64, its bytes, nor its pixels re-encoded.
  const maskedOriginal = { width: original.width, height: original.height, differing: 0, unmasked: 0 };
  const snapshot = await saved(draft.id);
  expect(snapshot.record?.draft.images[imageId]?.redacted).toBe(true);
  expect(await comparePixels(page, png(snapshot.images[imageId]), originalPng, mask)).toEqual(maskedOriginal);
  expect(await copiesOf(journey, originalPng)).toEqual([]);

  const prompt = await copyPrompt(journey, dock);
  expect(prompt).toContain(draft.id);
  expect(prompt).toContain('journeys.md');
  expect(prompt).toContain('The annual plan is in the cart.');
  expect(prompt).toContain('The cart is empty.');
  expect(prompt).not.toContain(SECRET);

  const { filename, files } = await download(journey, dock);
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

  // Exported screenshots are the captures, except the masked one, which
  // covers its region with opaque black as the saved snapshot does.
  for (const step of retained) {
    expect(files.get(names.get(step.id)!)!.equals(png(imageOf(draft, step)!.dataUrl!))).toBe(step !== click);
  }
  expect(await comparePixels(page, files.get(names.get(click.id)!)!, originalPng, mask)).toEqual(maskedOriginal);
  // The saved journey holds exactly the exported screenshots.
  const databases = (await held()).images.filter(image => image.where.startsWith('indexedDB '));
  expect(databases.map(image => image.base64).sort()).toEqual([...pngs].map(name => files.get(name)!.toString('base64')).sort());
});

test('leaving the starting website ends the journey as left-site and keeps earlier steps', async ({ journey }) => {
  const { page, state, held, activate } = journey;
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
  // Every screenshot kept anywhere decodes to the shop's yellow at both
  // right-hand corners: each the journey holds, whichever step keeps it, and
  // every PNG in the extension's storage. A capture of the blue partner site
  // fails it.
  const stored = (await held()).images;
  expect(Object.keys(draft.images).length).toBeGreaterThanOrEqual(2);
  expect(stored.length).toBeGreaterThanOrEqual(2);
  const images = [
    ...Object.entries(draft.images).map(([imageId, image]) => ({ where: `image ${imageId}`, bytes: png(image.dataUrl!) })),
    ...stored.map(image => ({ where: image.where, bytes: Buffer.from(image.base64, 'base64') })),
  ];
  for (const { where, bytes } of images) {
    expect((await colors(page, bytes, rightCorners)).colors, where).toEqual(['yellow', 'yellow']);
  }
});

test('nothing review removes, redacts or edits reaches a saved or exported copy', async ({ journey }) => {
  test.setTimeout(90_000);
  const { page, state, held, saved, activate } = journey;
  const dock = await activate();
  await startJourney(dock, state, { enteredValues: true });

  // An entered value, which the next click commits; a click whose label the
  // review redacts; a click the review removes; and a route to a URL the
  // review redacts. Each waits for its screenshot before the next.
  await page.locator('#coupon').fill(VALUE_SECRET);
  await page.locator('#add').click();
  await expect.poll(() => lastAction(state)).toBe('click Add to cart retained');
  await page.locator('#suggest').click();
  await expect.poll(() => lastAction(state)).toBe(`click Show ${LABEL_SECRET} retained`);
  await page.locator('#wrap').click();
  await expect.poll(() => lastAction(state)).toBe(`click Gift wrap ${REMOVED_SECRET} retained`);
  await page.locator('#orders').click();
  await expect.poll(() => lastAction(state)).toBe(`navigation ${SHOP}/orders/${URL_SECRET} retained`);
  await stopJourney(dock, state);

  // Recording kept all four, so their absence later is the review's doing.
  const recorded = draftOf(await state())!;
  for (const secret of [VALUE_SECRET, LABEL_SECRET, REMOVED_SECRET, URL_SECRET]) expect(JSON.stringify(recorded)).toContain(secret);
  const clickLabelled = (text: string) => recorded.steps.find(step => step.kind === 'click' && step.target.label.includes(text))!;
  const field = recorded.steps.find(step => step.kind === 'field-change')!;
  expect(field.enteredValue).toEqual({ kind: 'text', value: VALUE_SECRET, truncated: false });
  const labelled = clickLabelled(LABEL_SECRET);
  const removed = clickLabelled(REMOVED_SECRET);
  expect(removed.image.status).toBe('retained');
  const removedImageId = removed.image.status === 'retained' ? removed.image.imageId : '';
  const removedPng = png(imageOf(recorded, removed)!.dataUrl!);
  // No other step keeps these pixels, so any copy found later is the removed step's.
  for (const step of recorded.steps.filter(step => step !== removed && step.image.status === 'retained')) {
    expect((await comparePixels(page, png(imageOf(recorded, step)!.dataUrl!), removedPng)).differing).toBeGreaterThan(0);
  }

  // Edit the entered value.
  await press(dock, `edit-value-${field.id}`);
  await expect.poll(() => dock.evaluate(`return root.querySelector('${control(`value-${field.id}`)}')?.value`)).toBe(VALUE_SECRET);
  await type(dock, control(`value-${field.id}`), EDITED_VALUE);
  await reviewEdit(dock, state, `save-value-${field.id}`);
  // Redact the click label, and remove the other click.
  await reviewEdit(dock, state, `redact-label-${labelled.id}`);
  await reviewEdit(dock, state, `remove-${removed.id}`, `Confirm remove step ${removed.seq}`);
  // Redact every field that carries the URL: the route's destination, the
  // screenshot taken there, and any step that starts from it.
  for (let redactions = 0; redactions < 8; redactions++) {
    const current = draftOf(await state())!;
    const url = current.steps.flatMap(step => [
      ...(step.sourceUrl.includes(URL_SECRET) ? [`redact-source-${step.id}`] : []),
      ...(step.kind === 'navigation' && step.navigation.toUrl.includes(URL_SECRET) ? [`redact-destination-${step.id}`] : []),
      ...(imageOf(current, step)?.captureUrl.includes(URL_SECRET) ? [`redact-capture-${step.id}`] : []),
    ])[0];
    if (!url) break;
    await reviewEdit(dock, state, url);
  }
  const needles: Record<string, string> = {
    [VALUE_SECRET]: 'the entered value edited in review',
    [LABEL_SECRET]: 'the redacted click label',
    [URL_SECRET]: 'the redacted URL',
    [REMOVED_SECRET]: "the removed step's label",
    [removed.id]: "the removed step's ID",
    [removedImageId]: "the removed step's screenshot ID",
    [journeyImageFilename(recorded.id, removed.seq)]: "the removed step's screenshot name",
  };
  // Everywhere the extension keeps something of them, and where it keeps the
  // removed step's screenshot.
  const stored = async (when: string) => [
    ...(await held(Object.keys(needles))).found.map(({ needle, where }) => `${needles[needle]} in ${where} ${when}`),
    ...(await copiesOf(journey, removedPng)).map(copy => `the removed step's screenshot as ${copy} ${when}`),
  ];
  // The review the extension keeps has already dropped them all.
  const leaks = await stored('in review');

  await saveReview(dock, state);
  const prompt = await copyPrompt(journey, dock);
  const { filename, files } = await download(journey, dock);
  const snapshot = await saved(recorded.id);
  const promptMd = files.get('prompt.md')!.toString('utf8');
  const journeysMd = files.get('journeys.md')!.toString('utf8');

  // None of it reaches the saved snapshot, Copy Prompt, prompt.md,
  // journeys.md or a file name, nor stays anywhere in extension storage.
  const outputs: Record<string, string> = {
    'the saved snapshot': JSON.stringify(snapshot),
    'Copy Prompt': prompt,
    'prompt.md': promptMd,
    'journeys.md': journeysMd,
    'the archive and PNG names': [filename, ...files.keys()].join('\n'),
  };
  for (const [where, text] of Object.entries(outputs)) {
    for (const [needle, what] of Object.entries(needles)) if (text.includes(needle)) leaks.push(`${what} in ${where}`);
  }
  for (const [name, bytes] of files) {
    if (name.endsWith('.png') && (await comparePixels(page, bytes, removedPng)).differing === 0) leaks.push(`the removed step's screenshot as ${name}`);
  }
  leaks.push(...await stored('once saved'));
  expect(leaks).toEqual([]);

  // What review kept: the edited value, markers where it redacted, and a gap
  // where it removed a step, with every other step's screenshot.
  const kept = snapshot.record!.draft;
  expect(kept.steps.map(step => step.id)).toEqual(recorded.steps.filter(step => step !== removed).map(step => step.id));
  expect(kept.steps.find(step => step.id === field.id)).toMatchObject({ enteredValue: { kind: 'text', value: EDITED_VALUE, edited: true } });
  expect(kept.steps.find(step => step.id === labelled.id)).toMatchObject({ target: { label: '[redacted]' } });
  expect(kept.redactions?.steps[labelled.id]).toMatchObject({ label: true });
  expect(prompt).toContain(`value \`${EDITED_VALUE}\` (edited during review)`);
  expect(prompt).toContain(`**Step ${labelled.seq} · Click** [redacted] (\`button\`)`);
  expect(prompt).toMatch(/ to \[redacted\]/);
  expect(prompt).toContain('Missing step numbers are steps removed during review.');
  expect(promptMd).toContain(prompt.trim());
  const names = screenshotNames(journeysMd);
  const expectedNames = new Map<string, string>();
  for (const step of kept.steps) {
    if (step.image.status !== 'retained') continue;
    const imageId = step.image.imageId;
    const first = kept.steps.find(candidate => candidate.image.status === 'retained' && candidate.image.imageId === imageId)!;
    expectedNames.set(step.id, journeyImageFilename(recorded.id, first.seq));
  }
  expect(names).toEqual(expectedNames);
  expect([...files.keys()].sort()).toEqual(['journeys.md', 'prompt.md', ...new Set(expectedNames.values())].sort());
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
