import { expect, test, type Page } from '@playwright/test';
import { angularComponentContextProbe } from '../../src/angular-context-probe';

const FAILURE_TOKEN = 'ANMERKO_COMPONENT_CONTEXT_PROBE_FAILED';
const MARKER = 'data-anmerko-context-0123456789abcdef0123456789abcdef';

interface ProbeTarget {
  selectorPath: string[];
  expectedTag: string;
  markerName: string;
}

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

let fixtureServer: FixtureServer;

test.beforeAll(async () => {
  // The fixture server is an ESM-only test helper, intentionally outside the
  // root TypeScript project because it owns independent nested toolchains.
  // @ts-expect-error no declaration file is needed for this test-only module
  const { startFixtureServer } = await import('../fixtures/component-context/server.mjs');
  fixtureServer = await startFixtureServer();
});

test.afterAll(async () => fixtureServer.close());

function target(selectorPath: string[], expectedTag = 'button'): ProbeTarget {
  return { selectorPath, expectedTag, markerName: MARKER };
}

async function markTarget(page: Page, probeTarget: ProbeTarget): Promise<void> {
  await page.evaluate(({ selectorPath, markerName }) => {
    let root: Document | ShadowRoot = document;
    let selected: Element | null = null;
    for (let index = 0; index < selectorPath.length; index++) {
      selected = root.querySelector(selectorPath[index]);
      if (!selected) throw new Error('Test target missing');
      if (index < selectorPath.length - 1) {
        if (!selected.shadowRoot) throw new Error('Test shadow root missing');
        root = selected.shadowRoot;
      }
    }
    selected?.setAttribute(markerName, '');
  }, probeTarget);
}

async function runMarkedProbe(page: Page, probeTarget: ProbeTarget): Promise<string | null> {
  await markTarget(page, probeTarget);
  return page.evaluate(angularComponentContextProbe, probeTarget);
}

async function installFakeAngular(page: Page, names: string[]): Promise<ProbeTarget> {
  await page.setContent('<button id="selected" type="button">Selected</button>');
  await page.evaluate(componentNames => {
    const selected = document.querySelector('#selected');
    if (!selected) throw new Error('Missing selected element');
    const components = componentNames.map(name => {
      const constructor = function FixtureComponent() {};
      Object.defineProperty(constructor, 'name', { configurable: true, value: name });
      const prototype = {};
      Object.defineProperty(prototype, 'constructor', { configurable: true, value: constructor });
      return Object.create(prototype) as object;
    });
    const hosts = components.map((_, index) => {
      const host = document.createElement(`fixture-${index}`);
      document.body.append(host);
      return host;
    });
    const componentForHost = new Map<Element, object>(hosts.map((host, index) => [host, components[index]]));
    const hostForComponent = new Map(components.map((component, index) => [component, hosts[index]]));
    const ownerForHost = new Map<Element, object | null>(
      hosts.map((host, index) => [host, components[index + 1] ?? null]),
    );
    const calls = { getComponent: 0, getOwningComponent: 0, getHostElement: 0 };
    Object.defineProperty(window, '__angularProbeCalls', { configurable: true, value: calls });
    Object.defineProperty(window, 'ng', {
      configurable: true,
      value: {
        getComponent(element: Element) {
          calls.getComponent += 1;
          return componentForHost.get(element) ?? null;
        },
        getOwningComponent(element: Element) {
          calls.getOwningComponent += 1;
          return element === selected ? components[0] ?? null : ownerForHost.get(element) ?? null;
        },
        getHostElement(component: object) {
          calls.getHostElement += 1;
          return hostForComponent.get(component) ?? null;
        },
      },
    });
  }, names);
  const probeTarget = target(['#selected']);
  await markTarget(page, probeTarget);
  return probeTarget;
}

test('is self-contained when Playwright serializes it into the page world', async ({ page }) => {
  const probeTarget = await installFakeAngular(page, ['_PlanCardComponent', '_PricingPageComponent', '_AppComponent']);
  expect(JSON.parse((await page.evaluate(angularComponentContextProbe, probeTarget))!)).toEqual({
    version: 1,
    framework: 'angular',
    provenance: 'angular-debug-ownership',
    path: ['_AppComponent', '_PricingPageComponent', '_PlanCardComponent'],
    truncated: false,
  });
  expect(await page.evaluate(() => (window as any).__angularProbeCalls)).toEqual({
    getComponent: 4,
    getOwningComponent: 4,
    getHostElement: 3,
  });
});

