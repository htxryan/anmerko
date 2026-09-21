import { test, expect } from '@playwright/test';
import { buildSync } from 'esbuild';
import { mount } from '../../src/content';

const bundle = buildSync({ entryPoints: ['tests/chromium/fixtures/runtime-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
const panel = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'anmerko feedback panel' });
// The failure controls exist only in the fixture, never in a shipped bundle.
const run = (page: import('@playwright/test').Page, expression: string) => page.evaluate(expression);

test('importing the shared application requires neither a document nor an extension API', () => {
  expect(typeof mount).toBe('function');
  expect(typeof globalThis.document).toBe('undefined');
});

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.addScriptTag({ content: bundle });
});

test('mobile panel stays inside nonzero display safe-area insets', async ({ page, context }) => {
  const session = await context.newCDPSession(page);
  await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await session.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 13, right: 39, bottom: 21, left: 47 },
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await run(page, 'harness.open()');
  const bounds = await panel(page).evaluate(element => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(55);
  expect(bounds.right).toBeLessThanOrEqual(797);
  expect(bounds.top).toBeGreaterThanOrEqual(13);
  expect(bounds.bottom).toBeLessThanOrEqual(369);
});

test('global comments open focused, survive reopen, and have no element controls or markers', async ({ page }) => {
  await run(page, 'harness.open()');
  const toggle = panel(page).getByRole('button', { name: 'More Comment Options' });
  await toggle.press('ArrowDown');
  const global = panel(page).getByRole('menuitem', { name: 'New Global Comment' });
  // This runtime cannot capture screenshots; keyboard focus skips that action.
  await expect(panel(page).getByRole('menuitem', { name: 'Take Screenshot' })).toBeDisabled();
  await expect(global).toBeFocused();
  await global.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await global.click();
  const field = panel(page).getByLabel('Comment', { exact: true });
  await expect(field).toBeFocused();
  await expect(panel(page).locator('.editor .note-title')).toHaveText('Global Comment');
  await expect(panel(page).locator('.editor .tag')).toHaveText('Page');
  await expect(panel(page).getByRole('button', { name: 'Locate', exact: true })).toBeHidden();
  await expect(panel(page).getByRole('button', { name: 'Use Parent Element' })).toBeHidden();
  await expect(panel(page).locator('.hierarchy')).toBeHidden();
  await expect(toggle).toBeDisabled();
  await field.fill('Overall, make this page easier to scan.');
  await field.press('Control+Enter');
  await expect(page.locator('.pin')).toHaveCount(0);
  await run(page, 'harness.dispose(); harness.open()');
  await expect(panel(page).getByLabel('Comment 1', { exact: true })).toHaveValue('Overall, make this page easier to scan.');
  await panel(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(field).toBeFocused();
  await field.fill('An unsaved edit');
  await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel(page).getByLabel('Comment 1', { exact: true })).toHaveValue('Overall, make this page easier to scan.');
});

test('delete all remains available while editing and only clears drafts for deleted comments', async ({ page }) => {
  await run(page, 'harness.open()');
  const more = panel(page).getByRole('button', { name: 'More Prompt Options' });
  const remove = panel(page).getByRole('menuitem', { name: 'Delete All Comments' });
  const field = panel(page).getByLabel('Comment', { exact: true });
  const confirmation = page.getByRole('dialog', { name: 'Delete All Comments?' });
  async function newGlobal() {
    await panel(page).getByRole('button', { name: 'More Comment Options' }).click();
    await panel(page).getByRole('menuitem', { name: 'New Global Comment' }).click();
  }
  await newGlobal();
  await field.fill('A saved global comment.');
  await field.press('Control+Enter');
  await panel(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await field.fill('An edit to the saved comment.');
  await expect(more).toBeEnabled();
  await more.click();
  await remove.click();
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(field).toHaveValue('An edit to the saved comment.');
  await more.click();
  await remove.click();
  await confirmation.getByRole('button', { name: 'Delete All Comments', exact: true }).click();
  await expect(panel(page).locator('.note, .editor')).toHaveCount(0);
  await expect(more).toBeDisabled();
  await newGlobal();
  await field.fill('Another saved comment.');
  await field.press('Control+Enter');
  await newGlobal();
  await field.fill('Keep this independent unsaved draft.');
  await more.click();
  await remove.click();
  await confirmation.getByRole('button', { name: 'Delete All Comments', exact: true }).click();
  await expect(panel(page).locator('.note')).toHaveCount(0);
  await expect(field).toHaveValue('Keep this independent unsaved draft.');
  await expect(more).toBeDisabled();
});

test('parent selection exposes its hierarchy before the first resize notification', async ({ page }) => {
  // A slow browser can defer this observer past the user's next click.
  await page.evaluate(() => {
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  });
  await run(page, 'harness.open()');
  await panel(page).getByRole('button', { name: 'Select Element' }).click();
  await page.locator('#hero-title em').click();
  const editor = panel(page).locator('.editor');
  await editor.getByLabel('Comment', { exact: true }).fill('Keep the parent heading.');
  await editor.getByRole('button', { name: 'Use Parent Element' }).click();
  expect(await editor.locator('.selector').textContent()).toBe('html > body > main > section:nth-of-type(1) > h1');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel(page).getByLabel('Comment 1', { exact: true })).toHaveValue('Keep the parent heading.');
});

