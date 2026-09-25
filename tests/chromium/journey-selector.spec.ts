import { expect, test } from '@playwright/test';
import { buildSync } from 'esbuild';
import type { JourneyManifestV1, SafeTarget } from '../../src/journey-core';
import { validateJourneyManifest } from '../../src/journey-core';
import { validateJourneyEventBatch } from '../../src/journey-events';
import { formatJourneyMarkdown } from '../../src/journey-export';

type TargetsWindow = typeof globalThis & {
  journeyTargets: {
    attachJourneyRecorder(options: {
      sessionId: string; epoch: number; documentToken: string; startedAt: string;
      onBatch(batch: unknown): void;
    }): { dispose(): void };
    attachJourneyFields(options: {
      sessionId: string; epoch: number; documentToken: string; startedAt: string;
      onFieldCommit(commit: unknown): void;
    }): () => void;
  };
  recordedBatches: any[];
  fieldCommits: any[];
};

const bundle = buildSync({
  stdin: {
    contents: "export { attachJourneyRecorder } from './src/journey-recorder';\nexport { attachJourneyFields } from './src/journey-fields';",
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'journeyTargets',
}).outputFiles[0].text;

function batch(selectorPath: unknown) {
  return {
    schemaVersion: 1, sessionId: 'session-1', epoch: 1, documentToken: 'document-1', localCounter: 1,
    events: [{
      kind: 'click', id: 'event-1', observedAt: '2026-09-20T12:00:01.000Z', elapsedMs: 1_000,
      sourceUrl: 'https://shop.example/cart',
      target: { tag: 'button', selectorPath, label: 'Go', editable: false, viewport: { width: 390, height: 844 }, scroll: { x: 0, y: 0 } },
      image: { status: 'pending', captureId: 'capture-1' },
    }],
  };
}

function manifest(selectorPath: string[]): JourneyManifestV1 {
  const target: SafeTarget = {
    tag: 'button', role: 'button', selectorPath,
    label: { text: 'Continue', edited: false, redacted: false }, editable: false,
    viewport: { width: 1_280, height: 720 }, scroll: { x: 0, y: 0 },
  };
  const url = { text: 'https://shop.example/cart', edited: false, redacted: false };
  return {
    schemaVersion: 1, id: 'J1', revision: 1,
    createdAt: '2026-09-20T12:00:00.000Z', updatedAt: '2026-09-20T12:00:02.000Z',
    startedAt: '2026-09-20T12:00:00.000Z', stoppedAt: '2026-09-20T12:00:02.000Z',
    includeEnteredValues: false, stopReason: 'user', expected: 'Expected', actual: 'Actual',
    steps: [{
      kind: 'click', id: 'S1', seq: 1, observedAt: '2026-09-20T12:00:01.000Z', elapsedMs: 1_000,
      sourceUrl: url, target, image: { status: 'removed' },
    }],
    images: {},
    limitations: [],
  };
}

test('recorded and field selector paths mark truncation and shadow-root crossings', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/recorder');
  await page.setContent('<main id="deep"></main><section id="shadowed"></section>');
  await page.evaluate(() => {
    let parent: Element = document.querySelector('#deep')!;
    for (let depth = 0; depth < 16; depth++) parent = parent.appendChild(document.createElement('div'));
    parent.appendChild(document.createElement('button')).textContent = 'Deep action';

    const outer = document.createElement('x-outer');
    const outerRoot = outer.attachShadow({ mode: 'open' });
    const wrapper = outerRoot.appendChild(document.createElement('div'));
    const inner = wrapper.appendChild(document.createElement('x-inner'));
    const innerRoot = inner.attachShadow({ mode: 'open' });
    innerRoot.innerHTML = '<button type="button">Inner action</button><input type="text" name="nickname">';
    document.querySelector('#shadowed')!.append(outer);
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const state = globalThis as TargetsWindow;
    state.recordedBatches = [];
    state.fieldCommits = [];
    const common = { sessionId: 'session-1', epoch: 1, documentToken: 'document-1', startedAt: new Date(Date.now() - 100).toISOString() };
    state.journeyTargets.attachJourneyFields({ ...common, onFieldCommit: commit => { state.fieldCommits.push(commit); } });
    state.journeyTargets.attachJourneyRecorder({ ...common, onBatch: value => { state.recordedBatches.push(value); } });
  });

  await page.getByRole('button', { name: 'Deep action' }).click();
  await page.getByRole('button', { name: 'Inner action' }).click();
  await page.locator('x-inner input').fill('green otter');
  await page.getByRole('button', { name: 'Deep action' }).click();

  const { recordedBatches, fieldCommits } = await page.evaluate(() => {
    const state = globalThis as TargetsWindow;
    return { recordedBatches: state.recordedBatches, fieldCommits: state.fieldCommits };
  });
  const deep = recordedBatches[0].events[0].target.selectorPath;
  expect(deep).toEqual(['…', ...Array<string>(10).fill('div'), 'button']);
  expect(recordedBatches[1].events[0].target.selectorPath)
    .toEqual(['html', 'body', 'section', 'x-outer', '#shadow-root', 'div', 'x-inner', '#shadow-root', 'button']);
  expect(fieldCommits).toHaveLength(1);
  expect(fieldCommits[0].target.selectorPath)
    .toEqual(['html', 'body', 'section', 'x-outer', '#shadow-root', 'div', 'x-inner', '#shadow-root', 'input']);
  expect(recordedBatches.every(value => validateJourneyEventBatch(value).ok)).toBe(true);
  expect(validateJourneyEventBatch({ ...batch(fieldCommits[0].target.selectorPath), events: [fieldCommits[0]] }).ok).toBe(true);
});

