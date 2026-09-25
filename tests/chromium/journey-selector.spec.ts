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

test('any real element records: SVG, prefixed, and unusual custom element names fold to valid segments and tags', async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/recorder');
  // Mermaid draws node labels as HTML inside SVG foreignObject; Word exports
  // write <o:p>; custom element names may hold '.', '_' and non-ASCII letters.
  await page.setContent(`<main>
    <svg width="200" height="60"><foreignObject width="200" height="60"><div><button id="node" type="button">Node label</button></div></foreignObject></svg>
    <svg width="200" height="40"><path id="curve" d="M10 30 H190" fill="none"/><text><textPath id="path-label" href="#curve">Along the path</textPath></text></svg>
    <p id="word">Exported <o:p id="prefixed">paragraph</o:p></p>
    <x_y-el id="underscore">Underscore element</x_y-el>
    <constructor id="builtin-name">Prototype name</constructor>
  </main>`);
  await page.evaluate(() => {
    const main = document.querySelector('main')!;
    for (const [id, name, text] of [
      ['dotted', 'my.widget-x', 'Dotted element'],
      ['accented', 'café-élément', 'Accented element'],
      ['cjk', '漢字-el', ''],
      ['long', `x-${'y'.repeat(300)}`, ''],
    ]) {
      const element = main.appendChild(document.createElement(name));
      element.id = id;
      element.textContent = text;
      (element as HTMLElement).style.cssText = 'display:block;min-height:20px;min-width:40px';
    }
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

  for (const id of ['node', 'path-label', 'prefixed', 'underscore', 'builtin-name', 'dotted', 'accented', 'cjk', 'long']) {
    await page.locator(`#${id}`).click();
  }
  const recorded = await page.evaluate(() => (globalThis as TargetsWindow).recordedBatches);
  expect(recorded).toHaveLength(9);
  for (const value of recorded) expect(validateJourneyEventBatch(value), JSON.stringify(value.events[0].target)).toMatchObject({ ok: true });
  const targets = recorded.map(value => value.events[0].target);
  expect(targets[0]).toMatchObject({ tag: 'button', label: 'Node label', role: 'button' });
  expect(targets[0].selectorPath).toEqual(['html', 'body', 'main', 'svg:nth-of-type(1)', 'foreignobject', 'div', 'button']);
  expect(targets[1]).toMatchObject({ tag: 'textpath', label: 'Along the path' });
  expect(targets[2]).toMatchObject({ tag: 'o-p', label: 'paragraph' });
  expect(targets[2].selectorPath.slice(-2)).toEqual(['p', 'o-p']);
  expect(targets[3]).toMatchObject({ tag: 'x-y-el', label: 'Underscore element' });
  expect(targets[4]).toMatchObject({ tag: 'constructor', label: 'Prototype name' });
  expect(targets[4].role).toBeUndefined();
  expect(targets[5]).toMatchObject({ tag: 'my-widget-x', label: 'Dotted element' });
  expect(targets[6]).toMatchObject({ tag: 'cafe-element', label: 'Accented element' });
  // Without text the label is the element's own name, bounded like any label.
  expect(targets[7]).toMatchObject({ tag: 'x-el', label: '漢字 el' });
  expect(targets[8].tag).toBe(`x-${'y'.repeat(62)}`);
  expect(targets[8].selectorPath.at(-1)).toBe(`x-${'y'.repeat(62)}`);
  expect(Array.from(targets[8].label)).toHaveLength(120);
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
