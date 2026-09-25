import { test, expect, chromium, type Page } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sidebar } from '../shared/chromium-sidebar';
import { archiveEntries } from '../shared/expected-feedback';
import { journeyImageFilename } from '../../src/journey-export';
import type { JourneyDraftStep, JourneyDraftV1, JourneySession } from '../../src/journey-core';

// The other journey specs drive src modules against a chrome mock. These load
// an unmodified copy of the production Chrome build, which has no host
// permissions: recording relies on the activeTab grant of a toolbar click.
const SHOP = 'https://shop.example';
const ELSEWHERE = 'https://elsewhere.example';
const SECRET = 'coupon-do-not-export-7431';
const shopHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Journey shop</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:rgb(255,200,0);font:16px sans-serif}main{padding:24px;display:grid;gap:12px;justify-items:start}</style></head>
<body><main><h1 id="title">Shop</h1>
<button id="add" type="button">Add to cart</button>
<label>Coupon code <input id="coupon" autocomplete="off"></label>
<a id="pricing" href="/pricing">Pricing</a>
<button id="annual" type="button">Annual plans</button>
<a id="leave" href="${ELSEWHERE}/">Partner site</a></main>
<script>
const title = document.querySelector('#title');
const route = () => { title.textContent = location.pathname; };
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
    // The journey the background persisted, read from its own storage.session.
    const state = async (): Promise<JourneySession | undefined> => {
      const worker = context.serviceWorkers().find(candidate => candidate.url() === background);
      const stored = await worker?.evaluate(key => chrome.storage.session.get(key), PAYLOAD_KEY);
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
    return { temp, context, cdp, page, state, activate, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type Dock = Awaited<ReturnType<typeof sidebar>>;
const draftOf = (session: JourneySession | undefined): JourneyDraftV1 | undefined =>
  session && 'draft' in session ? session.draft : undefined;
const heading = (dock: Dock) => dock.evaluate("return root.querySelector('.journey-view h1')?.textContent");
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
const reviewTitles = (dock: Dock) => dock.evaluate("return [...root.querySelectorAll('.journey-steps > li > h2')].map(title => title.textContent)");
// Whether each review item shows a rendered screenshot preview.
const reviewPreviews = (dock: Dock) => dock.evaluate(`return [...root.querySelectorAll('.journey-steps > li')].map(item => {
  const box = item.querySelector('anmerko-image.journey-image')?.getBoundingClientRect();
  return !!box && box.width > 0 && box.height > 0;
})`);
const imageId = (step: JourneyDraftStep) => step.image.status === 'retained' ? step.image.imageId : '';
const png = (dataUrl: string) => Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');

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

test('the native side panel records, masks, saves and exports a same-origin journey', async () => {
  test.setTimeout(60_000);
  const { temp, context, cdp, page, state, activate, close } = await launch();
  try {
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
    await expect.poll(() => heading(dock)).toBe('Review journey');
    const titles = await reviewTitles(dock);
    expect(titles).toEqual(draft.steps.map(stepTitle));
    expect(titles.join('\n')).toMatch(/^Step 1 · Initial view\nStep 2 · Click: Add to cart\n(Step 3 · Click: Pricing\n)?Step \d · Navigation\n(Step \d · Click: Annual plans\n)?Step \d · Navigation$/);
    expect(draft.steps.flatMap(step => step.kind === 'navigation' ? [[step.sourceUrl, step.navigation.toUrl]] : [])).toEqual([
      [`${SHOP}/`, `${SHOP}/pricing`], [`${SHOP}/pricing`, `${SHOP}/pricing/annual`],
    ]);
    const essential = draft.steps.filter(step => step.kind !== 'click' || step.target.label === 'Add to cart');
    expect(essential.map(step => `${step.kind} ${step.image.status}`)).toEqual(['initial retained', 'click retained', 'navigation retained', 'navigation retained']);
    expect(await reviewPreviews(dock)).toEqual(draft.steps.map(step => step.image.status === 'retained'));
    const retained = draft.steps.filter(step => step.image.status === 'retained');
    for (const step of retained) {
      const image = draft.images[imageId(step)];
      expect(await colors(page, png(image.dataUrl!), [[image.width - 20, image.height - 20]]))
        .toEqual({ width: image.width, height: image.height, colors: ['yellow'] });
    }

    // Mask part of the click's screenshot in the review.
    const click = essential[1];
    const original = draft.images[imageId(click)];
    const mask = { x: original.width - 220, y: original.height - 160, width: 120, height: 90 };
    const dialog = 'dialog.journey-image-review[open]';
    await dock.click(control(`mask-image-${click.id}`));
    await expect.poll(() => dock.evaluate(`return !!root.querySelector('${dialog}')`)).toBe(true);
    for (const [label, value] of Object.entries({ X: mask.x, Y: mask.y, Width: mask.width, Height: mask.height })) {
      await type(dock, `${dialog} input[aria-label="${label}"]`, String(value));
    }
    const apply = `${dialog} .journey-image-review__button--primary`;
    await expect.poll(() => dock.evaluate(`return root.querySelector('${apply}').disabled`)).toBe(false);
    await dock.click(apply);
    await expect.poll(async () => draftOf(await state())?.images[imageId(click)]?.redacted).toBe(true);
    await expect.poll(() => dock.evaluate(`return !!root.querySelector('#journey-image-masked-${click.id}')`)).toBe(true);

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
    expect(filename).toBe(`journey-${draft.id}.zip`);
    const images = new Map(retained.map(step => [journeyImageFilename(draft.id, imageId(step)), step]));
    expect([...files.keys()].sort()).toEqual(['comments.md', 'journeys.md', ...images.keys()].sort());
    const journeysMd = files.get('journeys.md')!.toString('utf8');
    for (const name of images.keys()) expect(journeysMd).toContain(name);
    expect(journeysMd).toContain(`${SHOP}/pricing/annual`);
    expect(journeysMd).toContain('Add to cart');
    expect(journeysMd).not.toContain(SECRET);
    expect(files.get('comments.md')!.toString('utf8')).toContain(prompt.trim());

    // Saved and exported screenshots are the captures, except the masked one,
    // which now covers its region with opaque black.
    for (const [name, step] of images) {
      expect(files.get(name)!.equals(png(draft.images[imageId(step)].dataUrl!))).toBe(step !== click);
    }
    const inside: [number, number] = [mask.x + mask.width / 2, mask.y + mask.height / 2];
    const outside: [number, number] = [mask.x - 20, mask.y + mask.height / 2];
    expect(await colors(page, png(original.dataUrl!), [inside, outside])).toMatchObject({ colors: ['yellow', 'yellow'] });
    expect(await colors(page, files.get(journeyImageFilename(draft.id, imageId(click)))!, [inside, outside]))
      .toEqual({ width: original.width, height: original.height, colors: ['black', 'yellow'] });
  } finally {
    await close();
  }
});

test('leaving the starting website ends the journey as left-site and keeps earlier steps', async () => {
  const { page, state, activate, close } = await launch();
  try {
    const dock = await activate();
    await startJourney(dock, state);
    await page.locator('#add').click();
    await expect.poll(() => lastStep(state)).toBe(`click ${SHOP}/ retained`);
    await page.locator('#leave').click();
    await expect(page).toHaveURL(`${ELSEWHERE}/`);
    await expect.poll(async () => { const current = await state(); return current?.phase === 'reviewing' && current.draft.stopReason; }).toBe('left-site');

    // Nothing from the other website is recorded; the earlier steps and their
    // screenshots stay for review in the side panel.
    const draft = draftOf(await state())!;
    expect(draft.steps.every(step => step.sourceUrl.startsWith(`${SHOP}/`) && step.kind !== 'navigation')).toBe(true);
    expect(draft.steps.slice(0, 2).map(step => `${step.kind} ${step.image.status}`)).toEqual(['initial retained', 'click retained']);
    await expect.poll(() => heading(dock)).toBe('Review journey');
    expect(await dock.evaluate("return root.querySelector('.journey-stop-reason')?.textContent")).toMatch(/^Recording ended because the page left the website you started on\./);
    const titles = await reviewTitles(dock);
    expect(titles).toEqual(draft.steps.map(stepTitle));
    expect(titles.slice(0, 2)).toEqual(['Step 1 · Initial view', 'Step 2 · Click: Add to cart']);
    expect((await reviewPreviews(dock)).slice(0, 2)).toEqual([true, true]);
  } finally {
    await close();
  }
});
