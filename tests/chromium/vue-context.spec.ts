import { expect, test, type Page } from '@playwright/test';
import { vueComponentContextProbe } from '../../src/vue-context-probe';

const MARKER = 'data-anmerko-context-0123456789abcdef0123456789abcdef';
const FAILURE_TOKEN = 'ANMERKO_COMPONENT_CONTEXT_PROBE_FAILED';
interface FixtureServer { origin: string; close(): Promise<void> }
interface FixtureTarget { id: string; expectedPath: string[] }
interface ProbeTarget { selectorPath: string[]; expectedTag: string; markerName: string }
let fixtureServer: FixtureServer;

test.beforeAll(async () => {
  // @ts-expect-error the isolated ESM fixture package intentionally has no root declaration file
  const { startFixtureServer } = await import('../fixtures/component-context/server.mjs');
  fixtureServer = await startFixtureServer();
});
test.afterAll(async () => fixtureServer.close());

async function ready(page: Page, path: string): Promise<void> {
  await page.goto(`${fixtureServer.origin}${path}`);
  await page.waitForFunction(() => (globalThis as any).__ANMERKO_FIXTURE__?.ready === true);
}
async function mark(id: string, page: Page): Promise<ProbeTarget> {
  const expectedTag = await page.locator(`#${id}`).evaluate(element => element.localName);
  const probeTarget = { selectorPath: [`#${id}`], expectedTag, markerName: MARKER };
  await page.locator(`#${id}`).evaluate((element, marker) => element.setAttribute(marker, ''), MARKER);
  return probeTarget;
}

for (const mode of ['development', 'production-devtools']) {
  test(`extracts exact Vue ${mode} logical ancestry and avoids private fields`, async ({ page }) => {
    await ready(page, `/vue/3.5.43/${mode}`);
    const fixture = await page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__);
    for (const fixtureTarget of Object.values(fixture.targets) as FixtureTarget[]) {
      const probeTarget = await mark(fixtureTarget.id, page);
      const raw = await page.evaluate(vueComponentContextProbe, probeTarget);
      if (fixtureTarget.expectedPath.length === 0) expect(raw).toBeNull();
      else expect(JSON.parse(raw!)).toEqual({
        version: 1, framework: 'vue', provenance: 'vue3-instance-debug',
        path: fixtureTarget.expectedPath, truncated: false,
      });
    }
    expect(await page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__.privacyReads)).toEqual({
      props: 0, state: 0, source: 0, file: 0,
    });
  });
}

test('omits ordinary production and does not borrow a nearby Vue marker', async ({ page }) => {
  await ready(page, '/vue/3.5.43/production');
  const options = await page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__.targets.options);
  expect(await page.evaluate(vueComponentContextProbe, await mark(options.id, page))).toBeNull();
  expect(await page.evaluate(vueComponentContextProbe, await mark('vue-manual-button', page))).toBeNull();
});

