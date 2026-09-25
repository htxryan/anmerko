import { copyPrompt } from '../shared/clipboard';
import { test, expect } from '@playwright/test';
const panel = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'anmerko feedback panel' });

test('the demo shows the three comment actions and no journey launch without the extension', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try the Demo' }).click();
  const actions = panel(page).getByRole('group', { name: 'Comment Actions' });
  await expect(actions.getByRole('button')).toHaveCount(3);
  for (const name of ['Select Element', 'Take Screenshot', 'New Global Comment']) await expect(actions.getByRole('button', { name, exact: true })).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'More Comment Options' })).toHaveCount(0);
  await expect(panel(page).locator('#comment-menu')).toHaveCount(0);
  await expect(panel(page).getByRole('menuitem', { name: 'Record journey' })).toHaveCount(0);
});

test('the demo compiles the shared panel without shipping the journey UI it cannot reach', async ({ page }) => {
  const scripts = new Map<string, Promise<string>>();
  page.on('response', response => {
    // The body is read now but awaited later, so a body that can no longer be
    // read (a redirect, or one the page dropped) must not reject unobserved.
    if (response.request().resourceType() === 'script') {
      scripts.set(new URL(response.url()).pathname, response.text().catch(() => ''));
    }
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try the Demo' }).click();
  await expect(panel(page).getByRole('button', { name: 'Select Element' })).toBeVisible();
  const runtime = [...scripts.keys()].filter(path => /^\/_astro\/demo-runtime\.[^/]+\.js$/.test(path));
  expect(runtime).toHaveLength(1);
  expect((await scripts.get(runtime[0]))!.includes('Select Element'), 'the demo compiles the shared panel').toBe(true);
  for (const [path, body] of scripts) {
    const text = await body;
    for (const journeyUi of ['Record journey', 'Saved journeys', 'Discard journey', 'journeys.md', '__TARGET_JOURNEYS__']) {
      expect(text.includes(journeyUi), `${path} ships ${journeyUi}`).toBe(false);
    }
  }
});

test('the built demo exposes the current shared settings and comment actions', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'Try the Demo' }).click();
  await expect(panel(page).getByRole('button', { name: 'Feedback settings', exact: true })).toBeVisible();
  await page.clock.fastForward(10_000);
  await panel(page).getByRole('button', { name: 'Feedback settings', exact: true }).click();
  const componentCapture = panel(page).getByRole('switch', { name: 'Capture component context' });
  await expect(componentCapture).toBeDisabled();
  await expect(componentCapture).not.toBeChecked();
  await expect(panel(page).locator('.component-context-status')).toHaveText('Requires the extension.');
  const support = panel(page).getByRole('link', { name: 'Buy me a coffee (opens in new tab)' });
  await expect(support).toBeVisible();
  await expect(support).toHaveAttribute('href', 'https://buymeacoffee.com/htxryan');
  await expect(support.locator('svg')).toHaveCSS('filter', 'grayscale(1)');
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(support).toBeInViewport();
    await expect(panel(page).getByLabel('Prompt Preamble', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  await panel(page).getByRole('button', { name: 'Feedback settings', exact: true }).click();
  await expect(support).toBeHidden();
  await panel(page).getByRole('button', { name: 'New Global Comment' }).click();
  await panel(page).getByLabel('Comment', { exact: true }).fill('Feedback on the whole page.');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel(page).locator('.note')).toContainText('Feedback on the whole page.');
});

