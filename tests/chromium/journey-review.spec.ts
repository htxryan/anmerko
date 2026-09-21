import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';

const bundle = () => buildSync({ stdin: { contents: `
  import { mountJourneyUI } from './src/journey-ui';
  import styles from './src/journey.css';
  const style = document.createElement('style');
  style.textContent = styles;
  document.head.append(style);
  let state = { phase: 'idle', epoch: 0 };
  let changed = () => {};
  const summaryCalls = [];
  const removeCalls = [];
  let summaryError = null;
  let removeError = null;
  const client = {
    read: async () => state,
    start: async () => {},
    stop: async () => {},
    discard: async () => { state = { phase: 'idle', epoch: 9 }; changed(); },
    updateSummary: async (expected, actual) => {
      summaryCalls.push([expected, actual]);
      if (summaryError) throw summaryError;
      state = { ...state, draft: { ...state.draft, expected, actual, revision: state.draft.revision + 1 } };
      changed();
    },
    removeStep: async stepId => {
      removeCalls.push(stepId);
      if (removeError) throw removeError;
      state = { ...state, draft: { ...state.draft, steps: state.draft.steps.filter(step => step.id !== stepId), revision: state.draft.revision + 1 } };
      changed();
    },
    subscribe: listener => { changed = listener; return () => {}; },
  };
  const step = (id, seq, kind, image, extra) => ({
    id, seq, kind, observedAt: '2026-09-21T00:00:0' + seq + '.000Z', elapsedMs: (seq - 1) * 1000,
    sourceUrl: 'https://example.test/start', image, ...extra,
  });
  const reviewingDraft = steps => ({
    schemaVersion: 1, status: 'draft', id: 'J1', revision: 0,
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:03.000Z',
    startedAt: '2026-09-21T00:00:00.000Z', includeEnteredValues: false, stopReason: 'user',
    expected: '', actual: '', steps,
    images: {
      I1: { capturedAt: '2026-09-21T00:00:01.000Z', captureUrl: 'https://example.test/start', width: 8, height: 8, byteLength: 100, viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 0 } },
      I2: { capturedAt: '2026-09-21T00:00:02.000Z', captureUrl: 'https://example.test/start', width: 8, height: 8, byteLength: 100, viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 0 } },
    },
    limitations: [],
  });
  const reviewingSteps = () => [
    step('S1', 1, 'initial', { status: 'retained', imageId: 'I1' }),
    step('S2', 2, 'click', { status: 'retained', imageId: 'I2' }, { target: { label: 'Buy now' } }),
    step('S3', 3, 'navigation', { status: 'unavailable', reason: 'superseded' }, { navigation: { toUrl: 'https://example.test/checkout' } }),
  ];
  mountJourneyUI(document.body, client);
  window.journeyReviewHarness = {
    summaryCalls: () => summaryCalls,
    removeCalls: () => removeCalls,
    setReviewing: () => {
      summaryError = null; removeError = null;
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft: reviewingDraft(reviewingSteps()) };
      changed();
    },
    setUnreviewable: () => {
      summaryError = null; removeError = null;
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft: reviewingDraft([
          step('S1', 1, 'initial', { status: 'pending', captureId: 'C1' }),
          step('S2', 2, 'click', { status: 'unavailable', reason: 'superseded' }, { target: { label: 'Buy now' } }),
        ]) };
      changed();
    },
    failSummary: () => {
      summaryError = Object.assign(new Error('Another review tab changed this journey. Reload the review and try again.'), { code: 'stale-review' });
    },
  };
`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;

async function openReview(page: Page) {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyReviewHarness.setReviewing()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
}

test('expected and actual summaries persist through the client with live counters', async ({ page }) => {
  await openReview(page);
  const expected = page.getByLabel('Expected result');
  const actual = page.getByLabel('Actual result');
  await expect(expected).toHaveAttribute('maxlength', '4000');
  await expect(actual).toHaveAttribute('maxlength', '4000');
  await expect(page.getByText('0 / 4000 characters', { exact: true })).toHaveCount(2);
  await expected.pressSequentially('Shows checkout', { delay: 30 });
  await expect(page.getByText('14 / 4000 characters', { exact: true })).toBeVisible();
  await expect
    .poll(async () => page.evaluate('journeyReviewHarness.summaryCalls()'), { timeout: 10_000 })
    .toEqual([['Shows checkout', '']]);
  await actual.fill('Opens on time');
  await expect
    .poll(async () => page.evaluate('journeyReviewHarness.summaryCalls()'), { timeout: 10_000 })
    .toEqual([['Shows checkout', ''], ['Shows checkout', 'Opens on time']]);
});

test('step removal confirms inline and preserves sequence gaps', async ({ page }) => {
  await openReview(page);
  await page.getByRole('button', { name: 'Remove step 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm remove step 2', exact: true })).toBeVisible();
  expect(await page.evaluate('journeyReviewHarness.removeCalls()')).toEqual([]);
  await page.getByRole('button', { name: 'Confirm remove step 2', exact: true }).click();
  await expect
    .poll(async () => page.evaluate('journeyReviewHarness.removeCalls()'), { timeout: 10_000 })
    .toEqual(['S2']);
  await expect(page.getByRole('heading', { name: /Step 1 / })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Step 3 / })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Step 2 / })).toHaveCount(0);
});

