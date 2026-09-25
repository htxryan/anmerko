import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { journeyTextEntryTarget, validateJourneyEventBatch } from '../../src/journey-events';

type RecorderWindow = typeof globalThis & {
  anmerkoJourneyRecorder: {
    attachJourneyRecorder(options: {
      sessionId: string;
      epoch: number;
      documentToken: string;
      startedAt: string;
      onBatch(batch: unknown): void;
      drainFieldCommits?: () => unknown[];
      ignore?: (target: Element) => boolean;
    }): { dispose(): void; flushFieldCommits(): void };
  };
  journeyBatches: any[];
  disposeJourneyRecorder: { dispose(): void; flushFieldCommits(): void };
  normalActions: number;
  valueReads: number;
};

const bundle = buildSync({
  entryPoints: ['src/journey-recorder.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'anmerkoJourneyRecorder',
}).outputFiles[0].text;

async function attach(page: Page, ignoreClass?: string) {
  await page.addScriptTag({ content: bundle });
  await page.evaluate(ignoreClass => {
    const state = globalThis as RecorderWindow;
    state.journeyBatches = [];
    state.disposeJourneyRecorder = state.anmerkoJourneyRecorder.attachJourneyRecorder({
      sessionId: 'session-1',
      epoch: 3,
      documentToken: 'document-1',
      startedAt: new Date(Date.now() - 100).toISOString(),
      onBatch: batch => { state.journeyBatches.push(batch); },
      ignore: ignoreClass ? target => target.classList.contains(ignoreClass) : undefined,
    });
  }, ignoreClass);
}

const batches = (page: Page) => page.evaluate(() => (globalThis as RecorderWindow).journeyBatches);

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/recorder?item=green&item=large#start');
});

test('trusted mouse and keyboard clicks emit ordered raw batches without changing page behavior', async ({ page }) => {
  await page.setContent(`
    <a href="#destination">Continue</a>
    <button type="button">Normal button</button>
    <script>window.normalActions = 0; document.querySelector('button').addEventListener('click', () => window.normalActions++);</script>
  `);
  await attach(page);

  await page.getByRole('link', { name: 'Continue' }).click();
  await expect(page).toHaveURL(/#destination$/);
  await page.getByRole('button', { name: 'Normal button' }).click();
  await page.getByRole('button', { name: 'Normal button' }).focus();
  await page.keyboard.press('Enter');

  expect(await page.evaluate(() => (globalThis as RecorderWindow).normalActions)).toBe(2);
  const recorded = await batches(page);
  expect(recorded).toHaveLength(3);
  expect(recorded.map(batch => batch.localCounter)).toEqual([1, 2, 3]);
  expect(recorded.every(batch => batch.schemaVersion === 1
    && batch.sessionId === 'session-1'
    && batch.epoch === 3
    && batch.documentToken === 'document-1')).toBe(true);
  expect(recorded.map(batch => batch.events[0].target.label)).toEqual(['Continue', 'Normal button', 'Normal button']);
  expect(recorded[0].events[0].sourceUrl).toBe('http://127.0.0.1:4173/recorder?item=green&item=large#start');
  expect(recorded[1].events[0].sourceUrl).toBe('http://127.0.0.1:4173/recorder?item=green&item=large#destination');
  expect(recorded[0].events[0].target.role).toBe('link');
  expect(recorded[1].events[0].target.role).toBe('button');
  expect(recorded.every(batch => batch.events[0].kind === 'click'
    && batch.events[0].image.status === 'pending'
    && Number.isFinite(batch.events[0].elapsedMs)
    && batch.events[0].elapsedMs >= 0)).toBe(true);
  expect(recorded.every(batch => validateJourneyEventBatch(batch).ok)).toBe(true);
  expect(new Set(recorded.flatMap(batch => [batch.events[0].id, batch.events[0].image.captureId])).size).toBe(6);
  expect(recorded.flatMap(batch => [batch.events[0].id, batch.events[0].image.captureId])
    .every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))).toBe(true);
  expect(recorded[0].events[0].target.viewport).toEqual({ width: 1280, height: 720 });
  expect(recorded[0].events[0].target.scroll).toEqual({ x: 0, y: 0 });
  expect(recorded[0].events[0].target.point.x).toBeGreaterThanOrEqual(0);
  expect(recorded[0].events[0].target.point.y).toBeGreaterThanOrEqual(0);
  expect(recorded[2].events[0].target.point).toBeUndefined();

  await page.evaluate(() => (globalThis as RecorderWindow).disposeJourneyRecorder.dispose());
  await page.getByRole('button', { name: 'Normal button' }).click();
  expect(await batches(page)).toHaveLength(3);
  expect(await page.evaluate(() => (globalThis as RecorderWindow).normalActions)).toBe(3);
});