test('compact comment cards preserve identity and expand ancestry while editing and canceling', async ({ page }) => {
  await run(page, 'harness.open()');
  await panel(page).getByRole('button', { name: 'Select Element' }).click();
  await page.locator('#hero-title').click({ position: { x: 10, y: 10 } });
  const editor = panel(page).locator('.editor');
  const input = editor.getByLabel('Comment', { exact: true });
  await expect(input).toBeFocused();
  await expect(editor.locator('.note-title')).toHaveText('Make room for your best work.');
  await expect(editor.locator('.tag')).toHaveText('Heading');
  await expect(editor.locator('.selector')).toHaveAttribute('title', 'html > body > main > section:nth-of-type(1) > h1');
  await input.fill('Keep the whole headline.');
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  const note = panel(page).locator('.note');
  await expect(note.getByLabel('Comment 1', { exact: true })).toHaveValue('Keep the whole headline.');
  await expect(note.locator('textarea')).toHaveJSProperty('readOnly', true);
  await expect(note.locator('.note-actions')).toHaveText('');
  await page.locator('#hero-title').hover();
  await expect(note.locator('.note-actions')).toHaveCSS('opacity', '0');
  const titleWidth = await note.locator('.note-title').evaluate(el => {
    const title = el.getBoundingClientRect();
    const header = el.closest('.note-top')!.getBoundingClientRect();
    return { width: title.width, rightGap: header.right - title.right };
  });
  expect(titleWidth.rightGap).toBeLessThan(15);
  await note.locator('textarea').hover();
  await expect(note.locator('.note-actions')).toHaveCSS('opacity', '1');
  expect(await note.locator('.note-title').evaluate(el => el.getBoundingClientRect().width)).toBe(titleWidth.width);
  await page.locator('#hero-title').hover();
  await note.getByRole('button', { name: 'Locate', exact: true }).focus();
  await expect(note.locator('.note-actions')).toHaveCSS('opacity', '1');
  await expect(note.locator('.selector')).toHaveText(/^\.\.\. .*h1$/);
  await note.getByRole('button', { name: 'Show Full Element Hierarchy' }).click();
  await expect(note.locator('.selector')).toHaveText('html > body > main > section:nth-of-type(1) > h1');
  expect(await note.locator('.selector').evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(24);
  await note.getByRole('button', { name: 'Collapse Element Hierarchy' }).click();
  await note.getByRole('button', { name: 'Locate', exact: true }).click();
  await expect(page.locator('.saved-outline.active')).toBeVisible();
  await note.getByRole('button', { name: 'Edit', exact: true }).click();
  await expect(editor.locator('.number')).toHaveText('1');
  await expect(editor.locator('.editing-badge')).toHaveText('Editing');
  const footer = await editor.locator('.editor-actions').evaluate(el => {
    const hint = el.querySelector('.shortcut')!.getBoundingClientRect();
    const save = el.querySelector('.save')!.getBoundingClientRect();
    return { oneLine: hint.height < 20, centered: Math.abs(hint.y + hint.height / 2 - save.y - save.height / 2) < 1, fits: el.scrollWidth <= el.clientWidth };
  });
  expect(footer).toEqual({ oneLine: true, centered: true, fits: true });
  await input.fill('Discard this edit.');
  await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(note.locator('textarea')).toHaveValue('Keep the whole headline.');
  await note.getByRole('button', { name: 'Edit', exact: true }).click();
  await input.fill('Save this edit.');
  await input.press('Control+Enter');
  await expect(note.locator('textarea')).toHaveValue('Save this edit.');
});

test('failed reads and writes remain visible, preserve drafts, and recover through the same UI', async ({ page }) => {
  await run(page, 'harness.failures(true, false); harness.open()');
  await expect(panel(page).locator('.status')).toContainText('Could not');
  await panel(page).getByRole('button', { name: 'Select Element' }).click();
  await page.locator('#hero-title').click();
  await panel(page).getByLabel('Comment', { exact: true }).fill('Keep my draft');
  await run(page, 'harness.failures(false, true)');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel(page).getByLabel('Comment', { exact: true })).toHaveValue('Keep my draft');
  expect(await run(page, 'harness.close()')).toBe(false);
  await run(page, 'harness.failures(false, false)');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel(page).locator('.note')).toContainText('Keep my draft');
  expect(await run(page, 'harness.close(); harness.stats()')).toEqual({ subscribers: 0, disposed: 1 });
});

