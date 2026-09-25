import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { buildSync } from 'esbuild';
import { addJourneyApis } from './fixtures/journey-apis';

type Harness = {
  log: any[];
  listeners: Array<(message: unknown, sender: any) => void>;
  manifest: Record<string, unknown>;
  response: any;
  client?: any;
  pending?: Promise<void>;
};
type HarnessWindow = typeof globalThis & {
  clientModule: { createJourneyClient(owner?: () => { ownerTabId?: number; ownerWindowId?: number }, intent?: string): any };
  surfaceHarness: Harness;
};

const clientBundle = buildSync({
  entryPoints: ['src/journey-client.ts'], bundle: true, write: false, format: 'iife', globalName: 'clientModule',
}).outputFiles[0].text;

function pageBundle(enabled: boolean) {
  return buildSync({
    entryPoints: ['src/journey-page.ts'], bundle: true, write: false, format: 'iife',
    loader: { '.css': 'text' }, define: { __TARGET_JOURNEYS__: String(enabled) },
  }).outputFiles[0].text;
}

async function installChrome(page: Page) {
  await page.evaluate(() => {
    const harness: Harness = {
      log: [], listeners: [], manifest: { background: { service_worker: 'background.js' } },
      response: { ok: true, value: { phase: 'idle', epoch: 0 } },
    };
    (globalThis as any).chrome = {
      runtime: {
        id: 'test-extension',
        getURL: (path: string) => `chrome-extension://test-extension/${path}`,
        getManifest: () => structuredClone(harness.manifest),
        sendMessage: async (message: unknown) => {
          harness.log.push({ kind: 'message', message: structuredClone(message) });
          return structuredClone(harness.response);
        },
        onMessage: {
          addListener: (listener: Harness['listeners'][number]) => { harness.listeners.push(listener); },
          removeListener: (listener: Harness['listeners'][number]) => {
            const index = harness.listeners.indexOf(listener);
            if (index >= 0) harness.listeners.splice(index, 1);
          },
        },
      },
    };
    (globalThis as HarnessWindow).surfaceHarness = harness;
  });
  await page.evaluate(addJourneyApis);
}

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await installChrome(page);
});

test('performs a native start without requesting optional access', async ({ page }) => {
  await page.addScriptTag({ content: clientBundle });
  const immediate = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.client = (globalThis as HarnessWindow).clientModule.createJourneyClient(
      () => ({ ownerTabId: 12, ownerWindowId: 34 }),
    );
    harness.pending = harness.client.start(false);
    return {
      log: structuredClone(harness.log),
      enteredValues: harness.client.supportsEnteredValues,
      permissionsApi: typeof (globalThis as any).chrome.permissions,
    };
  });
  expect(immediate).toEqual({
    log: [{ kind: 'message', message: { type: 'ANMERKO_JOURNEY_START', ownerTabId: 12, ownerWindowId: 34, includeEnteredValues: false } }],
    enteredValues: true,
    permissionsApi: 'undefined',
  });
  await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.pending);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log
    .some(entry => entry.kind === 'permission'))).toBe(false);
});

test('the client says page loads end a journey only in Firefox, on desktop or Android', async ({ page }) => {
  await page.addScriptTag({ content: clientBundle });
  expect(await page.evaluate(() => {
    const { clientModule, surfaceHarness } = globalThis as HarnessWindow;
    const runtime = (globalThis as any).chrome.runtime;
    const loadsEnd = () => clientModule.createJourneyClient(() => ({ ownerTabId: 1, ownerWindowId: 1 })).pageLoadsEndJourney;
    const chromium = loadsEnd();
    // A manifest key is no browser signal.
    surfaceHarness.manifest = { background: { scripts: ['background.js'] }, sidebar_action: { default_panel: 'sidebar.html' } };
    const chromiumWithSidebarAction = loadsEnd();
    // Firefox implements getBrowserInfo and serves moz-extension: pages.
    runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
    runtime.getURL = (path: string) => `moz-extension://0b5e4b36-5f6d-4c2e-9b7a-1e2f3a4b5c6d/${path}`;
    const firefoxDesktop = loadsEnd();
    // Firefox for Android does not support sidebar_action, so its manifest may lack it.
    surfaceHarness.manifest = { background: { scripts: ['background.js'] } };
    const firefoxAndroid = loadsEnd();
    delete runtime.getBrowserInfo;
    const mozExtensionPageOnly = loadsEnd();
    runtime.getBrowserInfo = async () => ({ name: 'Firefox' });
    runtime.getURL = (path: string) => `chrome-extension://test-extension/${path}`;
    const browserInfoOnly = loadsEnd();
    return { chromium, chromiumWithSidebarAction, firefoxDesktop, firefoxAndroid, mozExtensionPageOnly, browserInfoOnly };
  })).toEqual({
    chromium: false, chromiumWithSidebarAction: false, firefoxDesktop: true, firefoxAndroid: true,
    mozExtensionPageOnly: true, browserInfoOnly: true,
  });
});