test('click context reports the visible viewport and a point inside it under zoom and pan', async ({ page }) => {
  await page.setContent(`
    <button type="button" style="position:absolute;left:300px;top:400px">Zoomed action</button>
    <button type="button" style="position:absolute;left:0;top:0">Panned away</button>
  `);
  await page.evaluate(() => {
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: { width: 640, height: 360, offsetLeft: 120, offsetTop: 80, scale: 2 },
    });
  });
  await attach(page);

  const zoomed = page.getByRole('button', { name: 'Zoomed action' });
  const box = (await zoomed.boundingBox())!;
  await zoomed.click();
  // Outside the visible viewport there is no honest point, but the click stays.
  await page.getByRole('button', { name: 'Panned away' }).click({ position: { x: 2, y: 2 } });
  const recorded = await batches(page);
  expect(recorded).toHaveLength(2);
  expect(recorded[0].events[0].target.viewport).toEqual({ width: 640, height: 360 });
  expect(recorded[0].events[0].target.scroll).toEqual({ x: 120, y: 80 });
  const { point } = recorded[0].events[0].target;
  expect(Math.abs(point.x - (box.x + box.width / 2 - 120))).toBeLessThanOrEqual(1);
  expect(Math.abs(point.y - (box.y + box.height / 2 - 80))).toBeLessThanOrEqual(1);
  expect(recorded[1].events[0].target.label).toBe('Panned away');
  expect(recorded[1].events[0].target.point).toBeUndefined();
  expect(recorded.every(batch => validateJourneyEventBatch(batch).ok)).toBe(true);
});

test('drained field commits merge ahead of the click, and commits from an earlier route travel first on their own', async ({ page }) => {
  await page.setContent('<button type="button">Buy now</button>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const state = globalThis as RecorderWindow;
    state.journeyBatches = [];
    const fieldCommit = (id: number, sourceUrl: string, value: string) => ({
      kind: 'field-change', id: `00000000-0000-4000-8000-00000000000${id}`,
      observedAt: new Date(Date.now() - 50).toISOString(), elapsedMs: 50,
      sourceUrl,
      target: {
        tag: 'input', selectorPath: ['input'], label: 'text field', editable: true,
        viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 },
      },
      enteredValue: { kind: 'text', value, truncated: false },
      image: { status: 'pending', captureId: `10000000-0000-4000-8000-00000000000${id}` },
    });
    // A search form submitted with Enter pushed a new route before the click.
    const route = new URL(location.href);
    const earlierUrl = `${route.origin}/search-form`;
    let drained = false;
    state.disposeJourneyRecorder = state.anmerkoJourneyRecorder.attachJourneyRecorder({
      sessionId: 'session-1', epoch: 3, documentToken: 'document-1',
      startedAt: new Date(Date.now() - 100).toISOString(),
      onBatch: batch => { state.journeyBatches.push(batch); },
      drainFieldCommits: () => {
        if (drained) return [];
        drained = true;
        return [
          fieldCommit(1, earlierUrl, 'shoes'),
          fieldCommit(3, 'about:blank', 'unusable'),
          fieldCommit(5, location.href, 'green'),
        ];
      },
    });
  });

  await page.getByRole('button', { name: 'Buy now' }).click();
  const recorded = await batches(page);
  expect(recorded.map(batch => batch.localCounter)).toEqual([1, 2]);
  expect(recorded.map(batch => batch.events.map((event: any) => [event.kind, event.enteredValue?.value ?? event.target.label])))
    .toEqual([[['field-change', 'shoes']], [['field-change', 'green'], ['click', 'Buy now']]]);
  expect(recorded[0].events[0].sourceUrl).toBe('http://127.0.0.1:4173/search-form');
  expect(recorded[1].events.every((event: any) => event.sourceUrl === 'http://127.0.0.1:4173/recorder?item=green&item=large#start')).toBe(true);
  expect(recorded.every(batch => validateJourneyEventBatch(batch).ok)).toBe(true);
});