test('rejects marker, instance and ancestry accessors without invoking them', async ({ page }) => {
  await ready(page, '/vue/3.5.43/development');
  const probeTarget = await mark('vue-options-button', page);
  await page.locator('#vue-options-button').evaluate(element => {
    const instance = (element as any).__vueParentComponent;
    Object.defineProperty(instance, 'parent', { configurable: true, get() { throw new Error('parent secret'); } });
  });
  await expect(page.evaluate(vueComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
  await expect(page.evaluate(vueComponentContextProbe, probeTarget)).rejects.not.toThrow('parent secret');
});

test('treats optional name accessors as unreadable without invoking them', async ({ page }) => {
  await ready(page, '/vue/3.5.43/development');
  const probeTarget = await mark('vue-options-button', page);
  await page.locator('#vue-options-button').evaluate(element => {
    const type = (element as any).__vueParentComponent.type;
    (window as any).__vueNameReads = 0;
    Object.defineProperty(type, 'name', { configurable: true, get() {
      (window as any).__vueNameReads += 1; throw new Error('name secret');
    } });
  });
  expect(await page.evaluate(vueComponentContextProbe, probeTarget)).toBeNull();
  expect(await page.evaluate(() => (window as any).__vueNameReads)).toBe(0);
});

test('fails closed for a cycle, unmounted instance, and unusable direct name', async ({ page }) => {
  await ready(page, '/vue/3.5.43/development');
  const probeTarget = await mark('vue-options-button', page);
  await page.locator('#vue-options-button').evaluate(element => {
    Object.defineProperty((element as any).__vueParentComponent, 'isUnmounted', { configurable: true, value: 'false' });
  });
  await expect(page.evaluate(vueComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
  await page.locator('#vue-options-button').evaluate(element => {
    Object.defineProperty((element as any).__vueParentComponent, 'isUnmounted', { configurable: true, value: true });
  });
  expect(await page.evaluate(vueComponentContextProbe, probeTarget)).toBeNull();
  await page.locator('#vue-options-button').evaluate(element => {
    const instance = (element as any).__vueParentComponent;
    Object.defineProperty(instance, 'isUnmounted', { configurable: true, value: false });
    Object.defineProperty(instance, 'parent', { configurable: true, value: instance });
  });
  await expect(page.evaluate(vueComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
});

test('accepts the canonical tag-name grammar', async ({ page }) => {
  await page.setContent('');
  const probeTarget = {
    selectorPath: ['#selected'], expectedTag: 'x_widget.part:leaf', markerName: MARKER,
  };
  await page.evaluate(({ markerName }) => {
    const selected = document.createElement('x_widget.part:leaf') as any;
    selected.id = 'selected';
    selected.setAttribute(markerName, '');
    document.body.append(selected);
    Object.defineProperty(selected, '__vueParentComponent', { value: {
      type: { name: 'Component' }, parent: null, isUnmounted: false,
    } });
  }, probeTarget);
  expect(JSON.parse((await page.evaluate(vueComponentContextProbe, probeTarget))!).path).toEqual(['Component']);
});

test('enforces the clock during final serialization', async ({ page }) => {
  await page.setContent('<button id="selected">Selected</button>');
  const probeTarget = await mark('selected', page);
  await page.evaluate(() => {
    const selected = document.querySelector('#selected')! as any;
    Object.defineProperty(selected, '__vueParentComponent', { value: {
      type: { name: 'Component' }, parent: null, isUnmounted: false,
    } });
  });
  await page.evaluate(() => {
    let now = 0;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
    const stringify = JSON.stringify;
    Object.defineProperty(JSON, 'stringify', { configurable: true, value(...args: Parameters<typeof JSON.stringify>) {
      const serialized = Reflect.apply(stringify, JSON, args) as string | undefined;
      now = 11;
      return serialized;
    } });
  });
  await expect(page.evaluate(vueComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
});

test('bounds raw names, ancestry, and final UTF-8 serialization', async ({ page }) => {
  await page.setContent('<button id="selected">Selected</button>');
  const probeTarget = await mark('selected', page);
  await page.evaluate(() => {
    const selected = document.querySelector('#selected')! as any;
    let parent: any = null;
    for (let index = 0; index < 6; index += 1) {
      parent = { type: { name: '\ud800'.repeat(64) }, parent, isUnmounted: false };
    }
    Object.defineProperty(selected, '__vueParentComponent', { configurable: true, value: parent });
  });
  const raw = (await page.evaluate(vueComponentContextProbe, probeTarget))!;
  expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(2_048);
  expect(JSON.parse(raw)).toMatchObject({ framework: 'vue', truncated: true });

  await page.evaluate(() => {
    const selected = document.querySelector('#selected')! as any;
    selected.__vueParentComponent.type.name = 'x'.repeat(129);
  });
  expect(await page.evaluate(vueComponentContextProbe, probeTarget)).toBeNull();
});

test('keeps the nearest eight names and rejects more than 64 instance links', async ({ page }) => {
  await page.setContent('<button id="selected">Selected</button>');
  const probeTarget = await mark('selected', page);
  await page.evaluate(() => {
    const makeChain = (count: number) => {
      let parent: any = null;
      for (let index = 0; index < count; index += 1) {
        parent = { type: { name: `Component${index}` }, parent, isUnmounted: false };
      }
      return parent;
    };
    const selected = document.querySelector('#selected')! as any;
    Object.defineProperty(selected, '__vueParentComponent', { configurable: true, value: makeChain(10) });
    (window as any).__makeVueChain = makeChain;
  });
  expect(JSON.parse((await page.evaluate(vueComponentContextProbe, probeTarget))!).path).toEqual(
    Array.from({ length: 8 }, (_, index) => `Component${index + 2}`),
  );
  await page.evaluate(() => {
    const selected = document.querySelector('#selected')! as any;
    Object.defineProperty(selected, '__vueParentComponent', {
      configurable: true, value: (window as any).__makeVueChain(65),
    });
  });
  await expect(page.evaluate(vueComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
});
