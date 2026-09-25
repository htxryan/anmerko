import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sidebar } from '../shared/chromium-sidebar.ts';

// The real extension: a journey recorded from the native side panel, reviewed
// in journey.html, and saved into a saved-journey store that is already full.
const FIXTURE = 'http://fixture.invalid/';
const panel = (page: Page) => page.getByRole('complementary', { name: 'anmerko feedback panel' });

let temp: string;
let context: BrowserContext;
let worker: Worker;

test.beforeEach(async () => {
  temp = await mkdtemp(path.join(tmpdir(), 'anmerko-journey-room-'));
  const extension = path.join(temp, 'extension');
  await cp('dist', extension, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
  // Automation cannot click the toolbar to grant activeTab, so only this
  // copy may capture the fixture page without it.
  manifest.host_permissions = ['<all_urls>'];
  manifest.background.service_worker = 'test-bootstrap.js';
  await writeFile(path.join(extension, 'test-bootstrap.js'),
    "import { activateTab } from './background.js'; globalThis.__testActivateTab = activateTab;");
  await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
    channel: 'chromium', headless: !process.env.HEADED, viewport: null,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1440,1000'],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
});

test.afterEach(async () => {
  await context.close();
  await rm(temp, { recursive: true, force: true });
});

// Saved journeys at anmerko's limit, written where the background keeps them.
async function fillSavedJourneys(count: number) {
  await worker.evaluate(async count => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('anmerko:journey-store:v1', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('snapshots', { keyPath: 'journeyId' });
        request.result.createObjectStore('blobs', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readwrite');
      for (let index = 0; index < count; index += 1) {
        tx.objectStore('snapshots').put({
          schemaVersion: 1, journeyId: `saved-${String(index).padStart(3, '0')}`, revision: 1,
          updatedAt: new Date(Date.UTC(2026, 8, 20, 12, 0, index)).toISOString(),
          stepCount: 1, manifestBytes: 2, imageBytes: 69, blobIds: [], draft: { expected: `Saved journey ${index}` },
        });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, count);
}

test('a review refused for lack of room deletes a saved journey from the review, then saves', async () => {
  const page = await context.newPage();
  await page.route(`${FIXTURE}**`, route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>Checkout</title></head><body><button id="pay" type="button">Pay</button></body></html>',
  }));
  await page.goto(FIXTURE);
  await worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(candidate => candidate.url === url);
    if (!tab?.id) throw new Error('Test tab not found');
    await (globalThis as typeof globalThis & { __testActivateTab(id: number): Promise<void> }).__testActivateTab(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'ANMERKO_PRESENT', mode: 'overlay', canDock: true });
  }, page.url());
  await panel(page).getByRole('button', { name: 'Dock sidebar', exact: true }).click();
  const dock = await sidebar(context, page);
  // Chrome animates the side panel open, and capture refuses a moving viewport.
  let previousWidth = 0, stableWidths = 0;
  await expect.poll(async () => {
    const width = await page.evaluate(() => innerWidth);
    stableWidths = width === previousWidth ? stableWidths + 1 : 0;
    previousWidth = width;
    return stableWidths;
  }, { intervals: [100] }).toBe(3);

  // The side panel acts only on trusted input, so its controls are pressed
  // with real mouse events.
  const press = async (selector: string) => {
    let center: { x: number; y: number } | null = null;
    await expect.poll(async () => {
      center = await dock.evaluate(`const element = root.querySelector(${JSON.stringify(selector)});
        if (!element || element.disabled) return null;
        element.scrollIntoView({ block: 'center' });
        const box = element.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };`);
      return center !== null;
    }).toBe(true);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await dock.command('Input.dispatchMouseEvent', { type, ...center!, button: 'left', clickCount: 1 });
    }
  };
  const phase = () => dock.evaluate(`return chrome.runtime.sendMessage({ type: 'ANMERKO_JOURNEY_STATE' })
    .then(response => response.value.phase + ':' + (response.value.draft?.steps.length ?? 0))`);
  await press('.comment-options');
  await press('.journey-record');
  await page.bringToFront();
  await press('.journey-view [data-focus-id="journey-start"]');
  await expect.poll(phase, { timeout: 10_000 }).toBe('recording:1');
  await page.locator('#pay').click();
  await expect.poll(phase, { timeout: 10_000 }).toBe('recording:2');
  await press('.journey-view [data-focus-id="journey-stop"]');
  await expect.poll(phase, { timeout: 10_000 }).toBe('reviewing:2');

  await fillSavedJourneys(100);
  const extensionId = new URL(worker.url()).host;
  const review = await context.newPage();
  await review.goto(`chrome-extension://${extensionId}/journey.html`);
  await expect(review.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await review.getByLabel('Expected result').fill('Paying places the order.');
  await review.getByLabel('Actual result').fill('Nothing happens.');
  await review.getByRole('checkbox', { name: /I understand this journey retains full URLs/ }).check();
  await expect(review.getByText('This review is ready to save.')).toBeVisible();
  await review.getByRole('button', { name: 'Save journey' }).click();
  await expect(review.getByRole('alert'))
    .toHaveText('Saved journeys are full. Delete saved journeys to make room for this one, then save again.');

  const room = review.getByRole('region', { name: 'Saved journeys' });
  await expect(room.getByRole('listitem')).toHaveCount(100);
  await room.getByRole('button', { name: /^Delete journey: Saved journey 99,/ }).click();
  await room.getByRole('button', { name: /^Confirm delete journey: Saved journey 99,/ }).click();
  await expect(room.getByRole('listitem')).toHaveCount(99);
  await review.getByRole('button', { name: 'Save journey' }).click();
  await expect(review.getByRole('heading', { name: 'Journey saved' })).toBeVisible();

  const saved = await dock.evaluate(`return chrome.runtime.sendMessage({ type: 'ANMERKO_JOURNEY_LIST' })
    .then(response => response.value.map(item => item.expected ?? ''))`) as string[];
  expect(saved).toHaveLength(100);
  expect(saved).toContain('Paying places the order.');
  expect(saved).not.toContain('Saved journey 99');
});
