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
  const startCalls = [];
  const editCalls = [];
  const redactCalls = [];
  const saveCalls = [];
  let summaryError = null;
  let removeError = null;
  let saveError = null;
  let listResult = [];
  let listShouldFail = false;
  const client = {
    supportsEnteredValues: true,
    read: async () => state,
    start: async includeEnteredValues => { startCalls.push(includeEnteredValues); },
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
    editValue: async (stepId, value) => {
      editCalls.push([stepId, structuredClone(value)]);
      state = { ...state, draft: { ...state.draft, steps: state.draft.steps.map(step => step.id === stepId ? { ...step, enteredValue: { ...structuredClone(value), edited: true } } : step), revision: state.draft.revision + 1 } };
      changed();
    },
    redactUrl: async (stepId, kind) => {
      redactCalls.push([stepId, kind]);
      const draft = state.draft;
      if (kind === 'source') {
        const redactions = draft.redactions ?? { steps: {} };
        state = { ...state, draft: { ...draft, steps: draft.steps.map(step => step.id === stepId ? { ...step, sourceUrl: '[redacted]' } : step), redactions: { steps: { ...redactions.steps, [stepId]: { ...redactions.steps[stepId], sourceUrl: true } } }, revision: draft.revision + 1 } };
      } else {
        const step = draft.steps.find(s => s.id === stepId);
        const imageId = step?.image?.imageId;
        const redactions = draft.redactions ?? { steps: {} };
        state = { ...state, draft: { ...draft, images: { ...draft.images, [imageId]: { ...draft.images[imageId], captureUrl: '[redacted]' } }, redactions: { steps: { ...redactions.steps, [stepId]: { ...redactions.steps[stepId], captureUrl: true } } }, revision: draft.revision + 1 } };
      }
      changed();
    },
    save: async acknowledged => {
      saveCalls.push(acknowledged);
      if (saveError) throw saveError;
      const draft = state.draft;
      const result = { journeyId: draft.id, revision: draft.revision + 1 };
      state = { phase: 'saved', epoch: state.epoch + 1, journeyId: draft.id, revision: draft.revision + 1 };
      changed();
      return result;
    },
    list: async () => {
      if (listShouldFail) throw new Error('Could not load saved journeys.');
      return structuredClone(listResult);
    },
    subscribe: listener => { changed = listener; return () => {}; },
  };
  const step = (id, seq, kind, image, extra) => ({
    id, seq, kind, observedAt: '2026-09-21T00:00:0' + seq + '.000Z', elapsedMs: (seq - 1) * 1000,
    sourceUrl: 'https://example.test/start', image, ...extra,
  });
  const fieldStep = (id, seq, enteredValue) => ({
    id, seq, kind: 'field-change', observedAt: '2026-09-21T00:00:0' + seq + '.000Z', elapsedMs: (seq - 1) * 1000,
    sourceUrl: 'https://example.test/form?next=1#form',
    target: { tag: 'input', selectorPath: ['input'], label: 'Email', editable: true, viewport: { width: 800, height: 600 }, scroll: { x: 0, y: 0 } },
    enteredValue, image: { status: 'unavailable', reason: 'superseded' },
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
  const reviewingStepsWithField = () => [
    step('S1', 1, 'initial', { status: 'retained', imageId: 'I1' }),
    step('S2', 2, 'click', { status: 'retained', imageId: 'I2' }, { target: { label: 'Buy now' } }),
    fieldStep('F1', 4, { kind: 'text', value: 'original search', truncated: false }),
  ];
  const reviewingStepsWithAllValues = () => [
    step('S1', 1, 'initial', { status: 'retained', imageId: 'I1' }),
    fieldStep('F1', 4, { kind: 'text', value: 'original search', truncated: false }),
    { ...fieldStep('F2', 5, { kind: 'selection', values: ['Green'], multiple: false, truncated: false }) },
    { ...fieldStep('F3', 6, { kind: 'checked', checked: true }) },
  ];
  mountJourneyUI(document.body, client);
  window.journeyReviewHarness = {
    summaryCalls: () => summaryCalls,
    removeCalls: () => removeCalls,
    startCalls: () => startCalls,
    editCalls: () => editCalls,
    redactCalls: () => redactCalls,
    saveCalls: () => saveCalls,
    setIdle: () => {
      summaryError = null; removeError = null; saveError = null;
      state = { phase: 'idle', epoch: 9 };
      changed();
    },
    setReviewing: () => {
      summaryError = null; removeError = null; saveError = null;
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft: reviewingDraft(reviewingSteps()) };
      changed();
    },
    setReviewingWithField: () => {
      summaryError = null; removeError = null; saveError = null;
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft: reviewingDraft(reviewingStepsWithField()) };
      changed();
    },
    setReviewingWithAllValues: () => {
      summaryError = null; removeError = null; saveError = null;
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft: reviewingDraft(reviewingStepsWithAllValues()) };
      changed();
    },
    setReviewingValuesOn: () => {
      summaryError = null; removeError = null; saveError = null;
      const draft = reviewingDraft(reviewingSteps());
      draft.includeEnteredValues = true;
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft };
      changed();
    },
    setUnreviewable: () => {
      summaryError = null; removeError = null; saveError = null;
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft: reviewingDraft([
          step('S1', 1, 'initial', { status: 'pending', captureId: 'C1' }),
          step('S2', 2, 'click', { status: 'unavailable', reason: 'superseded' }, { target: { label: 'Buy now' } }),
        ]) };
      changed();
    },
    setList: items => { listResult = items; listShouldFail = false; changed(); },
    failList: () => { listShouldFail = true; changed(); },
    failSummary: () => {
      summaryError = Object.assign(new Error('Another review tab changed this journey. Reload the review and try again.'), { code: 'stale-review' });
    },
    failSaveStale: () => {
      saveError = Object.assign(new Error('Another review tab changed this journey. Reload the review and try again.'), { code: 'stale-review' });
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
  await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(true);
  await expect(page.getByText('This review is ready to save.', { exact: true })).toBeVisible();
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

test('launch toggle defaults off, passes true through start, and resets after an enabled journey', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  const toggle = page.getByLabel('Include entered values');
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText('Screenshots and full URLs can contain personal information, even when entered values are off. Review and remove sensitive details before sharing.', { exact: true })).toBeVisible();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.startCalls()'), { timeout: 10_000 }).toEqual([true]);
  await page.evaluate('journeyReviewHarness.setReviewingValuesOn()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await page.evaluate('journeyReviewHarness.setIdle()');
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  await expect(page.getByLabel('Include entered values')).not.toBeChecked();
});