test('review edits refused by a save in progress say so, and real staleness still blames the other tab', async ({ page }) => {
  await page.addScriptTag({ content: clientBundle });
  const outcomes = await page.evaluate(async () => {
    const { clientModule } = globalThis as HarnessWindow;
    const runtime = (globalThis as any).chrome.runtime;
    const reviewing = (revision: number) => ({ phase: 'reviewing', epoch: 2, sessionId: 'S', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
      warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z',
      draft: { id: 'J1', revision, images: { I1: { dataUrl: 'data:image/png;base64,AAAA' } }, steps: [] } });
    const saving = { ...reviewing(3), phase: 'saving' };
    // Each case lists the states read in order and whether the edit itself is refused as stale.
    const run = async (states: unknown[], refused: boolean, edit: (client: any) => Promise<void>) => {
      const sent: string[] = [];
      let read = 0;
      runtime.sendMessage = async (message: { type: string }) => {
        sent.push(message.type);
        if (message.type === 'ANMERKO_JOURNEY_STATE') return { ok: true, value: states[Math.min(read++, states.length - 1)] };
        return refused ? { ok: false, error: 'Journey command unavailable.', code: 'stale-review' } : { ok: true };
      };
      try {
        await edit(clientModule.createJourneyClient(() => ({ ownerTabId: 1, ownerWindowId: 1 })));
        return { sent, outcome: 'ok' };
      } catch (error) {
        return { sent, outcome: `${(error as { code?: string }).code ?? 'none'}: ${(error as Error).message}` };
      }
    };
    const summary = (client: any) => client.updateSummary('Expected', 'Actual');
    return {
      savingBeforeEdit: await run([saving], false, summary),
      savingAfterRefusal: await run([reviewing(3), saving], true, client => client.removeStep('S1')),
      saveFailedSince: await run([reviewing(3), reviewing(3)], true, client => client.redactUrl('S1', 'source')),
      savedSince: await run([reviewing(3), { phase: 'saved', epoch: 3, journeyId: 'J1', revision: 4 }], true, client => client.editValue('S1', null)),
      imageDuringSave: await run([saving], false, client => client.reviewImage('I1', { operation: 'remove' })),
      changedElsewhere: await run([reviewing(3), reviewing(4)], true, summary),
    };
  });
  const saving = 'save-in-progress: This journey is being saved. Wait for the save to finish, then try again.';
  const stale = 'stale-review: Another review tab changed this journey. Reload the review and try again.';
  expect(outcomes).toEqual({
    savingBeforeEdit: { sent: ['ANMERKO_JOURNEY_STATE'], outcome: saving },
    savingAfterRefusal: { sent: ['ANMERKO_JOURNEY_STATE', 'ANMERKO_JOURNEY_REMOVE_STEP', 'ANMERKO_JOURNEY_STATE'], outcome: saving },
    saveFailedSince: { sent: ['ANMERKO_JOURNEY_STATE', 'ANMERKO_JOURNEY_REDACT_URL', 'ANMERKO_JOURNEY_STATE'], outcome: saving },
    savedSince: { sent: ['ANMERKO_JOURNEY_STATE', 'ANMERKO_JOURNEY_EDIT_VALUE', 'ANMERKO_JOURNEY_STATE'], outcome: saving },
    imageDuringSave: { sent: ['ANMERKO_JOURNEY_STATE'], outcome: saving },
    changedElsewhere: { sent: ['ANMERKO_JOURNEY_STATE', 'ANMERKO_JOURNEY_UPDATE_SUMMARY', 'ANMERKO_JOURNEY_STATE'], outcome: stale },
  });
});