test('the connection prompt leaves controls accessible and clears on reconnect without dismissing unrelated errors', async ({ page }) => {
  await run(page, 'harness.open(); harness.controller().connectionFailed()');
  const status = panel(page).locator('.status');
  const blocker = panel(page).locator('.connection-prompt');
  await expect(blocker).toContainText('Click anmerko in the browser toolbar');
  await expect(panel(page).locator('.connection-shade')).toBeVisible();
  await expect(blocker).toBeFocused();
  await expect(panel(page).locator('header')).toHaveJSProperty('inert', false);
  await expect(panel(page).locator('footer')).toHaveJSProperty('inert', false);
  await expect(panel(page).getByRole('button', { name: 'Select Element' })).toBeDisabled();
  await panel(page).getByRole('button', { name: 'Feedback settings', exact: true }).click();
  await expect(blocker).toBeHidden();
  await expect(panel(page).locator('.connection-shade')).toBeHidden();
  await expect(panel(page).getByLabel('Prompt Preamble')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Back', exact: true }).click();
  await expect(blocker).toBeVisible();
  await expect(panel(page).locator('.connection-shade')).toBeVisible();
  const reconnect = () => run(page, 'harness.controller().applyState({ ...harness.controller().viewState(), url: location.href })');
  await reconnect();
  await expect(blocker).toBeHidden();
  await expect(panel(page).locator('.connection-shade')).toBeHidden();
  await expect(panel(page).locator('header')).toHaveJSProperty('inert', false);
  await expect(panel(page).locator('footer')).toHaveJSProperty('inert', false);
  await expect(status).toHaveText('');
  await expect(status).not.toHaveClass(/error/);
  await expect(panel(page).getByRole('button', { name: 'Select Element' })).toBeEnabled();

  await run(page, 'harness.controller().connectionFailed(); harness.controller().status("Could not save your comment.", true)');
  await expect(blocker).toBeVisible();
  await reconnect();
  await expect(blocker).toBeHidden();
  await expect(status).toHaveText('Could not save your comment.');
  await reconnect();
  await expect(status).toHaveText('Could not save your comment.');
});

test('editor typing stays inside anmerko while page shortcuts still work outside it', async ({ page }) => {
  // Like GitHub's shortcuts, the site ignores native inputs but sees the
  // extension's shadow host as the target when keyboard events escape it.
  await page.evaluate(() => {
    const search = document.createElement('input');
    search.id = 'site-shortcut-search';
    document.body.prepend(search);
    for (const type of ['keydown', 'keypress', 'keyup']) {
      document.addEventListener(type, event => {
        const key = event as KeyboardEvent;
        if (key.target instanceof HTMLInputElement || key.target instanceof HTMLTextAreaElement) return;
        search.dataset.events = String(Number(search.dataset.events || 0) + 1);
        if (type === 'keydown' && key.key === 'a') {
          key.preventDefault();
          search.focus();
        }
      });
    }
  });
  await run(page, 'harness.open()');
  await panel(page).getByRole('button', { name: 'Select Element' }).click();
  await page.locator('#hero-title').click();
  const comment = panel(page).getByLabel('Comment', { exact: true });
  await expect(comment).toBeFocused();
  await page.keyboard.type('asdf / feedback');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second line');
  await expect(comment).toHaveValue('asdf / feedback\nSecond line');
  await expect(comment).toBeFocused();
  await expect(page.locator('#site-shortcut-search')).toHaveValue('');
  await expect(page.locator('#site-shortcut-search')).not.toHaveAttribute('data-events');
  await comment.press('Control+Enter');
  await expect(panel(page).getByLabel('Comment 1', { exact: true })).toHaveValue('asdf / feedback\nSecond line');
  await panel(page).getByRole('button', { name: 'Feedback settings', exact: true }).click();
  await panel(page).getByLabel('Prompt Preamble').fill('');
  await page.keyboard.type('a preamble');
  await expect(panel(page).getByLabel('Prompt Preamble')).toHaveValue('a preamble');
  await run(page, 'harness.dispose()');
  await page.locator('#hero-title').click();
  await page.keyboard.press('a');
  await expect(page.locator('#site-shortcut-search')).toBeFocused();
});

test('pending saves block close and explicit disposal cannot revive a detached application', async ({ page }) => {
  await run(page, 'harness.open(); harness.delay()');
  await panel(page).getByRole('button', { name: 'Select Element' }).click();
  await page.locator('#hero-title').click();
  await panel(page).getByLabel('Comment', { exact: true }).fill('Delayed save');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  expect(await run(page, 'harness.close()')).toBe(false);
  await expect(panel(page).locator('.status')).toHaveText('Finishing your save…');
  await run(page, 'harness.dispose(); harness.release()');
  await expect(page.locator('anmerko-overlay')).toHaveCount(0);
  expect(await run(page, 'harness.stats()')).toEqual({ subscribers: 0, disposed: 1 });
  await run(page, 'harness.open()');
  await expect(panel(page).locator('.note')).toContainText('Delayed save');
  await expect(page.locator('anmerko-overlay')).toHaveCount(1);
});


test('pending theme saves block close until the preference is committed', async ({ page }) => {
  await run(page, 'harness.open(); harness.delay()');
  await panel(page).getByRole('button', { name: 'Feedback settings', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Dark' }).click();
  expect(await run(page, 'harness.close()')).toBe(false);
  await expect(panel(page).locator('.status')).toHaveText('Finishing your save…');
  await run(page, 'harness.release()');
  await expect(page.locator('anmerko-overlay .app')).toHaveAttribute('data-theme', 'dark');
  expect(await run(page, 'harness.close()')).toBe(true);
});

test('failed deletion-preference writes keep confirmation on and a retry persists the choice', async ({ page }) => {
  await run(page, 'harness.open()');
  await panel(page).getByRole('button', { name: 'Feedback settings', exact: true }).click();
  const preference = panel(page).getByRole('switch', { name: 'Show individual comment deletion confirmation' });
  await expect(preference).toBeChecked();
  await run(page, 'harness.failures(false, true)');
  await preference.click();
  await expect(panel(page).locator('.preferences-status')).toContainText('Could not save');
  await expect(preference).toBeChecked();
  await run(page, 'harness.failures(false, false); harness.delay()');
  await preference.click();
  await expect(preference).toBeDisabled();
  expect(await run(page, 'harness.close()')).toBe(false);
  await run(page, 'harness.release()');
  await expect(preference).not.toBeChecked();
  await run(page, 'harness.dispose(); harness.open()');
  await panel(page).getByRole('button', { name: 'Feedback settings', exact: true }).click();
  await expect(preference).not.toBeChecked();
});

test('saved journeys list once each with spans scope and stay read-only', async ({ page }) => {
  await run(page, `harness.setJourneys([
    { journeyId: 'J1', revision: 2, updatedAt: '2026-09-21T01:00:00.000Z', stepCount: 3, spansPages: true },
    { journeyId: 'J2', revision: 1, updatedAt: '2026-09-21T02:00:00.000Z', stepCount: 1, spansPages: false },
  ]); harness.open()`);
  const section = panel(page).getByRole('region', { name: 'Saved journeys' });
  await expect(section).toBeVisible();
  await expect(section.getByText('Journey J1 · revision 2 · 3 steps', { exact: false })).toBeVisible();
  await expect(section.getByText('Journey J2 · revision 1 · 1 step', { exact: false })).toBeVisible();
  await expect(section.getByText('Spans pages', { exact: true })).toHaveCount(1);
  await expect(section.locator('li')).toHaveCount(2);
  await expect(section.locator('button')).toHaveCount(0);
  await panel(page).getByLabel('Comment scope').selectOption('all');
  await expect(section.locator('li')).toHaveCount(2);
});

test('saved journeys hide when the list is empty or fails without an error wall', async ({ page }) => {
  await run(page, 'harness.open()');
  await expect(panel(page).getByRole('region', { name: 'Saved journeys' })).toHaveCount(0);
  await run(page, 'harness.dispose(); harness.failJourneys(true); harness.open()');
  await expect(panel(page).getByRole('region', { name: 'Saved journeys' })).toHaveCount(0);
  await expect(panel(page).locator('.status')).toHaveText('');
});
