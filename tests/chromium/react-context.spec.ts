import { expect, test, type Page } from '@playwright/test';
import { selectComponentContext } from '../../src/component-context-dispatch';
import { reactComponentContextProbe } from '../../src/react-context-probe';
import { vueComponentContextProbe } from '../../src/vue-context-probe';

const MARKER = 'data-anmerko-context-0123456789abcdef0123456789abcdef';
const FAILURE_TOKEN = 'ANMERKO_COMPONENT_CONTEXT_PROBE_FAILED';
interface FixtureServer { origin: string; close(): Promise<void> }
interface FixtureTarget { id: string; expectedPath: string[] }
interface ProbeTarget { selectorPath: string[]; expectedTag: string; markerName: string }
let fixtureServer: FixtureServer;
const safeExpectedPaths: Record<string, string[]> = {
  'react-nested-button': ['App', 'PricingPage', 'PlanCard', 'FeedbackButton'],
  'react-memo-button': ['App', 'PricingPage', 'PlanCard', 'FeedbackButton'],
  'react-class-button': ['App', 'PricingPage', 'ClassPanel', 'FeedbackButton'],
  'react-portal-button': ['App', 'PricingPage', 'PortalPanel', 'FeedbackButton'],
  'react-shadow-button': ['App', 'PricingPage', 'ShadowPanel', 'FeedbackButton'],
};

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
async function targetFor(page: Page, fixtureTarget: FixtureTarget): Promise<ProbeTarget> {
  const shadow = fixtureTarget.id === 'react-shadow-button';
  const probeTarget = {
    selectorPath: shadow ? ['#react-shadow-host', `#${fixtureTarget.id}`] : [`#${fixtureTarget.id}`],
    expectedTag: 'button', markerName: MARKER,
  };
  await page.evaluate(({ selectorPath, markerName }) => {
    let root: Document | ShadowRoot = document;
    let selected: Element | null = null;
    for (const [index, selector] of selectorPath.entries()) {
      selected = root.querySelector(selector);
      if (!selected) throw new Error('fixture target missing');
      if (index < selectorPath.length - 1) root = selected.shadowRoot!;
    }
    selected!.setAttribute(markerName, '');
  }, probeTarget);
  return probeTarget;
}

for (const version of ['18.3.1', '19.2.7', '19.3.0']) {
  test(`extracts exact React ${version} development ancestry without privacy reads`, async ({ page }) => {
    await ready(page, `/react/${version}/development`);
    const fixture = await page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__);
    for (const fixtureTarget of Object.values(fixture.targets) as FixtureTarget[]) {
      const probeTarget = await targetFor(page, fixtureTarget);
      const startedAt = performance.now();
      const raw = await page.evaluate(reactComponentContextProbe, probeTarget);
      expect(performance.now() - startedAt).toBeLessThan(100);
      expect(JSON.parse(raw!)).toEqual({
        version: 1, framework: 'react', provenance: 'react-dom-fiber-dev',
        path: safeExpectedPaths[fixtureTarget.id], truncated: false,
      });
    }
    expect(await page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__.privacyReads)).toEqual({
      props: 0, state: 0, source: 0, stack: 0,
    });
  });
}

for (const mode of ['production', 'profiling']) {
  test(`omits React ${mode} metadata even when component names survive`, async ({ page }) => {
    await ready(page, `/react/19.3.0/${mode}`);
    const fixtureTarget = await page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__.targets.nested);
    expect(await page.evaluate(reactComponentContextProbe, await targetFor(page, fixtureTarget))).toBeNull();
  });
}