test('the client reads screenshots only where they are shown: a journey view in review, and a mask about to replace one', async ({ page }) => {
  await page.addScriptTag({ content: clientBundle });
  const sent = await page.evaluate(async () => {
    const { clientModule } = globalThis as HarnessWindow;
    const runtime = (globalThis as any).chrome.runtime;
    const reviewing = { phase: 'reviewing', epoch: 2, sessionId: 'S', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
      warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z',
      draft: { id: 'J1', revision: 3, images: { I1: { dataUrl: 'data:image/png;base64,AAAA' } }, steps: [] } };
    const log: unknown[] = [];
    let refuse = false;
    runtime.sendMessage = async (message: { type: string; screenshots?: unknown }) => {
      if (message.type === 'ANMERKO_JOURNEY_STATE') log.push({ type: message.type, ...'screenshots' in message ? { screenshots: message.screenshots } : {} });
      else log.push({ type: message.type });
      if (message.type === 'ANMERKO_JOURNEY_STATE') return { ok: true, value: reviewing };
      return refuse ? { ok: false, error: 'Journey command unavailable.', code: 'stale-review' } : { ok: true };
    };
    const client = clientModule.createJourneyClient(() => ({ ownerTabId: 1, ownerWindowId: 1 }));
    const run = async (action: () => Promise<unknown>) => { log.length = 0; await action(); return structuredClone(log); };
    return {
      read: await run(() => client.read()),
      summary: await run(() => client.updateSummary('Expected', 'Actual')),
      removeStep: await run(() => client.removeStep('S1')),
      editValue: await run(() => client.editValue('S1', null)),
      redactUrl: await run(() => client.redactUrl('S1', 'source')),
      redactLabel: await run(() => client.redactLabel('S1')),
      removeImage: await run(() => client.reviewImage('I1', { operation: 'remove' })),
      maskImage: await run(() => client.reviewImage('I1', { operation: 'replace', maskedFrom: 'data:image/png;base64,AAAA',
        image: { dataUrl: 'data:image/png;base64,BBBB' } })),
      // A refused edit reads the review again to tell a save from another tab.
      refused: await run(async () => {
        refuse = true;
        try { await client.removeStep('S1'); } catch { /* Refused as expected. */ } finally { refuse = false; }
      }),
      // So does a refused discard of a named review.
      refusedDiscard: await run(async () => {
        refuse = true;
        try {
          await client.discard({ phase: 'reviewing', journeyId: 'J1', sessionId: 'S' });
        } catch { /* Refused as expected. */ } finally { refuse = false; }
      }),
    };
  });
  const state = (screenshots?: unknown) => ({ type: 'ANMERKO_JOURNEY_STATE', ...screenshots === undefined ? {} : { screenshots } });
  expect(sent).toEqual({
    read: [state('review')],
    summary: [state(false), { type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY' }],
    removeStep: [state(false), { type: 'ANMERKO_JOURNEY_REMOVE_STEP' }],
    editValue: [state(false), { type: 'ANMERKO_JOURNEY_EDIT_VALUE' }],
    redactUrl: [state(false), { type: 'ANMERKO_JOURNEY_REDACT_URL' }],
    redactLabel: [state(false), { type: 'ANMERKO_JOURNEY_REDACT_LABEL' }],
    removeImage: [state(false), { type: 'ANMERKO_JOURNEY_REVIEW_IMAGE' }],
    maskImage: [state('review'), { type: 'ANMERKO_JOURNEY_REVIEW_IMAGE' }],
    refused: [state(false), { type: 'ANMERKO_JOURNEY_REMOVE_STEP' }, state(false)],
    refusedDiscard: [{ type: 'ANMERKO_JOURNEY_DISCARD' }, state(false)],
  });
});

// The client with the background's screenshot tokens, so a fake background
// answers reads as the real one does.
const transferBundle = buildSync({
  stdin: {
    contents: `export { createJourneyClient } from './src/journey-client';
      export { createJourneyScreenshotTokens } from './src/journey-screenshot-transfer';`,
    resolveDir: process.cwd(),
  },
  bundle: true, write: false, format: 'iife', globalName: 'transferModule',
}).outputFiles[0].text;

test('a review view fetches only the screenshots it does not hold, after every change and before a mask', async ({ page }) => {
  await page.addScriptTag({ content: transferBundle });
  const result = await page.evaluate(async () => {
    const { createJourneyClient, createJourneyScreenshotTokens } = (globalThis as any).transferModule;
    const runtime = (globalThis as any).chrome.runtime;
    const png = (name: string) => `data:image/png;base64,${name}`;
    const images = (i1: string) => ({ I1: { width: 1, height: 1, dataUrl: png(i1) }, I2: { width: 1, height: 1, dataUrl: png('TWO') } });
    let session: any = { phase: 'reviewing', epoch: 2, sessionId: 'S', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
      warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z',
      draft: { id: 'J1', revision: 3, images: images('ONE'), steps: [] } };
    const tokens = createJourneyScreenshotTokens();
    // Each state read: the tokens it named as held, and the screenshots its reply carried.
    const reads: Array<{ held: number; sent: string[] }> = [];
    let override: unknown;
    runtime.sendMessage = async (message: { type: string; screenshots?: unknown; held?: unknown }) => {
      if (message.type !== 'ANMERKO_JOURNEY_STATE') return { ok: true };
      const reply = override ?? (Array.isArray(message.held) ? tokens(structuredClone(session), message.held) : structuredClone(session));
      override = undefined;
      reads.push({
        held: Array.isArray(message.held) ? message.held.length : -1,
        sent: (JSON.stringify(reply).match(/data:image\/png;base64,\w+/g) ?? []).map((url: string) => url.slice(22)),
      });
      return { ok: true, value: reply };
    };
    const shown = (state: any) => Object.fromEntries(Object.entries(state.draft.images).map(([id, image]: [string, any]) => [id, image.dataUrl.slice(22)]));
    const client = createJourneyClient(() => ({ ownerTabId: 1, ownerWindowId: 1 }));
    const outcome: Record<string, unknown> = {};
    outcome.first = shown(await client.read());
    // A summary autosave or any other change: the view reads the review again.
    session = { ...session, draft: { ...session.draft, revision: 4 } };
    outcome.again = shown(await client.read());
    // Another surface masks one screenshot: only it is fetched.
    session = { ...session, draft: { ...session.draft, revision: 5, images: images('MASKED') } };
    outcome.masked = shown(await client.read());
    // A mask begun on the current pixels goes ahead without fetching them;
    // one begun on pixels since replaced is refused.
    const mask = (maskedFrom: string) => client.reviewImage('I1', { operation: 'replace', maskedFrom: png(maskedFrom), image: { dataUrl: png('NEW') } })
      .then(() => 'applied', (error: { code?: string }) => error.code);
    outcome.current = await mask('MASKED');
    outcome.stale = await mask('ONE');
    // A reply that leaves out a screenshot the view no longer holds is read again whole.
    override = { state: { ...session, draft: { ...session.draft, images: { I1: { width: 1, height: 1 }, I2: { width: 1, height: 1, dataUrl: png('TWO') } } } },
      tokens: { I1: 'unknown-token', I2: 'another-token' } };
    outcome.recovered = shown(await client.read());
    return { outcome, reads };
  });
  expect(result.outcome).toEqual({
    first: { I1: 'ONE', I2: 'TWO' }, again: { I1: 'ONE', I2: 'TWO' }, masked: { I1: 'MASKED', I2: 'TWO' },
    current: 'applied', stale: 'stale-review', recovered: { I1: 'MASKED', I2: 'TWO' },
  });
  expect(result.reads).toEqual([
    { held: 0, sent: ['ONE', 'TWO'] },
    { held: 2, sent: [] },
    { held: 2, sent: ['MASKED'] },
    // Each mask reads the review: nothing is fetched again.
    { held: 2, sent: [] },
    { held: 2, sent: [] },
    { held: 2, sent: ['TWO'] },
    { held: 0, sent: ['MASKED', 'TWO'] },
  ]);
});

test('a summary write names its review and is refused once another review is current', async ({ page }) => {
  await page.addScriptTag({ content: clientBundle });
  const outcomes = await page.evaluate(async () => {
    const { clientModule } = globalThis as HarnessWindow;
    const runtime = (globalThis as any).chrome.runtime;
    const reviewing = (journeyId: string, sessionId = 'S') => ({ phase: 'reviewing', epoch: 2, sessionId, journeyId, ownerTabId: 1, ownerWindowId: 1,
      warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z',
      draft: { id: journeyId, revision: 3, images: {}, steps: [] } });
    // The review this view typed in (J1, session S) was saved or closed, and
    // J2, or J1 reopened in a new session, is now under review or saving.
    const run = async (current: unknown) => {
      const sent: unknown[] = [];
      runtime.sendMessage = async (message: { type: string; journeyId?: string; sessionId?: string }) => {
        sent.push(message.type === 'ANMERKO_JOURNEY_STATE' ? message.type
          : { type: message.type, journeyId: message.journeyId, sessionId: message.sessionId });
        return message.type === 'ANMERKO_JOURNEY_STATE' ? { ok: true, value: current } : { ok: true };
      };
      try {
        await clientModule.createJourneyClient(() => ({ ownerTabId: 1, ownerWindowId: 1 }))
          .updateSummary('Expected', 'Actual', { journeyId: 'J1', sessionId: 'S' });
        return { sent, outcome: 'ok' };
      } catch (error) {
        return { sent, outcome: `${(error as { code?: string }).code ?? 'none'}: ${(error as Error).message}` };
      }
    };
    return {
      sameReview: await run(reviewing('J1')),
      otherJourney: await run(reviewing('J2')),
      otherJourneySaving: await run({ ...reviewing('J2'), phase: 'saving' }),
      sameJourneyReopened: await run(reviewing('J1', 'S2')),
      sameJourneyReopenedSaving: await run({ ...reviewing('J1', 'S2'), phase: 'saving' }),
    };
  });
  const stale = 'stale-review: Another review tab changed this journey. Reload the review and try again.';
  expect(outcomes).toEqual({
    sameReview: { sent: ['ANMERKO_JOURNEY_STATE', { type: 'ANMERKO_JOURNEY_UPDATE_SUMMARY', journeyId: 'J1', sessionId: 'S' }], outcome: 'ok' },
    otherJourney: { sent: ['ANMERKO_JOURNEY_STATE'], outcome: stale },
    otherJourneySaving: { sent: ['ANMERKO_JOURNEY_STATE'], outcome: stale },
    sameJourneyReopened: { sent: ['ANMERKO_JOURNEY_STATE'], outcome: stale },
    sameJourneyReopenedSaving: { sent: ['ANMERKO_JOURNEY_STATE'], outcome: stale },
  });
});

test('every review command and discard names the review or view it was made in', async ({ page }) => {
  await page.addScriptTag({ content: clientBundle });
  const outcomes = await page.evaluate(async () => {
    const { clientModule } = globalThis as HarnessWindow;
    const runtime = (globalThis as any).chrome.runtime;
    const reviewing = (sessionId: string, phase = 'reviewing') => ({ phase, epoch: 2, sessionId, journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
      warningAt: '2026-09-21T00:30:00.000Z', expiresAt: '2026-09-21T01:00:00.000Z',
      draft: { id: 'J1', revision: 3, images: { I1: { dataUrl: 'data:image/png;base64,AAAA' } }, steps: [] } });
    const review = { journeyId: 'J1', sessionId: 'S' };
    // current: the state each read returns; refused: whether the command itself is refused as stale.
    const run = async (current: unknown, refused: boolean, command: (client: any) => Promise<unknown>) => {
      const sent: unknown[] = [];
      runtime.sendMessage = async (message: Record<string, unknown>) => {
        if (message.type === 'ANMERKO_JOURNEY_STATE') {
          sent.push(message.type);
          return { ok: true, value: current };
        }
        const { type, updatedAt: _updatedAt, ...rest } = message;
        sent.push({ type, ...rest });
        if (refused) return { ok: false, error: 'Journey command unavailable.', code: 'stale-review' };
        return type === 'ANMERKO_JOURNEY_SAVE' ? { ok: true, value: { journeyId: 'J1', revision: 4 } } : { ok: true };
      };
      try {
        await command(clientModule.createJourneyClient(() => ({ ownerTabId: 1, ownerWindowId: 1 })));
        return { sent, outcome: 'ok' };
      } catch (error) {
        return { sent, outcome: `${(error as { code?: string }).code ?? 'none'}: ${(error as Error).message}` };
      }
    };
    const edits: Record<string, (client: any) => Promise<unknown>> = {
      removeStep: client => client.removeStep('S1', review),
      editValue: client => client.editValue('S1', { kind: 'text', value: 'x' }, review),
      redactUrl: client => client.redactUrl('S1', 'source', review),
      redactLabel: client => client.redactLabel('S1', review),
      reviewImage: client => client.reviewImage('I1', { operation: 'remove' }, review),
    };
    const results: Record<string, unknown> = {};
    for (const [name, edit] of Object.entries(edits)) {
      results[name] = await run(reviewing('S'), false, edit);
      // The saved journey was reopened elsewhere: nothing is sent.
      results[`${name}Reopened`] = await run(reviewing('S2'), false, edit);
    }
    results.save = await run(reviewing('S'), false, client => client.save(true, review));
    results.discardReview = await run(reviewing('S'), false, client => client.discard({ phase: 'reviewing', ...review, revision: 3 }));
    // A discard this review's own save refuses says so; another review's refusal blames the other tab.
    results.discardWhileSaving = await run(reviewing('S', 'saving'), true, client => client.discard({ phase: 'reviewing', ...review }));
    results.discardReopened = await run(reviewing('S2'), true, client => client.discard({ phase: 'reviewing', ...review }));
    results.discardSaved = await run({ phase: 'saved', epoch: 3, journeyId: 'J1', revision: 4 }, false,
      client => client.discard({ phase: 'saved', journeyId: 'J1' }));
    results.reset = await run({ phase: 'idle', epoch: 3 }, false, client => client.discard());
    return results;
  });
  const stale = 'stale-review: Another review tab changed this journey. Reload the review and try again.';
  const guards = { epoch: 2, journeyId: 'J1', sessionId: 'S', revision: 3 };
  const sentEdit = (type: string, extra: Record<string, unknown>) => ({ sent: ['ANMERKO_JOURNEY_STATE', { type, ...guards, ...extra }], outcome: 'ok' });
  const refusedUnsent = { sent: ['ANMERKO_JOURNEY_STATE'], outcome: stale };
  expect(outcomes).toEqual({
    removeStep: sentEdit('ANMERKO_JOURNEY_REMOVE_STEP', { stepId: 'S1' }),
    removeStepReopened: refusedUnsent,
    editValue: sentEdit('ANMERKO_JOURNEY_EDIT_VALUE', { stepId: 'S1', value: { kind: 'text', value: 'x' } }),
    editValueReopened: refusedUnsent,
    redactUrl: sentEdit('ANMERKO_JOURNEY_REDACT_URL', { stepId: 'S1', url: 'source' }),
    redactUrlReopened: refusedUnsent,
    redactLabel: sentEdit('ANMERKO_JOURNEY_REDACT_LABEL', { stepId: 'S1' }),
    redactLabelReopened: refusedUnsent,
    reviewImage: sentEdit('ANMERKO_JOURNEY_REVIEW_IMAGE', { imageId: 'I1', operation: 'remove' }),
    reviewImageReopened: refusedUnsent,
    save: { sent: [{ type: 'ANMERKO_JOURNEY_SAVE', acknowledged: true, journeyId: 'J1', sessionId: 'S' }], outcome: 'ok' },
    discardReview: { sent: [{ type: 'ANMERKO_JOURNEY_DISCARD', phase: 'reviewing', journeyId: 'J1', sessionId: 'S', revision: 3 }], outcome: 'ok' },
    discardWhileSaving: {
      sent: [{ type: 'ANMERKO_JOURNEY_DISCARD', phase: 'reviewing', journeyId: 'J1', sessionId: 'S' }, 'ANMERKO_JOURNEY_STATE'],
      outcome: 'save-in-progress: This journey is being saved. Wait for the save to finish, then try again.',
    },
    discardReopened: {
      sent: [{ type: 'ANMERKO_JOURNEY_DISCARD', phase: 'reviewing', journeyId: 'J1', sessionId: 'S' }, 'ANMERKO_JOURNEY_STATE'],
      outcome: stale,
    },
    discardSaved: { sent: [{ type: 'ANMERKO_JOURNEY_DISCARD', phase: 'saved', journeyId: 'J1' }], outcome: 'ok' },
    reset: { sent: [{ type: 'ANMERKO_JOURNEY_DISCARD' }], outcome: 'ok' },
  });
});

test('binds fallback actions to one intent and authenticates change notifications', async ({ page }) => {
  await page.addScriptTag({ content: clientBundle });
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.client = (globalThis as HarnessWindow).clientModule.createJourneyClient(undefined, 'launch_nonce-1234567890');
  });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.client.supportsEnteredValues)).toBe(true);
  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.pending = harness.client.start(true);
  });
  await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.pending);
  await page.evaluate(async () => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    await harness.client.read(); await harness.client.stop(); await harness.client.discard();
  });
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log)).toEqual([
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_START', intent: 'launch_nonce-1234567890', includeEnteredValues: true } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_STATE', screenshots: 'review', held: [] } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_STOP', intent: 'launch_nonce-1234567890' } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_DISCARD' } },
  ]);

  const notifications = await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    let count = 0;
    const accepted: string[] = [];
    const unsubscribe = harness.client.subscribe(() => { count++; });
    const message = { type: 'ANMERKO_JOURNEY_CHANGED' };
    const emit = (label: string, sender: unknown) => {
      const before = count;
      for (const listener of harness.listeners) listener(message, sender);
      if (count > before) accepted.push(label);
    };
    emit('wrong-id', { id: 'other-extension' });
    emit('tab', { id: 'test-extension', tab: { id: 1 }, url: 'https://example.test/' });
    emit('sidebar', { id: 'test-extension', url: 'chrome-extension://test-extension/sidebar.html' });
    emit('journey', { id: 'test-extension', url: 'chrome-extension://test-extension/journey.html' });
    emit('worker-query', { id: 'test-extension', url: 'chrome-extension://test-extension/background.js?query=1' });
    emit('worker-hash', { id: 'test-extension', url: 'chrome-extension://test-extension/background.js#hash' });
    emit('worker-prefix', { id: 'test-extension', url: 'chrome-extension://test-extension/background.js/prefix' });
    emit('external', { id: 'test-extension', url: 'https://example.test/background.js' });
    emit('undefined', { id: 'test-extension' });
    emit('worker', { id: 'test-extension', url: 'chrome-extension://test-extension/background.js' });
    harness.manifest = { background: { scripts: ['background.js'] } };
    emit('worker-under-scripts', { id: 'test-extension', url: 'chrome-extension://test-extension/background.js' });
    emit('generated-query', { id: 'test-extension', url: 'chrome-extension://test-extension/_generated_background_page.html?query=1' });
    emit('generated-hash', { id: 'test-extension', url: 'chrome-extension://test-extension/_generated_background_page.html#hash' });
    emit('generated-prefix', { id: 'test-extension', url: 'chrome-extension://test-extension/_generated_background_page.html/nested' });
    emit('generated-tab', { id: 'test-extension', url: 'chrome-extension://test-extension/_generated_background_page.html', tab: { id: 2 } });
    emit('generated', { id: 'test-extension', url: 'chrome-extension://test-extension/_generated_background_page.html' });
    unsubscribe();
    for (const listener of harness.listeners) listener(message, { id: 'test-extension' });
    return { accepted, count, listeners: harness.listeners.length };
  });
  expect(notifications).toEqual({ accepted: ['undefined', 'worker', 'generated'], count: 3, listeners: 0 });
});

