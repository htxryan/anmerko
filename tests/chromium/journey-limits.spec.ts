import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { JOURNEY_LIMITATIONS } from '../../src/journey-limits';

// The review surface and the real extension client, over a scripted background.
const bundle = buildSync({ stdin: { contents: `
  import { createJourneyClient } from './src/journey-client';
  import { mountJourneyUI } from './src/journey-ui';
  import { journeySurfaceStyles } from './src/journey-styles';
  const style = document.createElement('style');
  style.textContent = journeySurfaceStyles;
  document.head.append(style);
  window.mountReview = () => mountJourneyUI(document.body, createJourneyClient(() => ({ ownerTabId: 1, ownerWindowId: 1 })));
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+AvzvAAAAAElFTkSuQmCC';

function reviewing(limitations: string[]) {
  return {
    phase: 'reviewing', epoch: 2, sessionId: 'session-1', journeyId: 'journey-1', ownerTabId: 1, ownerWindowId: 1,
    warningAt: '2026-09-21T00:28:05.000Z', expiresAt: '2026-09-21T00:30:05.000Z',
    draft: {
      schemaVersion: 1, status: 'draft', id: 'journey-1', revision: 3,
      createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:05.000Z',
      startedAt: '2026-09-21T00:00:00.000Z', stoppedAt: '2026-09-21T00:00:05.000Z',
      includeEnteredValues: false, stopReason: 'page-access-lost',
      expected: 'The order is placed.', actual: 'The confirmation page never loads.',
      steps: [{
        kind: 'initial', id: 'step-1', seq: 1, observedAt: '2026-09-21T00:00:01.000Z', elapsedMs: 1_000,
        sourceUrl: 'https://shop.example/cart', image: { status: 'retained', imageId: 'image-1' },
      }],
      images: {
        'image-1': {
          capturedAt: '2026-09-21T00:00:01.000Z', captureUrl: 'https://shop.example/cart',
          width: 1, height: 1, byteLength: 69, dataUrl: PNG,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 },
        },
      },
      limitations,
    },
  };
}

type Saved = { journeyId: string; revision: number; updatedAt: string; stepCount: number; spansPages: boolean; expected?: string };

async function mountReview(page: Page, state: unknown, responses: Record<string, unknown> = {}, saved: Saved[] = []) {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.evaluate(({ state, responses, saved }) => {
    const listeners: Array<(message: unknown, sender: unknown) => void> = [];
    const background = {
      state,
      saved,
      responses,
      messages: [] as unknown[],
      changed() { for (const listener of listeners) listener({ type: 'ANMERKO_JOURNEY_CHANGED' }, { id: 'test-extension' }); },
    };
    (globalThis as any).background = background;
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-extension',
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        getManifest: () => ({ background: { service_worker: 'background.js' } }),
        sendMessage: async (message: { type: string }) => {
          background.messages.push(structuredClone(message));
          if (message.type === 'ANMERKO_JOURNEY_STATE') return { ok: true, value: structuredClone(background.state) };
          if (message.type === 'ANMERKO_JOURNEY_LIST') return { ok: true, value: structuredClone(background.saved) };
          if (message.type === 'ANMERKO_JOURNEY_DELETE_SNAPSHOT') {
            background.saved = background.saved.filter(item => item.journeyId !== (message as { journeyId?: string }).journeyId);
          }
          return structuredClone(background.responses[message.type] ?? { ok: true });
        },
        onMessage: {
          addListener: (listener: (message: unknown, sender: unknown) => void) => { listeners.push(listener); },
          removeListener: () => {},
        },
      },
    };
  }, { state, responses, saved });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => (globalThis as any).mountReview());
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
}

test('review lists what recording lost before the summaries, and nothing when it lost nothing', async ({ page }) => {
  const limitations = [JOURNEY_LIMITATIONS.enteredValuesTruncated, JOURNEY_LIMITATIONS.pageAccessLost];
  await mountReview(page, reviewing(limitations));

  const section = page.getByRole('region', { name: 'Limitations' });
  await expect(section.getByRole('heading', { name: 'Limitations' })).toBeVisible();
  await expect(section.getByRole('listitem')).toHaveText(limitations);
  // Read before the summaries and steps a reviewer shares.
  expect(await page.evaluate(() => {
    const limits = document.querySelector('.journey-limitations')!;
    const summary = document.querySelector('.journey-summary')!;
    return Boolean(limits.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);

  await page.evaluate(() => {
    const background = (globalThis as any).background;
    background.state = { ...background.state, draft: { ...background.state.draft, limitations: [] } };
    background.changed();
  });
  await expect(page.getByRole('region', { name: 'Limitations' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
});

test('a save into full saved-journey storage lists saved journeys to delete, then saves', async ({ page }) => {
  const savedJourney = (journeyId: string, expected: string): Saved => ({
    journeyId, revision: 1, updatedAt: '2026-09-20T12:00:00.000Z', stepCount: 2, spansPages: false, expected,
  });
  await mountReview(page, reviewing([]), {
    ANMERKO_JOURNEY_SAVE: { ok: false, error: 'Journey command unavailable.', code: 'saved-journeys-full' },
  }, [
    // The reviewed journey's own saved copy is replaced by this save, so it makes no room.
    { ...savedJourney('journey-1', 'The order is placed.'), revision: 2 },
    savedJourney('saved-a', 'Checkout keeps the coupon.'),
    savedJourney('saved-b', 'Search finds the product.'),
  ]);
  const room = page.getByRole('region', { name: 'Saved journeys' });
  await expect(room).toHaveCount(0);
  await page.getByRole('checkbox', { name: /I understand this journey retains full URLs/ }).check();
  await page.getByRole('button', { name: 'Save journey' }).click();
  await expect(page.getByRole('alert'))
    .toHaveText('Saved journeys are full. Delete saved journeys to make room for this one, then save again.');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();

  // The review now offers what the message asks for, and nothing that leaves it.
  await expect(room.getByText('Delete journeys you no longer need, then save this one again.')).toBeVisible();
  await expect(room.locator('.journey-saved-title')).toHaveText(['Checkout keeps the coupon.', 'Search finds the product.']);
  await expect(room.getByRole('button', { name: /^Reopen/ })).toHaveCount(0);
  await room.getByRole('button', { name: /^Delete journey: Checkout keeps the coupon\./ }).click();
  // A background change while confirming keeps the confirmation.
  const lists = () => page.evaluate(() => (globalThis as any).background.messages
    .filter((message: { type: string }) => message.type === 'ANMERKO_JOURNEY_LIST').length);
  const listed = await lists();
  await page.evaluate(() => (globalThis as any).background.changed());
  await expect.poll(lists).toBe(listed + 1);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
  await room.getByRole('button', { name: /^Confirm delete journey: Checkout keeps the coupon\./ }).click();
  await expect(room.locator('.journey-saved-title')).toHaveText(['Search finds the product.']);
  expect(await page.evaluate(() => (globalThis as any).background.messages
    .filter((message: { type: string }) => message.type === 'ANMERKO_JOURNEY_DELETE_SNAPSHOT')))
    .toEqual([{ type: 'ANMERKO_JOURNEY_DELETE_SNAPSHOT', journeyId: 'saved-a', revision: 1 }]);
  await expect(page.getByRole('alert')).toBeEmpty();

  await page.evaluate(() => {
    const background = (globalThis as any).background;
    background.responses.ANMERKO_JOURNEY_SAVE = { ok: true, value: { journeyId: 'journey-1', revision: 3 } };
    background.state = { phase: 'saved', epoch: 3, journeyId: 'journey-1', revision: 3 };
  });
  await page.getByRole('button', { name: 'Save journey' }).click();
  await expect(page.getByRole('heading', { name: 'Journey saved' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Saved journeys' })).toHaveCount(0);
});
