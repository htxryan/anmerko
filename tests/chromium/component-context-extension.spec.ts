import { copyPrompt } from '../shared/clipboard';
import { test as base, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// @ts-expect-error browser-neutral scenario data intentionally stays plain JavaScript for Selenium reuse
const scenarioModule = await import('../shared/component-context-scenarios.mjs');
const {
  componentContextFallbackScenarios,
  componentContextMixedScenarios,
  componentContextPositiveScenarios,
  componentFixtureUrl,
} = scenarioModule;

const ORIGIN = 'http://127.0.0.1:4177';
const CONTEXT_KEY = 'anmerko:capture-component-context';
type Scenario = {
  id: string;
  route: string;
  framework: string;
  version: string | null;
  target: { selectorPath: string[]; expectedTag: string; clickPosition?: { x: number; y: number }; dispatchTarget?: boolean };
  expectedPath: string[] | null;
  provenance?: string;
  privacy?: boolean;
};
type Fixtures = {
  extensionContext: BrowserContext;
  worker: Worker;
  page: Page;
  activate: (page: Page) => Promise<void>;
};

const test = base.extend<Fixtures>({
  extensionContext: async ({ browserName: _browserName }, use) => {
    const temp = await mkdtemp(path.join(tmpdir(), 'anmerko-component-context-'));
    const extension = path.join(temp, 'extension');
    await cp('dist', extension, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(extension, 'manifest.json'), 'utf8'));
    manifest.host_permissions = [`${ORIGIN}/*`];
    manifest.background.service_worker = 'test-bootstrap.js';
    await writeFile(path.join(extension, 'test-bootstrap.js'), `
      import { activateTab } from './background.js';
      let componentRequests = 0;
      const componentMessages = [];
      chrome.runtime.onMessage.addListener(message => {
        if (message?.type === 'ANMERKO_COMPONENT_CONTEXT') {
          componentRequests += 1;
          componentMessages.push(structuredClone(message));
        }
      });
      globalThis.__testActivateTab = activateTab;
      globalThis.__testComponentRequests = () => componentRequests;
      globalThis.__testComponentMessages = () => structuredClone(componentMessages);
    `);
    await writeFile(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
    const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
      channel: 'chromium',
      headless: !process.env.HEADED,
      viewport: { width: 1440, height: 1000 },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    try { await use(context); } finally {
      await context.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  worker: async ({ extensionContext }, use) => {
    const worker = extensionContext.serviceWorkers()[0] || await extensionContext.waitForEvent('serviceworker');
    await use(worker);
  },
  page: async ({ extensionContext }, use) => {
    const page = await extensionContext.newPage();
    await use(page);
  },
  activate: async ({ worker }, use) => {
    await use(async page => {
      await worker.evaluate(async url => {
        const tab = (await chrome.tabs.query({})).find(candidate => candidate.url === url);
        if (!tab?.id) throw new Error('Fixture tab not found');
        await (globalThis as typeof globalThis & { __testActivateTab(tabId: number): Promise<void> }).__testActivateTab(tab.id);
      }, page.url());
      await expect(panel(page)).toBeVisible();
    });
  },
});

const panel = (page: Page) => page.getByRole('complementary', { name: 'anmerko feedback panel' });
const componentRow = (page: Page) => panel(page).locator('.component-context');

function targetLocator(page: Page, scenario: Scenario) {
  let locator = page.locator(scenario.target.selectorPath[0]);
  for (const selector of scenario.target.selectorPath.slice(1)) locator = locator.locator(selector);
  return locator;
}

async function openScenario(page: Page, scenario: Scenario) {
  const response = await page.goto(componentFixtureUrl(ORIGIN, scenario));
  expect(response?.headers()['content-security-policy']).toContain("connect-src 'none'");
  expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:4177\//);
  await page.waitForFunction(mixed => mixed
    ? (globalThis as any).__ANMERKO_FIXTURE__?.ready === true
    : (globalThis as any).__ANMERKO_FIXTURE__?.ready === true
      || (globalThis as any).__BRIEFMARK_ANGULAR_FIXTURE__?.ready === true,
  scenario.route.startsWith('/mixed/'));
  const metadata = await page.evaluate(() => {
    const angular = (globalThis as any).__BRIEFMARK_ANGULAR_FIXTURE__;
    const fixture = (globalThis as any).__ANMERKO_FIXTURE__;
    return fixture ? { framework: fixture.framework, version: fixture.version, mode: fixture.mode }
      : { framework: angular.framework, version: angular.runtime.angularVersion, mode: angular.runtime.buildMode };
  });
  expect(metadata.version).toBe(scenario.version);
  return metadata;
}

async function selectScenario(page: Page, scenario: Scenario) {
  await panel(page).getByRole('button', { name: 'Select Element', exact: true }).click();
  const locator = targetLocator(page, scenario);
  if (scenario.target.dispatchTarget) await locator.dispatchEvent('click');
  else await locator.click({ position: scenario.target.clickPosition });
  await expect(panel(page).getByLabel('Comment', { exact: true })).toBeVisible();
}

async function enableComponentCapture(page: Page) {
  await panel(page).getByRole('button', { name: 'Extension settings' }).click();
  const toggle = panel(page).getByRole('switch', { name: 'Capture component context' });
  await expect(toggle).toBeEnabled();
  if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await panel(page).getByRole('button', { name: 'Back', exact: false }).click();
}

async function privacyReads(page: Page) {
  return page.evaluate(() => {
    const angular = (globalThis as any).__BRIEFMARK_ANGULAR_FIXTURE__;
    return angular ? angular.sentinels.reads : (globalThis as any).__ANMERKO_FIXTURE__?.privacyReads;
  });
}

test('the built broker stays off by default, then covers the strict-CSP HTTP framework matrix', async ({
  page, worker, activate,
}) => {
  test.setTimeout(120_000);
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  const first = componentContextPositiveScenarios[0] as Scenario;
  await openScenario(page, first);
  await activate(page);
  await panel(page).getByRole('button', { name: 'Extension settings' }).click();
  const toggle = panel(page).getByRole('switch', { name: 'Capture component context' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await panel(page).getByRole('button', { name: 'Back', exact: false }).click();
  await selectScenario(page, first);
  await expect(componentRow(page)).toHaveCount(0);
  expect(await worker.evaluate(() => (globalThis as any).__testComponentRequests())).toBe(0);
  expect(await privacyReads(page)).toEqual({ props: 0, state: 0, source: 0, stack: 0 });
  await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await enableComponentCapture(page);

  const matrix = [
    ...componentContextPositiveScenarios,
    ...componentContextFallbackScenarios,
    ...componentContextMixedScenarios,
  ] as Scenario[];
  for (const scenario of matrix) {
    await openScenario(page, scenario);
    await activate(page);
    await expect(panel(page).locator('.component-context-toggle')).toHaveAttribute('aria-checked', 'true');
    const before = await worker.evaluate(() => (globalThis as any).__testComponentRequests());
    await selectScenario(page, scenario);
    await expect.poll(() => worker.evaluate(() => (globalThis as any).__testComponentRequests())).toBe(before + 1);
    if (scenario.expectedPath) {
      await expect(componentRow(page)).toContainText(`Component hint · ${scenario.framework[0].toUpperCase()}${scenario.framework.slice(1)}`);
      await expect(componentRow(page).locator('.component-context-path')).toHaveText(scenario.expectedPath.join(' → '));
    } else {
      await page.waitForTimeout(100);
      await expect(componentRow(page)).toHaveCount(0);
    }
    if (scenario.privacy) expect(Object.values(await privacyReads(page)).every(value => value === 0)).toBe(true);
    await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  expect(requests.every(url => !url.startsWith('http') || url.startsWith(ORIGIN))).toBe(true);
});

test('a real built hint follows parent, saved snapshot, reload, removal, clipboard and ZIP flows', async ({
  page, worker, activate,
}, testInfo) => {
  test.setTimeout(60_000);
  const scenario = componentContextPositiveScenarios.find((item: Scenario) => item.id === 'react-19.3.0-development') as Scenario;
  await openScenario(page, scenario);
  await activate(page);
  await enableComponentCapture(page);
  await selectScenario(page, scenario);
  await expect(componentRow(page).locator('.component-context-path')).toHaveText(scenario.expectedPath!.join(' → '));
  await panel(page).getByLabel('Comment', { exact: true }).fill('Keep the component snapshot.');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel(page).locator('.note')).toHaveCount(1);
  const stored = await worker.evaluate(async key => {
    const values = await chrome.storage.local.get(null);
    return Object.entries(values).find(([name]) => name.startsWith(key))?.[1];
  }, 'anmerko:note:v1:') as any;
  expect(stored.element.componentContext).toMatchObject({ framework: 'react', path: scenario.expectedPath });

  const prompt = await copyPrompt(page);
  expect(prompt).toContain('React · development metadata');
  expect(prompt).toContain('`App` → `PricingPage` → `PlanCard` → `FeedbackButton`');
  await worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(candidate => candidate.url === url);
    if (!tab?.id) throw new Error('Fixture tab not found');
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      navigator.clipboard.writeText = () => Promise.reject(new Error('Simulated clipboard denial'));
    } });
  }, page.url());
  await panel(page).getByRole('button', { name: 'Copy Prompt' }).click();
  await expect(panel(page).getByRole('status')).toContainText('Could not copy');
  const downloading = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Download Markdown + Images' }).click();
  const archive = await downloading;
  const archivePath = testInfo.outputPath('component-context.zip');
  await archive.saveAs(archivePath);
  expect(execFileSync('unzip', ['-p', archivePath, 'comments.md'], { encoding: 'utf8' })).toBe(prompt);

  await page.reload();
  await page.waitForFunction(() => (globalThis as any).__ANMERKO_FIXTURE__?.ready === true);
  await activate(page);
  await expect(panel(page).locator('.note .component-context-path')).toHaveText(scenario.expectedPath!.join(' → '));
  await panel(page).locator('.note').getByRole('button', { name: 'Edit', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Remove component hint' }).click();
  await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel(page).locator('.note .component-context')).toHaveCount(1);
  await panel(page).locator('.note').getByRole('button', { name: 'Edit', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Remove component hint' }).click();
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel(page).locator('.note .component-context')).toHaveCount(0);

  await selectScenario(page, scenario);
  await expect(componentRow(page).locator('.component-context-path')).toHaveText(scenario.expectedPath!.join(' → '));
  await panel(page).getByRole('button', { name: 'Use Parent Element' }).click();
  await expect(componentRow(page).locator('.component-context-path')).toHaveText('App → PricingPage → PlanCard');
  await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await worker.evaluate(async key => (await chrome.storage.local.get(key))[key], CONTEXT_KEY)).toBe(true);
});
