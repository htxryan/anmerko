import { test, expect, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';

const bundle = buildSync({ entryPoints: ['tests/chromium/fixtures/runtime-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
const panel = (page: Page) => page.getByRole('complementary', { name: 'anmerko feedback panel' });
const run = (page: Page, code: string) => page.evaluate(code);
const context = { version: 1, framework: 'react', provenance: 'react-dom-fiber-dev', path: ['App', 'Heading'], truncated: false };
const resolve = (page: Page, index = 0) => run(page, `harness.resolveContext(${index}, ${JSON.stringify(context)})`);
async function select(page: Page, selector = '#hero-title') {
  await panel(page).getByRole('button', { name: 'Select Element', exact: true }).click();
  await page.locator(selector).click();
}
test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:4173');
  await page.addScriptTag({ content: bundle });
  await run(page, 'harness.write("anmerko:capture-component-context", true).then(() => harness.open(true))');
});

test('late enrichment preserves the live textarea, focus, selection and typed comment', async ({ page }) => {
  await select(page);
  const field = panel(page).getByLabel('Comment', { exact: true });
  await field.fill('Typing without waiting');
  await field.evaluate(el => { (el as HTMLTextAreaElement).setSelectionRange(3, 8); (window as any).originalField = el; });
  expect(await run(page, 'harness.contextRequests().length')).toBe(1);
  await resolve(page);
  await expect(panel(page).locator('.component-context')).toContainText('App → Heading');
  await expect(field).toHaveValue('Typing without waiting');
  await expect(field).toBeFocused();
  expect(await field.evaluate(el => [el === (window as any).originalField, (el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([true, 3, 8]);
});

for (const action of ['save', 'cancel', 'detach', 'navigate', 'dispose', 'disable'] as const) {
  test(`${action} invalidates a pending lookup without changing saved or newer state`, async ({ page }) => {
    await select(page);
    const field = panel(page).getByLabel('Comment', { exact: true });
    if (action === 'save') {
      await field.fill('Saved before metadata');
      await field.press('Control+Enter');
    } else if (action === 'cancel') await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    else if (action === 'detach') await page.locator('#hero-title').evaluate(el => el.remove());
    else if (action === 'navigate') await page.evaluate(() => history.pushState({}, '', '/new-route'));
    else if (action === 'dispose') await run(page, 'harness.dispose()');
    else await run(page, 'harness.write("anmerko:capture-component-context", false)');
    await resolve(page);
    await expect(panel(page).locator('.component-context')).toHaveCount(0);
    if (action === 'save') expect(await run(page, 'harness.controller().viewState().draft')).toBe(null);
    expect(await run(page, 'harness.contextRequests()[0].aborted')).toBe(true);
  });
}

test('a new parent cancels child metadata and uses its own current target', async ({ page }) => {
  await select(page, '#hero-title em');
  await panel(page).getByLabel('Comment', { exact: true }).fill('Parent feedback');
  await panel(page).getByRole('button', { name: 'Use Parent Element' }).click();
  expect(await run(page, 'harness.contextRequests().map(r => [r.tag, r.aborted])')).toEqual([['em', true], ['h1', false]]);
  await resolve(page, 0);
  await expect(panel(page).locator('.component-context')).toHaveCount(0);
  await resolve(page, 1);
  await expect(panel(page).locator('.component-context')).toContainText('App → Heading');
  await expect(panel(page).getByLabel('Comment', { exact: true })).toHaveValue('Parent feedback');
});

test('removal persists only on Save and editing never starts another lookup', async ({ page }) => {
  await select(page);
  await resolve(page);
  await panel(page).getByLabel('Comment', { exact: true }).fill('A saved hint');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Remove component hint' }).click();
  await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel(page).locator('.note .component-context')).toContainText('App → Heading');
  await panel(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Remove component hint' }).click();
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel(page).locator('.component-context')).toHaveCount(0);
  expect(await run(page, 'harness.contextRequests().length')).toBe(1);
});

test('default-off capture and global comments never request component data', async ({ page }) => {
  await run(page, 'harness.write("anmerko:capture-component-context", false)');
  await select(page);
  await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await run(page, 'harness.write("anmerko:capture-component-context", true)');
  await panel(page).getByRole('button', { name: 'More Comment Options' }).click();
  await panel(page).getByRole('menuitem', { name: 'New Global Comment' }).click();
  expect(await run(page, 'harness.contextRequests().length')).toBe(0);
});