test('save stays disabled until summaries and acknowledgement are ready', async ({ page }) => {
  await openReview(page);
  const save = page.getByRole('button', { name: 'Save journey', exact: true });
  await expect(save).toBeDisabled();
  await expect(page.getByText('Enter both an expected and an actual summary.', { exact: true })).toBeVisible();
  await expect(page.getByText('Acknowledge that full URLs and entered values are retained.', { exact: true })).toBeVisible();
  await page.getByLabel('Expected result').fill('Sharable summary');
  await page.getByLabel('Actual result').fill('Matches');
  await page.getByLabel('I understand this journey retains full URLs and any entered values.').check();
  await expect(page.getByText('Enter both an expected and an actual summary.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Acknowledge that full URLs and entered values are retained.', { exact: true })).toHaveCount(0);
  await expect(save).toBeDisabled();
  await expect(page.getByText('Saving is not available in this build. Review saving arrives next; your draft stays in this tab until then.', { exact: true })).toBeVisible();
});

test('save explains pending screenshots and missing retained steps', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyReviewHarness.setUnreviewable()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save journey', exact: true })).toBeDisabled();
  await expect(page.getByText('Keep at least one step with its screenshot.', { exact: true })).toBeVisible();
  await expect(page.getByText('Wait for pending screenshots to finish.', { exact: true })).toBeVisible();
});

test('acknowledgement checkbox state is visible and survives re-renders', async ({ page }) => {
  await openReview(page);
  const ack = page.getByLabel('I understand this journey retains full URLs and any entered values.');
  await expect(ack).not.toBeChecked();
  await ack.check();
  await expect(ack).toBeChecked();
  await page.getByLabel('Expected result').fill('Trigger a save re-render');
  await expect
    .poll(async () => Number(await page.evaluate('journeyReviewHarness.summaryCalls().length')), { timeout: 10_000 })
    .toBe(1);
  await expect(ack).toBeChecked();
});

test('failed summary updates surface the client message and keep typed text', async ({ page }) => {
  await openReview(page);
  await page.evaluate('journeyReviewHarness.failSummary()');
  await page.getByLabel('Expected result').fill('Typed before stale failure');
  await expect(page.getByRole('alert')).toHaveText('Another review tab changed this journey. Reload the review and try again.');
  await expect(page.getByLabel('Expected result')).toHaveValue('Typed before stale failure');
});

test('focus stays in the summary field across save re-renders', async ({ page }) => {
  await openReview(page);
  const expected = page.getByLabel('Expected result');
  await expected.fill('Focus survives refresh');
  await expect
    .poll(async () => Number(await page.evaluate('journeyReviewHarness.summaryCalls().length')), { timeout: 10_000 })
    .toBe(1);
  await expect(expected).toBeFocused();
});

test('review stays usable at 320 CSS px width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await openReview(page);
  await expect(page.getByLabel('Expected result')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove step 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save journey', exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