test('requires one direct data marker and never borrows an ancestor Fiber', async ({ page }) => {
  await ready(page, '/react/19.3.0/development');
  await page.evaluate(() => document.querySelector('#react-root')!.append(document.createElement('button')));
  const unmanaged = { selectorPath: ['#react-root > button'], expectedTag: 'button', markerName: MARKER };
  await page.locator('#react-root > button').evaluate((element, marker) => element.setAttribute(marker, ''), MARKER);
  expect(await page.evaluate(reactComponentContextProbe, unmanaged)).toBeNull();

  const fixtureTarget = await page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__.targets.nested);
  const probeTarget = await targetFor(page, fixtureTarget);
  await page.locator('#react-nested-button').evaluate(element => Object.defineProperty(element, '__reactFiber$trap', {
    get() { throw new Error('private getter'); },
  }));
  await expect(page.evaluate(reactComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
  await expect(page.evaluate(reactComponentContextProbe, probeTarget)).rejects.not.toThrow('private getter');
});

test('fails closed on cycles, accessors and exhausted traversal', async ({ page }) => {
  await ready(page, '/react/19.3.0/development');
  const fixtureTarget = await page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__.targets.nested);
  const probeTarget = await targetFor(page, fixtureTarget);
  await page.locator('#react-nested-button').evaluate(element => {
    const key = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactFiber$'))!;
    const fiber = (element as any)[key];
    Object.defineProperty(fiber, 'return', { configurable: true, get() { throw new Error('return secret'); } });
  });
  await expect(page.evaluate(reactComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
});

test('never invokes optional wrapper displayName accessors', async ({ page }) => {
  await ready(page, '/react/19.3.0/development');
  const fixtureTarget = await page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__.targets.nested);
  const probeTarget = await targetFor(page, fixtureTarget);
  await page.locator('#react-nested-button').evaluate(element => {
    const key = Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactFiber$'))!;
    const wrapper = (element as any)[key].return.type;
    (window as any).__displayNameReads = 0;
    Object.defineProperty(wrapper, 'displayName', { configurable: true, get() {
      (window as any).__displayNameReads += 1; throw new Error('displayName secret');
    } });
  });
  expect(JSON.parse((await page.evaluate(reactComponentContextProbe, probeTarget))!).path).toEqual(
    safeExpectedPaths['react-nested-button'],
  );
  expect(await page.evaluate(() => (window as any).__displayNameReads)).toBe(0);
});

test('rejects detached targets and malformed target contracts cleanly', async ({ page }) => {
  await ready(page, '/react/19.3.0/development');
  const fixtureTarget = await page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__.targets.nested);
  const probeTarget = await targetFor(page, fixtureTarget);
  await page.locator('#react-nested-button').evaluate(element => element.remove());
  expect(await page.evaluate(reactComponentContextProbe, probeTarget)).toBeNull();
});

test('treats a malformed React type as indeterminate beside valid Vue metadata', async ({ page }) => {
  await page.setContent('<button id="selected">Selected</button>');
  const probeTarget = { selectorPath: ['#selected'], expectedTag: 'button', markerName: MARKER };
  await page.evaluate(({ markerName }) => {
    const selected = document.querySelector('#selected')! as any;
    selected.setAttribute(markerName, '');
    Object.defineProperty(selected, '__reactFiber$fixture', { value: {
      tag: 5, stateNode: selected, return: { tag: 0, type: 42, return: { tag: 3, return: null } },
      _debugStack: null, _debugOwner: null, _debugInfo: null,
    } });
    Object.defineProperty(selected, '__vueParentComponent', { value: {
      type: { name: 'VueCard' }, parent: null, isUnmounted: false,
    } });
  }, probeTarget);

  await expect(page.evaluate(reactComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
  const vueValue = JSON.parse((await page.evaluate(vueComponentContextProbe, probeTarget))!);
  expect(selectComponentContext([
    { kind: 'indeterminate' }, { kind: 'valid', value: vueValue }, { kind: 'none' },
  ])).toBeNull();
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
    function Component() {}
    Object.defineProperty(selected, '__reactFiber$fixture', { value: {
      tag: 5, stateNode: selected,
      return: { tag: 0, type: Component, return: { tag: 3, return: null } },
      _debugStack: null, _debugOwner: null, _debugInfo: null,
    } });
  }, probeTarget);
  expect(JSON.parse((await page.evaluate(reactComponentContextProbe, probeTarget))!).path).toEqual(['Component']);
});