test('rejects invalid launch context before start and sanitizes failures', async ({ page }) => {
  await page.addScriptTag({ content: clientBundle });
  expect(await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.client = (globalThis as HarnessWindow).clientModule.createJourneyClient();
    try { harness.client.start(false); return 'no error'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toBe('Open anmerko from a website before starting a journey.');
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log)).toEqual([]);
  expect(await page.evaluate(() => {
    const client = (globalThis as HarnessWindow).clientModule.createJourneyClient(() => { throw new Error('private owner error'); });
    try { client.start(false); return 'no error'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toBe('Open anmerko from a website before starting a journey.');

  await page.evaluate(() => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.client = (globalThis as HarnessWindow).clientModule.createJourneyClient(() => ({ ownerTabId: 1, ownerWindowId: 2 }));
    harness.response = { ok: false, code: 'busy', error: 'private backend details' };
    harness.pending = harness.client.start(false);
  });
  expect(await page.evaluate(async () => {
    try { await (globalThis as HarnessWindow).surfaceHarness.pending; return 'no error'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toBe('Finish or discard the existing journey before starting another.');

  await page.evaluate(() => {
    (globalThis as HarnessWindow).surfaceHarness.response = {
      ok: false, code: 'session-storage-failed', error: 'private storage details',
    };
  });
  expect(await page.evaluate(async () => {
    try { await (globalThis as HarnessWindow).surfaceHarness.client.read(); return 'no error'; }
    catch (error) { return error instanceof Error ? error.message : String(error); }
  })).toBe('Journey storage failed. Reset journey storage to continue. A previous draft or the latest action may be lost.');

  // A start that failed for no reason the view can name says start, and can
  // be tried again; so can one whose first screenshot failed. The view says how.
  const startFailure = (response: unknown) => page.evaluate(async response => {
    const harness = (globalThis as HarnessWindow).surfaceHarness;
    harness.response = response;
    try { await harness.client.start(false); return 'no error'; }
    catch (error) { return { message: (error as Error).message, code: (error as { code?: unknown }).code ?? null, retry: (error as { retry?: unknown }).retry ?? null }; }
  }, response);
  expect(await startFailure({ ok: false, code: '__proto__', error: 'private backend details' }))
    .toEqual({ message: 'Could not start the journey.', code: '__proto__', retry: true });
  expect(await startFailure({ ok: false, error: 'private backend details' }))
    .toEqual({ message: 'Could not start the journey.', code: null, retry: true });
  expect(await startFailure({ ok: false, code: 'initial-capture-failed', error: 'private backend details' }))
    .toEqual({ message: 'The first journey screenshot failed.', code: 'initial-capture-failed', retry: true });
  expect(await startFailure({ ok: false, code: 'busy', error: 'private backend details' }))
    .toEqual({ message: 'Finish or discard the existing journey before starting another.', code: 'busy', retry: null });
});

// A launch link is spent by its first Start, even one that fails, so the tab
// then offers no Start: its error says where to start again.
for (const [code, error] of [
  ['initial-capture-failed', 'The first journey screenshot failed. To try again, go to the website tab and choose Record journey again.'],
  [undefined, 'Could not start the journey. To try again, go to the website tab and choose Record journey again.'],
] as const) {
  test(`a journey tab whose start failed (${code ?? 'no code'}) says where to start again, not to try again here`, async ({ page }) => {
    await page.setContent('<!doctype html><html><head></head><body><main id="journey"></main></body></html>');
    await page.evaluate(() => { location.hash = 'launch=valid_nonce-1234567890'; });
    await page.addScriptTag({ content: pageBundle(true) });
    const start = page.getByRole('button', { name: 'Start journey', exact: true });
    await expect(start).toBeVisible();
    await page.evaluate(code => {
      const harness = (globalThis as HarnessWindow).surfaceHarness;
      const idle = harness.response;
      (globalThis as any).chrome.runtime.sendMessage = async (message: { type: string }) => {
        harness.log.push({ kind: 'message', message: structuredClone(message) });
        if (message.type !== 'ANMERKO_JOURNEY_START') return structuredClone(idle);
        return { ok: false, error: 'private backend details', ...code ? { code } : {} };
      };
    }, code);
    await start.click();
    await expect(page.getByRole('alert')).toHaveText(error);
    await expect(page.locator('#journey-start-error')).toHaveText(error);
    await expect(start).toHaveCount(0);
    await expect(page.getByText(/^To record a new journey, go to the website tab/)).toBeVisible();
    await expect(page.locator('.journey-view')).not.toContainText('Try again');
  });
}

test('the journey tab names each view in its title', async ({ page }) => {
  await page.setContent('<!doctype html><html><head><title>anmerko journey</title></head><body><main id="journey"></main></body></html>');
  await page.evaluate(() => { location.hash = 'launch=valid_nonce-1234567890'; });
  await page.addScriptTag({ content: pageBundle(true) });
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  await expect(page).toHaveTitle('Record a journey – anmerko');
  const draft = { id: 'J1', revision: 1, includeEnteredValues: false, stopReason: 'user', expected: '', actual: '', steps: [], images: {}, limitations: [] };
  const owner = { epoch: 2, sessionId: 'S', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1 };
  const views: Array<[unknown, string]> = [
    [{ ...owner, phase: 'recording', documentToken: 'D', deadlineAt: '2099-01-01T00:00:00.000Z', documentCounters: {}, draft }, 'Recording journey – anmerko'],
    [{ ...owner, phase: 'reviewing', warningAt: '2099-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:10:00.000Z', draft }, 'Review journey – anmerko'],
    [{ ...owner, phase: 'saving', draft }, 'Saving journey – anmerko'],
    [{ phase: 'saved', epoch: 3, journeyId: 'J1', revision: 2 }, 'Journey saved – anmerko'],
  ];
  for (const [state, title] of views) {
    await page.evaluate(state => {
      const harness = (globalThis as HarnessWindow).surfaceHarness;
      harness.response = { ok: true, value: state };
      for (const listener of harness.listeners) listener({ type: 'ANMERKO_JOURNEY_CHANGED' }, { id: 'test-extension' });
    }, state);
    await expect(page).toHaveTitle(title);
  }
});

test('a spent journey link and an unavailable browser say so in the tab title too', async ({ page }) => {
  await page.setContent('<!doctype html><html><head><title>anmerko journey</title></head><body><main id="journey"></main></body></html>');
  await page.evaluate(() => { location.hash = 'launch=valid_nonce-1234567890'; });
  await page.addScriptTag({ content: pageBundle(true) });
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
  await page.evaluate(() => {
    (globalThis as HarnessWindow).surfaceHarness.response = { ok: false, code: 'launch-expired', error: 'private backend details' };
  });
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'This journey link already opened' })).toBeVisible();
  await expect(page).toHaveTitle('Journey link already used – anmerko');

  await page.setContent('<!doctype html><html><head><title>anmerko journey</title></head><body><main id="journey"></main></body></html>');
  await page.addScriptTag({ content: pageBundle(false) });
  await expect(page.getByRole('heading', { name: 'Journey recording unavailable' })).toBeVisible();
  await expect(page).toHaveTitle('Journey recording unavailable – anmerko');
});

test('trusted page strictly parses launch intent and shares the journey UI only when enabled', async ({ page }) => {
  await page.setContent('<!doctype html><html><head></head><body><main id="journey"></main></body></html>');
  await page.evaluate(() => { location.hash = 'launch=valid_nonce-1234567890'; });
  await page.addScriptTag({ content: pageBundle(true) });
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Include entered values' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Include entered values' })).not.toBeChecked();
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log)).toEqual([
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_STATE', screenshots: 'review', held: [] } },
    { kind: 'message', message: { type: 'ANMERKO_JOURNEY_LIST' } },
  ]);
  await page.getByRole('button', { name: 'Start journey', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log
    .some(entry => entry.message?.type === 'ANMERKO_JOURNEY_START')))).toBe(true);
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log
    .filter(entry => entry.kind === 'permission'))).toEqual([]);
  await expect(page.getByRole('alert')).toBeEmpty();
  // The link is spent after one Start, so the tab explains how to record again.
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toHaveCount(0);
  await expect(page.getByText(/^To record a new journey, go to the website tab/)).toBeVisible();
});