test('returns clean absence for missing and incomplete debug API sets', async ({ page }) => {
  const probeTarget = target(['#selected']);
  await page.setContent('<button id="selected" type="button">Selected</button>');
  await markTarget(page, probeTarget);
  expect(await page.evaluate(angularComponentContextProbe, probeTarget)).toBeNull();
  await page.evaluate(() => Object.defineProperty(window, 'ng', {
    configurable: true,
    value: { getComponent() { return null; }, getOwningComponent() { return null; } },
  }));
  expect(await page.evaluate(angularComponentContextProbe, probeTarget)).toBeNull();

  await page.evaluate(() => Object.defineProperty(window, 'ng', {
    configurable: true,
    value: { version: { full: '1.8.3' }, module() {} },
  }));
  expect(await page.evaluate(angularComponentContextProbe, probeTarget)).toBeNull();

  await page.evaluate(() => Object.defineProperty(window, 'ng', {
    configurable: true,
    value: Object.create({
      getComponent() { return null; },
      getOwningComponent() { return null; },
      getHostElement() { return null; },
    }),
  }));
  expect(await page.evaluate(angularComponentContextProbe, probeTarget)).toBeNull();
});

test('requires exact unique target resolution, tag, and empty marker value', async ({ page }) => {
  await page.setContent('<div id="host"></div><button class="duplicate"></button><button class="duplicate"></button>');
  for (const probeTarget of [
    target(['#missing']),
    target(['.duplicate']),
    target(['#host', '#missing']),
    target(['#host'], 'button'),
  ]) expect(await page.evaluate(angularComponentContextProbe, probeTarget)).toBeNull();

  const marked = target(['#host'], 'div');
  await page.locator('#host').evaluate((element, marker) => element.setAttribute(marker, 'occupied'), MARKER);
  expect(await page.evaluate(angularComponentContextProbe, marked)).toBeNull();
});