test('a truncated path keeps a shadow-root crossing next to its marker', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/recorder');
  await page.setContent('<main></main>');
  await page.evaluate(() => {
    let parent: Element = document.querySelector('main')!;
    for (let depth = 0; depth < 12; depth++) parent = parent.appendChild(document.createElement('div'));
    const host = parent.appendChild(document.createElement('x-host'));
    let inner: Element | ShadowRoot = host.attachShadow({ mode: 'open' });
    for (let depth = 0; depth < 9; depth++) inner = inner.appendChild(document.createElement('span'));
    inner.appendChild(document.createElement('button')).textContent = 'Nested action';
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const state = globalThis as TargetsWindow;
    state.recordedBatches = [];
    state.journeyTargets.attachJourneyRecorder({
      sessionId: 'session-1', epoch: 1, documentToken: 'document-1', startedAt: new Date(Date.now() - 100).toISOString(),
      onBatch: value => { state.recordedBatches.push(value); },
    });
  });

  await page.getByRole('button', { name: 'Nested action' }).click();
  const recorded = await page.evaluate(() => (globalThis as TargetsWindow).recordedBatches);
  expect(recorded[0].events[0].target.selectorPath).toEqual(['…', '#shadow-root', ...Array<string>(9).fill('span'), 'button']);
  expect(validateJourneyEventBatch(recorded[0]).ok).toBe(true);
});

test('event and manifest validation accept marked paths and reject misplaced markers', () => {
  const valid = [
    ['button'],
    ['main', 'button:nth-of-type(2)'],
    ['…', 'div', 'button'],
    ['html', 'body', 'x-host', '#shadow-root', 'button'],
    ['…', '#shadow-root', 'span', 'button'],
    ['…', ...Array<string>(11).fill('div')],
  ];
  const invalid = [
    [],
    ['…'],
    ['#shadow-root'],
    ['#shadow-root', 'button'],
    ['x-host', '#shadow-root'],
    ['x-host', '#shadow-root', '#shadow-root', 'button'],
    ['div', '…', 'button'],
    ['…', '…', 'button'],
    ['...', 'button'],
    ['shadow root', 'button'],
    ['…', ...Array<string>(12).fill('div')],
    ['div > button'],
  ];
  for (const path of valid) {
    expect(validateJourneyEventBatch(batch(path)).ok, JSON.stringify(path)).toBe(true);
    expect(validateJourneyManifest(manifest(path)).ok, JSON.stringify(path)).toBe(true);
  }
  for (const path of invalid) {
    expect(validateJourneyEventBatch(batch(path)).ok, JSON.stringify(path)).toBe(false);
    expect(validateJourneyManifest(manifest(path)).ok, JSON.stringify(path)).toBe(false);
  }
});

test('journeys.md marks truncation and shadow roots like the comments export', () => {
  const marked = formatJourneyMarkdown(manifest(['…', 'div', 'x-host', '#shadow-root', 'button:nth-of-type(2)']));
  expect(marked).toContain('Selector path: … → `div` → `x-host` → shadow root → `button:nth-of-type(2)`\n');
  const plain = formatJourneyMarkdown(manifest(['main', 'button']));
  expect(plain).toContain('Selector path: `main` → `button`\n');
});