test('value edit persists through the client and marks edited', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyReviewHarness.setReviewingWithField()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await expect(page.getByText('original search', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit value for step 4', exact: true }).click();
  const editor = page.getByLabel('Edit entered value for step 4');
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue('original search');
  await editor.fill('edited search');
  await page.getByRole('button', { name: 'Save value for step 4', exact: true }).click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.editCalls()'), { timeout: 10_000 })
    .toEqual([[ 'F1', { kind: 'text', value: 'edited search', truncated: false } ]]);
  await expect(page.getByText('edited search', { exact: true })).toBeVisible();
  await expect(page.getByText('Edited during review.', { exact: true }).first()).toBeVisible();
});

test('value removal clears through the client', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyReviewHarness.setReviewingWithField()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove value for step 4', exact: true }).click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.editCalls()'), { timeout: 10_000 })
    .toEqual([[ 'F1', { kind: 'text', value: '', truncated: false } ]]);
  await expect(page.getByText('Edited during review.', { exact: true }).first()).toBeVisible();
});

test('selection and checked values render matching controls', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyReviewHarness.setReviewingWithAllValues()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit value for step 5', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit value for step 6', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit value for step 6', exact: true }).click();
  await expect(page.getByLabel('Edit entered value for step 6')).toBeVisible();
});

test('URL redact buttons call with step id and kind and show redacted marker', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyReviewHarness.setReviewing()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await page.getByRole('button', { name: 'Redact source URL for step 1', exact: true }).click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.redactCalls()'), { timeout: 10_000 })
    .toEqual([[ 'S1', 'source' ]]);
  await expect(page.getByText('[redacted]', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Redacted during review.', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Redact image URL for step 1', exact: true }).click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.redactCalls()'), { timeout: 10_000 })
    .toEqual([[ 'S1', 'source' ], [ 'S1', 'capture' ]]);
});

test('save enables when ready, saves with acknowledgement, and shows confirmation', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyReviewHarness.setReviewing()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  const save = page.getByRole('button', { name: 'Save journey', exact: true });
  await expect(save).toBeDisabled();
  await page.getByLabel('Expected result').fill('Keeps the item in the cart.');
  await page.getByLabel('Actual result').fill('Checkout is empty.');
  await page.getByLabel('I understand this journey retains full URLs and any entered values.').check();
  await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(true);
  await save.click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.saveCalls()'), { timeout: 10_000 }).toEqual([true]);
  await expect(page.getByRole('heading', { name: 'Journey saved' })).toBeVisible();
  await expect(page.getByText(/Journey J1 saved \(revision \d+\)\./, { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to comments', exact: true })).toBeVisible();
});

test('saved list renders summaries read-only with reopening note', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  await page.evaluate(`journeyReviewHarness.setList([
    { journeyId: 'J1', revision: 2, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 3 },
    { journeyId: 'J2', revision: 1, updatedAt: '2026-09-21T02:00:00.000Z', stepCount: 1 },
  ])`);
  await expect(page.getByRole('heading', { name: 'Saved journeys' })).toBeVisible();
  await expect(page.getByText('Journey J1 · revision 2 · 3 steps · updated 2026-09-21T01:00:00.000Z', { exact: true })).toBeVisible();
  await expect(page.getByText('Journey J2 · revision 1 · 1 step · updated 2026-09-21T02:00:00.000Z', { exact: true })).toBeVisible();
  await expect(page.getByText('Reopening a saved journey for editing arrives next.', { exact: true })).toBeVisible();
});

test('saved list hides when loading fails without an error wall', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  await page.evaluate('journeyReviewHarness.failList()');
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Saved journeys' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('stale save keeps typed summaries', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyReviewHarness.setReviewing()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await page.evaluate('journeyReviewHarness.failSaveStale()');
  await page.getByLabel('Expected result').fill('Typed before stale save');
  await page.getByLabel('Actual result').fill('Actual stays');
  await page.getByLabel('I understand this journey retains full URLs and any entered values.').check();
  const save = page.getByRole('button', { name: 'Save journey', exact: true });
  await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(true);
  await save.click();
  await expect(page.getByRole('alert')).toHaveText('Another review tab changed this journey. Reload the review and try again.');
  await expect(page.getByLabel('Expected result')).toHaveValue('Typed before stale save');
  await expect(page.getByLabel('Actual result')).toHaveValue('Actual stays');
});
