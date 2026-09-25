import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFile } from 'node:fs/promises';

const bundle = () => buildSync({ stdin: { contents: `
  import { mountJourneyUI } from './src/journey-ui';
  import { JOURNEY_LIMITS as journeyLimits } from './src/journey-limits';
  import { journeySurfaceStyles as styles } from './src/journey-styles';
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
  const reviewImageCalls = [];
  let lastReplacement = null;
  let reviewImageError = null;
  // Held gates keep a screenshot change or save in flight until released.
  let reviewImageGate = null;
  let saveGate = null;
  const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
  let summaryError = null;
  let removeError = null;
  let saveError = null;
  let listResult = [];
  let listShouldFail = false;
  let openSnapshotError = null;
  let reopenError = null;
  let stayInReview = false;
  const openSnapshotCalls = [];
  const reopenCalls = [];
  const deleteCalls = [];
  let staleDeleteIds = [];
  let staleListResult = [];
  let failingDeleteIds = [];
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
    reviewImage: async (imageId, change) => {
      reviewImageCalls.push(change.operation === 'replace'
        ? { imageId, operation: 'replace', width: change.image.width, height: change.image.height,
          maskedCurrent: change.maskedFrom === state.draft.images[imageId]?.dataUrl }
        : { imageId, operation: 'remove' });
      if (reviewImageGate) await reviewImageGate.promise;
      if (reviewImageError) throw reviewImageError;
      const draft = state.draft;
      if (change.operation === 'replace') {
        lastReplacement = change.image.dataUrl;
        const image = { ...draft.images[imageId], dataUrl: change.image.dataUrl, byteLength: change.image.byteLength, redacted: true };
        state = { ...state, draft: { ...draft, images: { ...draft.images, [imageId]: image }, revision: draft.revision + 1 } };
      } else {
        const images = { ...draft.images };
        delete images[imageId];
        const steps = draft.steps.map(step => step.image.status === 'retained' && step.image.imageId === imageId
          ? { ...step, image: { status: 'removed' } } : step);
        state = { ...state, draft: { ...draft, images, steps, revision: draft.revision + 1 } };
      }
      changed();
    },
    save: async acknowledged => {
      saveCalls.push(acknowledged);
      if (saveGate) await saveGate.promise;
      if (saveError) throw saveError;
      const draft = state.draft;
      const result = stayInReview
        ? { journeyId: draft.id, revision: draft.revision }
        : { journeyId: draft.id, revision: draft.revision + 1 };
      if (!stayInReview) {
        state = { phase: 'saved', epoch: state.epoch + 1, journeyId: draft.id, revision: draft.revision + 1 };
      }
      changed();
      return result;
    },
    openSnapshot: async journeyId => {
      openSnapshotCalls.push(journeyId);
      if (openSnapshotError) throw openSnapshotError;
      const base = exportableDraft();
      const live = state.draft ?? base;
      const draft = { ...base, id: live.id, revision: live.revision, expected: live.expected, actual: live.actual };
      return { draft: structuredClone(draft), images: structuredClone(draft.images) };
    },
    reopen: async journeyId => {
      reopenCalls.push(journeyId);
      if (reopenError) throw reopenError;
    },
    deleteSnapshot: async (journeyId, revision) => {
      deleteCalls.push([journeyId, revision]);
      if (staleDeleteIds.includes(journeyId)) {
        listResult = structuredClone(staleListResult);
        throw Object.assign(new Error('Another review tab changed this journey. Reload the review and try again.'), { code: 'stale-review' });
      }
      if (failingDeleteIds.includes(journeyId)) throw new Error('boom-' + journeyId);
      listResult = listResult.filter(item => item.journeyId !== journeyId);
      changed();
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
  const MINIMAL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+AvzvAAAAAElFTkSuQmCC';
  const exportableDraft = () => ({
    schemaVersion: 1, status: 'draft', id: 'J1', revision: 4,
    createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:04.000Z',
    startedAt: '2026-09-20T12:00:00.000Z', stoppedAt: '2026-09-20T12:00:04.000Z',
    includeEnteredValues: true, stopReason: 'user',
    expected: 'The selected item remains in the cart.', actual: 'Checkout is empty after navigation.',
    steps: [
      {
        kind: 'click', id: 'S2', seq: 2, observedAt: '2026-09-20T12:00:01.210Z', elapsedMs: 1210,
        sourceUrl: 'https://shop.example/items?q=green',
        target: {
          tag: 'button', role: 'button', selectorPath: ['main', 'button:nth-of-type(2)'],
          label: 'Checkout', editable: false, viewport: { width: 1280, height: 720 },
          scroll: { x: 0, y: 300 }, point: { x: 1010, y: 650 },
        },
        image: { status: 'retained', imageId: 'I2' },
      },
      {
        kind: 'field-change', id: 'S4', seq: 7, observedAt: '2026-09-20T12:00:02.000Z', elapsedMs: 2000,
        sourceUrl: 'https://other.example/pay?q=green',
        target: {
          tag: 'input', selectorPath: ['input'], label: 'text field', editable: true,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 },
        },
        enteredValue: { kind: 'text', value: 'edited query', truncated: false, edited: true },
        image: { status: 'unavailable', reason: 'superseded' },
      },
    ],
    images: {
      I2: {
        capturedAt: '2026-09-20T12:00:01.600Z', captureUrl: 'https://shop.example/pay?q=green',
        width: 1, height: 1, byteLength: 69,
        dataUrl: MINIMAL_PNG,
        viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 },
      },
    },
    limitations: [],
  });
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
  // Real PNGs so the mask editor can open: 40×20, one solid color per image.
  const png = color => {
    const canvas = document.createElement('canvas');
    canvas.width = 40; canvas.height = 20;
    const context = canvas.getContext('2d');
    context.fillStyle = color;
    context.fillRect(0, 0, 40, 20);
    const dataUrl = canvas.toDataURL('image/png');
    return { dataUrl, width: 40, height: 20, byteLength: atob(dataUrl.split(',')[1]).length };
  };
  const imageDraft = () => {
    const draft = reviewingDraft([
      step('S1', 1, 'initial', { status: 'retained', imageId: 'I1' }),
      step('S2', 2, 'click', { status: 'retained', imageId: 'I2', sharedNavigationResult: true }, { target: { label: 'Checkout' } }),
      step('S3', 3, 'navigation', { status: 'retained', imageId: 'I2', sharedNavigationResult: true }, { navigation: { toUrl: 'https://example.test/checkout' } }),
    ]);
    draft.images.I1 = { ...draft.images.I1, ...png('rgb(200, 100, 50)') };
    draft.images.I2 = { ...draft.images.I2, ...png('rgb(40, 120, 200)') };
    return draft;
  };
  mountJourneyUI(document.body, client);
  window.journeyReviewHarness = {
    summaryCalls: () => summaryCalls,
    removeCalls: () => removeCalls,
    startCalls: () => startCalls,
    editCalls: () => editCalls,
    redactCalls: () => redactCalls,
    saveCalls: () => saveCalls,
    reviewImageCalls: () => reviewImageCalls,
    lastReplacement: () => lastReplacement,
    holdReviewImage: () => { reviewImageGate = gate(); },
    releaseReviewImage: () => { const held = reviewImageGate; reviewImageGate = null; held?.release(); },
    holdSave: () => { saveGate = gate(); },
    releaseSave: () => { const held = saveGate; saveGate = null; held?.release(); },
    failReviewImage: () => {
      reviewImageError = Object.assign(new Error('Another review tab changed this journey. Reload the review and try again.'), { code: 'stale-review' });
    },
    setReviewingWithImages: () => {
      reviewImageError = null;
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft: imageDraft() };
      changed();
    },
    openSnapshotCalls: () => openSnapshotCalls,
    reopenCalls: () => reopenCalls,
    deleteCalls: () => deleteCalls,
    setIdle: () => {
      summaryError = null; removeError = null; saveError = null;
      openSnapshotError = null; reopenError = null; stayInReview = false;
      state = { phase: 'idle', epoch: 9 };
      changed();
    },
    setReviewing: () => {
      summaryError = null; removeError = null; saveError = null;
      openSnapshotError = null; reopenError = null; stayInReview = false;
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft: reviewingDraft(reviewingSteps()) };
      changed();
    },
    setReviewingWithField: () => {
      summaryError = null; removeError = null; saveError = null;
      openSnapshotError = null; reopenError = null; stayInReview = false;
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft: reviewingDraft(reviewingStepsWithField()) };
      changed();
    },
    setReviewingWithAllValues: () => {
      summaryError = null; removeError = null; saveError = null;
      openSnapshotError = null; reopenError = null; stayInReview = false;
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft: reviewingDraft(reviewingStepsWithAllValues()) };
      changed();
    },
    setStopReason: reason => {
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z',
        draft: { ...reviewingDraft(reviewingSteps()), stopReason: reason } };
      changed();
    },
    setReviewingValuesOn: () => {
      summaryError = null; removeError = null; saveError = null;
      openSnapshotError = null; reopenError = null; stayInReview = false;
      const draft = reviewingDraft(reviewingSteps());
      draft.includeEnteredValues = true;
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft };
      changed();
    },
    setUnreviewable: () => {
      summaryError = null; removeError = null; saveError = null;
      openSnapshotError = null; reopenError = null; stayInReview = false;
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
    saveWithoutLeaving: () => { stayInReview = true; },
    failReopenBusy: () => {
      reopenError = Object.assign(new Error('Finish or discard the current journey before reopening a saved one.'), { code: 'busy' });
    },
    failOpenSnapshot: message => { openSnapshotError = new Error(message); },
    failDeleteStale: (journeyId, refreshed) => { staleDeleteIds = [journeyId]; staleListResult = refreshed; },
    failDeleteIds: ids => { failingDeleteIds = ids; },
    clearDeleteFailures: () => { staleDeleteIds = []; failingDeleteIds = []; },
    shrinkExportLimit: () => { journeyLimits.maxExportBytes = 10; },
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

async function openImageReview(page: Page) {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyReviewHarness.setReviewingWithImages()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
}

const stepItem = (page: Page, seq: number) =>
  page.locator('li', { has: page.getByRole('heading', { name: new RegExp(`^Step ${seq} `) }) });
const IMAGE_HELP = 'Mask part of this screenshot or remove it before saving. Masks cannot be undone.';

test('screenshot masking opens from the keyboard, applies through the client, and returns focus', async ({ page }) => {
  await openImageReview(page);
  await expect(page.getByText('Keep, mask, or remove this screenshot during full image review.')).toHaveCount(0);
  await expect(stepItem(page, 1).getByText(IMAGE_HELP, { exact: true })).toBeVisible();
  const mask = page.getByRole('button', { name: 'Mask screenshot for step 1', exact: true });
  await expect(mask).toHaveAccessibleDescription(IMAGE_HELP);
  await page.getByLabel('Actual result').focus();
  await page.keyboard.press('Tab');
  await expect(mask).toBeFocused();

  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Mask screenshot' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Mask sensitive details' })).toBeFocused();
  // The shared surface stylesheet styles the dialog, not just the review list.
  expect(await dialog.evaluate(element => getComputedStyle(element).borderTopLeftRadius)).toBe('12px');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(mask).toBeFocused();
  expect(await page.evaluate('journeyReviewHarness.reviewImageCalls()')).toEqual([]);

  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('spinbutton', { name: 'X', exact: true }).fill('0');
  await dialog.getByRole('spinbutton', { name: 'Y', exact: true }).fill('0');
  await dialog.getByRole('spinbutton', { name: 'Width', exact: true }).fill('10');
  await dialog.getByRole('spinbutton', { name: 'Height', exact: true }).fill('5');
  await dialog.getByRole('button', { name: 'Apply mask', exact: true }).click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.reviewImageCalls()'), { timeout: 10_000 })
    .toEqual([{ imageId: 'I1', operation: 'replace', width: 40, height: 20, maskedCurrent: true }]);
  await expect(dialog).toHaveCount(0);
  await expect(stepItem(page, 1).getByText('Masked during review.', { exact: true })).toBeVisible();
  await expect(stepItem(page, 2).getByText('Masked during review.', { exact: true })).toHaveCount(0);
  await expect(mask).toBeFocused();
  await expect(mask).toHaveAccessibleDescription(`Masked during review. ${IMAGE_HELP}`);
  await expect(stepItem(page, 1).getByRole('status')).toHaveText('Screenshot for step 1 masked.');
  const pixels = await page.evaluate(async () => {
    const dataUrl = (globalThis as any).journeyReviewHarness.lastReplacement();
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(bitmap, 0, 0);
    return [Array.from(context.getImageData(9, 4, 1, 1).data), Array.from(context.getImageData(10, 5, 1, 1).data)];
  });
  expect(pixels).toEqual([[0, 0, 0, 255], [200, 100, 50, 255]]);
});

test('removing a shared screenshot confirms inline, names every affected step, and keeps focus on the step', async ({ page }) => {
  await openImageReview(page);
  const note = 'Steps 2 and 3 share this screenshot. Masking or removing it changes all of them.';
  await expect(stepItem(page, 2).getByText(note, { exact: true })).toBeVisible();
  await expect(stepItem(page, 3).getByText(note, { exact: true })).toBeVisible();
  await expect(stepItem(page, 1).getByText(note, { exact: true })).toHaveCount(0);
  // The shared-step warning adds to the usual help instead of replacing it.
  await expect(stepItem(page, 2).getByText(IMAGE_HELP, { exact: true })).toBeVisible();
  await expect(stepItem(page, 3).getByText(IMAGE_HELP, { exact: true })).toBeVisible();
  const remove = page.getByRole('button', { name: 'Remove screenshot for step 2', exact: true });
  await expect(remove).toHaveAccessibleDescription(note);
  await expect(page.getByRole('button', { name: 'Mask screenshot for step 3', exact: true })).toHaveAccessibleDescription(`${IMAGE_HELP} ${note}`);

  await remove.focus();
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('button', { name: 'Confirm remove screenshot for step 2', exact: true });
  await expect(confirm).toBeFocused();
  await expect(confirm).toHaveAccessibleDescription(note);
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(remove).toBeFocused();
  await remove.click();
  await page.getByRole('button', { name: 'Keep screenshot for step 2', exact: true }).click();
  await expect(remove).toBeFocused();
  expect(await page.evaluate('journeyReviewHarness.reviewImageCalls()')).toEqual([]);

  await remove.click();
  await confirm.click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.reviewImageCalls()'), { timeout: 10_000 })
    .toEqual([{ imageId: 'I2', operation: 'remove' }]);
  await expect(stepItem(page, 2).getByText('Screenshot unavailable: removed during review.', { exact: true })).toBeVisible();
  await expect(stepItem(page, 3).getByText('Screenshot unavailable: removed during review.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Step 2 / })).toBeFocused();
  await expect(stepItem(page, 2).getByRole('status')).toHaveText('Screenshot for steps 2 and 3 removed.');
  await expect(page.getByRole('button', { name: /screenshot for step [23]$/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Mask screenshot for step 1', exact: true })).toBeVisible();
});

test('the mask editor repeats the shared-step warning and its Remove applies to every step', async ({ page }) => {
  await openImageReview(page);
  await page.getByRole('button', { name: 'Mask screenshot for step 3', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Mask screenshot' });
  await expect(dialog.getByText('Steps 2 and 3 share this screenshot. Masking or removing it changes all of them.', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Remove screenshot', exact: true }).click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.reviewImageCalls()'), { timeout: 10_000 })
    .toEqual([{ imageId: 'I2', operation: 'remove' }]);
  await expect(dialog).toHaveCount(0);
  await expect(stepItem(page, 2).getByText('Screenshot unavailable: removed during review.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Step 3 / })).toBeFocused();
});

test('a rejected screenshot change keeps the image and reports the client message', async ({ page }) => {
  await openImageReview(page);
  await page.evaluate('journeyReviewHarness.failReviewImage()');
  const mask = page.getByRole('button', { name: 'Mask screenshot for step 1', exact: true });
  await mask.click();
  const dialog = page.getByRole('dialog', { name: 'Mask screenshot' });
  await dialog.getByRole('spinbutton', { name: 'X', exact: true }).fill('1');
  await dialog.getByRole('spinbutton', { name: 'Y', exact: true }).fill('1');
  await dialog.getByRole('spinbutton', { name: 'Width', exact: true }).fill('4');
  await dialog.getByRole('spinbutton', { name: 'Height', exact: true }).fill('4');
  await dialog.getByRole('button', { name: 'Apply mask', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Another review tab changed this journey. Reload the review and try again.');
  await expect(stepItem(page, 1).getByText('Masked during review.', { exact: true })).toHaveCount(0);
  await expect(mask).toBeFocused();
});

test('save and its acknowledgement wait for a pending screenshot change, which never takes focus from a reader who moved on', async ({ page }) => {
  await openImageReview(page);
  await page.getByLabel('Expected result').fill('Card details stay private.');
  await page.getByLabel('Actual result').fill('The card number was visible.');
  const ack = page.getByLabel('I understand this journey retains full URLs, any entered values, and its kept screenshots.');
  await ack.check();
  const save = page.getByRole('button', { name: 'Save journey', exact: true });
  await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(true);

  await page.evaluate('journeyReviewHarness.holdReviewImage()');
  const mask = page.getByRole('button', { name: 'Mask screenshot for step 1', exact: true });
  await mask.click();
  const dialog = page.getByRole('dialog', { name: 'Mask screenshot' });
  await dialog.getByRole('spinbutton', { name: 'X', exact: true }).fill('0');
  await dialog.getByRole('spinbutton', { name: 'Y', exact: true }).fill('0');
  await dialog.getByRole('spinbutton', { name: 'Width', exact: true }).fill('10');
  await dialog.getByRole('spinbutton', { name: 'Height', exact: true }).fill('5');
  await dialog.getByRole('button', { name: 'Apply mask', exact: true }).click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.reviewImageCalls().length'), { timeout: 10_000 }).toBe(1);
  // Saving now would store the unmasked pixels, so both save controls wait.
  await expect(save).toBeDisabled();
  await expect(ack).toBeDisabled();
  await expect(ack).toBeChecked();
  await expect(mask).toBeDisabled();
  await save.click({ force: true });
  expect(await page.evaluate('journeyReviewHarness.saveCalls()')).toEqual([]);

  const actual = page.getByLabel('Actual result');
  await actual.focus();
  await page.evaluate('journeyReviewHarness.releaseReviewImage()');
  await expect(stepItem(page, 1).getByText('Masked during review.', { exact: true })).toBeVisible();
  await expect(stepItem(page, 1).getByRole('status')).toHaveText('Screenshot for step 1 masked.');
  await expect(actual).toBeFocused();
  await expect(ack).toBeEnabled();
  await expect(ack).toBeChecked();
  await expect(save).toBeEnabled();
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog', { name: 'Mask screenshot' })).toHaveCount(0);
});

test('screenshot controls wait while a save is in flight', async ({ page }) => {
  await openImageReview(page);
  await page.getByLabel('Expected result').fill('Card details stay private.');
  await page.getByLabel('Actual result').fill('The card number was visible.');
  await page.getByLabel('I understand this journey retains full URLs, any entered values, and its kept screenshots.').check();
  const save = page.getByRole('button', { name: 'Save journey', exact: true });
  await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(true);
  await page.evaluate('journeyReviewHarness.holdSave()');
  await save.click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.saveCalls()'), { timeout: 10_000 }).toEqual([true]);
  for (const name of ['Mask screenshot for step 1', 'Remove screenshot for step 1', 'Mask screenshot for step 2', 'Remove screenshot for step 3']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
  }
  await page.getByRole('button', { name: 'Mask screenshot for step 1', exact: true }).click({ force: true });
  await expect(page.getByRole('dialog', { name: 'Mask screenshot' })).toHaveCount(0);
  await page.evaluate('journeyReviewHarness.releaseSave()');
  await expect(page.getByRole('heading', { name: 'Journey saved' })).toBeVisible();
  expect(await page.evaluate('journeyReviewHarness.reviewImageCalls()')).toEqual([]);
});

test('review explains a stop that left the starting site', async ({ page }) => {
  await openReview(page);
  await page.evaluate('journeyReviewHarness.setStopReason("left-site")');
  await expect(page.getByText('Recording ended because the page left the site you started on. Steps recorded there are kept; start a new journey from the toolbar to record somewhere else.', { exact: true })).toBeVisible();
});

test('review shows a navigation destination alongside its source URL', async ({ page }) => {
  await openReview(page);
  const destination = page.getByText('https://example.test/checkout', { exact: true });
  await expect(page.getByText('Destination URL', { exact: true })).toHaveCount(1);
  await expect(destination).toBeVisible();
  const step3 = page.locator('li', { has: page.getByRole('heading', { name: /Step 3 / }) });
  await expect(step3.getByText('Source URL', { exact: true })).toBeVisible();
  await expect(step3.getByText('Destination URL', { exact: true })).toBeVisible();
  // Clicks carry only their source URL: no destination label leaks to them.
  const step2 = page.locator('li', { has: page.getByRole('heading', { name: /Step 2 / }) });
  await expect(step2.getByText('Destination URL', { exact: true })).toHaveCount(0);
});

test('save stays disabled until summaries and acknowledgement are ready', async ({ page }) => {
  await openReview(page);
  const save = page.getByRole('button', { name: 'Save journey', exact: true });
  await expect(save).toBeDisabled();
  await expect(page.getByText('Enter both an expected and an actual summary.', { exact: true })).toBeVisible();
  await expect(page.getByText('Acknowledge that full URLs, entered values, and kept screenshots are retained.', { exact: true })).toBeVisible();
  await page.getByLabel('Expected result').fill('Sharable summary');
  await page.getByLabel('Actual result').fill('Matches');
  await page.getByLabel('I understand this journey retains full URLs, any entered values, and its kept screenshots.').check();
  await expect(page.getByText('Enter both an expected and an actual summary.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Acknowledge that full URLs, entered values, and kept screenshots are retained.', { exact: true })).toHaveCount(0);
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
  const ack = page.getByLabel('I understand this journey retains full URLs, any entered values, and its kept screenshots.');
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
  await page.getByLabel('I understand this journey retains full URLs, any entered values, and its kept screenshots.').check();
  await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(true);
  await save.click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.saveCalls()'), { timeout: 10_000 }).toEqual([true]);
  await expect(page.getByRole('heading', { name: 'Journey saved' })).toBeVisible();
  await expect(page.getByText(/Journey J1 saved \(revision \d+\)\./, { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to comments', exact: true })).toBeVisible();
});

test('saved journeys list once each with spans scope and a reopen action', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  await page.evaluate(`journeyReviewHarness.setList([
    { journeyId: 'J1', revision: 2, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 3, spansPages: true },
    { journeyId: 'J2', revision: 1, updatedAt: '2026-09-21T02:00:00.000Z', stepCount: 1, spansPages: false },
  ])`);
  const saved = page.getByRole('region', { name: 'Saved journeys' });
  await expect(saved).toBeVisible();
  await expect(saved.getByText('Journey J1 · revision 2 · 3 steps · updated 2026-09-21T01:00:00.000Z', { exact: false })).toBeVisible();
  await expect(saved.getByText('Journey J2 · revision 1 · 1 step · updated 2026-09-21T02:00:00.000Z', { exact: false })).toBeVisible();
  await expect(saved.getByText('Spans pages', { exact: true })).toHaveCount(1);
  await expect(saved.locator('li')).toHaveCount(2);
  await expect(page.getByText('Reopening a saved journey for editing arrives next.', { exact: true })).toHaveCount(0);
  await saved.getByRole('button', { name: 'Reopen journey J1', exact: true }).click();
  await expect
    .poll(async () => page.evaluate('journeyReviewHarness.reopenCalls()'), { timeout: 10_000 })
    .toEqual(['J1']);
});

test('reopen surfaces busy errors without leaving the saved list', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  await page.evaluate(`journeyReviewHarness.setList([
    { journeyId: 'J1', revision: 2, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 3, spansPages: false },
  ])`);
  await page.evaluate('journeyReviewHarness.failReopenBusy()');
  await page.getByRole('button', { name: 'Reopen journey J1', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Finish or discard the current journey before reopening a saved one.');
  await expect(page.getByRole('heading', { name: 'Saved journeys' })).toBeVisible();
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
  await page.getByLabel('I understand this journey retains full URLs, any entered values, and its kept screenshots.').check();
  const save = page.getByRole('button', { name: 'Save journey', exact: true });
  await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(true);
  await save.click();
  await expect(page.getByRole('alert')).toHaveText('Another review tab changed this journey. Reload the review and try again.');
  await expect(page.getByLabel('Expected result')).toHaveValue('Typed before stale save');
  await expect(page.getByLabel('Actual result')).toHaveValue('Actual stays');
});

function centralDirectoryNames(bytes: Buffer): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= 0; offset--) {
    if (view.getUint32(offset, true) === 0x06054b50) { end = offset; break; }
  }
  if (end < 0) throw new Error('ZIP end of central directory not found');
  const count = view.getUint16(end + 8, true);
  let offset = view.getUint32(end + 16, true);
  const names: string[] = [];
  for (let index = 0; index < count; index++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('ZIP central directory entry not found');
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    names.push(Buffer.from(bytes.subarray(offset + 46, offset + 46 + nameLength)).toString('utf8'));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

async function saveReviewWithoutLeaving(page: Page) {
  await openReview(page);
  await page.evaluate('journeyReviewHarness.saveWithoutLeaving()');
  await page.getByLabel('Expected result').fill('Keeps the item in the cart.');
  await expect
    .poll(async () => Number(await page.evaluate('journeyReviewHarness.summaryCalls().length')), { timeout: 10_000 })
    .toBe(1);
  await page.getByLabel('Actual result').fill('Checkout is empty.');
  await expect
    .poll(async () => Number(await page.evaluate('journeyReviewHarness.summaryCalls().length')), { timeout: 10_000 })
    .toBe(2);
  await page.getByLabel('I understand this journey retains full URLs, any entered values, and its kept screenshots.').check();
  const save = page.getByRole('button', { name: 'Save journey', exact: true });
  await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(true);
  await save.click();
  await expect(page.getByRole('button', { name: 'Copy Prompt', exact: true })).toBeEnabled({ timeout: 10_000 });
}

test('export buttons stay disabled with a save-first note until the review is saved', async ({ page }) => {
  await openReview(page);
  await expect(page.getByRole('button', { name: 'Copy Prompt', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download Markdown + Images', exact: true })).toBeDisabled();
  await expect(page.getByText('Save first to copy or download this journey.', { exact: true })).toBeVisible();
});

test('a successful save enables export until the next edit', async ({ page }) => {
  await saveReviewWithoutLeaving(page);
  const copy = page.getByRole('button', { name: 'Copy Prompt', exact: true });
  const download = page.getByRole('button', { name: 'Download Markdown + Images', exact: true });
  await expect(copy).toBeEnabled();
  await expect(download).toBeEnabled();
  await expect(page.getByText('Save first to copy or download this journey.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove step 3', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm remove step 3', exact: true }).click();
  await expect(copy).toBeDisabled();
  await expect(page.getByText('Save first to copy or download this journey.', { exact: true })).toBeVisible();
});

test('copy writes the saved journey prompt with its id and summaries', async ({ page, context }) => {
  await saveReviewWithoutLeaving(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4173' });
  await page.getByRole('button', { name: 'Copy Prompt', exact: true }).click();
  await expect(page.getByText('Journey prompt copied. Download the images to attach them with the prompt.', { exact: true })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain('## Recorded journeys');
  expect(text).toContain('J1');
  expect(text).toContain('Keeps the item in the cart.');
  expect(await page.evaluate('journeyReviewHarness.openSnapshotCalls()')).toEqual(['J1']);
});

test('copy failure offers download without throwing', async ({ page }) => {
  await saveReviewWithoutLeaving(page);
  await page.evaluate(`Object.defineProperty(navigator.clipboard, 'writeText', {
    value: () => Promise.reject(new Error('Simulated clipboard denial')), configurable: true })`);
  await page.getByRole('button', { name: 'Copy Prompt', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Could not copy the journey prompt. Use Download Markdown + Images to export this journey.');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
});

test('download produces a ZIP with journeys.md and the PNG', async ({ page }) => {
  await saveReviewWithoutLeaving(page);
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Markdown + Images', exact: true }).click();
  const archive = await downloading;
  expect(archive.suggestedFilename()).toBe('journey-J1.zip');
  const bytes = await readFile((await archive.path())!);
  expect(centralDirectoryNames(bytes)).toEqual(['comments.md', 'journeys.md', 'journey-2-J1-image-2-I2.png']);
  expect(bytes.includes(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
  await expect(page.getByText('Journey download started. Extract the ZIP and attach its images with the prompt.', { exact: true })).toBeVisible();
});

test('download surfaces the export size limit and keeps the review', async ({ page }) => {
  await saveReviewWithoutLeaving(page);
  await page.evaluate('journeyReviewHarness.shrinkExportLimit()');
  await page.getByRole('button', { name: 'Download Markdown + Images', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Journey export exceeds the export size limit.');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download Markdown + Images', exact: true })).toBeEnabled();
});

test('export controls stay usable at 320 CSS px width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await saveReviewWithoutLeaving(page);
  await expect(page.getByRole('button', { name: 'Copy Prompt', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download Markdown + Images', exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

const savedItems = () => ([
  { journeyId: 'J1', revision: 2, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 3, spansPages: true },
  { journeyId: 'J2', revision: 1, updatedAt: '2026-09-21T02:00:00.000Z', stepCount: 1, spansPages: false },
]);

async function openIdleWithSaved(page: Page, items: unknown[]) {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  await page.evaluate(`journeyReviewHarness.setList(${JSON.stringify(items)})`);
  await expect(page.getByRole('region', { name: 'Saved journeys' })).toBeVisible();
}

test('saved journey delete confirms inline and removes the row with id and revision', async ({ page }) => {
  await openIdleWithSaved(page, savedItems());
  const saved = page.getByRole('region', { name: 'Saved journeys' });
  await saved.getByRole('button', { name: 'Delete journey J1', exact: true }).click();
  await expect(saved.getByRole('button', { name: 'Confirm delete journey J1', exact: true })).toBeVisible();
  expect(await page.evaluate('journeyReviewHarness.deleteCalls()')).toEqual([]);
  await saved.getByRole('button', { name: 'Confirm delete journey J1', exact: true }).click();
  await expect
    .poll(async () => page.evaluate('journeyReviewHarness.deleteCalls()'), { timeout: 10_000 })
    .toEqual([['J1', 2]]);
  await expect(saved.locator('li')).toHaveCount(1);
  await expect(saved.getByText('Journey J1 ·', { exact: false })).toHaveCount(0);
  await expect(saved.getByText('Journey J2 · revision 1 · 1 step · updated 2026-09-21T02:00:00.000Z', { exact: false })).toBeVisible();
});

test('delete confirm disarms with keep or Escape without calling delete', async ({ page }) => {
  await openIdleWithSaved(page, savedItems());
  const saved = page.getByRole('region', { name: 'Saved journeys' });
  await saved.getByRole('button', { name: 'Delete journey J1', exact: true }).click();
  await saved.getByRole('button', { name: 'Keep journey J1', exact: true }).click();
  await expect(saved.getByRole('button', { name: 'Confirm delete journey J1', exact: true })).toHaveCount(0);
  expect(await page.evaluate('journeyReviewHarness.deleteCalls()')).toEqual([]);
  await saved.getByRole('button', { name: 'Delete journey J1', exact: true }).click();
  const confirm = saved.getByRole('button', { name: 'Confirm delete journey J1', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.focus();
  await page.keyboard.press('Escape');
  await expect(saved.getByRole('button', { name: 'Confirm delete journey J1', exact: true })).toHaveCount(0);
  await expect(saved.getByRole('button', { name: 'Delete journey J1', exact: true })).toBeFocused();
  expect(await page.evaluate('journeyReviewHarness.deleteCalls()')).toEqual([]);
  await expect(saved.locator('li')).toHaveCount(2);
});

test('stale delete reloads the list and explains the change', async ({ page }) => {
  await openIdleWithSaved(page, savedItems());
  const refreshed = [
    { journeyId: 'J1', revision: 3, updatedAt: '2026-09-21T03:00:00.000Z', stepCount: 4, spansPages: true },
    { journeyId: 'J2', revision: 1, updatedAt: '2026-09-21T02:00:00.000Z', stepCount: 1, spansPages: false },
  ];
  await page.evaluate(`journeyReviewHarness.failDeleteStale('J1', ${JSON.stringify(refreshed)})`);
  const saved = page.getByRole('region', { name: 'Saved journeys' });
  await saved.getByRole('button', { name: 'Delete journey J1', exact: true }).click();
  await saved.getByRole('button', { name: 'Confirm delete journey J1', exact: true }).click();
  await expect
    .poll(async () => page.evaluate('journeyReviewHarness.deleteCalls()'), { timeout: 10_000 })
    .toEqual([['J1', 2]]);
  await expect(page.getByRole('alert')).toHaveText('A saved journey changed. The list was reloaded; try again.');
  await expect(saved.getByText('revision 3', { exact: false })).toBeVisible();
  await expect(saved.locator('li')).toHaveCount(2);
});

test('delete all confirms scope and count, then deletes every journey', async ({ page }) => {
  await openIdleWithSaved(page, savedItems());
  const saved = page.getByRole('region', { name: 'Saved journeys' });
  await saved.getByRole('button', { name: 'Delete all journeys', exact: true }).click();
  await expect(saved.getByText('Delete 2 saved journeys? This cannot be undone.', { exact: true })).toBeVisible();
  expect(await page.evaluate('journeyReviewHarness.deleteCalls()')).toEqual([]);
  await saved.getByRole('button', { name: 'Confirm delete all journeys', exact: true }).click();
  await expect
    .poll(async () => page.evaluate('journeyReviewHarness.deleteCalls()'), { timeout: 10_000 })
    .toEqual([['J1', 2], ['J2', 1]]);
  await expect(saved.getByText('Deleted 2 of 2 journeys.', { exact: true })).toBeVisible();
  await expect(page.getByText('No saved journeys yet.', { exact: true })).toBeVisible();
});

test('delete all reports partial failures by id without raw errors', async ({ page }) => {
  await openIdleWithSaved(page, savedItems());
  await page.evaluate(`journeyReviewHarness.failDeleteIds(['J2'])`);
  const saved = page.getByRole('region', { name: 'Saved journeys' });
  await saved.getByRole('button', { name: 'Delete all journeys', exact: true }).click();
  await saved.getByRole('button', { name: 'Confirm delete all journeys', exact: true }).click();
  await expect
    .poll(async () => page.evaluate('journeyReviewHarness.deleteCalls()'), { timeout: 10_000 })
    .toEqual([['J1', 2], ['J2', 1]]);
  await expect(saved.getByText('Deleted 1 of 2 journeys.', { exact: true })).toBeVisible();
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('Could not delete journey J2.');
  await expect(alert).not.toContainText('boom');
  await expect(saved.locator('li')).toHaveCount(1);
  await expect(saved.getByText('Journey J2 · revision 1 · 1 step · updated 2026-09-21T02:00:00.000Z', { exact: false })).toBeVisible();
});

test('delete all cancel leaves every journey alone', async ({ page }) => {
  await openIdleWithSaved(page, savedItems());
  const saved = page.getByRole('region', { name: 'Saved journeys' });
  await saved.getByRole('button', { name: 'Delete all journeys', exact: true }).click();
  await expect(saved.getByText('Delete 2 saved journeys? This cannot be undone.', { exact: true })).toBeVisible();
  await saved.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate('journeyReviewHarness.deleteCalls()')).toEqual([]);
  await expect(saved.getByText('Delete 2 saved journeys? This cannot be undone.', { exact: true })).toHaveCount(0);
  await expect(saved.locator('li')).toHaveCount(2);
});

test('delete controls stay usable at 320 CSS px width', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 700 });
  await openIdleWithSaved(page, savedItems());
  const saved = page.getByRole('region', { name: 'Saved journeys' });
  await saved.getByRole('button', { name: 'Delete journey J1', exact: true }).click();
  await expect(saved.getByRole('button', { name: 'Confirm delete journey J1', exact: true })).toBeVisible();
  await saved.getByRole('button', { name: 'Keep journey J1', exact: true }).click();
  await saved.getByRole('button', { name: 'Delete all journeys', exact: true }).click();
  await expect(saved.getByText('Delete 2 saved journeys? This cannot be undone.', { exact: true })).toBeVisible();
  await expect(saved.getByRole('button', { name: 'Confirm delete all journeys', exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('expired review returns to launch with no stale actions', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyReviewHarness.setReviewing()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await page.evaluate(`journeyReviewHarness.setList(${JSON.stringify(savedItems())})`);
  // The session store purges an expired review without readback, so the next
  // read reports idle and the open surface must fall back to launch.
  await page.evaluate('journeyReviewHarness.setIdle()');
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save journey', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Discard journey', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Remove step 1', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Saved journeys' })).toBeVisible();
});
