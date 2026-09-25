import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { readFileSync } from 'node:fs';
import { addJourneyApis } from './fixtures/journey-apis';

// The journey review inside a panel (the native sidebar) takes its colors from
// the panel's theme. This mounts it in the same .app wrapper with panel.css.
const panelReviewBundle = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
  import { mountJourneyUI } from './src/journey-ui';
  import panelStyles from './src/panel.css';
  import { journeySurfaceStyles } from './src/journey-styles';
  const style = document.createElement('style');
  style.textContent = panelStyles + journeySurfaceStyles;
  document.head.append(style);
  const app = document.createElement('div');
  app.className = 'app native';
  app.dataset.theme = window.journeyTheme;
  document.body.append(app);
  const draft = {
    schemaVersion: 1, status: 'draft', id: 'J1', revision: 0,
    createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:03.000Z', startedAt: '2026-09-21T00:00:00.000Z',
    includeEnteredValues: false, stopReason: 'user', expected: '', actual: '', images: {}, limitations: [],
    steps: [1, 2].map(seq => ({ id: 'S' + seq, seq, kind: seq === 1 ? 'initial' : 'navigation', observedAt: '2026-09-21T00:00:00.000Z',
      elapsedMs: 0, sourceUrl: 'https://example.test/', navigation: { toUrl: 'https://example.test/next' },
      image: { status: 'unavailable', reason: 'superseded' } })),
  };
  const later = minutes => new Date(Date.now() + minutes * 60_000).toISOString();
  mountJourneyUI(app, {
    read: async () => ({ phase: 'reviewing', epoch: 1, sessionId: 'S', journeyId: 'J1', ownerTabId: 1, ownerWindowId: 1,
      warningAt: later(28), expiresAt: later(30), draft }),
    list: async () => [], subscribe: () => () => {},
    start: async () => {}, stop: async () => {}, discard: async () => {}, updateSummary: async () => {},
    removeStep: async () => {}, editValue: async () => {}, redactUrl: async () => {},
  });
` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;

const journeyPageBundle = buildSync({ stdin: { resolveDir: process.cwd(), contents: `
  import './src/journey-page';
` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'text' }, define: { __TARGET_JOURNEYS__: 'true' } }).outputFiles[0].text;

// WCAG contrast of an element's text against its own opaque background.
async function contrast(page: Page, selector: string): Promise<number> {
  return page.locator(selector).first().evaluate(element => {
    const channels = (value: string) => value.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    const luminance = (value: string) => {
      const [r, g, b] = channels(value).map(channel => {
        const c = channel / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const style = getComputedStyle(element);
    const [light, dark] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
    return (light + 0.05) / (dark + 0.05);
  });
}

for (const theme of ['light', 'dark']) {
  test(`destructive confirmations keep AA contrast in the ${theme} panel theme`, async ({ page }) => {
    await page.goto('http://127.0.0.1:4173');
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(value => { (window as any).journeyTheme = value; }, theme);
    await page.addScriptTag({ content: panelReviewBundle });
    await page.getByRole('button', { name: 'Remove step 2', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Confirm remove step 2', exact: true })).toBeVisible();
    expect(await contrast(page, '.journey-danger')).toBeGreaterThanOrEqual(4.5);
    await page.getByRole('button', { name: 'Keep step 2', exact: true }).click();
    await page.getByRole('button', { name: 'Discard journey', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Confirm discard journey', exact: true })).toBeVisible();
    expect(await contrast(page, '.journey-danger')).toBeGreaterThanOrEqual(4.5);
  });
}

async function openJourneyTab(page: Page, stored: Record<string, unknown> | null) {
  await page.goto('http://127.0.0.1:4173');
  await page.setContent('<!doctype html><html><body class="journey-page"><main id="journey"></main></body></html>');
  // A launch link offers Start, so the tab shows its primary button.
  await page.evaluate(`location.hash = '#launch=${'a'.repeat(16)}'`);
  await page.evaluate(`window.chrome = {
    runtime: {
      sendMessage: async message => message && message.type === 'ANMERKO_JOURNEY_STATE'
        ? { ok: true, value: { phase: 'idle', epoch: 0 } }
        : message && message.type === 'ANMERKO_JOURNEY_LIST' ? { ok: true, value: [] } : { ok: false },
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
  };`);
  await page.evaluate(addJourneyApis);
  if (stored) {
    await page.evaluate(values => {
      const listeners = new Set<(changes: object, area: string) => void>();
      const api = (window as any).chrome;
      api.storage.local = { get: async (key: string) => (key in values ? { [key]: values[key] } : {}) };
      api.storage.onChanged = { addListener: (listener: any) => listeners.add(listener), removeListener: (listener: any) => listeners.delete(listener) };
      (window as any).changeTheme = (value: unknown) => listeners.forEach(listener => listener({ 'anmerko:theme': { newValue: value } }, 'local'));
    }, stored);
  }
  await page.addScriptTag({ content: journeyPageBundle });
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
}

test('the journey tab follows the stored Dark appearance and later changes to it', async ({ page }) => {
  await openJourneyTab(page, { 'anmerko:theme': 'dark' });
  const body = page.locator('body');
  await expect(body).toHaveAttribute('data-theme', 'dark');
  await expect(body).toHaveCSS('background-color', 'rgb(28, 37, 53)');
  await expect(page.locator('.journey-view')).toHaveCSS('color', 'rgb(230, 234, 243)');
  expect(await contrast(page, '.journey-primary')).toBeGreaterThanOrEqual(4.5);
  await page.evaluate(() => (window as any).changeTheme('light'));
  await expect(body).toHaveAttribute('data-theme', 'light');
  await expect(body).toHaveCSS('background-color', 'rgb(255, 255, 255)');
});

test('the journey tab defaults to light, like the panel, without a stored or readable theme', async ({ page }) => {
  await openJourneyTab(page, {});
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await openJourneyTab(page, null);
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'light');
});

// journey.css repeats the panel's colors for the standalone tab; they must not drift.
test('the journey tab carries the panel theme colors', () => {
  const tokens = (css: string, selector: string) => {
    const start = css.indexOf(`${selector} {`);
    expect(start).toBeGreaterThanOrEqual(0);
    const body = css.slice(start, css.indexOf('}', start));
    return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
  };
  const panel = readFileSync('src/panel.css', 'utf8');
  const journey = readFileSync('src/journey.css', 'utf8');
  for (const [app, page] of [['.app', '.journey-page'], ['.app[data-theme="dark"]', '.journey-page[data-theme="dark"]']]) {
    const carried = tokens(journey, page);
    const source = tokens(panel, app);
    expect(Object.keys(carried).length).toBeGreaterThan(5);
    for (const [name, value] of Object.entries(carried)) expect([name, value]).toEqual([name, source[name]]);
  }
});

// Opens the journey tab with a stored theme that is read only when released,
// recording the theme the page shows when its content first appears.
async function openJourneyTabHeld(page: Page, stored: unknown, reload = false) {
  if (!reload) await page.goto('http://127.0.0.1:4173');
  else await page.reload();
  await page.setContent('<!doctype html><html><body class="journey-page"><main id="journey"></main></body></html>');
  await page.evaluate(`location.hash = '#launch=${'a'.repeat(16)}'`);
  await page.evaluate(`window.chrome = {
    runtime: {
      sendMessage: async message => message && message.type === 'ANMERKO_JOURNEY_STATE'
        ? { ok: true, value: { phase: 'idle', epoch: 0 } }
        : message && message.type === 'ANMERKO_JOURNEY_LIST' ? { ok: true, value: [] } : { ok: false },
      onMessage: { addListener: () => {}, removeListener: () => {} },
    },
  };`);
  await page.evaluate(addJourneyApis);
  await page.evaluate(value => {
    const api = (window as any).chrome;
    let release: (stored: object) => void = () => {};
    const read = new Promise<object>(resolve => { release = resolve; });
    api.storage.local = { get: () => read };
    api.storage.onChanged = { addListener: () => {}, removeListener: () => {} };
    (window as any).releaseTheme = () => release(value === undefined ? {} : { 'anmerko:theme': value });
    (window as any).firstContentTheme = null;
    new MutationObserver(() => {
      if ((window as any).firstContentTheme === null && document.querySelector('.journey-view')) {
        (window as any).firstContentTheme = [document.body.dataset.theme, document.documentElement.style.colorScheme];
      }
    }).observe(document.body, { childList: true, subtree: true });
  }, stored);
  await page.addScriptTag({ content: journeyPageBundle });
}

test('the journey tab resolves a stored Dark appearance before its content first paints, with no light flash', async ({ page }) => {
  await openJourneyTabHeld(page, 'dark');
  // Until the stored theme is read, no content is shown in the wrong theme.
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
  expect(await page.evaluate(() => (window as any).firstContentTheme)).toBeNull();
  await page.evaluate(() => (window as any).releaseTheme());
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).firstContentTheme)).toEqual(['dark', 'dark']);
  // The root element carries the scheme, so the canvas and scrollbars match.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');

  // The next tab paints dark at once from the theme this one resolved.
  await openJourneyTabHeld(page, 'dark', true);
  expect(await page.evaluate(() => [document.body.dataset.theme, getComputedStyle(document.documentElement).colorScheme]))
    .toEqual(['dark', 'dark']);
  await page.evaluate(() => (window as any).releaseTheme());
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  expect(await page.evaluate(() => (window as any).firstContentTheme)).toEqual(['dark', 'dark']);
});

test('the journey tab still opens when the stored appearance never arrives', async ({ page }) => {
  await openJourneyTabHeld(page, 'dark');
  await expect(page.getByRole('heading', { name: 'Record a journey' })).toBeVisible();
  await expect(page.locator('body')).toHaveAttribute('data-theme', 'light');
});
