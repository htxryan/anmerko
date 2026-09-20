import { test, expect, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';

const bundle = buildSync({ entryPoints: ['tests/chromium/fixtures/runtime-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
const nativeBundle = buildSync({ entryPoints: ['tests/chromium/fixtures/native-sidebar-harness.ts'], bundle: true, write: false, format: 'iife', loader: { '.css': 'text' } }).outputFiles[0].text;
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

test('removing a target inside open shadow DOM aborts its lookup immediately', async ({ page }) => {
  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'context-shadow-host';
    const root = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    button.textContent = 'Shadow target';
    root.append(button);
    document.body.append(host);
  });
  await select(page, '#context-shadow-host button');
  await page.locator('#context-shadow-host button').evaluate(element => element.remove());
  await expect.poll(() => run(page, 'harness.contextRequests()[0].aborted')).toBe(true);
});

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

test('the page parent service captures the actual parent and starts only its enrichment', async ({ page }) => {
  await select(page, '#hero-title em');
  await run(page, `(() => {
    const state = structuredClone(harness.controller().viewState());
    delete state.draft.element.componentContext;
    state.targetToken = 'remote-parent-target';
    state.revision += 1;
    harness.controller().applyState(state);
    globalThis.parentResult = harness.controller().locate(state.draft, true, {
      viewToken: state.viewToken, draftId: state.draft.id, draftToken: state.draftToken, targetToken: state.targetToken, revision: state.revision
    });
  })()`);
  expect(await run(page, 'parentResult.tag')).toBe('h1');
  expect(await run(page, 'harness.contextRequests().map(r => [r.tag, r.aborted])')).toEqual([['em', true], ['h1', false]]);
  await run(page, `(() => {
    const state = structuredClone(harness.controller().viewState());
    state.draft.comment = 'Typing during parent enrichment';
    state.revision += 1;
    harness.controller().applyState(state);
  })()`);
  expect(await run(page, 'harness.contextRequests()[1].aborted')).toBe(false);
  await resolve(page, 1);
  expect(await run(page, 'harness.controller().viewState().draft.element')).toEqual(expect.objectContaining({
    tag: 'h1', componentContext: context,
  }));
});

test('removal persists only on Save and editing never starts another lookup', async ({ page }) => {
  await select(page);
  await resolve(page);
  await panel(page).getByLabel('Comment', { exact: true }).fill('A saved hint');
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Remove component hint' }).click();
  await expect(panel(page).getByLabel('Comment', { exact: true })).toBeFocused();
  await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel(page).locator('.note .component-context')).toContainText('App → Heading');
  await panel(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Remove component hint' }).click();
  await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel(page).locator('.component-context')).toHaveCount(0);
  expect(await run(page, 'harness.contextRequests().length')).toBe(1);
});

test('metadata-only state preserves the textarea node, caret and newer comment', async ({ page }) => {
  await select(page);
  const field = panel(page).getByLabel('Comment', { exact: true });
  await field.fill('Newer sidebar text');
  await field.evaluate(el => { (el as HTMLTextAreaElement).setSelectionRange(2, 7); (window as any).metadataField = el; });
  await run(page, `(() => {
    const state = structuredClone(harness.controller().viewState());
    state.draft.comment = 'Stale page text';
    state.componentContextUpdate = {
      viewToken: state.viewToken, draftId: state.draft.id, draftToken: state.draftToken, targetToken: state.targetToken,
      value: ${JSON.stringify(context)}
    };
    harness.controller().applyState(state);
  })()`);
  await expect(panel(page).locator('.component-context')).toContainText('App → Heading');
  await expect(field).toHaveValue('Newer sidebar text');
  await expect(field).toBeFocused();
  expect(await field.evaluate(el => [el === (window as any).metadataField, (el as HTMLTextAreaElement).selectionStart, (el as HTMLTextAreaElement).selectionEnd])).toEqual([true, 2, 7]);
});

test('an older full state cannot restore a removed hint or overwrite newer typing', async ({ page }) => {
  await select(page);
  await resolve(page);
  const oldState = await run(page, 'structuredClone(harness.controller().viewState())');
  const field = panel(page).getByLabel('Comment', { exact: true });
  await field.fill('Keep the latest text');
  await panel(page).getByRole('button', { name: 'Remove component hint' }).click();
  await run(page, `harness.controller().applyState(${JSON.stringify(oldState)})`);
  await expect(field).toHaveValue('Keep the latest text');
  await expect(panel(page).locator('.component-context')).toHaveCount(0);
});

test('native parent clears the child hint immediately and preserves typing when the parent arrives', async ({ page }) => {
  await openNativeDraft(page);
  const field = panel(page).getByLabel('Comment', { exact: true });
  await panel(page).getByRole('button', { name: 'Use Parent Element' }).click();
  await expect(panel(page).locator('.component-context')).toHaveCount(0);
  await field.fill('Typed while finding the parent');
  await run(page, 'nativeParent.resolve()');
  await expect(field).toHaveValue('Typed while finding the parent');
  await expect(panel(page).locator('.selector')).toContainText('section');
});

test('native parent reply cannot overwrite a replacement draft or disconnected page', async ({ page }) => {
  await openNativeDraft(page);
  await panel(page).getByRole('button', { name: 'Use Parent Element' }).click();
  const current = await run(page, 'structuredClone(nativeHarness.snapshot())') as any;
  await run(page, `nativeHarness.reply({ ...${JSON.stringify(current)}, url: location.origin + '/other',
    viewToken: 'replacement-view', draftToken: 'replacement-draft', targetToken: 'replacement-target', revision: 0, draft: {
    ...${JSON.stringify(current.draft)}, id: 'replacement', comment: 'Replacement draft'
  } })`);
  await run(page, 'nativeParent.resolve()');
  await expect(panel(page).getByLabel('Comment', { exact: true })).toHaveValue('Replacement draft');
  await expect(panel(page).locator('.selector')).toContainText('h1');
  await expect(panel(page).locator('.tag')).toHaveText('Heading');
});

test('Edit in Sidebar rejects an older page handoff and keeps the active caret', async ({ page }) => {
  await openNativeDraft(page);
  const snapshot = await run(page, 'structuredClone(nativeHarness.snapshot())') as any;
  const remote = { ...snapshot, viewToken: 'page-view', draftToken: 'draft-token', targetToken: 'target-token', revision: 0, composeOnPage: true };
  await run(page, `nativeHarness.reply(${JSON.stringify(remote)})`);
  await panel(page).getByRole('button', { name: 'Edit in Sidebar' }).click();
  const field = panel(page).getByLabel('Comment', { exact: true });
  await field.fill('Keep editing here');
  await field.evaluate(element => {
    (element as HTMLTextAreaElement).setSelectionRange(5, 12);
    (window as any).sidebarField = element;
  });
  await run(page, `nativeHarness.reply(${JSON.stringify(remote)})`);
  await expect(field).toHaveValue('Keep editing here');
  await expect(field).toBeFocused();
  expect(await field.evaluate(element => [element === (window as any).sidebarField,
    (element as HTMLTextAreaElement).selectionStart, (element as HTMLTextAreaElement).selectionEnd])).toEqual([true, 5, 12]);
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

async function openNativeDraft(page: Page) {
  await page.goto('http://127.0.0.1:4173/sidebar.html');
  await page.addScriptTag({ content: nativeBundle });
  await expect.poll(() => run(page, 'nativeHarness.requests.length')).toBe(1);
  await run(page, `(() => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    let finish;
    chrome.tabs.sendMessage = (tabId, message) => message.type === 'ANMERKO_PARENT'
      ? new Promise(resolve => { finish = () => resolve({
          selectorPath: ['main > section'], hierarchy: ['html', 'body', 'main', 'section'], tag: 'section',
          text: 'Parent', label: 'Parent section', viewport: { width: 1280, height: 720 }
        }); })
      : original(tabId, message);
    globalThis.nativeParent = { resolve() { finish(); } };
    nativeHarness.reply({
      draft: {
        id: 'draft-1', pageUrl: location.origin + '/page', pageTitle: 'Review page', comment: 'Original comment',
        createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z',
        element: {
          selectorPath: ['main > section > h1'], hierarchy: ['html', 'body', 'main', 'section', 'h1'], tag: 'h1',
          text: 'Child', label: 'Child heading', viewport: { width: 1280, height: 720 },
          componentContext: ${JSON.stringify(context)}
        }
      }
    });
  })()`);
  await expect(panel(page).getByLabel('Comment', { exact: true })).toBeVisible();
}
