import { expect, test, type Page } from '@playwright/test';
import { preactComponentContextProbe } from '../../src/preact-context-probe';

const MARKER = 'data-anmerko-context-0123456789abcdef0123456789abcdef';
interface FixtureServer { origin: string; close(): Promise<void> }
interface FixtureTarget { id: string; expectedPath: string[] }
interface ProbeTarget { selectorPath: string[]; expectedTag: string; markerName: string }
let fixtureServer: FixtureServer;
const safeExpectedPaths: Record<string, string[]> = {
  'preact-nested-button': ['App', 'PricingPage', 'PlanCard', 'FeedbackButton'],
  'preact-memo-button': ['App', 'PricingPage', 'MemoPlanCard', 'PlanCard', 'FeedbackButton'],
  'preact-forward-button': ['App', 'PricingPage', 'ForwardedPanel', 'FeedbackButton'],
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
  const probeTarget = {
    selectorPath: [`#${fixtureTarget.id}`],
    expectedTag: 'button', markerName: MARKER,
  };
  await page.evaluate(({ selectorPath, markerName }) => {
    const selected = document.querySelector(selectorPath[0]);
    if (!selected) throw new Error('fixture target missing');
    selected.setAttribute(markerName, '');
  }, probeTarget);
  return probeTarget;
}

test('extracts exact Preact development ancestry without privacy reads', async ({ page }) => {
  await ready(page, '/preact/10.29.8/development');
  const fixture = await page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__);
  expect(fixture.framework).toBe('preact');
  for (const fixtureTarget of Object.values(fixture.targets) as FixtureTarget[]) {
    if (fixtureTarget.id === 'preact-anonymous-button') continue;
    const probeTarget = await targetFor(page, fixtureTarget);
    const startedAt = performance.now();
    const raw = await page.evaluate(preactComponentContextProbe, probeTarget);
    expect(performance.now() - startedAt).toBeLessThan(100);
    expect(JSON.parse(raw!)).toEqual({
      version: 1, framework: 'preact', provenance: 'preact-vnode-prod',
      path: safeExpectedPaths[fixtureTarget.id], truncated: false,
    });
  }
  expect(await page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__.privacyReads)).toEqual({
    props: 0, state: 0, source: 0, stack: 0,
  });
});

test('extracts exact Preact production ancestry from minified names via displayName', async ({ page }) => {
  await ready(page, '/preact/10.29.8/production');
  const fixture = await page.evaluate(() => (globalThis as any).__ANMERKO_FIXTURE__);
  for (const fixtureTarget of Object.values(fixture.targets) as FixtureTarget[]) {
    if (fixtureTarget.id === 'preact-anonymous-button') continue;
    const probeTarget = await targetFor(page, fixtureTarget);
    const raw = await page.evaluate(preactComponentContextProbe, probeTarget);
    expect(JSON.parse(raw!)).toEqual({
      version: 1, framework: 'preact', provenance: 'preact-vnode-prod',
      path: safeExpectedPaths[fixtureTarget.id], truncated: false,
    });
  }
});

test('omits Preact context when the path contains an anonymous component', async ({ page }) => {
  await ready(page, '/preact/10.29.8/development');
  const probeTarget = await targetFor(page, { id: 'preact-anonymous-button', expectedPath: [] });
  expect(await page.evaluate(preactComponentContextProbe, probeTarget)).toBeNull();
});

test('omits Preact metadata on plain DOM pages', async ({ page }) => {
  await ready(page, '/plain');
  await page.evaluate(({ markerName }) => {
    document.querySelector('#plain-target')!.setAttribute(markerName, '');
  }, { markerName: MARKER });
  expect(await page.evaluate(preactComponentContextProbe, {
    selectorPath: ['#plain-target'], expectedTag: 'button', markerName: MARKER,
  })).toBeNull();
});

test('omits Preact context for unmarked nodes and never borrows an ancestor vnode', async ({ page }) => {
  await ready(page, '/preact/10.29.8/development');
  await page.evaluate(() => document.querySelector('#preact-root')!.append(document.createElement('button')));
  const probeTarget = {
    selectorPath: ['#preact-root > button:last-child'],
    expectedTag: 'button', markerName: MARKER,
  };
  await page.locator('#preact-root > button:last-child').evaluate((element, marker) => element.setAttribute(marker, ''), MARKER);
  expect(await page.evaluate(preactComponentContextProbe, probeTarget)).toBeNull();
});