test('committed values are sent before a submit handler or a route change moves the page on', async ({ page }) => {
  await page.setContent(`
    <form id="spa"><input id="q" aria-label="Search"></form>
    <button id="route" type="button">Route</button>
    <script>
      document.querySelector('#spa').addEventListener('submit', event => {
        event.preventDefault();
        history.pushState({}, '', '/search?q=' + encodeURIComponent(document.querySelector('#q').value));
      });
    </script>
  `);
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const state = globalThis as RecorderWindow & { queued: unknown[]; commitsSeen: number };
    state.journeyBatches = [];
    state.queued = [];
    const startedMs = Date.now() - 100;
    // Stands in for the field module: each change is committed as the page
    // sees it and queued until the recorder drains it.
    document.addEventListener('change', event => {
      const input = event.target as HTMLInputElement;
      const now = Date.now();
      state.queued.push({
        kind: 'field-change', id: crypto.randomUUID(), observedAt: new Date(now).toISOString(), elapsedMs: now - startedMs,
        sourceUrl: location.href,
        target: { tag: 'input', role: 'textbox', selectorPath: ['input'], label: 'text field', editable: true,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 } },
        enteredValue: { kind: 'text', value: input.value, truncated: false },
        image: { status: 'pending', captureId: crypto.randomUUID() },
      });
    }, true);
    state.disposeJourneyRecorder = state.anmerkoJourneyRecorder.attachJourneyRecorder({
      sessionId: 'session-1', epoch: 3, documentToken: 'document-1',
      startedAt: new Date(startedMs).toISOString(),
      onBatch: batch => { state.journeyBatches.push({ ...(batch as object), postedAt: location.href }); },
      drainFieldCommits: () => state.queued.splice(0),
    });
  });

  await page.locator('#q').fill('shoes');
  await page.locator('#q').press('Enter');
  await expect(page).toHaveURL(/\/search\?q=shoes$/);
  let recorded = await batches(page);
  expect(recorded).toHaveLength(1);
  // Sent while the URL was still the form's, before the route changed.
  expect(recorded[0]).toMatchObject({ localCounter: 1, postedAt: 'http://127.0.0.1:4173/recorder?item=green&item=large#start' });
  expect(recorded[0].events.map((event: any) => [event.kind, event.enteredValue.value, event.sourceUrl]))
    .toEqual([['field-change', 'shoes', 'http://127.0.0.1:4173/recorder?item=green&item=large#start']]);

  // A committed value is also sent before any other change of URL, here a
  // route change a timer makes, not after the next click.
  await page.evaluate(() => {
    const input = document.querySelector('#q') as HTMLInputElement;
    input.value = 'boots';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    history.pushState({}, '', '/elsewhere');
  });
  recorded = await batches(page);
  expect(recorded).toHaveLength(2);
  expect(recorded[1]).toMatchObject({ localCounter: 2, postedAt: 'http://127.0.0.1:4173/search?q=shoes' });
  expect(recorded[1].events.map((event: any) => [event.enteredValue.value, event.sourceUrl]))
    .toEqual([['boots', 'http://127.0.0.1:4173/search?q=shoes']]);
  // A history update that keeps the URL sends nothing early.
  await page.evaluate(() => {
    const input = document.querySelector('#q') as HTMLInputElement;
    input.value = 'sandals';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    history.replaceState({ idx: 0 }, '');
  });
  expect(await batches(page)).toHaveLength(2);
  await page.locator('#route').click();
  recorded = await batches(page);
  expect(recorded).toHaveLength(3);
  expect(recorded[2].events.map((event: any) => event.kind)).toEqual(['field-change', 'click']);
  for (const { postedAt: _postedAt, ...batch } of recorded) expect(validateJourneyEventBatch(batch)).toMatchObject({ ok: true });

  // After dispose nothing more is sent.
  await page.evaluate(() => {
    (globalThis as RecorderWindow).disposeJourneyRecorder.dispose();
    const input = document.querySelector('#q') as HTMLInputElement;
    input.value = 'slippers';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    history.pushState({}, '', '/after');
  });
  expect(await batches(page)).toHaveLength(3);
});