test('rejects malformed selectors, tags, markers, and selector controls', async ({ page }) => {
  await page.setContent('<button id="selected" type="button">Selected</button>');
  for (const probeTarget of [
    target(['[']),
    target(['#selected'], 'BUTTON'),
    { ...target(['#selected']), markerName: 'data-anmerko-context-not-a-token' },
    target(['#selected\n']),
  ]) await expect(page.evaluate(angularComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
});

test('turns accessors, malformed APIs, and API throws into only the fixed failure token', async ({ page }) => {
  const probeTarget = target(['#selected']);
  await page.setContent('<button id="selected" type="button">Selected</button>');
  await markTarget(page, probeTarget);
  await page.evaluate(() => {
    Object.defineProperty(window, '__forbiddenReads', { configurable: true, value: 0, writable: true });
    Object.defineProperty(window, 'ng', {
      configurable: true,
      get() { (window as any).__forbiddenReads += 1; throw new Error('page secret'); },
    });
  });
  await expect(page.evaluate(angularComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
  expect(await page.evaluate(() => (window as any).__forbiddenReads)).toBe(0);

  await page.evaluate(() => Object.defineProperty(window, 'ng', {
    configurable: true,
    value: Object.defineProperty({
      getOwningComponent() { return null; },
      getHostElement() { return null; },
    }, 'getComponent', {
      configurable: true,
      get() { (window as any).__forbiddenReads += 1; throw new Error('method secret'); },
    }),
  }));
  await expect(page.evaluate(angularComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
  expect(await page.evaluate(() => (window as any).__forbiddenReads)).toBe(0);

  await page.evaluate(() => Object.defineProperty(window, 'ng', { configurable: true, value: 1 }));
  await expect(page.evaluate(angularComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);

  await page.evaluate(() => Object.defineProperty(window, 'ng', {
    configurable: true,
    value: {
      getComponent() { throw new Error('private page failure'); },
      getOwningComponent() { return null; },
      getHostElement() { return null; },
    },
  }));
  await expect(page.evaluate(angularComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
  await expect(page.evaluate(angularComponentContextProbe, probeTarget)).rejects.not.toThrow('private page failure');
});

test('reads only immediate prototype constructor names and never instance privacy getters', async ({ page }) => {
  const probeTarget = await installFakeAngular(page, ['_AppComponent']);
  await page.evaluate(() => {
    const calls = (window as any).__angularProbeCalls;
    const original = (window as any).ng.getOwningComponent;
    const component = original(document.querySelector('#selected'));
    const reads = { props: 0, state: 0, source: 0 };
    for (const key of Object.keys(reads)) Object.defineProperty(component, key, {
      get() { reads[key as keyof typeof reads] += 1; throw new Error(`forbidden:${key}`); },
    });
    Object.defineProperty(window, '__angularPrivacyReads', { configurable: true, value: reads });
    calls.getOwningComponent = 0;
  });
  expect(JSON.parse((await page.evaluate(angularComponentContextProbe, probeTarget))!).path).toEqual(['_AppComponent']);
  expect(await page.evaluate(() => (window as any).__angularPrivacyReads)).toEqual({ props: 0, state: 0, source: 0 });
});

test('fails closed without invoking constructor or function-name accessors', async ({ page }) => {
  const probeTarget = await installFakeAngular(page, ['_AppComponent']);
  await page.evaluate(() => {
    const component = (window as any).ng.getOwningComponent(document.querySelector('#selected'));
    const reads = { constructor: 0 };
    Object.defineProperty(Object.getPrototypeOf(component), 'constructor', {
      configurable: true,
      get() { reads.constructor += 1; throw new Error('constructor secret'); },
    });
    Object.defineProperty(window, '__angularAccessorReads', { configurable: true, value: reads });
  });
  await expect(page.evaluate(angularComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
  expect(await page.evaluate(() => (window as any).__angularAccessorReads)).toEqual({ constructor: 0 });

  const nameTarget = await installFakeAngular(page, ['_AppComponent']);
  await page.evaluate(() => {
    const component = (window as any).ng.getOwningComponent(document.querySelector('#selected'));
    const constructor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(component), 'constructor')!.value;
    const reads = { name: 0 };
    Object.defineProperty(constructor, 'name', {
      configurable: true,
      get() { reads.name += 1; throw new Error('name secret'); },
    });
    Object.defineProperty(window, '__angularAccessorReads', { configurable: true, value: reads });
  });
  await expect(page.evaluate(angularComponentContextProbe, nameTarget)).rejects.toThrow(FAILURE_TOKEN);
  expect(await page.evaluate(() => (window as any).__angularAccessorReads)).toEqual({ name: 0 });
});

test('rejects contradictory direct hosts, detached hosts, non-elements, and proxy traps', async ({ page }) => {
  const directTarget = await installFakeAngular(page, ['_DirectComponent']);
  await page.evaluate(() => {
    const ng = (window as any).ng;
    const selected = document.querySelector('#selected');
    const originalGetComponent = ng.getComponent;
    const originalGetOwningComponent = ng.getOwningComponent;
    const component = originalGetOwningComponent(selected);
    ng.getComponent = (element: Element) => element === selected ? component : originalGetComponent(element);
    ng.getOwningComponent = (element: Element) => element === selected ? null : originalGetOwningComponent(element);
  });
  await expect(page.evaluate(angularComponentContextProbe, directTarget)).rejects.toThrow(FAILURE_TOKEN);

  const detachedTarget = await installFakeAngular(page, ['_DetachedComponent']);
  await page.evaluate(() => {
    const ng = (window as any).ng;
    const component = ng.getOwningComponent(document.querySelector('#selected'));
    ng.getHostElement(component).remove();
  });
  await expect(page.evaluate(angularComponentContextProbe, detachedTarget)).rejects.toThrow(FAILURE_TOKEN);

  const nonElementTarget = await installFakeAngular(page, ['_NonElementComponent']);
  await page.evaluate(() => { (window as any).ng.getHostElement = () => ({}); });
  await expect(page.evaluate(angularComponentContextProbe, nonElementTarget)).rejects.toThrow(FAILURE_TOKEN);

  const proxyTarget = await installFakeAngular(page, ['_ProxyComponent']);
  await page.evaluate(() => {
    const selected = document.querySelector('#selected');
    const proxy = new Proxy({}, { getPrototypeOf() { throw new Error('proxy secret'); } });
    (window as any).ng.getOwningComponent = (element: Element) => element === selected ? proxy : null;
  });
  await expect(page.evaluate(angularComponentContextProbe, proxyTarget)).rejects.toThrow(FAILURE_TOKEN);
  await expect(page.evaluate(angularComponentContextProbe, proxyTarget)).rejects.not.toThrow('proxy secret');
});

test('keeps the innermost eight names and total-name budget without cutting identifiers', async ({ page }) => {
  const names = Array.from({ length: 10 }, (_, index) => `_Component${index}`);
  const probeTarget = await installFakeAngular(page, names);
  expect(JSON.parse((await page.evaluate(angularComponentContextProbe, probeTarget))!)).toMatchObject({
    path: names.slice(0, 8).reverse(),
    truncated: true,
  });

  const wideNames = Array.from({ length: 8 }, (_, index) => `${index}${'x'.repeat(59)}`);
  const wideTarget = await installFakeAngular(page, wideNames);
  expect(JSON.parse((await page.evaluate(angularComponentContextProbe, wideTarget))!)).toMatchObject({
    path: wideNames.slice(0, 6).reverse(),
    truncated: true,
  });

  const escapedNames = Array(8).fill('\ud800'.repeat(64));
  const escapedTarget = await installFakeAngular(page, escapedNames);
  const escapedResult = await page.evaluate(angularComponentContextProbe, escapedTarget);
  const escapedContext = JSON.parse(escapedResult!);
  expect(new TextEncoder().encode(escapedResult!).byteLength).toBeLessThanOrEqual(2_048);
  expect(escapedContext).toMatchObject({ truncated: true });
  expect(escapedContext.path.length).toBeLessThan(8);
  expect(escapedContext.path.at(-1)).toBe(escapedNames[0]);
});

test('rejects unusable names as clean absence', async ({ page }) => {
  for (const name of ['', 'x', 'Bad\nName', 'x'.repeat(65), '\ud800'.repeat(65)]) {
    const probeTarget = await installFakeAngular(page, [name]);
    expect(await page.evaluate(angularComponentContextProbe, probeTarget)).toBeNull();
  }
});

test('rejects cycles and stops at exactly 64 links and 194 allowlisted calls', async ({ page }) => {
  const cycleTarget = await installFakeAngular(page, ['_CycleComponent']);
  await page.evaluate(() => {
    const ng = (window as any).ng;
    const component = ng.getOwningComponent(document.querySelector('#selected'));
    const host = ng.getHostElement(component);
    ng.getOwningComponent = (element: Element) => element === document.querySelector('#selected') || element === host
      ? component : null;
  });
  await expect(page.evaluate(angularComponentContextProbe, cycleTarget)).rejects.toThrow(FAILURE_TOKEN);

  const depthTarget = await installFakeAngular(page, Array(65).fill('_DeepComponent'));
  await expect(page.evaluate(angularComponentContextProbe, depthTarget)).rejects.toThrow(FAILURE_TOKEN);
  expect(await page.evaluate(() => (window as any).__angularProbeCalls)).toEqual({
    getComponent: 65,
    getOwningComponent: 65,
    getHostElement: 64,
  });
});

test('enforces cooperative clock checks around framework calls', async ({ page }) => {
  const probeTarget = await installFakeAngular(page, ['_ClockComponent']);
  await page.evaluate(() => {
    let calls = 0;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => (++calls <= 4 ? 0 : 11) });
  });
  await expect(page.evaluate(angularComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
  expect(await page.evaluate(() => (window as any).__angularProbeCalls)).toEqual({
    getComponent: 1,
    getOwningComponent: 0,
    getHostElement: 0,
  });
});

test('rejects a non-finite initial cooperative clock before framework calls', async ({ page }) => {
  const probeTarget = await installFakeAngular(page, ['_ClockComponent']);
  await page.evaluate(() => {
    Object.defineProperty(performance, 'now', { configurable: true, value: () => Number.NaN });
  });
  await expect(page.evaluate(angularComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
  expect(await page.evaluate(() => (window as any).__angularProbeCalls)).toEqual({
    getComponent: 0,
    getOwningComponent: 0,
    getHostElement: 0,
  });
});

test('rejects a result when final UTF-8 serialization exhausts the clock budget', async ({ page }) => {
  const probeTarget = await installFakeAngular(page, ['_ClockComponent']);
  await page.evaluate(() => {
    let elapsed = 0;
    const encode = TextEncoder.prototype.encode;
    Object.defineProperty(performance, 'now', { configurable: true, value: () => elapsed });
    TextEncoder.prototype.encode = function (value) {
      const result = encode.call(this, value);
      elapsed = 11;
      return result;
    };
  });
  await expect(page.evaluate(angularComponentContextProbe, probeTarget)).rejects.toThrow(FAILURE_TOKEN);
});

test('uses the cooperative 25 ms Android clock cap', async ({ page }) => {
  const probeTarget = await installFakeAngular(page, ['_AndroidComponent']);
  await page.evaluate(() => {
    let first = true;
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Mozilla/5.0 Android' });
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: () => {
        if (first) { first = false; return 0; }
        return 20;
      },
    });
  });
  expect(JSON.parse((await page.evaluate(angularComponentContextProbe, probeTarget))!).path).toEqual(['_AndroidComponent']);
});

const realDevelopmentCases = [
  { id: 'angular-app-host', tag: 'angular-fixture-app', path: ['_AppComponent'], shadowHost: null },
  { id: 'angular-app-inner', tag: 'main', path: ['_AppComponent'], shadowHost: null },
  { id: 'angular-secondary-app-host', tag: 'angular-fixture-app', path: ['_AppComponent'], shadowHost: null },
  { id: 'angular-pricing-host', tag: 'pricing-page', path: ['_AppComponent', '_PricingPageComponent'], shadowHost: null },
  { id: 'angular-plan-card-host', tag: 'plan-card', path: ['_AppComponent', '_PricingPageComponent', '_PlanCardComponent'], shadowHost: null },
  { id: 'angular-secondary-plan-card-host', tag: 'plan-card', path: ['_AppComponent', '_PricingPageComponent', '_PlanCardComponent'], shadowHost: null },
  { id: 'angular-embedded-reports', tag: 'span', path: ['_AppComponent', '_PricingPageComponent'], shadowHost: null },
  { id: 'angular-projected-host', tag: 'article', path: ['_AppComponent'], shadowHost: 'angular-plan-card-host' },
  { id: 'angular-projected-leaf', tag: 'span', path: ['_AppComponent'], shadowHost: 'angular-plan-card-host' },
  { id: 'angular-projected-embedded', tag: 'em', path: ['_AppComponent'], shadowHost: 'angular-plan-card-host' },
  { id: 'angular-dynamic-host', tag: 'plan-card', path: ['_PlanCardComponent'], shadowHost: null },
  { id: 'angular-dynamic-leaf', tag: 'button', path: ['_PlanCardComponent'], shadowHost: 'angular-dynamic-host' },
  { id: 'angular-unmanaged-innerhtml', tag: 'button', path: null, shadowHost: null },
  { id: 'angular-unmanaged-clone', tag: 'button', path: null, shadowHost: null },
] as const;

test('records the development AOT runtime and own data-function API boundary', async ({ page }) => {
  await page.goto(`${fixtureServer.origin}/angular/22.1.7/development`);
  await page.waitForFunction(() => (window as any).__BRIEFMARK_ANGULAR_FIXTURE__?.ready === true);
  expect(await page.evaluate(() => {
    const ngDescriptor = Object.getOwnPropertyDescriptor(window, 'ng');
    const ng = ngDescriptor && 'value' in ngDescriptor ? ngDescriptor.value : undefined;
    return {
      runtime: (window as any).__BRIEFMARK_ANGULAR_FIXTURE__.runtime,
      ngOwnData: Boolean(ngDescriptor && 'value' in ngDescriptor),
      api: ['getComponent', 'getOwningComponent', 'getHostElement'].map(name => {
        const descriptor = ng && Object.getOwnPropertyDescriptor(ng, name);
        return Boolean(descriptor && 'value' in descriptor && typeof descriptor.value === 'function');
      }),
    };
  })).toEqual({
    runtime: {
      angularVersion: '22.1.7',
      buildMode: 'development',
      aot: true,
      optimized: false,
      devToolsInstalled: false,
    },
    ngOwnData: true,
    api: [true, true, true],
  });
});

for (const fixtureCase of realDevelopmentCases) {
  test(`reads real Angular AOT ownership for ${fixtureCase.id}`, async ({ page }) => {
    await page.goto(`${fixtureServer.origin}/angular/22.1.7/development`);
    await page.waitForFunction(() => (window as any).__BRIEFMARK_ANGULAR_FIXTURE__?.ready === true);
    const probeTarget = target([
      ...(fixtureCase.shadowHost ? [`[data-fixture-id="${fixtureCase.shadowHost}"]`] : []),
      `[data-fixture-id="${fixtureCase.id}"]`,
    ], fixtureCase.tag);
    const result = await runMarkedProbe(page, probeTarget);
    expect(result === null ? null : JSON.parse(result).path).toEqual(fixtureCase.path);
    expect(await page.evaluate(() => (window as any).__BRIEFMARK_ANGULAR_FIXTURE__.sentinels.reads)).toEqual({
      props: 0,
      source: 0,
      state: 0,
    });
  });
}

test('resolves the exact shadow-root leaf and stays within the desktop clock budget', async ({ page }) => {
  await page.goto(`${fixtureServer.origin}/angular/22.1.7/development`);
  await page.waitForFunction(() => (window as any).__BRIEFMARK_ANGULAR_FIXTURE__?.ready === true);
  const probeTarget = target([
    '[data-fixture-id="angular-plan-card-host"]',
    '[data-fixture-id="angular-plan-card-leaf"]',
  ]);
  await markTarget(page, probeTarget);
  await page.evaluate(() => {
    const actualNow = performance.now.bind(performance);
    const clock = { first: Number.NaN, last: Number.NaN, calls: 0 };
    Object.defineProperty(window, '__angularProbeClock', { configurable: true, value: clock });
    Object.defineProperty(performance, 'now', { configurable: true, value() {
      const value = actualNow();
      if (clock.calls === 0) clock.first = value;
      clock.last = value;
      clock.calls += 1;
      return value;
    } });
  });
  expect(JSON.parse((await page.evaluate(angularComponentContextProbe, probeTarget))!).path).toEqual([
    '_AppComponent',
    '_PricingPageComponent',
    '_PlanCardComponent',
  ]);
  const clock = await page.evaluate(() => (window as any).__angularProbeClock);
  expect(clock.calls).toBeGreaterThan(1);
  expect(clock.last - clock.first).toBeLessThanOrEqual(10);
});

test('permits Angular debug helper caching but never reads fixture privacy sentinels', async ({ page }) => {
  await page.goto(`${fixtureServer.origin}/angular/22.1.7/development`);
  await page.waitForFunction(() => (window as any).__BRIEFMARK_ANGULAR_FIXTURE__?.ready === true);
  const probeTarget = target([
    '[data-fixture-id="angular-plan-card-host"]',
    '[data-fixture-id="angular-plan-card-leaf"]',
  ]);
  await markTarget(page, probeTarget);
  const before = await page.evaluate(() => {
    const host = document.querySelector('[data-fixture-id="angular-plan-card-host"]');
    const leaf = host?.shadowRoot?.querySelector('[data-fixture-id="angular-plan-card-leaf"]');
    return Object.getOwnPropertyDescriptor(leaf!, '__ngContext__')?.value;
  });
  await page.evaluate(angularComponentContextProbe, probeTarget);
  const after = await page.evaluate(() => {
    const host = document.querySelector('[data-fixture-id="angular-plan-card-host"]');
    const leaf = host?.shadowRoot?.querySelector('[data-fixture-id="angular-plan-card-leaf"]');
    return {
      cacheType: typeof Object.getOwnPropertyDescriptor(leaf!, '__ngContext__')?.value,
      reads: (window as any).__BRIEFMARK_ANGULAR_FIXTURE__.sentinels.reads,
    };
  });
  expect(before === undefined || typeof before === 'number').toBe(true);
  expect(after).toEqual({ cacheType: 'object', reads: { props: 0, source: 0, state: 0 } });
});

test('returns clean absence for the real optimized production AOT fixture', async ({ page }) => {
  await page.goto(`${fixtureServer.origin}/angular/22.1.7/production`);
  await page.waitForFunction(() => (window as any).__BRIEFMARK_ANGULAR_FIXTURE__?.ready === true);
  const probeTarget = target(['[data-fixture-id="angular-plan-card-host"]'], 'plan-card');
  expect(await runMarkedProbe(page, probeTarget)).toBeNull();
  expect(await page.evaluate(() => ({
    runtime: (window as any).__BRIEFMARK_ANGULAR_FIXTURE__.runtime,
    ngOwn: Object.getOwnPropertyDescriptor(window, 'ng') !== undefined,
  }))).toEqual({
    runtime: {
      angularVersion: '22.1.7',
      buildMode: 'production',
      aot: true,
      optimized: true,
      devToolsInstalled: false,
    },
    ngOwn: false,
  });
});

test('returns absence when a dynamic target is disposed before exact resolution', async ({ page }) => {
  await page.goto(`${fixtureServer.origin}/angular/22.1.7/development`);
  await page.waitForFunction(() => (window as any).__BRIEFMARK_ANGULAR_FIXTURE__?.ready === true);
  const probeTarget = target(['[data-fixture-id="angular-dynamic-host"]'], 'plan-card');
  await markTarget(page, probeTarget);
  await page.locator('[data-fixture-id="angular-dispose-dynamic"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-fixture-id="angular-dynamic-host"]'));
  expect(await page.evaluate(angularComponentContextProbe, probeTarget)).toBeNull();
});