test('lazy demo uses the real comment-to-prompt flow and retains only the current session', async ({ page }) => {
  const requests: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => requests.push(request.url()));
  await page.goto('/');
  expect(requests.some(url => /demo-runtime|panel.*css/.test(url))).toBe(false);
  await expect(page.locator('#demo-help')).toHaveText('Local · clears on reload');
  await expect(page.getByRole('button', { name: 'Reset demo' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Try the Demo' }).click();
  await expect(panel(page)).toBeVisible();
  const capture = panel(page).getByRole('button', { name: 'Take Screenshot' });
  await expect(capture).toBeDisabled();
  await expect(capture).toHaveAttribute('title', 'Screenshots require the extension');
  await panel(page).getByRole('button', { name: 'Select Element' }).click();
  await page.locator('#headline').click();
  await panel(page).getByLabel('Comment', { exact: true }).fill('Make this headline clearer.');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel(page).locator('.note')).toContainText('Make this headline clearer.');
  await panel(page).getByRole('button', { name: 'Locate', exact: false }).click();
  await expect(page.locator('anmerko-overlay .saved-outline.active')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await panel(page).getByLabel('Comment', { exact: true }).fill('Keep the headline concise.');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  const prompt = await copyPrompt(page);
  expect(prompt).toContain('> Keep the headline concise.');
  expect(prompt).toContain('**Selector:** `#headline`');
  expect(prompt).toContain('Turn website feedback into an AI prompt.');
  expect(prompt).toContain(page.url());
  await panel(page).getByRole('button', { name: 'Copy Prompt', exact: true }).click();
  await expect(panel(page).locator('.status')).toContainText(/Copied 1 comment|Could not copy/);
  await panel(page).getByRole('button', { name: 'Close anmerko' }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Try the Demo' })).toBeFocused();
  await page.getByRole('button', { name: 'Try the Demo' }).click();
  await expect(panel(page).locator('.note')).toContainText('Keep the headline concise.');
  await page.reload();
  await page.getByRole('button', { name: 'Try the Demo' }).click();
  await expect(panel(page).locator('.count')).toHaveText('0 comments');
  expect(errors).toEqual([]);
  expect(requests.every(url => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
});

test('rapid activation, saved settings, draft guards and repeated closes keep one session', async ({ page }) => {
  await page.goto('/');
  const launch = page.getByRole('button', { name: 'Try the Demo' });
  await launch.focus(); await page.keyboard.press('Enter');
  await expect(panel(page).getByRole('button', { name: 'Select Element' })).toBeFocused();
  await page.evaluate(() => { for (let i = 0; i < 5; i++) document.querySelector<HTMLButtonElement>('#try-demo')!.click(); });
  await expect(page.locator('anmerko-overlay')).toHaveCount(1);
  await panel(page).getByRole('button', { name: 'Feedback settings', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Dark' }).click();
  await panel(page).getByLabel('Prompt Preamble', { exact: true }).fill('Please improve this page.');
  await panel(page).getByRole('button', { name: 'Close anmerko' }).click();
  await expect(panel(page).locator('.status')).toContainText('Save or restore your preamble');
  await expect(panel(page).getByLabel('Prompt Preamble', { exact: true })).toHaveValue('Please improve this page.');
  await panel(page).getByRole('button', { name: 'Save Preamble', exact: true }).click();
  for (let i = 0; i < 5; i++) {
    await panel(page).getByRole('button', { name: 'Close anmerko' }).click();
    await expect(panel(page)).toHaveCount(0);
    await launch.click();
    await expect(page.locator('anmerko-overlay')).toHaveCount(1);
    await expect(page.locator('anmerko-overlay .app')).toHaveAttribute('data-theme', 'dark');
  }
  await panel(page).getByRole('button', { name: 'Select Element' }).click();
  await page.keyboard.press('Escape');
  await expect(panel(page).getByRole('button', { name: 'Select Element' })).toBeFocused();
  await panel(page).getByRole('button', { name: 'Select Element' }).click();
  await page.locator('#headline').click();
  await panel(page).getByLabel('Comment', { exact: true }).fill('Unsaved comment');
  await panel(page).getByRole('button', { name: 'Close anmerko' }).click();
  await expect(panel(page).getByLabel('Comment', { exact: true })).toHaveValue('Unsaved comment');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  expect(await copyPrompt(page)).toMatch(/Please improve this page/);
  await panel(page).getByRole('button', { name: 'Minimize comments' }).click();
  await launch.click();
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete Comment?', exact: true }).getByRole('button', { name: 'Delete Comment', exact: true }).click();
  await expect(panel(page).locator('.count')).toHaveText('0 comments');
  await page.reload();
  await launch.click();
  await expect(page.locator('anmerko-overlay .app')).toHaveAttribute('data-theme', 'light');
});

test('clipboard denial offers a download', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('Permission denied')) } }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Try the Demo' }).click();
  await panel(page).getByRole('button', { name: 'Select Element' }).click();
  await page.locator('#headline').click();
  await panel(page).getByLabel('Comment', { exact: true }).fill('Manual copy works.');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Copy Prompt', exact: true }).click();
  await expect(panel(page).locator('.status')).toContainText('Could not copy');
  const download = page.waitForEvent('download');
  await panel(page).getByRole('button', { name: 'Download Markdown + Images' }).click();
  expect((await download).suggestedFilename()).toBe('anmerko-comments.zip');
});

for (const asset of ['styles', 'module']) test(`failed lazy ${asset} leaves a usable page and an explicit retry`, async ({ page }) => {
  let fail = true;
  await page.route(asset === 'styles' ? '**/*panel*.css' : '**/demo-runtime*.js', route => {
    if (fail) { fail = false; return route.abort('failed'); }
    return route.fallback();
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try the Demo' }).click();
  await expect(page.locator('#demo-status')).toContainText('could not load');
  await expect(page.locator('anmerko-overlay')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Documentation', exact: true })).toBeVisible();
  if (asset === 'module') await page.getByRole('button', { name: 'Reload to try demo' }).click();
  await page.getByRole('button', { name: 'Try the Demo' }).click();
  await expect(panel(page)).toBeVisible();
});

test.describe('touch demo', () => {
  test.use({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true });
  test('touch selects links without navigation and the editor fits at 390 and 320 pixels', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Try the Demo' }).tap();
    await panel(page).getByRole('button', { name: 'Select Element' }).tap();
    await expect(page.locator('anmerko-overlay .picker-bar')).toBeVisible({ timeout: 3000 });
    await page.getByRole('link', { name: 'Documentation', exact: true }).tap();
    expect(new URL(page.url()).pathname).toBe('/');
    await expect(panel(page).getByLabel('Comment', { exact: true })).toBeVisible({ timeout: 5000 });
    await panel(page).getByLabel('Comment', { exact: true }).fill('Make the docs link clearer.');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 664 });
      await expect(panel(page).getByLabel('Comment', { exact: true })).toBeInViewport();
      await expect(panel(page).getByRole('button', { name: 'Save', exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ path: `artifacts/native-brochure-demo/touch-editor-${width}.png` });
    }
    await panel(page).getByRole('button', { name: 'Save', exact: true }).tap();
    await expect(panel(page).locator('.count')).toHaveText('1 comment');
  });
});

test('a lazy activation completed after pagehide cannot reopen the disposed session', async ({ page }) => {
  let release!: () => void;
  let reached!: () => void;
  const requested = new Promise<void>(resolve => { reached = resolve; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/demo-runtime*.js', async route => { reached(); await delayed; await route.fallback(); });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try the Demo' }).click();
  await requested;
  // Model a cached document's pagehide while its module request is pending.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  release();
  await expect(page.getByRole('button', { name: 'Try the Demo' })).toBeEnabled();
  await expect(page.locator('#demo-status')).toBeEmpty();
  await expect(page.locator('anmerko-overlay')).toHaveCount(0);
  await page.getByRole('button', { name: 'Try the Demo' }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).locator('.count')).toHaveText('0 comments');
});
