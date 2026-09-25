import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';

type ReviewResult =
  | { kind: 'applied'; image: { dataUrl: string; width: number; height: number; byteLength: number } }
  | { kind: 'removed' }
  | { kind: 'cancelled' };

type ImageReviewWindow = typeof globalThis & {
  imageReviewHarness: {
    begin(width?: number, height?: number, dataUrl?: string): void;
    beginInShadow(): void;
    promise: Promise<ReviewResult>;
    result: ReviewResult | null;
    abort: AbortController;
    root: HTMLElement;
    shadowHost?: HTMLElement;
    holdDecode(): void;
    releaseDecode?: () => Promise<void>;
  };
};

const bundle = () => buildSync({
  stdin: {
    contents: `
      import { reviewJourneyImage } from './src/journey-image-review';
      import styles from './src/journey-image-review.css';
      const style = document.createElement('style');
      style.textContent = styles;
      document.head.append(style);
      const harness = {
        promise: Promise.resolve({ kind: 'cancelled' }),
        result: null,
        abort: new AbortController(),
        root: document.createElement('div'),
        begin(width = 100, height = 50, supplied) {
          this.root.remove();
          this.shadowHost?.remove();
          this.root = document.createElement('div');
          this.root.id = 'review-root';
          this.root.style.width = '260px';
          document.body.append(this.root);
          let dataUrl = supplied;
          if (!dataUrl) {
            const canvas = document.createElement('canvas');
            canvas.width = width; canvas.height = height;
            const context = canvas.getContext('2d');
            context.fillStyle = 'rgb(200, 100, 50)';
            context.fillRect(0, 0, width, height);
            dataUrl = canvas.toDataURL('image/png');
          }
          this.abort = new AbortController();
          this.result = null;
          this.promise = reviewJourneyImage(this.root, { dataUrl, width, height }, this.abort.signal);
          this.promise.then(result => { this.result = result; });
        },
        beginInShadow() {
          this.root.remove();
          this.shadowHost?.remove();
          this.shadowHost = document.createElement('div');
          const shadow = this.shadowHost.attachShadow({ mode: 'open' });
          const trigger = document.createElement('button');
          trigger.id = 'shadow-launch-mask';
          trigger.textContent = 'Open shadow mask editor';
          this.root = document.createElement('div');
          const after = document.createElement('button');
          after.textContent = 'Shadow outside control';
          shadow.append(trigger, this.root, after);
          document.body.append(this.shadowHost);
          const canvas = document.createElement('canvas');
          canvas.width = 100; canvas.height = 50;
          const context = canvas.getContext('2d');
          context.fillStyle = 'rgb(200, 100, 50)';
          context.fillRect(0, 0, 100, 50);
          trigger.focus();
          this.abort = new AbortController();
          this.result = null;
          this.promise = reviewJourneyImage(this.root, { dataUrl: canvas.toDataURL('image/png'), width: 100, height: 50 }, this.abort.signal);
          this.promise.then(result => { this.result = result; });
        },
        holdDecode() {
          const original = globalThis.createImageBitmap;
          globalThis.createImageBitmap = (...arguments_) => new Promise((resolve, reject) => {
            this.releaseDecode = async () => {
              globalThis.createImageBitmap = original;
              try { resolve(await original(...arguments_)); } catch (error) { reject(error); }
            };
          });
        },
      };
      window.imageReviewHarness = harness;
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'iife',
  loader: { '.css': 'text' },
}).outputFiles[0].text;

async function loadEditor(page: Page, viewport = { width: 600, height: 700 }) {
  await page.setViewportSize(viewport);
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: bundle() });
}

async function begin(page: Page, width = 100, height = 50, dataUrl?: string) {
  await page.evaluate(({ width, height, dataUrl }) => {
    (globalThis as ImageReviewWindow).imageReviewHarness.begin(width, height, dataUrl);
  }, { width, height, dataUrl });
  await expect(page.getByRole('dialog', { name: 'Mask screenshot' })).toBeVisible();
}

async function setGeometry(page: Page, values: { x: number; y: number; width: number; height: number }) {
  await page.getByRole('spinbutton', { name: 'X', exact: true }).fill(String(values.x));
  await page.getByRole('spinbutton', { name: 'Y', exact: true }).fill(String(values.y));
  await page.getByRole('spinbutton', { name: 'Width', exact: true }).fill(String(values.width));
  await page.getByRole('spinbutton', { name: 'Height', exact: true }).fill(String(values.height));
}

test('maps a pointer drag into image coordinates and applies opaque black pixels', async ({ page }) => {
  await loadEditor(page);
  await begin(page);

  const drawing = page.getByLabel('Draw mask region');
  const bounds = await drawing.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width * .25, bounds!.y + bounds!.height * .2);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * .75, bounds!.y + bounds!.height * .8);
  await page.mouse.up();

  const geometry = await page.getByRole('dialog', { name: 'Mask screenshot' }).evaluate(element => {
    const value = (name: string) => Number(element.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)!.value);
    return { x: value('X'), y: value('Y'), width: value('Width'), height: value('Height') };
  });
  expect(geometry.x).toBeGreaterThanOrEqual(24);
  expect(geometry.x).toBeLessThanOrEqual(25);
  expect(geometry.y).toBeGreaterThanOrEqual(9);
  expect(geometry.y).toBeLessThanOrEqual(10);
  expect(geometry.x + geometry.width).toBeGreaterThanOrEqual(75);
  expect(geometry.x + geometry.width).toBeLessThanOrEqual(76);
  expect(geometry.y + geometry.height).toBeGreaterThanOrEqual(40);
  expect(geometry.y + geometry.height).toBeLessThanOrEqual(41);
  await expect(page.getByRole('button', { name: 'Apply mask' })).toBeEnabled();
  expect(await page.locator('#review-root').innerHTML()).not.toContain('data:image');
  expect(await page.locator('#review-root').innerHTML()).not.toContain('blob:');

  await page.getByRole('button', { name: 'Apply mask' }).click();
  const inspected = await page.evaluate(async () => {
    const result = await (globalThis as ImageReviewWindow).imageReviewHarness.promise;
    if (result.kind !== 'applied') return result;
    const image = new Image(); image.src = result.image.dataUrl; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    return {
      kind: result.kind,
      width: result.image.width,
      height: result.image.height,
      inside: [...context.getImageData(50, 25, 1, 1).data],
      outside: [...context.getImageData(5, 5, 1, 1).data],
      mountedChildren: (globalThis as ImageReviewWindow).imageReviewHarness.root.childElementCount,
    };
  });
  expect(inspected).toEqual({
    kind: 'applied', width: 100, height: 50,
    inside: [0, 0, 0, 255], outside: [200, 100, 50, 255], mountedChildren: 0,
  });
});

test('keeps a tall preview at the image aspect ratio and rounds dragged edges outward', async ({ page }) => {
  await loadEditor(page, { width: 500, height: 360 });
  await begin(page, 40, 100);

  const drawing = page.getByLabel('Draw mask region');
  const bounds = await drawing.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width / bounds!.height).toBeCloseTo(.4, 2);
  await page.mouse.move(bounds!.x + bounds!.width * .251, bounds!.y + bounds!.height * .201);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * .749, bounds!.y + bounds!.height * .799);
  await page.mouse.up();

  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('10');
  await expect(page.getByRole('spinbutton', { name: 'Y', exact: true })).toHaveValue('20');
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('20');
  await expect(page.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('60');
});

test('number inputs expose invalid geometry and preserve a valid image-space rectangle on resize', async ({ page }) => {
  await loadEditor(page);
  await begin(page);
  await expect(page.getByRole('heading', { name: 'Mask sensitive details' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toBeFocused();
  await setGeometry(page, { x: 80, y: 5, width: 30, height: 10 });
  await expect(page.getByRole('button', { name: 'Apply mask' })).toBeDisabled();
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveAttribute('aria-invalid', 'true');

  await setGeometry(page, { x: 20, y: 5, width: 30, height: 10 });
  await expect(page.getByRole('button', { name: 'Apply mask' })).toBeEnabled();
  await page.getByRole('dialog', { name: 'Mask screenshot' }).evaluate(element => { element.style.width = '180px'; });
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('20');
  await expect(page.getByRole('spinbutton', { name: 'Y', exact: true })).toHaveValue('5');
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('30');
  await expect(page.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('10');

  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.promise)).toEqual({ kind: 'cancelled' });
  await expect(page.locator('#review-root')).toBeEmpty();
});

test('pointer cancellation and a second touch leave the completed rectangle unchanged', async ({ page }) => {
  await loadEditor(page);
  await begin(page);
  await setGeometry(page, { x: 10, y: 5, width: 20, height: 10 });
  const drawing = page.getByLabel('Draw mask region');
  await drawing.dispatchEvent('pointerdown', { pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: 20, clientY: 20 });
  await drawing.dispatchEvent('pointermove', { pointerId: 11, pointerType: 'touch', isPrimary: true, clientX: 120, clientY: 80 });
  await drawing.dispatchEvent('pointercancel', { pointerId: 11, pointerType: 'touch', isPrimary: true });
  await drawing.dispatchEvent('pointerdown', { pointerId: 21, pointerType: 'touch', isPrimary: true, clientX: 20, clientY: 20 });
  await drawing.dispatchEvent('pointerdown', { pointerId: 22, pointerType: 'touch', isPrimary: false, clientX: 30, clientY: 30 });
  await drawing.dispatchEvent('pointermove', { pointerId: 21, pointerType: 'touch', isPrimary: true, clientX: 150, clientY: 90 });
  await page.locator('body').dispatchEvent('pointerup', { pointerId: 21, pointerType: 'touch', isPrimary: true });
  await page.locator('body').dispatchEvent('pointerup', { pointerId: 22, pointerType: 'touch', isPrimary: false });
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('10');
  await expect(page.getByRole('spinbutton', { name: 'Y', exact: true })).toHaveValue('5');
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('20');
  await expect(page.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('10');

  await drawing.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const init = { pointerId: 31, pointerType: 'touch', isPrimary: true, bubbles: true };
    element.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: bounds.left + bounds.width * .201, clientY: bounds.top + bounds.height * .201 }));
    element.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: bounds.left + bounds.width * .599, clientY: bounds.top + bounds.height * .599 }));
    element.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: bounds.left + bounds.width * .599, clientY: bounds.top + bounds.height * .599 }));
  });
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('20');
  await expect(page.getByRole('spinbutton', { name: 'Y', exact: true })).toHaveValue('10');
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('40');
  await expect(page.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('20');
});

test('resize during an active gesture preserves the completed rectangle and permits a fresh drag', async ({ page }) => {
  await loadEditor(page);
  await begin(page);
  await setGeometry(page, { x: 10, y: 5, width: 20, height: 10 });
  const drawing = page.getByLabel('Draw mask region');
  const originalWidth = (await drawing.boundingBox())!.width;
  await drawing.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const init = { pointerId: 41, pointerType: 'touch', isPrimary: true, bubbles: true };
    element.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: bounds.left + 10, clientY: bounds.top + 10 }));
    element.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: bounds.right - 10, clientY: bounds.bottom - 10 }));
  });
  await page.getByRole('dialog', { name: 'Mask screenshot' }).evaluate(element => { element.style.width = '180px'; });
  await expect.poll(async () => (await drawing.boundingBox())!.width).toBeLessThan(originalWidth);
  await page.locator('body').dispatchEvent('pointerup', { pointerId: 41, pointerType: 'touch', isPrimary: true });
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('10');
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('20');

  await drawing.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const init = { pointerId: 42, pointerType: 'touch', isPrimary: true, bubbles: true };
    element.dispatchEvent(new PointerEvent('pointerdown', { ...init, clientX: bounds.left + bounds.width * .201, clientY: bounds.top + bounds.height * .201 }));
    element.dispatchEvent(new PointerEvent('pointermove', { ...init, clientX: bounds.left + bounds.width * .599, clientY: bounds.top + bounds.height * .599 }));
    element.dispatchEvent(new PointerEvent('pointerup', { ...init, clientX: bounds.left + bounds.width * .599, clientY: bounds.top + bounds.height * .599 }));
  });
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toHaveValue('20');
  await expect(page.getByRole('spinbutton', { name: 'Y', exact: true })).toHaveValue('10');
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toHaveValue('40');
  await expect(page.getByRole('spinbutton', { name: 'Height', exact: true })).toHaveValue('20');
});

test('Remove returns removed without exposing the source and abort resolves cancelled', async ({ page }) => {
  await loadEditor(page);
  await begin(page);
  expect(await page.locator('#review-root').innerHTML()).not.toContain('data:image');
  await page.getByRole('button', { name: 'Remove screenshot' }).click();
  expect(await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.promise)).toEqual({ kind: 'removed' });
  await expect(page.locator('#review-root')).toBeEmpty();

  await begin(page);
  await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.abort.abort());
  expect(await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.promise)).toEqual({ kind: 'cancelled' });
  await expect(page.locator('#review-root')).toBeEmpty();
});

test('contains modal keyboard focus and restores the launching control on every completion path', async ({ page }) => {
  await loadEditor(page);
  await page.evaluate(() => {
    const trigger = document.createElement('button');
    trigger.id = 'launch-mask';
    trigger.textContent = 'Open mask editor';
    const after = document.createElement('button');
    after.id = 'outside-control';
    after.textContent = 'Outside control';
    document.body.append(trigger, after);
  });

  for (const completion of ['escape', 'cancel', 'remove', 'apply'] as const) {
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('#launch-mask')!.focus();
      (globalThis as ImageReviewWindow).imageReviewHarness.begin();
    });
    await expect(page.getByRole('dialog', { name: 'Mask screenshot' })).toHaveAttribute('aria-modal', 'true');
    expect(await page.getByRole('dialog', { name: 'Mask screenshot' }).evaluate(element => element.matches(':modal'))).toBe(true);
    await expect(page.getByRole('heading', { name: 'Mask sensitive details' })).toBeFocused();
    await page.locator('#outside-control').evaluate(element => element.focus());
    await expect(page.getByRole('heading', { name: 'Mask sensitive details' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toBeFocused();

    if (completion === 'escape') await page.keyboard.press('Escape');
    if (completion === 'cancel') await page.getByRole('button', { name: 'Cancel' }).click();
    if (completion === 'remove') await page.getByRole('button', { name: 'Remove screenshot' }).click();
    if (completion === 'apply') {
      await setGeometry(page, { x: 20, y: 5, width: 30, height: 10 });
      await page.getByRole('button', { name: 'Apply mask' }).click();
    }
    await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.promise);
    await expect(page.locator('#launch-mask')).toBeFocused();
  }
});

test('contains and restores focus when mounted inside a shadow root', async ({ page }) => {
  await loadEditor(page);
  await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.beginInShadow());
  await expect(page.getByRole('heading', { name: 'Mask sensitive details' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('spinbutton', { name: 'Y', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('spinbutton', { name: 'Width', exact: true })).toBeFocused();
  await page.getByRole('spinbutton', { name: 'X', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.promise);
  await expect(page.locator('#shadow-launch-mask')).toBeFocused();
});

test('rejects external preview URLs and mismatched image metadata before mounting', async ({ page }) => {
  await loadEditor(page);
  await page.evaluate(() => {
    (globalThis as ImageReviewWindow).imageReviewHarness.begin(100, 50, 'https://example.com/private.png');
  });
  expect(await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.promise)).toEqual({ kind: 'cancelled' });
  await expect(page.locator('#review-root')).toBeEmpty();

  await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 10; canvas.height = 10;
    (globalThis as ImageReviewWindow).imageReviewHarness.begin(20, 10, canvas.toDataURL('image/png'));
  });
  expect(await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.promise)).toEqual({ kind: 'cancelled' });
  await expect(page.locator('#review-root')).toBeEmpty();
});

test('Cancel and abort suppress late mask results across repeated editor opens', async ({ page }) => {
  await loadEditor(page);

  for (const completion of ['cancel', 'abort'] as const) {
    await begin(page);
    await setGeometry(page, { x: 20, y: 5, width: 30, height: 10 });
    await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.holdDecode());
    await page.getByRole('button', { name: 'Apply mask' }).click();
    await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toBeDisabled();
    await expect.poll(() => page.evaluate(() => typeof (globalThis as ImageReviewWindow).imageReviewHarness.releaseDecode)).toBe('function');
    if (completion === 'cancel') await page.getByRole('button', { name: 'Cancel' }).click();
    else await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.abort.abort());
    expect(await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.promise)).toEqual({ kind: 'cancelled' });
    await expect(page.locator('#review-root')).toBeEmpty();
    await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.releaseDecode?.());
    await page.waitForTimeout(50);
    expect(await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.result)).toEqual({ kind: 'cancelled' });
    await expect(page.locator('#review-root')).toBeEmpty();
  }
});

test('decoder errors stay recoverable and allow removal', async ({ page }) => {
  await loadEditor(page);
  const malformed = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAK';
  await begin(page, 10, 10, malformed);
  await setGeometry(page, { x: 1, y: 1, width: 5, height: 5 });
  await page.getByRole('button', { name: 'Apply mask' }).click();
  await expect(page.getByRole('alert')).toContainText('could not');
  await expect(page.getByRole('spinbutton', { name: 'X', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Apply mask' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Remove screenshot' })).toBeEnabled();
  await page.getByRole('button', { name: 'Remove screenshot' }).click();
  expect(await page.evaluate(() => (globalThis as ImageReviewWindow).imageReviewHarness.promise)).toEqual({ kind: 'removed' });
});

test('narrow layout keeps all controls touch-sized while only the drawing surface suppresses touch gestures', async ({ page }) => {
  await loadEditor(page, { width: 320, height: 700 });
  await begin(page);
  const dialog = page.getByRole('dialog', { name: 'Mask screenshot' });
  const box = await dialog.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(320);
  for (const control of await dialog.locator('button,input').all()) {
    expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  expect(await page.getByLabel('Draw mask region').evaluate(element => getComputedStyle(element).touchAction)).toBe('none');
  expect(await dialog.evaluate(element => getComputedStyle(element).touchAction)).not.toBe('none');
  expect(await page.locator('#review-root').innerHTML()).not.toContain('data:image');
});

// A tall phone capture fills most of the stage height; the region fields must
// still follow it rather than slide under it.
for (const viewport of [{ width: 320, height: 700 }, { width: 360, height: 800 }, { width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`the stage never overlaps the region fields at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await loadEditor(page, viewport);
    await begin(page, 390, 844);
    const dialog = page.getByRole('dialog', { name: 'Mask screenshot' });
    const layout = await dialog.evaluate(element => {
      const box = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
      const stage = box('.journey-image-review__stage');
      const legend = box('.journey-image-review__fields legend');
      const fields = [...element.querySelectorAll('.journey-image-review__field input')].map(input => input.getBoundingClientRect());
      return { stageBottom: stage.bottom, legendTop: legend.top, fieldTops: fields.map(field => field.top), stageRatio: stage.width / stage.height };
    });
    expect(layout.legendTop).toBeGreaterThanOrEqual(layout.stageBottom);
    for (const top of layout.fieldTops) expect(top).toBeGreaterThan(layout.stageBottom);
    expect(Math.abs(layout.stageRatio - 390 / 844)).toBeLessThan(0.01);
    // Every control can be scrolled fully into view inside the dialog.
    for (const control of await dialog.locator('button,input').all()) {
      await control.scrollIntoViewIfNeeded();
      const box = (await control.boundingBox())!;
      // Allow subpixel rounding at the scroll edge.
      expect(box.y).toBeGreaterThanOrEqual(-1);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
    }
  });
}