for (const hash of ['', 'launch=short', 'launch=valid_nonce-1234567890&extra=1', 'launch=valid%5Fnonce-1234567890', 'launch=invalid/value_1234567890']) {
  test(`offers guidance instead of Start for invalid intent hash ${hash || '(empty)'}`, async ({ page }) => {
    await page.setContent('<!doctype html><html><head></head><body><main id="journey"></main></body></html>');
    await page.evaluate(value => { location.hash = value; }, hash);
    await page.addScriptTag({ content: pageBundle(true) });
    await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
    await expect(page.getByText(/^To record a new journey, go to the website tab/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log
      .some(entry => entry.message?.type === 'ANMERKO_JOURNEY_START' || entry.kind === 'permission'))).toBe(false);
  });
}

test('every review surface styles the screenshot mask dialog', async ({ page }) => {
  const maskDialogRadius = () => {
    const host = Array.from(document.documentElement.children).find(element => element.shadowRoot?.querySelector('.app'));
    const dialog = document.createElement('dialog');
    dialog.className = 'journey-image-review';
    (host?.shadowRoot?.querySelector('.app') ?? document.body).append(dialog);
    return getComputedStyle(dialog).borderTopLeftRadius;
  };
  await page.setContent('<!doctype html><html><head></head><body><main id="journey"></main></body></html>');
  await page.addScriptTag({ content: pageBundle(true) });
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  expect(await page.evaluate(maskDialogRadius)).toBe('12px');

  const sidebarBundle = buildSync({
    entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife',
    loader: { '.css': 'text' }, define: { __TARGET_JOURNEYS__: 'true' },
  }).outputFiles[0].text;
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: sidebarBundle });
  await expect(page.getByRole('complementary', { name: 'anmerko feedback panel' })).toBeVisible();
  expect(await page.evaluate(maskDialogRadius)).toBe('12px');

  // A dark sidebar keeps the dialog's warning text on theme tokens, readable on its dark surface.
  expect(await page.evaluate(() => {
    const app = Array.from(document.documentElement.children)
      .map(element => element.shadowRoot?.querySelector('.app')).find(Boolean)!;
    app.setAttribute('data-theme', 'dark');
    const dialog = app.querySelector('.journey-image-review')!;
    const danger = document.createElement('button');
    danger.className = 'journey-image-review__button journey-image-review__button--danger';
    const error = document.createElement('p');
    error.className = 'journey-image-review__error';
    dialog.append(danger, error);
    return [getComputedStyle(dialog).backgroundColor, getComputedStyle(danger).color, getComputedStyle(error).color];
  })).toEqual(['rgb(28, 37, 53)', 'rgb(255, 170, 165)', 'rgb(255, 170, 165)']);
});

