import { expect, test, type Page } from '@playwright/test';
import { angularComponentContextProbe } from '../../src/angular-context-probe';
import {
  classifyComponentContextProbeResult,
  type ComponentContextProbeOutcome,
  type ComponentContextProbeTarget,
} from '../../src/component-context-bridge';
import { selectComponentContext } from '../../src/component-context-dispatch';
import { reactComponentContextProbe } from '../../src/react-context-probe';
import { vueComponentContextProbe } from '../../src/vue-context-probe';

const MARKER = 'data-anmerko-context-0123456789abcdef0123456789abcdef';
const probes = [reactComponentContextProbe, vueComponentContextProbe, angularComponentContextProbe] as const;
const frameworks = ['react', 'vue', 'angular'] as const;
interface FixtureServer { origin: string; close(): Promise<void> }
interface MixedTarget {
  id: string;
  selectorPath: string[];
  expectedTag: string;
  expectedFrameworks: string[];
  expectedPaths: Record<string, string[]>;
}
let fixtureServer: FixtureServer;

test.beforeAll(async () => {
  // @ts-expect-error the isolated ESM fixture package intentionally has no root declaration file
  const { startFixtureServer } = await import('../fixtures/component-context/server.mjs');
  fixtureServer = await startFixtureServer();
});
test.afterAll(async () => fixtureServer.close());

async function load(page: Page, route: string): Promise<Record<string, MixedTarget>> {
  await page.goto(`${fixtureServer.origin}${route}`);
  await page.waitForFunction(() => (globalThis as any).__ANMERKO_FIXTURE__?.ready === true);
  return page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__.targets);
}

async function mark(page: Page, fixtureTarget: MixedTarget): Promise<ComponentContextProbeTarget> {
  const target = {
    selectorPath: fixtureTarget.selectorPath,
    expectedTag: fixtureTarget.expectedTag,
    markerName: MARKER,
  };
  await page.evaluate(({ selectorPath, markerName }) => {
    let root: Document | ShadowRoot = document;
    let selected: Element | null = null;
    for (const [index, selector] of selectorPath.entries()) {
      selected = root.querySelector(selector);
      if (!selected) throw new Error(`Missing mixed target segment: ${selector}`);
      if (index < selectorPath.length - 1) {
        if (!selected.shadowRoot) throw new Error(`Missing mixed target shadow root: ${selector}`);
        root = selected.shadowRoot;
      }
    }
    selected!.setAttribute(markerName, '');
  }, target);
  return target;
}

async function expectMixedRoute(page: Page, route: string): Promise<void> {
  const targets = await load(page, route);
  for (const fixtureTarget of Object.values(targets)) {
    const target = await mark(page, fixtureTarget);
    const outcomes: ComponentContextProbeOutcome[] = [];
    for (const probe of probes) {
      outcomes.push(classifyComponentContextProbeResult(await page.evaluate(probe, target)));
    }
    expect(outcomes.some(outcome => outcome.kind === 'indeterminate'), fixtureTarget.id).toBe(false);
    const valid = outcomes.flatMap((outcome, index) => outcome.kind === 'valid'
      ? [{ framework: frameworks[index], value: outcome.value }] : []);
    expect(valid.map(entry => entry.framework), fixtureTarget.id).toEqual(fixtureTarget.expectedFrameworks);
    for (const entry of valid) {
      expect(entry.value.framework).toBe(entry.framework);
      expect(entry.value.path).toEqual(fixtureTarget.expectedPaths[entry.framework]);
    }
    const selected = selectComponentContext(outcomes);
    if (fixtureTarget.expectedFrameworks.length === 1) {
      expect(selected?.framework).toBe(fixtureTarget.expectedFrameworks[0]);
      expect(selected?.path).toEqual(fixtureTarget.expectedPaths[fixtureTarget.expectedFrameworks[0]]);
    } else {
      expect(selected, `${fixtureTarget.id} must conservatively omit ambiguous context`).toBeNull();
    }
  }
}

test('selects each real framework only on its independent island', async ({ page }) => {
  await expectMixedRoute(page, '/mixed/islands');
});

for (const [label, route] of [
  ['React and Vue', '/mixed/dual-association'],
  ['React and Angular', '/mixed/react-angular-association'],
  ['Vue and Angular', '/mixed/vue-angular-association'],
  ['React, Vue and Angular', '/mixed/triple-association'],
] as const) {
  test(`omits a real same-node ${label} ambiguity`, async ({ page }) => {
    await expectMixedRoute(page, route);
  });
}