test('enforces the clock during final serialization', async ({ page }) => {
  await page.setContent('<button id="selected">Selected</button>');
  const probeTarget = { selectorPath: ['#selected'], expectedTag: 'button', markerName: MARKER };
  await page.evaluate(({ markerName }) => {
    const selected = document.querySelector('#selected')! as any;
    selected.setAttribute(markerName, '');
    function Component() {}
    Object.defineProperty(selected, '__reactFiber$fixture', { value: {
      tag: 5, stateNode: selected,
      return: { tag: 0, type: Component, return: { tag: 3, return: null } },
      _debugStack: null, _debugOwner: null, _debugInfo: null,
    } });
  }, probeTarget);
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
  await expect(page.evaluate(reactComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
});

test('keeps the nearest eight names and rejects more than 64 Fiber links', async ({ page }) => {
  await page.setContent('<button id="selected">Selected</button>');
  const probeTarget = { selectorPath: ['#selected'], expectedTag: 'button', markerName: MARKER };
  await page.evaluate(({ markerName }) => {
    const selected = document.querySelector('#selected')! as any;
    selected.setAttribute(markerName, '');
    const makeChain = (count: number) => {
      let parent: any = { tag: 3, return: null };
      for (let index = 0; index < count; index += 1) {
        const type = function Component() {};
        Object.defineProperty(type, 'displayName', { value: `Component${index}` });
        parent = { tag: 0, type, return: parent };
      }
      return parent;
    };
    Object.defineProperty(selected, '__reactFiber$fixture', { configurable: true, value: {
      tag: 5, stateNode: selected, return: makeChain(10), _debugStack: null, _debugOwner: null, _debugInfo: null,
    } });
    (window as any).__makeReactChain = makeChain;
  }, probeTarget);
  expect(JSON.parse((await page.evaluate(reactComponentContextProbe, probeTarget))!).path).toEqual(
    Array.from({ length: 8 }, (_, index) => `Component${index + 2}`),
  );
  await page.evaluate(() => {
    const selected = document.querySelector('#selected')! as any;
    selected.__reactFiber$fixture.return = (window as any).__makeReactChain(65);
  });
  await expect(page.evaluate(reactComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
});

test('deduplicates only an identity-equal memo tag14 wrapper and inner Fiber', async ({ page }) => {
  await page.setContent('<button id="selected">Selected</button>');
  const probeTarget = { selectorPath: ['#selected'], expectedTag: 'button', markerName: MARKER };
  await page.evaluate(({ markerName }) => {
    const selected = document.querySelector('#selected')! as any;
    selected.setAttribute(markerName, '');
    function PlanCard() {}
    const root = { tag: 3, return: null };
    const repeatedOuter = { tag: 0, type: PlanCard, return: root };
    const memoWrapper = { $$typeof: Symbol.for('react.memo'), type: PlanCard };
    const memo = { tag: 14, elementType: memoWrapper, return: repeatedOuter };
    const memoInner = { tag: 0, type: PlanCard, return: memo };
    Object.defineProperty(selected, '__reactFiber$fixture', { value: {
      tag: 5, stateNode: selected, return: memoInner,
      _debugStack: null, _debugOwner: null, _debugInfo: null,
    } });
  }, probeTarget);
  expect(JSON.parse((await page.evaluate(reactComponentContextProbe, probeTarget))!).path).toEqual([
    'PlanCard', 'PlanCard',
  ]);
});

test('bounds raw names, ancestry, and final UTF-8 serialization', async ({ page }) => {
  await page.setContent('<button id="selected">Selected</button>');
  const probeTarget = { selectorPath: ['#selected'], expectedTag: 'button', markerName: MARKER };
  await page.evaluate(({ markerName }) => {
    const selected = document.querySelector('#selected')!;
    selected.setAttribute(markerName, '');
    const root = { tag: 3, return: null };
    let parent: any = root;
    for (let index = 0; index < 6; index += 1) {
      const type = function Component() {};
      Object.defineProperty(type, 'displayName', { configurable: true, value: '\ud800'.repeat(64) });
      parent = { tag: 0, type, return: parent };
    }
    const host = {
      tag: 5, stateNode: selected, return: parent,
      _debugStack: null, _debugOwner: null, _debugInfo: null,
    };
    Object.defineProperty(selected, '__reactFiber$fixture', { value: host });
  }, probeTarget);
  const raw = (await page.evaluate(reactComponentContextProbe, probeTarget))!;
  expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(2_048);
  expect(JSON.parse(raw)).toMatchObject({ framework: 'react', truncated: true });

  await page.evaluate(() => {
    const selected = document.querySelector('#selected')! as any;
    const key = Object.getOwnPropertyNames(selected).find(name => name.startsWith('__reactFiber$'))!;
    const type = selected[key].return.type;
    Object.defineProperty(type, 'displayName', { configurable: true, value: 'x'.repeat(129) });
  });
  expect(await page.evaluate(reactComponentContextProbe, probeTarget)).toBeNull();
});