test('the journey tab drops the body margin and leaves room to scroll its last control above a dynamic toolbar', async ({ page }) => {
  const html = await readFile('public/journey.html', 'utf8');
  await page.setViewportSize({ width: 390, height: 700 });
  await page.setContent(html.replace('<script src="journey.js"></script>', ''));
  await page.evaluate(() => { location.hash = 'launch=valid_nonce-1234567890'; });
  await page.addScriptTag({ content: pageBundle(true) });
  await expect(page.getByRole('button', { name: 'Start journey', exact: true })).toBeVisible();
  const layout = await page.evaluate(() => {
    const view = document.querySelector('.journey-view')!;
    const buttons = [...view.querySelectorAll('button')];
    const last = buttons.at(-1)!.getBoundingClientRect();
    return {
      bodyMargin: getComputedStyle(document.body).margin,
      paddingBottom: parseFloat(getComputedStyle(view).paddingBottom),
      room: document.documentElement.scrollHeight - (last.bottom + scrollY),
    };
  });
  expect(layout.bodyMargin).toBe('0px');
  // Firefox for Android lays the page out about 65px taller than it shows.
  expect(layout.paddingBottom).toBeGreaterThanOrEqual(96);
  expect(layout.room).toBeGreaterThanOrEqual(96);
});

test('feature-off page renders an unavailable message without contacting the background', async ({ page }) => {
  await page.setContent('<!doctype html><html><head></head><body><main id="journey"></main></body></html>');
  await page.evaluate(() => { location.hash = 'launch=valid_nonce-1234567890'; });
  await page.addScriptTag({ content: pageBundle(false) });
  await expect(page.getByRole('heading', { name: 'Journey recording unavailable' })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as HarnessWindow).surfaceHarness.log)).toEqual([]);
});

test('bundled page has a viewport, external script, and no web-accessible exposure', async () => {
  const [html, manifestText] = await Promise.all([
    readFile('public/journey.html', 'utf8'), readFile('public/manifest.json', 'utf8'),
  ]);
  expect(html).toMatch(/<meta name="viewport"/);
  expect(html).toMatch(/<script src="journey\.js"><\/script>/);
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
  expect(html).not.toMatch(/<style\b|\sstyle=/);
  const manifest = JSON.parse(manifestText);
  expect(JSON.stringify(manifest.web_accessible_resources ?? [])).not.toContain('journey.html');
});
