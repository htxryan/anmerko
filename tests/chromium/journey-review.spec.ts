import { expect, test, type Locator, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { STOP_REASONS } from '../../src/journey-limits';

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
  // [phase, journey under review, journey the text was typed in] per summary write.
  const summaryTargets = [];
  const removeCalls = [];
  const startCalls = [];
  const editCalls = [];
  const redactCalls = [];
  const saveCalls = [];
  const savedSummaries = [];
  const reviewImageCalls = [];
  let lastReplacement = null;
  let reviewImageError = null;
  // Held gates keep a screenshot change or save in flight until released.
  let reviewImageGate = null;
  let saveGate = null;
  let summaryGate = null;
  let listCalls = 0;
  const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
  // Like the extension client, edits refused while a save holds the review say so.
  const savingError = () => Object.assign(new Error('This journey is being saved. Wait for the save to finish, then try again.'), { code: 'save-in-progress' });
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
  let startError = null;
  let startHook = null;
  let firefox = false;
  let startable = true;
  let reopenInto = null;
  const client = {
    supportsEnteredValues: true,
    get pageLoadsEndJourney() { return firefox; },
    canStart: () => startable,
    read: async () => state,
    start: async includeEnteredValues => {
      startCalls.push(includeEnteredValues);
      startHook?.();
      if (startError) throw new Error(startError);
    },
    stop: async () => {},
    discard: async () => { state = { phase: 'idle', epoch: 9 }; changed(); },
    updateSummary: async (expected, actual, journeyId) => {
      summaryCalls.push([expected, actual]);
      summaryTargets.push([state.phase, state.draft?.id ?? null, journeyId ?? null]);
      if (summaryGate) await summaryGate.promise;
      // Like the extension client, text typed in another journey is refused.
      if (journeyId !== undefined && state.journeyId !== journeyId) {
        throw Object.assign(new Error('Another review tab changed this journey. Reload the review and try again.'), { code: 'stale-review' });
      }
      if (state.phase === 'saving') throw savingError();
      if (summaryError) throw summaryError;
      state = { ...state, draft: { ...state.draft, expected, actual, revision: state.draft.revision + 1 } };
      changed();
    },
    removeStep: async stepId => {
      removeCalls.push(stepId);
      if (state.phase === 'saving') throw savingError();
      if (removeError) throw removeError;
      state = { ...state, draft: { ...state.draft, steps: state.draft.steps.filter(step => step.id !== stepId), revision: state.draft.revision + 1 } };
      changed();
    },
    editValue: async (stepId, value) => {
      editCalls.push([stepId, structuredClone(value)]);
      if (state.phase === 'saving') throw savingError();
      state = { ...state, draft: { ...state.draft, steps: state.draft.steps.map(step => step.id === stepId ? { ...step, enteredValue: { ...structuredClone(value), edited: true } } : step), revision: state.draft.revision + 1 } };
      changed();
    },
    redactUrl: async (stepId, kind) => {
      redactCalls.push([stepId, kind]);
      if (state.phase === 'saving') throw savingError();
      const draft = state.draft;
      if (kind === 'source') {
        const redactions = draft.redactions ?? { steps: {} };
        state = { ...state, draft: { ...draft, steps: draft.steps.map(step => step.id === stepId ? { ...step, sourceUrl: '[redacted]' } : step), redactions: { steps: { ...redactions.steps, [stepId]: { ...redactions.steps[stepId], sourceUrl: true } } }, revision: draft.revision + 1 } };
      } else if (kind === 'destination') {
        const redactions = draft.redactions ?? { steps: {} };
        state = { ...state, draft: { ...draft, steps: draft.steps.map(step => step.id === stepId ? { ...step, navigation: { ...step.navigation, toUrl: '[redacted]' } } : step), redactions: { steps: { ...redactions.steps, [stepId]: { ...redactions.steps[stepId], toUrl: true } } }, revision: draft.revision + 1 } };
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
      if (state.phase === 'saving') { reviewImageCalls.pop(); throw savingError(); }
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
      savedSummaries.push([draft.expected, draft.actual]);
      const result = stayInReview
        ? { journeyId: draft.id, revision: draft.revision }
        : { journeyId: draft.id, revision: draft.revision + 1 };
      if (!stayInReview) {
        state = { phase: 'saved', epoch: state.epoch + 1, journeyId: draft.id, revision: draft.revision + 1 };
      }
      // Like the real store, a save lists the journey at its saved revision.
      listResult = [
        { journeyId: draft.id, revision: result.revision, updatedAt: draft.updatedAt, stepCount: draft.steps.length, spansPages: false, expected: draft.expected },
        ...listResult.filter(item => item.journeyId !== draft.id),
      ];
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
      if (reopenInto) { state = reopenInto(); changed(); }
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
      listCalls += 1;
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
    summaryTargets: () => summaryTargets,
    removeCalls: () => removeCalls,
    startCalls: () => startCalls,
    editCalls: () => editCalls,
    redactCalls: () => redactCalls,
    saveCalls: () => saveCalls,
    savedSummaries: () => savedSummaries,
    reviewImageCalls: () => reviewImageCalls,
    lastReplacement: () => lastReplacement,
    holdReviewImage: () => { reviewImageGate = gate(); },
    releaseReviewImage: () => { const held = reviewImageGate; reviewImageGate = null; held?.release(); },
    holdSave: () => { saveGate = gate(); },
    holdSummary: () => { summaryGate = gate(); },
    releaseSummary: () => { const held = summaryGate; summaryGate = null; held?.release(); },
    listCalls: () => listCalls,
    state: () => state,
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
    failStart: message => { startError = message; },
    // Runs inside Start, as the background does when it switches to the website tab.
    onStart: hook => { startHook = hook; },
    setFirefox: value => { firefox = value; changed(); },
    setStartable: value => { startable = value; changed(); },
    // Reopening a saved journey lands in review at its saved revision.
    reopenIntoReview: () => {
      reopenInto = () => ({ phase: 'reviewing', epoch: 1, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z',
        draft: { ...reviewingDraft(reviewingSteps()), revision: 2, expected: 'Checkout keeps the item', actual: 'It is empty' } });
    },
    setRecording: count => {
      const draft = reviewingDraft(reviewingSteps().slice(0, count));
      state = { phase: 'recording', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        documentToken: 'D', deadlineAt: '2026-09-21T00:05:00.000Z', documentCounters: {}, draft };
      changed();
    },
    // A different journey under review, as after this one was saved or
    // discarded elsewhere and another was reopened or recorded.
    setReviewingOther: () => {
      const draft = reviewingDraft([
        step('T1', 1, 'initial', { status: 'retained', imageId: 'I1' }),
        step('T2', 2, 'click', { status: 'retained', imageId: 'I2' }, { target: { label: 'Pay now' } }),
      ]);
      state = { phase: 'reviewing', epoch: 12, sessionId: 'SESS2', journeyId: 'J2', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft: { ...draft, id: 'J2' } };
      changed();
    },
    setReviewingSteps: count => {
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft: reviewingDraft(reviewingSteps().slice(0, count)) };
      changed();
    },
    // One portrait phone capture and one landscape desktop capture.
    setReviewingWithSizedImages: (portrait = [390, 844]) => {
      const draft = reviewingDraft([
        step('S1', 1, 'initial', { status: 'retained', imageId: 'I1' }),
        step('S2', 2, 'click', { status: 'retained', imageId: 'I2' }, { target: { label: 'Checkout' } }),
      ]);
      const sized = (width, height) => {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d');
        context.fillStyle = 'rgb(40, 120, 200)';
        context.fillRect(0, 0, width, height);
        context.fillStyle = 'rgb(200, 30, 30)';
        context.fillRect(0, height - 40, width, 40);
        const dataUrl = canvas.toDataURL('image/png');
        return { dataUrl, width, height, byteLength: atob(dataUrl.split(',')[1]).length };
      };
      draft.images.I1 = { ...draft.images.I1, ...sized(portrait[0], portrait[1]) };
      draft.images.I2 = { ...draft.images.I2, ...sized(1280, 720) };
      state = { phase: 'reviewing', epoch: 2, sessionId: 'SESS', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
        warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z', draft };
      changed();
    },
    // Another surface's save holds the review, then fails back to it or completes.
    setSavingSilently: () => {
      const { warningAt, expiresAt, ...owner } = state;
      state = { ...owner, phase: 'saving' };
    },
    setSaving: () => {
      const { warningAt, expiresAt, ...owner } = state;
      state = { ...owner, phase: 'saving' };
      changed();
    },
    failSaving: () => {
      state = { ...state, phase: 'reviewing', warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z' };
      changed();
    },
    completeSaving: () => {
      state = { phase: 'saved', epoch: state.epoch + 1, journeyId: state.draft.id, revision: state.draft.revision + 1 };
      changed();
    },
    removeImage: imageId => {
      const draft = state.draft;
      const images = { ...draft.images };
      delete images[imageId];
      state = { ...state, draft: { ...draft, images, revision: draft.revision + 1,
        steps: draft.steps.map(step => step.image.status === 'retained' && step.image.imageId === imageId ? { ...step, image: { status: 'removed' } } : step) } };
      changed();
    },
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
  await expect(page.getByRole('button', { name: 'View full-size screenshot for step 1', exact: true })).toBeFocused();
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

test('review explains a stop that left the starting origin and how to record elsewhere', async ({ page }) => {
  await openReview(page);
  await page.evaluate('journeyReviewHarness.setStopReason("left-site")');
  // The toolbar reopens this review while it is pending, so it must be resolved first.
  const text = 'Recording ended because the page left the website you started on. A different domain, subdomain, or port, or a switch between http and https, counts as leaving. Steps recorded before then are kept. To record the other website, save or discard this review first, then open anmerko from the toolbar there.';
  await expect(page.locator('.journey-stop-reason')).toHaveText(text);
  await expect(page.locator('.journey-live [aria-live="polite"]')).toHaveText(text);
});

test('review explains withdrawn page access after a page load', async ({ page }) => {
  await openReview(page);
  await page.evaluate('journeyReviewHarness.setStopReason("page-access-lost")');
  const text = "Recording ended because the browser withdrew anmerko's access when the page reloaded or opened another page. Firefox does this on every page load, even on the same website. Steps recorded before then are kept. The new page has no screenshot. To record more, save or discard this review first, then open anmerko from the toolbar on the current page and start a new journey.";
  await expect(page.locator('.journey-stop-reason')).toHaveText(text);
  await expect(page.locator('.journey-live [aria-live="polite"]')).toHaveText(text);
});

test('review explains every stop reason in a notice, announcing storage failure assertively', async ({ page }) => {
  await openReview(page);
  const notices = new Set<string>();
  let previous = '';
  const polite = page.locator('.journey-live [aria-live="polite"]');
  const urgent = page.locator('.journey-live [aria-live="assertive"]');
  for (const reason of STOP_REASONS) {
    await page.evaluate(`journeyReviewHarness.setStopReason(${JSON.stringify(reason)})`);
    const notice = page.locator('.journey-stop-reason');
    await expect(notice).toHaveCount(1);
    // Each reason has its own explanation, rendered in place of the last one.
    await expect(notice).not.toHaveText(previous);
    // The notice is styled as one, not muted help, and the persistent live
    // region announces it instead of a status node rebuilt on every render.
    await expect(notice).toHaveClass(/journey-notice/);
    await expect(notice).not.toHaveAttribute('role', /.+/);
    previous = (await notice.textContent()) ?? '';
    const storage = reason === 'session-storage-limit';
    await expect(storage ? urgent : polite).toHaveText(previous);
    await expect(storage ? polite : urgent).toHaveText('');
    expect(previous, reason).toMatch(/^(Recording|Journey storage|You stopped)/);
    notices.add(previous);
  }
  expect(notices.size).toBe(STOP_REASONS.length);
});

test('a stop notice is announced once and survives re-renders without being re-announced', async ({ page }) => {
  await openReview(page);
  await page.evaluate('journeyReviewHarness.setStopReason("focus-lost")');
  const polite = page.locator('.journey-live [aria-live="polite"]');
  await expect(polite).toHaveText(/^Recording ended because the recorded tab lost focus/);
  // Clearing the region proves later renders leave it alone.
  await polite.evaluate(element => { element.textContent = ''; });
  await page.getByLabel('Expected result').fill('Typing re-renders the review');
  await expect
    .poll(async () => Number(await page.evaluate('journeyReviewHarness.summaryCalls().length')), { timeout: 10_000 })
    .toBe(1);
  await expect(page.locator('.journey-stop-reason')).toHaveText(/^Recording ended because the recorded tab lost focus/);
  await expect(polite).toHaveText('');
  await page.evaluate('journeyReviewHarness.setIdle()');
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  await expect(page.locator('.journey-live')).toHaveText('');
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
  const step1 = page.locator('li', { has: page.getByRole('heading', { name: /^Step 1 / }) });
  await expect(step1.getByText('[redacted]', { exact: true })).toBeVisible();
  // The marker names the field it replaced and takes focus from the Redact button.
  const sourceMarker = step1.getByText('Source URL redacted during review.', { exact: true });
  await expect(sourceMarker).toBeFocused();
  await expect(page.getByRole('button', { name: 'Redact source URL for step 1', exact: true })).toHaveCount(0);
  // It sits directly after the redacted source URL, before the screenshot URL.
  expect(await sourceMarker.evaluate(element => element.previousElementSibling?.textContent)).toBe('[redacted]');
  await page.getByRole('button', { name: 'Redact screenshot URL for step 1', exact: true }).click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.redactCalls()'), { timeout: 10_000 })
    .toEqual([[ 'S1', 'source' ], [ 'S1', 'capture' ]]);
  await expect(step1.getByText('Screenshot URL redacted during review.', { exact: true })).toBeFocused();
  await expect(step1.getByText('Redacted during review.', { exact: true })).toHaveCount(0);
});

test('destination redact button appears only for navigation steps and redacts only the destination', async ({ page }) => {
  await openReview(page);
  const navigation = page.getByRole('listitem').filter({ hasText: 'Step 3 · Navigation' });
  await expect(navigation.getByText('https://example.test/checkout', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Redact destination URL/ })).toHaveCount(1);
  await page.getByRole('button', { name: 'Redact destination URL for step 3', exact: true }).click();
  await expect.poll(async () => page.evaluate('journeyReviewHarness.redactCalls()'), { timeout: 10_000 })
    .toEqual([['S3', 'destination']]);
  await expect(navigation.getByText('[redacted]', { exact: true })).toBeVisible();
  await expect(navigation.getByText('https://example.test/checkout', { exact: true })).toHaveCount(0);
  await expect(navigation.getByText('Destination URL redacted during review.', { exact: true })).toBeFocused();
  await expect(navigation.getByText('Source URL redacted during review.', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Redact destination URL/ })).toHaveCount(0);
  await expect(navigation.getByText('https://example.test/start', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Redact source URL for step 3', exact: true })).toBeEnabled();
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
  const heading = page.getByRole('heading', { name: 'Journey saved' });
  await expect(heading).toBeFocused();
  // A friendly confirmation names the journey by its summary, never its raw ID.
  await expect(page.getByText('“Keeps the item in the cart.” is saved. Reopen, share, or delete it any time from Saved journeys.', { exact: true })).toBeVisible();
  await expect(page.locator('.journey-view')).not.toContainText('J1');
  await expect(page.locator('.journey-view')).not.toContainText('revision');
  // The saved screen offers distinct actions: share this revision or record another.
  await expect(page.getByRole('button', { name: 'Back to comments' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy Prompt', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Download Markdown + Images', exact: true })).toBeEnabled();
  await expect(page.getByText('Save first to copy or download this journey.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Record another journey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeFocused();
});

test('a surface that cannot start again closes the saved screen with Done', async ({ page }) => {
  await openReview(page);
  await page.evaluate('journeyReviewHarness.setStartable(false)');
  await page.getByLabel('Expected result').fill('Keeps the item in the cart.');
  await page.getByLabel('Actual result').fill('Checkout is empty.');
  await page.getByLabel('I understand this journey retains full URLs, any entered values, and its kept screenshots.').check();
  const save = page.getByRole('button', { name: 'Save journey', exact: true });
  await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(true);
  await save.click();
  await expect(page.getByRole('heading', { name: 'Journey saved' })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Record another journey', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeFocused();
  await expect(page.getByText(/^To record a new journey, go to the website tab/)).toBeVisible();
});

test('the saved screen copies and downloads the saved revision', async ({ page, context }) => {
  await openReview(page);
  await page.getByLabel('Expected result').fill('Keeps the item in the cart.');
  await page.getByLabel('Actual result').fill('Checkout is empty.');
  await page.getByLabel('I understand this journey retains full URLs, any entered values, and its kept screenshots.').check();
  const save = page.getByRole('button', { name: 'Save journey', exact: true });
  await expect.poll(async () => save.isEnabled(), { timeout: 10_000 }).toBe(true);
  await save.click();
  await expect(page.getByRole('heading', { name: 'Journey saved' })).toBeVisible();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:4173' });
  await page.getByRole('button', { name: 'Copy Prompt', exact: true }).click();
  await expect(page.getByText('Journey prompt copied. Download the images to attach them with the prompt.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('## Recorded journeys');
  await expect(page.getByRole('button', { name: 'Copy Prompt', exact: true })).toBeFocused();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Markdown + Images', exact: true }).click();
  expect((await downloading).suggestedFilename()).toBe('journey-J1.zip');
  expect(await page.evaluate('journeyReviewHarness.openSnapshotCalls()')).toEqual(['J1', 'J1']);
});

test('saved journeys list once each with a human label, local time, spans scope, and a reopen action', async ({ page }) => {
  await openIdleWithSaved(page, savedItems());
  const saved = page.getByRole('region', { name: 'Saved journeys' });
  const [first, second] = await page.evaluate(() => ['2026-09-21T01:00:00.000Z', '2026-09-21T02:00:00.000Z']
    .map(iso => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(Date.parse(iso))));
  await expect(saved.locator('.journey-saved-title')).toHaveText(['Checkout keeps the item', 'Journey on shop.example/cart']);
  await expect(saved.locator('.journey-saved-meta')).toHaveText([`Saved ${first} · 3 steps · Spans pages`, `Saved ${second} · 1 step`]);
  await expect(saved.locator('time').first()).toHaveAttribute('datetime', '2026-09-21T01:00:00.000Z');
  // Raw IDs and ISO timestamps stay out of visible text.
  await expect(saved).not.toContainText('J1');
  await expect(saved).not.toContainText('2026-09-21T');
  await expect(saved.getByText('Spans pages', { exact: true })).toHaveCount(1);
  await expect(saved.locator('li')).toHaveCount(2);
  // Short visible labels keep descriptive, unique accessible names.
  const reopen = saved.getByRole('button', { name: `Reopen journey: Checkout keeps the item, saved ${first}`, exact: true });
  await expect(reopen).toHaveText('Reopen');
  await expect(saved.getByRole('button', { name: `Delete journey: Journey on shop.example/cart, saved ${second}`, exact: true })).toHaveText('Delete');
  await reopen.click();
  await expect
    .poll(async () => page.evaluate('journeyReviewHarness.reopenCalls()'), { timeout: 10_000 })
    .toEqual(['J1']);
});

test('saved journeys fall back to an untitled label and keep identical names distinct', async ({ page }) => {
  await openIdleWithSaved(page, [
    { journeyId: 'J1', revision: 0, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 2, spansPages: false },
    { journeyId: 'J2', revision: 0, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 2, spansPages: false },
  ]);
  const saved = page.getByRole('region', { name: 'Saved journeys' });
  await expect(saved.locator('.journey-saved-title')).toHaveText(['Untitled journey', 'Untitled journey']);
  await expect(saved.getByRole('button', { name: /^Reopen journey: Untitled journey, saved .+ \(1 of 2\)$/ })).toHaveCount(1);
  await expect(saved.getByRole('button', { name: /^Reopen journey: Untitled journey, saved .+ \(2 of 2\)$/ })).toHaveCount(1);
});

test('saved journeys lay out without overflow or tall buttons at narrow widths', async ({ page }) => {
  for (const width of [200, 320, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await openIdleWithSaved(page, savedItems());
    const saved = page.getByRole('region', { name: 'Saved journeys' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${width}px`).toBeLessThanOrEqual(0);
    for (const button of await saved.getByRole('button').all()) {
      // A single line of text stays under two lines tall.
      expect((await button.boundingBox())!.height, `${width}px ${await button.textContent()}`).toBeLessThanOrEqual(48);
    }
    // Rows and Delete all share one left edge.
    const lefts = await saved.evaluate(section => [
      ...Array.from(section.querySelectorAll('.journey-saved-title'), element => element.getBoundingClientRect().left),
      section.querySelector('.journey-saved-delete-all button')!.getBoundingClientRect().left,
    ]);
    expect(new Set(lefts).size, `${width}px`).toBe(1);
    const meta = saved.locator('.journey-saved-meta').first();
    // Separators never form their own flex items.
    expect(await meta.evaluate(element => getComputedStyle(element).display)).toBe('block');
    const colors = await saved.getByRole('button', { name: /^Delete journey:/ }).first().evaluate(element => getComputedStyle(element).color);
    expect(colors).toBe('rgb(177, 68, 63)');
  }
});

test('reopen surfaces busy errors without leaving the saved list', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  await page.evaluate(`journeyReviewHarness.setList([
    { journeyId: 'J1', revision: 2, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 3, spansPages: false, expected: 'Checkout keeps the item' },
  ])`);
  await page.evaluate('journeyReviewHarness.failReopenBusy()');
  const reopen = page.getByRole('button', { name: /^Reopen journey: Checkout keeps the item/ });
  await reopen.click();
  await expect(page.getByRole('alert')).toHaveText('Finish or discard the current journey before reopening a saved one.');
  await expect(page.getByRole('heading', { name: 'Saved journeys' })).toBeVisible();
  await expect(reopen).toBeFocused();
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
  { journeyId: 'J1', revision: 2, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 3, spansPages: true, expected: 'Checkout keeps the item' },
  { journeyId: 'J2', revision: 1, updatedAt: '2026-09-21T02:00:00.000Z', stepCount: 1, spansPages: false, startPage: 'shop.example/cart' },
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
  await saved.getByRole('button', { name: /^Delete journey: Checkout keeps the item, saved / }).click();
  await expect(saved.getByRole('button', { name: /^Confirm delete journey: Checkout keeps the item, saved / })).toBeVisible();
  expect(await page.evaluate('journeyReviewHarness.deleteCalls()')).toEqual([]);
  await saved.getByRole('button', { name: /^Confirm delete journey: Checkout keeps the item, saved / }).click();
  await expect
    .poll(async () => page.evaluate('journeyReviewHarness.deleteCalls()'), { timeout: 10_000 })
    .toEqual([['J1', 2]]);
  await expect(saved.locator('li')).toHaveCount(1);
  await expect(saved.getByText('Checkout keeps the item', { exact: true })).toHaveCount(0);
  await expect(saved.getByText('Journey on shop.example/cart', { exact: true })).toBeVisible();
  // The removed row's controls are gone; focus lands on the next row.
  await expect(saved.getByRole('button', { name: /^Reopen journey: Journey on shop\.example\/cart/ })).toBeFocused();
});

test('delete confirm disarms with keep or Escape without calling delete', async ({ page }) => {
  await openIdleWithSaved(page, savedItems());
  const saved = page.getByRole('region', { name: 'Saved journeys' });
  await saved.getByRole('button', { name: /^Delete journey: Checkout keeps the item, saved / }).click();
  await saved.getByRole('button', { name: /^Keep journey: Checkout keeps the item, saved / }).click();
  await expect(saved.getByRole('button', { name: /^Confirm delete journey: Checkout keeps the item, saved / })).toHaveCount(0);
  expect(await page.evaluate('journeyReviewHarness.deleteCalls()')).toEqual([]);
  await saved.getByRole('button', { name: /^Delete journey: Checkout keeps the item, saved / }).click();
  const confirm = saved.getByRole('button', { name: /^Confirm delete journey: Checkout keeps the item, saved / });
  await expect(confirm).toBeVisible();
  await confirm.focus();
  await page.keyboard.press('Escape');
  await expect(saved.getByRole('button', { name: /^Confirm delete journey: Checkout keeps the item, saved / })).toHaveCount(0);
  await expect(saved.getByRole('button', { name: /^Delete journey: Checkout keeps the item, saved / })).toBeFocused();
  expect(await page.evaluate('journeyReviewHarness.deleteCalls()')).toEqual([]);
  await expect(saved.locator('li')).toHaveCount(2);
});

test('stale delete reloads the list and explains the change', async ({ page }) => {
  await openIdleWithSaved(page, savedItems());
  const refreshed = [
    { journeyId: 'J1', revision: 3, updatedAt: '2026-09-21T03:00:00.000Z', stepCount: 4, spansPages: true, expected: 'Checkout keeps the item' },
    { journeyId: 'J2', revision: 1, updatedAt: '2026-09-21T02:00:00.000Z', stepCount: 1, spansPages: false, startPage: 'shop.example/cart' },
  ];
  await page.evaluate(`journeyReviewHarness.failDeleteStale('J1', ${JSON.stringify(refreshed)})`);
  const saved = page.getByRole('region', { name: 'Saved journeys' });
  await saved.getByRole('button', { name: /^Delete journey: Checkout keeps the item, saved / }).click();
  await saved.getByRole('button', { name: /^Confirm delete journey: Checkout keeps the item, saved / }).click();
  await expect
    .poll(async () => page.evaluate('journeyReviewHarness.deleteCalls()'), { timeout: 10_000 })
    .toEqual([['J1', 2]]);
  await expect(page.getByRole('alert')).toHaveText('A saved journey changed. The list was reloaded; try again.');
  await expect(saved.getByText(/4 steps/)).toBeVisible();
  await expect(saved.locator('li')).toHaveCount(2);
  await expect(saved.getByRole('button', { name: /^Delete journey: Checkout keeps the item/ })).toBeFocused();
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
  await expect(saved.getByRole('heading', { name: 'Saved journeys' })).toBeFocused();
});

test('delete all reports partial failures by name without raw errors', async ({ page }) => {
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
  await expect(alert).toHaveText('Could not delete “Journey on shop.example/cart”.');
  await expect(alert).not.toContainText('boom');
  await expect(saved.locator('li')).toHaveCount(1);
  await expect(saved.getByText('Journey on shop.example/cart', { exact: true })).toBeVisible();
  await expect(saved.getByRole('button', { name: 'Delete all journeys', exact: true })).toBeFocused();
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
  await saved.getByRole('button', { name: /^Delete journey: Checkout keeps the item, saved / }).click();
  await expect(saved.getByRole('button', { name: /^Confirm delete journey: Checkout keeps the item, saved / })).toBeVisible();
  await saved.getByRole('button', { name: /^Keep journey: Checkout keeps the item, saved / }).click();
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

async function openIdle(page: Page) {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
}

test('a failed start shows its error beside Start, announces it, keeps focus there, and clears on return', async ({ page }) => {
  await openIdle(page);
  await page.evaluate(`journeyReviewHarness.setList(${JSON.stringify(savedItems())})`);
  await expect(page.getByRole('region', { name: 'Saved journeys' })).toBeVisible();
  const message = 'anmerko could not reach the website tab. On that tab, click anmerko in the browser toolbar or Extensions menu, then try again.';
  await page.evaluate(`journeyReviewHarness.failStart(${JSON.stringify(message)})`);
  const start = page.getByRole('button', { name: 'Start journey', exact: true });
  await start.click();
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText(message);
  await expect(start).toBeFocused();
  await expect(start).toHaveAccessibleDescription(message);
  // The error follows Start directly, above the saved list, so it is seen where the reader acted.
  const shown = page.locator('.journey-view').getByText(message, { exact: true });
  const [startBox, shownBox, savedBox] = await Promise.all([start.boundingBox(), shown.boundingBox(),
    page.getByRole('region', { name: 'Saved journeys' }).boundingBox()]);
  expect(shownBox!.y).toBeGreaterThan(startBox!.y);
  expect(shownBox!.y + shownBox!.height).toBeLessThan(savedBox!.y);
  expect(shownBox!.y - (startBox!.y + startBox!.height)).toBeLessThan(40);
  // Coming back to the surface clears the stale error.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(alert).toHaveCount(0);
  await expect(shown).toHaveCount(0);
});

// Fakes page visibility and document focus, as a journey tab sees them while
// the background shows the website tab.
async function fakeVisibility(page: Page) {
  await page.evaluate(() => {
    let visible = true;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible ? 'visible' : 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => !visible });
    document.hasFocus = () => visible;
    (window as any).setVisible = (value: boolean) => {
      visible = value;
      document.dispatchEvent(new Event('visibilitychange'));
      if (value) window.dispatchEvent(new Event('focus'));
    };
  });
}

test('a start error is announced once and survives launch re-renders without a new alert', async ({ page }) => {
  await openIdle(page);
  const message = 'The initial journey screenshot failed. Try again.';
  await page.evaluate(`journeyReviewHarness.failStart(${JSON.stringify(message)})`);
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(message);
  // The visible error is plain text; the one alert lives outside the re-rendered view.
  await expect(page.locator('.journey-view [role="alert"]')).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).alertsAdded = 0;
    new MutationObserver(records => {
      for (const record of records) {
        for (const added of Array.from(record.addedNodes)) {
          if (added instanceof Element && (added.matches('[role="alert"]') || added.querySelector('[role="alert"]'))) (window as any).alertsAdded++;
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await page.evaluate(`journeyReviewHarness.setList(${JSON.stringify(savedItems())})`);
  await expect(page.getByRole('region', { name: 'Saved journeys' })).toBeVisible();
  await expect(page.locator('.journey-view').getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(message);
  expect(await page.evaluate(() => (window as any).alertsAdded)).toBe(0);
});

test('a start error clears once another view replaces the launch view', async ({ page }) => {
  await openIdle(page);
  const message = 'The initial journey screenshot failed. Try again.';
  await page.evaluate(`journeyReviewHarness.failStart(${JSON.stringify(message)})`);
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(message);
  // A review opened elsewhere, then discarded here, returns to a launch view without the old error.
  await page.evaluate('journeyReviewHarness.setReviewing()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Discard journey', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm discard journey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeFocused();
  await expect(page.getByText(message, { exact: true })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).not.toHaveAttribute('aria-describedby');
});

test('a start that fails while the surface is hidden keeps its error until the reader returns to see it', async ({ page }) => {
  await openIdle(page);
  await fakeVisibility(page);
  const message = 'anmerko could not reach the website tab. On that tab, click anmerko in the browser toolbar or Extensions menu, then try again.';
  await page.evaluate(`journeyReviewHarness.failStart(${JSON.stringify(message)})`);
  // The background switches to the website tab before the start fails.
  await page.evaluate('journeyReviewHarness.onStart(() => setVisible(false))');
  const start = page.getByRole('button', { name: 'Start journey', exact: true });
  await start.click();
  const shown = page.locator('.journey-view').getByText(message, { exact: true });
  await expect(shown).toBeAttached();
  // Nothing is announced to a hidden surface, and focus is not taken there.
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(start).not.toBeFocused();
  // Returning shows, announces, and focuses the failed start instead of clearing it.
  await page.evaluate('journeyReviewHarness.onStart(null)');
  await page.evaluate(() => (window as any).setVisible(true));
  await expect(page.getByRole('alert')).toHaveText(message);
  await expect(shown).toBeVisible();
  await expect(start).toBeFocused();
  await expect(start).toHaveAccessibleDescription(message);
  // Once seen, leaving and returning again clears it.
  await page.evaluate(() => (window as any).setVisible(false));
  await page.evaluate(() => (window as any).setVisible(true));
  await expect(shown).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a start error seen in a visible sidebar never pulls focus back from the page', async ({ page }) => {
  await openIdle(page);
  const message = 'The initial journey screenshot failed. Try again.';
  await page.evaluate(`journeyReviewHarness.failStart(${JSON.stringify(message)})`);
  // The reader moves to the web page beside the sidebar while Start is in flight.
  await page.evaluate('journeyReviewHarness.onStart(() => { document.hasFocus = () => false; })');
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(message);
  await page.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')); });
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
});

test('Firefox launches say up front that page loads end the journey', async ({ page }) => {
  await openIdle(page);
  const notice = 'In Firefox, reloading the page or opening another page ends the journey there. Navigation inside the page, such as a single-page app route change, keeps recording.';
  await expect(page.getByText(notice, { exact: true })).toHaveCount(0);
  await page.evaluate('journeyReviewHarness.setFirefox(true)');
  await expect(page.getByText(notice, { exact: true })).toBeVisible();
  // It comes before Start, not after.
  const [noticeBox, startBox] = await Promise.all([page.getByText(notice, { exact: true }).boundingBox(),
    page.getByRole('button', { name: 'Start journey', exact: true }).boundingBox()]);
  expect(noticeBox!.y).toBeLessThan(startBox!.y);
});

test('a surface that cannot start again explains how to record instead of offering a dead Start', async ({ page }) => {
  await openIdle(page);
  await page.evaluate('journeyReviewHarness.setStartable(false)');
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Include entered values')).toHaveCount(0);
  await expect(page.getByText('To record a new journey, go to the website tab, click anmerko in the browser toolbar or Extensions menu, and choose Record journey from More Comment Options.', { exact: true })).toBeVisible();
});

test('recording and review counts use singular and plural forms', async ({ page }) => {
  await openIdle(page);
  await page.evaluate('journeyReviewHarness.setRecording(1)');
  await expect(page.getByText('1 step recorded. Continue in the original tab.', { exact: true })).toBeVisible();
  await page.evaluate('journeyReviewHarness.setRecording(2)');
  await expect(page.getByText('2 steps recorded. Continue in the original tab.', { exact: true })).toBeVisible();
  await page.evaluate('journeyReviewHarness.setReviewingSteps(1)');
  await expect(page.getByText('1 retained step · Entered values: Off', { exact: true })).toBeVisible();
  await page.evaluate('journeyReviewHarness.setReviewingSteps(3)');
  await expect(page.getByText('3 retained steps · Entered values: Off', { exact: true })).toBeVisible();
});

test('each new view takes focus through its heading after Stop, Reopen, and Discard', async ({ page }) => {
  await openIdle(page);
  await page.evaluate('journeyReviewHarness.setRecording(1)');
  const stop = page.getByRole('button', { name: 'Stop journey', exact: true });
  await stop.focus();
  await page.evaluate('journeyReviewHarness.setReviewing()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeFocused();

  await page.getByRole('button', { name: 'Discard journey', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm discard journey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeFocused();

  await page.evaluate(`journeyReviewHarness.setList(${JSON.stringify(savedItems())})`);
  await page.evaluate('journeyReviewHarness.reopenIntoReview()');
  await page.getByRole('button', { name: /^Reopen journey: Checkout keeps the item/ }).click();
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeFocused();
});

test('a new view never steals focus from a reader outside it', async ({ page }) => {
  await openIdle(page);
  await page.evaluate(() => {
    const outside = document.createElement('button');
    outside.textContent = 'Outside control';
    document.body.prepend(outside);
    outside.focus();
  });
  await page.evaluate('journeyReviewHarness.setReviewing()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Outside control' })).toBeFocused();
});

test('step removal lands on the neighbouring step and Keep returns to Remove', async ({ page }) => {
  await openReview(page);
  await page.getByRole('button', { name: 'Remove step 2', exact: true }).click();
  await page.getByRole('button', { name: 'Keep step 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove step 2', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Remove step 2', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm remove step 2', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Confirm remove step 2', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Step 3 / })).toBeFocused();
  // The last step falls back to the one before it.
  await page.getByRole('button', { name: 'Remove step 3', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm remove step 3', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Step 1 / })).toBeFocused();
});

test('value editing moves focus into the editor and back to Edit on save, cancel, or Escape', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
  await page.evaluate('journeyReviewHarness.setReviewingWithField()');
  const edit = page.getByRole('button', { name: 'Edit value for step 4', exact: true });
  const editor = page.getByLabel('Edit entered value for step 4');
  await edit.click();
  await expect(editor).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(edit).toBeFocused();
  await edit.click();
  await page.getByRole('button', { name: 'Cancel editing step 4', exact: true }).click();
  await expect(edit).toBeFocused();
  await edit.click();
  await editor.fill('edited search');
  await page.getByRole('button', { name: 'Save value for step 4', exact: true }).click();
  await expect(page.getByText('edited search', { exact: true })).toBeVisible();
  await expect(edit).toBeFocused();
  await page.getByRole('button', { name: 'Remove value for step 4', exact: true }).click();
  await expect(page.getByText('(empty value)', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove value for step 4', exact: true })).toBeFocused();
});

test('discarding an unsaved review asks for confirmation that Keep or Escape disarms', async ({ page }) => {
  await openReview(page);
  const discard = page.getByRole('button', { name: 'Discard journey', exact: true });
  await discard.click();
  const confirm = page.getByRole('button', { name: 'Confirm discard journey', exact: true });
  await expect(confirm).toBeFocused();
  await expect(confirm).toHaveAccessibleDescription('Discard this journey? Its steps and screenshots are deleted and cannot be recovered.');
  await page.getByRole('button', { name: 'Keep reviewing', exact: true }).click();
  await expect(discard).toBeFocused();
  await discard.click();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(discard).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
});

test('an unchanged reopened journey exports and discards in one step, keeping its saved copy', async ({ page }) => {
  await openReview(page);
  // Re-entering the view: the draft is exactly the stored revision.
  await page.evaluate(`journeyReviewHarness.setList([
    { journeyId: 'J1', revision: 0, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 3, spansPages: false, expected: 'Checkout keeps the item' },
  ])`);
  await expect(page.getByRole('button', { name: 'Copy Prompt', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Download Markdown + Images', exact: true })).toBeEnabled();
  await expect(page.getByText('Save first to copy or download this journey.', { exact: true })).toHaveCount(0);
  const discard = page.getByRole('button', { name: 'Discard journey', exact: true });
  await expect(discard).toHaveAccessibleDescription('Discarding closes this review. The saved copy stays in Saved journeys.');

  // An edit makes the draft differ from its saved revision again. A pointer
  // press on Discard blurs the field, and the autosave that starts lands while
  // the pointer is still down.
  await page.evaluate('journeyReviewHarness.holdSummary()');
  await page.getByLabel('Expected result').fill('Edited after reopening');
  await expect(page.getByRole('button', { name: 'Copy Prompt', exact: true })).toBeDisabled();
  await pressWhile(page, discard, () => landSummary(page));
  await expect(page.getByRole('button', { name: 'Confirm discard journey', exact: true }))
    .toHaveAccessibleDescription('Discard your unsaved changes? The last saved copy stays in Saved journeys.');
});

test('typing into an unchanged reopened journey withdraws export and one-step discard before the autosave lands', async ({ page }) => {
  await openReview(page);
  await page.evaluate(`journeyReviewHarness.setList([
    { journeyId: 'J1', revision: 0, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 3, spansPages: false, expected: 'Checkout keeps the item' },
  ])`);
  const copy = page.getByRole('button', { name: 'Copy Prompt', exact: true });
  await expect(copy).toBeEnabled();
  // The autosave is held, so the draft still matches its saved revision in storage.
  await page.evaluate('journeyReviewHarness.holdSummary()');
  const expected = page.getByLabel('Expected result');
  await expected.pressSequentially('Edited', { delay: 20 });
  await expect(copy).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Download Markdown + Images', exact: true })).toBeDisabled();
  await expect(page.getByText('Save first to copy or download this journey.', { exact: true })).toBeVisible();
  // Typing continues in place: the re-render keeps focus and every character.
  await expect(expected).toBeFocused();
  await expect(expected).toHaveValue('Edited');
  await page.getByRole('button', { name: 'Discard journey', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm discard journey', exact: true }))
    .toHaveAccessibleDescription('Discard your unsaved changes? The last saved copy stays in Saved journeys.');
});

test('a failed summary autosave keeps an unchanged journey from exporting its older saved revision', async ({ page }) => {
  await openReview(page);
  await page.evaluate(`journeyReviewHarness.setList([
    { journeyId: 'J1', revision: 0, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 3, spansPages: false, expected: 'Checkout keeps the item' },
  ])`);
  await expect(page.getByRole('button', { name: 'Copy Prompt', exact: true })).toBeEnabled();
  await page.evaluate('journeyReviewHarness.failSummary()');
  await page.getByLabel('Expected result').fill('Edited after reopening');
  await expect(page.getByRole('alert')).toHaveText('Another review tab changed this journey. Reload the review and try again.', { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Copy Prompt', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Discard journey', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Confirm discard journey', exact: true }))
    .toHaveAccessibleDescription('Discard your unsaved changes? The last saved copy stays in Saved journeys.');
});

// Holds the primary pointer down on a control while `during` runs, such as an
// autosave or another tab's change landing, then releases it as one click.
async function pressWhile(page: Page, control: Locator, during: () => Promise<void>) {
  // Let an earlier click's re-render settle before locating the control.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
  await control.scrollIntoViewIfNeeded();
  const box = (await control.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await during();
  await page.mouse.up();
}

// A refresh reads the saved list last and renders in the same turn, so a new
// list read plus a short settle means its update has landed.
async function refreshLanded(page: Page, before: number) {
  await expect.poll(() => page.evaluate('journeyReviewHarness.listCalls()')).toBeGreaterThan(before);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
}

async function landSummary(page: Page) {
  const before = await page.evaluate('journeyReviewHarness.listCalls()') as number;
  await page.evaluate('journeyReviewHarness.releaseSummary()');
  await refreshLanded(page, before);
}

async function readyToSave(page: Page) {
  await openReview(page);
  await page.getByLabel('Expected result').fill('Shows checkout');
  await page.getByLabel('Actual result').fill('Opens on time');
  await page.getByRole('checkbox', { name: /^I understand this journey retains/ }).check();
  await expect.poll(() => page.evaluate('[journeyReviewHarness.state().draft.expected, journeyReviewHarness.state().draft.actual]'), { timeout: 10_000 })
    .toEqual(['Shows checkout', 'Opens on time']);
  await expect(page.getByRole('button', { name: 'Save journey', exact: true })).toBeEnabled();
}

test('Save pressed while the blur autosave lands still saves, with the typed summary', async ({ page }) => {
  await readyToSave(page);
  await page.evaluate('journeyReviewHarness.holdSummary()');
  await page.getByLabel('Actual result').pressSequentially(' again');
  // Pressing Save blurs the field, which starts the autosave; it lands and
  // re-renders the review before the pointer is released.
  await pressWhile(page, page.getByRole('button', { name: 'Save journey', exact: true }), () => landSummary(page));
  await expect(page.getByRole('heading', { name: 'Journey saved' })).toBeVisible();
  expect(await page.evaluate('journeyReviewHarness.saveCalls()')).toEqual([true]);
  expect(await page.evaluate('journeyReviewHarness.savedSummaries()')).toEqual([['Shows checkout', 'Opens on time again']]);
});

test('Save pressed before the summary autosave waits for it instead of saving the older text', async ({ page }) => {
  await readyToSave(page);
  await page.evaluate('journeyReviewHarness.holdSummary()');
  await page.getByLabel('Actual result').pressSequentially(' again');
  await page.getByRole('button', { name: 'Save journey', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
  expect(await page.evaluate('journeyReviewHarness.saveCalls()')).toEqual([]);
  await page.evaluate('journeyReviewHarness.releaseSummary()');
  await expect(page.getByRole('heading', { name: 'Journey saved' })).toBeVisible();
  expect(await page.evaluate('journeyReviewHarness.savedSummaries()')).toEqual([['Shows checkout', 'Opens on time again']]);
});

test('Save becomes available as soon as both summaries are typed, before the autosave lands', async ({ page }) => {
  await openReview(page);
  await page.getByRole('checkbox', { name: /^I understand this journey retains/ }).check();
  await page.getByLabel('Expected result').fill('Shows checkout');
  await expect.poll(() => page.evaluate('journeyReviewHarness.state().draft.expected'), { timeout: 10_000 }).toBe('Shows checkout');
  const save = page.getByRole('button', { name: 'Save journey', exact: true });
  await expect(save).toBeDisabled();
  await page.evaluate('journeyReviewHarness.holdSummary()');
  const actual = page.getByLabel('Actual result');
  await actual.pressSequentially('O');
  await expect(save).toBeEnabled();
  await expect(page.getByText('Enter both an expected and an actual summary.', { exact: true })).toHaveCount(0);
  // Typing continues in place.
  await expect(actual).toBeFocused();
  await actual.pressSequentially('pens');
  await expect(actual).toHaveValue('Opens');
  await actual.fill('');
  await expect(save).toBeDisabled();
  await expect(page.getByText('Enter both an expected and an actual summary.', { exact: true })).toBeVisible();
  await expect(actual).toBeFocused();
});

test('controls pressed while another tab or a list refresh re-renders the review still get their click', async ({ page }) => {
  await openReview(page);
  await pressWhile(page, page.getByRole('button', { name: 'Remove step 2', exact: true }), async () => {
    const before = await page.evaluate('journeyReviewHarness.listCalls()') as number;
    // Another review tab's change arrives as a state broadcast.
    await page.evaluate('journeyReviewHarness.setList([])');
    await refreshLanded(page, before);
  });
  await expect(page.getByRole('button', { name: 'Confirm remove step 2', exact: true })).toBeFocused();
  await pressWhile(page, page.getByRole('button', { name: 'Keep step 2', exact: true }), async () => {
    const before = await page.evaluate('journeyReviewHarness.listCalls()') as number;
    await page.evaluate('journeyReviewHarness.setList([])');
    await refreshLanded(page, before);
  });
  await expect(page.getByRole('button', { name: 'Remove step 2', exact: true })).toBeFocused();
  // Space activates on release, so a re-render between its press and release
  // must not swallow it either.
  const discard = page.getByRole('button', { name: 'Discard journey', exact: true });
  await discard.focus();
  await page.keyboard.down(' ');
  const before = await page.evaluate('journeyReviewHarness.listCalls()') as number;
  await page.evaluate('journeyReviewHarness.setList([])');
  await refreshLanded(page, before);
  await page.keyboard.up(' ');
  await expect(page.getByRole('button', { name: 'Confirm discard journey', exact: true })).toBeFocused();
});

test('another surface saving keeps unsent summaries, the acknowledgement and an open mask editor', async ({ page }) => {
  await openImageReview(page);
  const ack = page.getByRole('checkbox', { name: /^I understand this journey retains/ });
  await ack.check();
  await page.evaluate('journeyReviewHarness.holdSummary()');
  await page.getByLabel('Expected result').fill('Typed before the save');
  // Opening the editor blurs the field; its autosave stays in flight.
  await page.getByRole('button', { name: 'Mask screenshot for step 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Mask screenshot' });
  await expect(dialog).toBeVisible();
  await page.evaluate('journeyReviewHarness.setSaving()');
  await expect(page.locator('.journey-view h1')).toHaveText('Saving journey');
  // The save refuses the autosave; it waits instead of reporting an error.
  await page.evaluate('journeyReviewHarness.releaseSummary()');
  await expect.poll(() => page.evaluate('journeyReviewHarness.summaryCalls().length')).toBe(1);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  await expect(dialog).toBeVisible();
  await expect(page.locator('.journey-error')).toHaveCount(0);
  // The save fails, so the review comes back with everything this tab had.
  await page.evaluate('journeyReviewHarness.failSaving()');
  await expect.poll(() => page.evaluate('journeyReviewHarness.state().draft.expected'), { timeout: 10_000 }).toBe('Typed before the save');
  expect(await page.evaluate('journeyReviewHarness.summaryCalls()')).toEqual([['Typed before the save', ''], ['Typed before the save', '']]);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByLabel('Expected result')).toHaveValue('Typed before the save');
  await expect(ack).toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a mask applied while another surface saves lands once the failed save returns to review', async ({ page }) => {
  await openImageReview(page);
  await page.getByRole('button', { name: 'Mask screenshot for step 1', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Mask screenshot' });
  await page.evaluate('journeyReviewHarness.setSaving()');
  await expect(page.locator('.journey-view h1')).toHaveText('Saving journey');
  await dialog.getByRole('spinbutton', { name: 'X', exact: true }).fill('0');
  await dialog.getByRole('spinbutton', { name: 'Y', exact: true }).fill('0');
  await dialog.getByRole('spinbutton', { name: 'Width', exact: true }).fill('10');
  await dialog.getByRole('spinbutton', { name: 'Height', exact: true }).fill('5');
  await dialog.getByRole('button', { name: 'Apply mask', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  expect(await page.evaluate('journeyReviewHarness.reviewImageCalls()')).toEqual([]);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate('journeyReviewHarness.failSaving()');
  await expect.poll(() => page.evaluate('journeyReviewHarness.reviewImageCalls()'), { timeout: 10_000 })
    .toEqual([{ imageId: 'I1', operation: 'replace', width: 40, height: 20, maskedCurrent: true }]);
  await expect(stepItem(page, 1).getByRole('status')).toHaveText('Screenshot for step 1 masked.');
  await expect(stepItem(page, 1).getByText('Masked during review.', { exact: true })).toBeVisible();
});

test('a save that completes elsewhere reports the edits it left out', async ({ page }) => {
  await openReview(page);
  await page.evaluate('journeyReviewHarness.holdSummary()');
  await page.getByLabel('Expected result').fill('Typed before the save');
  await page.getByRole('button', { name: 'Remove step 2', exact: true }).click();
  await page.evaluate('journeyReviewHarness.setSaving()');
  await page.evaluate('journeyReviewHarness.releaseSummary()');
  await expect.poll(() => page.evaluate('journeyReviewHarness.summaryCalls().length')).toBe(1);
  await page.evaluate('journeyReviewHarness.completeSaving()');
  await expect(page.getByRole('heading', { name: 'Journey saved' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('This journey was saved before your latest edits here reached it, so the saved copy does not include them. Reopen it from Saved journeys to make them again.');
});

const SAVE_IN_PROGRESS = 'This journey is being saved. Wait for the save to finish, then try again.';
const LOST_EDITS = 'This journey was saved before your latest edits here reached it, so the saved copy does not include them. Reopen it from Saved journeys to make them again.';
const EDITS_NOT_APPLIED = 'The journey you were reviewing was saved or closed before your latest edits here reached it, so they were not applied. If it was saved, reopen it from Saved journeys to make them again.';
const SAVE_NOT_FINISHED = 'The save did not finish, and your change was not applied while it ran. Try the change again.';

test('an edit refused by a save in progress says so, then reports it missing from the saved copy', async ({ page }) => {
  await openReview(page);
  await page.getByRole('button', { name: 'Remove step 2', exact: true }).click();
  const confirm = page.getByRole('button', { name: 'Confirm remove step 2', exact: true });
  // The save starts after this view last rendered the review.
  await page.evaluate('journeyReviewHarness.setSavingSilently()');
  await confirm.click();
  await expect(page.locator('.journey-view h1')).toHaveText('Saving journey');
  await expect(page.getByRole('alert')).toHaveText(SAVE_IN_PROGRESS);
  await page.evaluate('journeyReviewHarness.completeSaving()');
  await expect(page.getByRole('heading', { name: 'Journey saved' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(LOST_EDITS);
  expect(await page.evaluate('journeyReviewHarness.removeCalls()')).toEqual(['S2']);
});

test('an edit refused by a save that then fails can be made again', async ({ page }) => {
  await openReview(page);
  const redact = page.getByRole('button', { name: 'Redact source URL for step 1', exact: true });
  await page.evaluate('journeyReviewHarness.setSavingSilently()');
  await redact.click();
  await expect(page.getByRole('alert')).toHaveText(SAVE_IN_PROGRESS);
  await page.evaluate('journeyReviewHarness.failSaving()');
  await expect(page.getByRole('heading', { name: 'Review journey' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(SAVE_NOT_FINISHED);
  await expect(stepItem(page, 1).getByText('Source URL redacted during review.', { exact: true })).toHaveCount(0);
  await redact.click();
  await expect(stepItem(page, 1).getByText('Source URL redacted during review.', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await page.evaluate('journeyReviewHarness.redactCalls()')).toEqual([['S1', 'source'], ['S1', 'source']]);
});

test('a summary held by a save is never written into the next journey under review', async ({ page }) => {
  await openReview(page);
  await page.getByLabel('Expected result').fill('Typed for J1');
  // Another surface starts saving J1 before the autosave goes out, so it waits.
  await page.evaluate('journeyReviewHarness.setSaving()');
  await expect(page.locator('.journey-view h1')).toHaveText('Saving journey');
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
  // This view never reads J1's save ending: the next state is another journey's review.
  await page.evaluate('journeyReviewHarness.setReviewingOther()');
  await expect(page.getByRole('heading', { name: 'Step 2 · Click: Pay now' })).toBeVisible();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
  expect(await page.evaluate('journeyReviewHarness.summaryCalls()')).toEqual([]);
  expect(await page.evaluate('journeyReviewHarness.state().draft')).toMatchObject({ id: 'J2', expected: '', actual: '' });
  await expect(page.getByLabel('Expected result')).toHaveValue('');
  await expect(page.getByRole('alert')).toHaveText(EDITS_NOT_APPLIED);
  // Text typed into J2's review goes to J2, named as such.
  await page.getByLabel('Expected result').fill('Typed for J2');
  await expect.poll(() => page.evaluate('journeyReviewHarness.state().draft.expected'), { timeout: 10_000 }).toBe('Typed for J2');
  expect(await page.evaluate('journeyReviewHarness.summaryTargets()')).toEqual([['reviewing', 'J2', 'J2']]);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a summary typed just before another journey takes over the review is never written into it', async ({ page }) => {
  await openReview(page);
  await page.getByRole('checkbox', { name: /^I understand this journey retains/ }).check();
  await page.getByLabel('Expected result').fill('Typed for J1');
  // Within the autosave delay, this view reads another journey's review.
  await page.evaluate('journeyReviewHarness.setReviewingOther()');
  await expect(page.getByRole('heading', { name: 'Step 2 · Click: Pay now' })).toBeVisible();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 600)));
  expect(await page.evaluate('journeyReviewHarness.summaryCalls()')).toEqual([]);
  expect(await page.evaluate('journeyReviewHarness.state().draft')).toMatchObject({ id: 'J2', expected: '', actual: '' });
  await expect(page.getByLabel('Expected result')).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: /^I understand this journey retains/ })).not.toBeChecked();
  await expect(page.getByRole('alert')).toHaveText(EDITS_NOT_APPLIED);
});

test('a save elsewhere reports an open value editor with unsent input as lost', async ({ page }) => {
  await openReview(page);
  await page.evaluate('journeyReviewHarness.setReviewingWithField()');
  await page.getByRole('button', { name: 'Edit value for step 4', exact: true }).click();
  await page.getByLabel('Edit entered value for step 4').fill('typed but not saved');
  await page.evaluate('journeyReviewHarness.setSaving()');
  await expect(page.locator('.journey-view h1')).toHaveText('Saving journey');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate('journeyReviewHarness.completeSaving()');
  await expect(page.getByRole('heading', { name: 'Journey saved' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText(LOST_EDITS);
  expect(await page.evaluate('journeyReviewHarness.editCalls()')).toEqual([]);
});

test('a save elsewhere reports a drawn mask as lost, but not a mask editor left untouched', async ({ page }) => {
  for (const drawn of [false, true]) {
    await openImageReview(page);
    await page.getByRole('button', { name: 'Mask screenshot for step 1', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Mask screenshot' });
    await expect(dialog).toBeVisible();
    if (drawn) {
      for (const [name, value] of [['X', '0'], ['Y', '0'], ['Width', '10'], ['Height', '5']]) {
        await dialog.getByRole('spinbutton', { name, exact: true }).fill(value);
      }
      await expect(dialog.getByRole('button', { name: 'Apply mask', exact: true })).toBeEnabled();
    }
    await page.evaluate('journeyReviewHarness.setSaving()');
    await page.evaluate('journeyReviewHarness.completeSaving()');
    await expect(page.getByRole('heading', { name: 'Journey saved' })).toBeVisible();
    await expect(dialog).toHaveCount(0);
    if (drawn) await expect(page.getByRole('alert')).toHaveText(LOST_EDITS);
    else await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate('journeyReviewHarness.reviewImageCalls()')).toEqual([]);
  }
});

test('the only remaining step explains why it cannot be removed', async ({ page }) => {
  await openReview(page);
  await page.evaluate('journeyReviewHarness.setReviewingSteps(1)');
  await expect(page.getByRole('heading', { name: /^Step 1 / })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Remove step/ })).toHaveCount(0);
  await expect(stepItem(page, 1).getByText('A journey keeps at least one step. To remove this one, discard the journey.', { exact: true })).toBeVisible();
  await page.evaluate('journeyReviewHarness.setReviewingSteps(2)');
  await expect(page.getByRole('button', { name: 'Remove step 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remove step 2', exact: true })).toBeVisible();
  // Confirming the removal of one of two steps leaves the other without Remove.
  await page.getByRole('button', { name: 'Remove step 2', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm remove step 2', exact: true }).click();
  await expect(page.getByRole('heading', { name: /^Step 2 / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Remove step/ })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a landscape capture in a narrow column opens at full size in a private, keyboard-operable dialog', async ({ page }) => {
  for (const width of [360, 390, 1280]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto('http://127.0.0.1:4173');
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(() => {
      (window as any).objectUrls = 0;
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (object: Blob | MediaSource) => { (window as any).objectUrls += 1; return create(object); };
    });
    await page.addScriptTag({ content: bundle() });
    await page.evaluate('journeyReviewHarness.setReviewingWithSizedImages()');
    const inline = (await page.locator('.journey-image').nth(1).boundingBox())!;
    const open = page.getByRole('button', { name: 'View full-size screenshot for step 2', exact: true });
    await open.click();
    const dialog = page.getByRole('dialog', { name: 'Screenshot for step 2' });
    await expect(dialog).toBeVisible();
    const scroller = dialog.getByRole('group', { name: 'Screenshot for step 2, 1280 by 720 pixels' });
    await expect(scroller).toBeFocused();
    const image = dialog.locator('anmerko-image');
    const full = (await image.boundingBox())!;
    expect(full.width, `${width}px`).toBe(1280);
    expect(full.height, `${width}px`).toBe(720);
    expect(full.width, `${width}px`).toBeGreaterThan(inline.width);
    // The dialog fills the screen without widening the page.
    const box = (await dialog.boundingBox())!;
    expect(box.width, `${width}px`).toBe(await page.evaluate(() => document.documentElement.clientWidth));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    if (width < 1280) {
      await page.keyboard.press('ArrowRight');
      await expect.poll(() => scroller.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    }
    const fit = dialog.getByRole('button', { name: 'Fit to window', exact: true });
    await fit.click();
    const fitted = (await image.boundingBox())!;
    expect(fitted.width, `${width}px`).toBeLessThanOrEqual(width);
    await expect(dialog.getByRole('button', { name: 'Actual size', exact: true })).toBeFocused();
    // Tab stays inside the dialog.
    for (let index = 0; index < 4; index += 1) {
      await page.keyboard.press('Tab');
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();
    // No page-readable image or URL: pixels stay in closed shadow roots.
    expect(await page.evaluate(() => [document.querySelectorAll('img').length, (window as any).objectUrls])).toEqual([0, 0]);
  }
});

test('the full-size view closes when another surface removes its screenshot and Close returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openReview(page);
  await page.evaluate('journeyReviewHarness.setReviewingWithSizedImages()');
  const open = page.getByRole('button', { name: 'View full-size screenshot for step 1', exact: true });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Screenshot for step 1' });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(open).toBeFocused();
  await open.click();
  await expect(dialog).toBeVisible();
  await page.evaluate("journeyReviewHarness.removeImage('I1')");
  await expect(dialog).toHaveCount(0);
  await expect(stepItem(page, 1).getByText('Screenshot unavailable: removed during review.', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Step 1 / })).toBeFocused();
});

test('a portrait screenshot that already fits whole offers no Enlarge', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await openReview(page);
  await page.evaluate('journeyReviewHarness.setReviewingWithSizedImages([200, 400])');
  await expect(page.locator('.journey-image')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /^Enlarge screenshot/ })).toHaveCount(0);
  const box = (await page.locator('.journey-image').first().boundingBox())!;
  expect(Math.abs((box.width - 2) / (box.height - 2) - 200 / 400)).toBeLessThan(0.02);
});

test('screenshots show whole at every width and tall ones can be enlarged', async ({ page }) => {
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('http://127.0.0.1:4173');
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: bundle() });
    await page.evaluate('journeyReviewHarness.setReviewingWithSizedImages()');
    const portrait = page.locator('.journey-image').first();
    const landscape = page.locator('.journey-image').nth(1);
    for (const [image, ratio] of [[portrait, 390 / 844], [landscape, 1280 / 720]] as const) {
      // The preview box keeps the capture's aspect ratio (within its 1px border), so nothing is cropped.
      const box = (await image.boundingBox())!;
      expect(Math.abs((box.width - 2) / (box.height - 2) - ratio), `${width}px`).toBeLessThan(0.02);
      expect(box.height, `${width}px`).toBeLessThanOrEqual(442);
      expect(box.x + box.width, `${width}px`).toBeLessThanOrEqual(width);
    }
    // The bottom band of the portrait capture is on screen once scrolled to.
    await portrait.scrollIntoViewIfNeeded();
    const box = (await portrait.boundingBox())!;
    const bottom = await page.evaluate(async ({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return element?.localName;
    }, { x: box.x + box.width / 2, y: box.y + box.height - 10 });
    expect(bottom).toBe('anmerko-image');
    const enlarge = page.getByRole('button', { name: 'Enlarge screenshot for step 1', exact: true });
    await expect(page.getByRole('button', { name: 'Enlarge screenshot for step 2', exact: true })).toHaveCount(0);
    await enlarge.click();
    const fit = page.getByRole('button', { name: 'Fit screenshot for step 1', exact: true });
    await expect(fit).toBeFocused();
    const enlarged = (await portrait.boundingBox())!;
    expect(enlarged.width).toBeGreaterThan(box.width);
    expect(Math.abs((enlarged.width - 2) / (enlarged.height - 2) - 390 / 844)).toBeLessThan(0.02);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await fit.click();
    await expect(enlarge).toBeFocused();
  }
});
