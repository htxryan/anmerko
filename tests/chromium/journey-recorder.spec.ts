import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { validateJourneyEventBatch } from '../../src/journey-events';

type RecorderWindow = typeof globalThis & {
  anmerkoJourneyRecorder: {
    attachJourneyRecorder(options: {
      sessionId: string;
      epoch: number;
      documentToken: string;
      startedAt: string;
      onBatch(batch: unknown): void;
      ignore?: (target: Element) => boolean;
    }): () => void;
  };
  journeyBatches: any[];
  disposeJourneyRecorder: () => void;
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

  await page.evaluate(() => (globalThis as RecorderWindow).disposeJourneyRecorder());
  await page.getByRole('button', { name: 'Normal button' }).click();
  expect(await batches(page)).toHaveLength(3);
  expect(await page.evaluate(() => (globalThis as RecorderWindow).normalActions)).toBe(3);
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
      <div class="aggregate">Safe container text<textarea>editable-descendant-secret</textarea></div>
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
  });
  await attach(page);

  await page.locator('#secret-id').click();
  await page.locator('input').click();
  await page.locator('.aggregate').click({ position: { x: 5, y: 5 } });

  const recorded = await batches(page);
  const button = recorded[0].events[0].target;
  expect(button.label).toHaveLength(120);
  expect(button.label.startsWith('Visible label')).toBe(true);
  expect(button.selectorPath).toHaveLength(12);
  expect(button.selectorPath.at(-1)).toBe('button');
  expect(button.selectorPath.every((segment: string) => /^[a-z][a-z0-9-]*(?::nth-of-type\([1-9][0-9]*\))?$/.test(segment))).toBe(true);
  expect(JSON.stringify(button)).not.toMatch(/secret-id|secret-name|attribute-secret|aria-secret/);
  expect(recorded[1].events[0].target).toMatchObject({ tag: 'input', role: 'textbox', label: 'text field' });
  expect(recorded[1].events[0].target.editable).toBe(true);
  expect(JSON.stringify(recorded[1])).not.toMatch(/value-secret|placeholder-secret|aria-input-secret/);
  expect(recorded[2].events[0].target.label).toContain('Safe container text');
  expect(recorded[2].events[0].target.label).not.toContain('editable-descendant-secret');
  expect(await page.evaluate(() => (globalThis as RecorderWindow).valueReads)).toBe(0);
});