test('a long form travels in batches within the payload and event limits, its click last', async ({ page }) => {
  await page.setContent('<button type="button">Submit</button>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const state = globalThis as RecorderWindow;
    state.journeyBatches = [];
    const commit = (index: number, enteredValue: unknown) => ({
      kind: 'field-change', id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      observedAt: new Date(Date.now() - 50).toISOString(), elapsedMs: 50,
      sourceUrl: location.href,
      target: {
        tag: 'textarea', selectorPath: ['textarea'], label: 'text field', editable: true,
        viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 },
      },
      enteredValue,
      image: { status: 'pending', captureId: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}` },
    });
    // Eleven 2,000-character CJK values are 66 KB on their own; forty
    // checkboxes more make more events than one batch may carry.
    const commits = [
      ...Array.from({ length: 11 }, (_, index) => commit(index + 1, { kind: 'text', value: '漢'.repeat(2_000), truncated: false })),
      ...Array.from({ length: 40 }, (_, index) => commit(index + 20, { kind: 'checked', checked: true })),
      // A selection too large to travel even alone keeps what fits.
      commit(90, { kind: 'selection', values: Array.from({ length: 100 }, () => '選'.repeat(2_000)), multiple: true, truncated: false }),
    ];
    let drained = false;
    state.disposeJourneyRecorder = state.anmerkoJourneyRecorder.attachJourneyRecorder({
      sessionId: 'session-1', epoch: 3, documentToken: 'document-1',
      startedAt: new Date(Date.now() - 100).toISOString(),
      onBatch: batch => { state.journeyBatches.push(batch); },
      drainFieldCommits: () => {
        if (drained) return [];
        drained = true;
        return commits;
      },
    });
  });

  await page.getByRole('button', { name: 'Submit' }).click();
  const recorded = await batches(page);
  expect(recorded.length).toBeGreaterThan(2);
  expect(recorded.map(batch => batch.localCounter)).toEqual(recorded.map((_, index) => index + 1));
  for (const batch of recorded) {
    expect(validateJourneyEventBatch(batch).ok).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThanOrEqual(64 * 1_024);
    expect(batch.events.length).toBeLessThanOrEqual(30);
  }
  const events = recorded.flatMap(batch => batch.events);
  expect(events.map((event: any) => event.kind)).toEqual([...Array(52).fill('field-change'), 'click']);
  expect(recorded.at(-1).events.at(-1).kind).toBe('click');
  // Every value arrives whole, except the selection that could not.
  expect(events.slice(0, 11).every((event: any) => event.enteredValue.value === '漢'.repeat(2_000) && !event.enteredValue.truncated)).toBe(true);
  const selection = events[51].enteredValue;
  expect(selection.truncated).toBe(true);
  expect(selection.values.length).toBeGreaterThan(0);
  expect(selection.values.length).toBeLessThan(100);
  expect(selection.values.every((value: string) => value === '選'.repeat(2_000))).toBe(true);
});

test('dispose flushes orphaned field commits without a click', async ({ page }) => {
  await page.setContent('<button type="button">Later</button>');
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const state = globalThis as RecorderWindow;
    state.journeyBatches = [];
    state.disposeJourneyRecorder = state.anmerkoJourneyRecorder.attachJourneyRecorder({
      sessionId: 'session-1', epoch: 3, documentToken: 'document-1',
      startedAt: new Date(Date.now() - 100).toISOString(),
      onBatch: batch => { state.journeyBatches.push(batch); },
      drainFieldCommits: () => [{
        kind: 'field-change', id: '00000000-0000-4000-8000-000000000004',
        observedAt: new Date().toISOString(), elapsedMs: 90,
        sourceUrl: location.href,
        target: {
          tag: 'input', selectorPath: ['input'], label: 'text field', editable: true,
          viewport: { width: 1280, height: 720 }, scroll: { x: 0, y: 0 },
        },
        enteredValue: { kind: 'checked', checked: true },
        image: { status: 'pending', captureId: '00000000-0000-4000-8000-000000000005' },
      }],
    });
  });

  await page.evaluate(() => (globalThis as RecorderWindow).disposeJourneyRecorder.flushFieldCommits());
  const recorded = await batches(page);
  expect(recorded).toHaveLength(1);
  expect(recorded[0].events).toHaveLength(1);
  expect(recorded[0].events[0].kind).toBe('field-change');
  expect(recorded.every(batch => validateJourneyEventBatch(batch).ok)).toBe(true);
});

test('open shadows expose their target while closed shadows degrade to the host', async ({ page }) => {
  await page.setContent('<main><section></section></main>');
  await page.evaluate(() => {
    const section = document.querySelector('section')!;
    const openHost = document.createElement('journey-open-host');
    const openRoot = openHost.attachShadow({ mode: 'open' });
    const openButton = document.createElement('button');
    openButton.textContent = 'Shadow action';
    openRoot.append(openButton);
    section.append(openHost);

    const closedHost = document.createElement('journey-closed-host');
    closedHost.style.cssText = 'display:block;width:180px;height:60px';
    const closedRoot = closedHost.attachShadow({ mode: 'closed' });
    const closedButton = document.createElement('button');
    closedButton.textContent = 'Private shadow label';
    closedButton.style.cssText = 'width:100%;height:100%';
    closedButton.addEventListener('click', () => { (globalThis as RecorderWindow).normalActions++; });
    closedRoot.append(closedButton);
    section.append(closedHost);
    (globalThis as RecorderWindow).normalActions = 0;
  });
  await attach(page);

  await page.locator('journey-open-host').getByRole('button', { name: 'Shadow action' }).click();
  await page.locator('journey-closed-host').click();

  const recorded = await batches(page);
  expect(recorded).toHaveLength(2);
  expect(recorded[0].events[0].target).toMatchObject({ tag: 'button', role: 'button', label: 'Shadow action' });
  expect(recorded[0].events[0].target.editable).toBe(false);
  expect(recorded[0].events[0].target.selectorPath.at(-1)).toBe('button');
  expect(recorded[0].events[0].target.selectorPath).toContain('journey-open-host');
  expect(recorded[1].events[0].target).toMatchObject({ tag: 'journey-closed-host', label: 'journey closed host' });
  expect(recorded[1].events[0].target.selectorPath.at(-1)).toBe('journey-closed-host');
  expect(recorded[1].events[0].target.label).not.toContain('Private shadow label');
  expect(await page.evaluate(() => (globalThis as RecorderWindow).normalActions)).toBe(1);
});

test('ignores extension UI, caller exclusions, untrusted clicks, and recorder attachment in child frames', async ({ page }) => {
  await page.setContent(`
    <button class="record">Record me</button>
    <button class="caller-ignore">Caller ignored</button>
    <anmerko-overlay></anmerko-overlay>
    <anmerko-journey-strip></anmerko-journey-strip>
    <iframe></iframe>
  `);
  await page.evaluate(() => {
    for (const selector of ['anmerko-overlay', 'anmerko-journey-strip']) {
      const root = document.querySelector(selector)!.attachShadow({ mode: 'open' });
      const button = document.createElement('button');
      button.textContent = 'Extension control';
      root.append(button);
    }
  });
  await attach(page, 'caller-ignore');

  await page.locator('.record').evaluate((button: HTMLButtonElement) => button.click());
  await page.locator('.caller-ignore').click();
  await page.locator('anmerko-overlay').getByRole('button').click();
  await page.locator('anmerko-journey-strip').getByRole('button').click();
  expect(await batches(page)).toEqual([]);
  await page.locator('.record').click();
  expect(await batches(page)).toHaveLength(1);

  const frame = page.frames()[1];
  await frame.setContent('<button>Child frame action</button>');
  await frame.addScriptTag({ content: bundle });
  await frame.evaluate(() => {
    const state = globalThis as RecorderWindow;
    state.journeyBatches = [];
    state.disposeJourneyRecorder = state.anmerkoJourneyRecorder.attachJourneyRecorder({
      sessionId: 'child-session', epoch: 1, documentToken: 'child-document',
      startedAt: new Date().toISOString(), onBatch: batch => { state.journeyBatches.push(batch); },
    });
  });
  await frame.getByRole('button').click();
  expect(await frame.evaluate(() => (globalThis as RecorderWindow).journeyBatches)).toEqual([]);
});

test('uses bounded visible text and structural selectors without reading editable values or private attributes', async ({ page }) => {
  await page.setContent(`
    <main>
      <div><div><div><div><div><div><div><div><div><div><div><div><div><div>
        <button id="secret-id" name="secret-name" data-secret="attribute-secret" aria-label="aria-secret">${'Visible label '.repeat(20)}</button>
      </div></div></div></div></div></div></div></div></div></div></div></div></div></div>
      <input type="text" value="value-secret" placeholder="placeholder-secret" aria-label="aria-input-secret">
      <div class="aggregate" role="private-account-token">Safe container text<textarea>editable-descendant-secret</textarea></div>
      <div class="known-role" role="status">Ready</div>
      <div class="large-tree" role="button" style="display:block;padding-top:40px"></div>
    </main>
  `);
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
    (globalThis as RecorderWindow).valueReads = 0;
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
      configurable: true,
      get() { (globalThis as RecorderWindow).valueReads++; return descriptor.get!.call(this); },
      set(value) { descriptor.set!.call(this, value); },
    });
    const large = document.querySelector('.large-tree')!;
    for (let index = 0; index < 2_000; index++) {
      const span = document.createElement('span');
      span.textContent = `visible-${index} `;
      large.append(span);
    }
  });
  await attach(page);

  await page.locator('#secret-id').click();
  await page.locator('input').click();
  await page.locator('.aggregate').click({ position: { x: 5, y: 5 } });
  await page.locator('.known-role').click();
  await page.locator('.large-tree').click({ position: { x: 5, y: 5 } });

  const recorded = await batches(page);
  const button = recorded[0].events[0].target;
  expect(button.label).toHaveLength(120);
  expect(button.label.startsWith('Visible label')).toBe(true);
  expect(button.selectorPath).toHaveLength(12);
  expect(button.selectorPath[0]).toBe('…');
  expect(button.selectorPath.at(-1)).toBe('button');
  expect(button.selectorPath.slice(1).every((segment: string) => /^[a-z][a-z0-9-]*(?::nth-of-type\([1-9][0-9]*\))?$/.test(segment))).toBe(true);
  expect(JSON.stringify(button)).not.toMatch(/secret-id|secret-name|attribute-secret|aria-secret/);
  expect(recorded[1].events[0].target).toMatchObject({ tag: 'input', role: 'textbox', label: 'text field' });
  expect(recorded[1].events[0].target.editable).toBe(true);
  expect(JSON.stringify(recorded[1])).not.toMatch(/value-secret|placeholder-secret|aria-input-secret/);
  expect(recorded[2].events[0].target).toMatchObject({ label: 'div', editable: false });
  expect(recorded[2].events[0].target.role).toBeUndefined();
  expect(JSON.stringify(recorded[2])).not.toMatch(/private-account-token|Safe container text|editable-descendant-secret/);
  expect(recorded[3].events[0].target).toMatchObject({ role: 'status', label: 'Ready' });
  expect(Array.from(recorded[4].events[0].target.label)).toHaveLength(120);
  expect(recorded[4].events[0].target.label).toMatch(/^visible-0 visible-1/);
  expect(await page.evaluate(() => (globalThis as RecorderWindow).valueReads)).toBe(0);
});

test('labels never echo text typed into design-mode documents or ARIA text boxes', async ({ page }) => {
  await page.setContent(`
    <main>
      <p id="designed">Draft:</p>
      <div role="textbox" id="aria-box" tabindex="0" style="min-height:24px"></div>
      <div id="wrapper" style="padding:20px"><span>Wrapper</span><div role="searchbox" id="aria-search"></div></div>
    </main>
  `);
  await attach(page);

  // A custom text box renders what the user typed without contenteditable.
  await page.locator('#aria-box').click();
  await page.evaluate(() => {
    document.querySelector('#aria-box')!.textContent = 'typed-aria-secret';
    document.querySelector('#aria-search')!.textContent = 'typed-search-secret';
  });
  await page.locator('#aria-box').click();
  await page.locator('#wrapper').click({ position: { x: 4, y: 4 } });

  // Design mode makes the whole document editable.
  await page.evaluate(() => { document.designMode = 'on'; });
  await page.locator('#designed').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' typed-design-secret');
  await page.locator('#designed').click();

  const recorded = await batches(page);
  expect(recorded).toHaveLength(5);
  const targets = recorded.map(batch => batch.events[0].target);
  expect(targets[1]).toMatchObject({ tag: 'div', role: 'textbox', label: 'text field', editable: true });
  expect(targets[2]).toMatchObject({ tag: 'div', label: 'div', editable: false });
  expect(targets[4]).toMatchObject({ tag: 'p', label: 'text field', editable: true });
  expect(JSON.stringify(recorded)).not.toMatch(/typed-(aria|search|design)-secret/);
  expect(recorded.every(batch => validateJourneyEventBatch(batch).ok)).toBe(true);
});

test('buttons of every kind record as buttons, and text entry as text fields', async ({ page }) => {
  await page.setContent(`<form onsubmit="return false">
    <input type="image" alt="Go" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="20">
    <input type="submit" value="Send">
    <input type="reset" value="Clear">
    <input type="text" aria-label="Query">
    <textarea aria-label="Notes"></textarea>
    <div contenteditable="true"><p>Draft</p></div>
  </form>`);
  await attach(page);
  for (const selector of ['input[type=image]', 'input[type=submit]', 'input[type=reset]', 'input[type=text]', 'textarea', '[contenteditable] p']) {
    await page.locator(selector).click();
  }
  const recorded = await batches(page);
  const targets = recorded.map(batch => batch.events[0].target);
  expect(targets.map(target => [target.tag, target.role, target.label, journeyTextEntryTarget(target)])).toEqual([
    ['input', 'button', 'button', false],
    ['input', 'button', 'button', false],
    ['input', 'button', 'button', false],
    ['input', 'textbox', 'text field', true],
    ['textarea', 'textbox', 'text field', true],
    ['p', undefined, 'text field', true],
  ]);
  expect(recorded.every(batch => validateJourneyEventBatch(batch).ok)).toBe(true);
});
