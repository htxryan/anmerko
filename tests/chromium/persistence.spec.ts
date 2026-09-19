import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sidebar } from '../shared/chromium-sidebar';

test('saved element, screenshot and global comments survive changing refresh URLs and a full browser restart', async () => {
  test.setTimeout(60000);
  const profile = await mkdtemp(path.join(tmpdir(), 'anmerko-persistence-'));
  const extension = path.resolve('dist');
  const html = await readFile('tests/fixtures/demo/index.html', 'utf8');
  let context: BrowserContext | undefined;
  let reloadToken = 100;
  async function launch() {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: !process.env.HEADED, viewport: null,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--enable-unsafe-extension-debugging', '--window-size=1440,1000'],
    });
    // A local fixture reproduces Google's changing reload token without using
    // the network or changing the production manifest / its activeTab grants.
    await context.route('https://www.google.com/**', route => route.fulfill({
      contentType: 'text/html', body: `<script>history.replaceState(null, '', '/?zx=${++reloadToken}')</script>${html}`,
    }));
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const id = new URL(worker.url()).host;
    const cdp = await context.browser()!.newBrowserCDPSession();
    const page = await context.newPage();
    await page.goto('https://www.google.com/');
    const activate = async () => {
      await page.bringToFront();
      const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
      const target = targetInfos.find(target => target.url === page.url() && target.embedderData?.tabActive)!;
      await cdp.send('Extensions.triggerAction', { id, targetId: target.targetId });
      return sidebar(context!, page);
    };
    return { page, activate, worker };
  }
  const panel = (page: Page) => page.getByRole('complementary', { name: 'anmerko feedback panel' });
  const comments = (page: Page) => panel(page).locator('.note .comment');
  try {
    let session = await launch();
    let dock = await session.activate();
    await dock.click('.dock');
    const page = session.page;
    await panel(page).getByRole('button', { name: 'Select Element', exact: true }).click();
    await page.locator('#hero-title').click();
    await page.keyboard.type('Keep this element comment tomorrow.');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(comments(page)).toHaveCount(1);
    // Wait for Chrome's sidebar-width animation before capturing the viewport.
    let width = 0;
    await expect.poll(async () => { const next = await page.evaluate(() => innerWidth); const stable = next === width; width = next; return stable; }).toBe(true);
    await panel(page).getByRole('button', { name: 'More Comment Options' }).click();
    await panel(page).getByRole('menuitem', { name: 'Take Screenshot', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Select screenshot region' })).toBeVisible();
    await page.mouse.move(110, 110); await page.mouse.down(); await page.mouse.move(290, 210); await page.mouse.up();
    await page.getByRole('button', { name: 'Use Screenshot', exact: true }).click();
    await page.keyboard.type('Keep this screenshot tomorrow.');
    await panel(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(comments(page)).toHaveCount(2);
    const stored = await session.worker.evaluate(() => chrome.storage.local.get(null));
    const savedUrl = page.url();

    // Refresh an open native sidebar, with no extra toolbar activation.
    await panel(page).getByRole('button', { name: 'Dock sidebar', exact: true }).click();
    dock = await sidebar(context!, page);
    await dock.click('.comment-options');
    await dock.click('.global-comment');
    await expect.poll(() => dock.evaluate("return root.activeElement?.id")).toBe('comment');
    await dock.command('Input.insertText', { text: 'Keep this overall page comment tomorrow.' });
    await dock.click('.save');
    await expect.poll(() => dock.evaluate("return root.querySelectorAll('.note').length")).toBe(3);
    await expect(panel(page)).toBeHidden();
    const storedWithGlobal = await session.worker.evaluate(() => chrome.storage.local.get(null));
    const global = Object.values(storedWithGlobal).find((value: any) => value.kind === 'page') as any;
    expect(global).toMatchObject({ pageUrl: savedUrl, pageTitle: await page.title(), comment: 'Keep this overall page comment tomorrow.' });
    expect(global.element).toBeUndefined();
    expect(global.screenshot).toBeUndefined();
    expect(Object.keys(storedWithGlobal).length).toBe(Object.keys(stored).length + 1);
    await page.reload();
    expect(page.url()).not.toBe(savedUrl);
    await expect(page.locator('.pin')).toHaveCount(2);
    await expect.poll(() => dock.evaluate("return [...root.querySelectorAll('.note .comment')].map(field => field.value)")).toEqual([
      'Keep this element comment tomorrow.', 'Keep this screenshot tomorrow.', 'Keep this overall page comment tomorrow.',
    ]);
    await dock.click('.note:nth-child(2) .locate');
    await expect(page.locator('.pin.active')).toHaveText('2');

    // Shut down the whole browser process and reopen the exact same profile.
    await context!.close(); context = undefined;
    session = await launch();
    expect(await session.worker.evaluate(() => chrome.storage.local.get(null))).toEqual(storedWithGlobal);
    dock = await session.activate();
    await expect.poll(() => dock.evaluate("return [...root.querySelectorAll('.note .comment')].map(field => field.value)")).toEqual([
      'Keep this element comment tomorrow.', 'Keep this screenshot tomorrow.', 'Keep this overall page comment tomorrow.',
    ]);
    await dock.click('.note:first-child .locate');
    await expect(session.page.locator('.pin.active')).toHaveText('1');
    await expect.poll(() => dock.evaluate("return !!root.querySelector('.screenshot-preview')")).toBe(true);
    // Only an explicit deletion removes a record; another restart keeps that decision.
    await dock.click('.note:first-child .delete');
    await dock.click('.delete-dialog [value=delete]');
    await expect.poll(() => dock.evaluate("return root.querySelectorAll('.note').length")).toBe(2);
    await context!.close(); context = undefined;
    session = await launch();
    dock = await session.activate();
    await expect.poll(() => dock.evaluate("return [...root.querySelectorAll('.note .comment')].map(field => field.value)")).toEqual(['Keep this screenshot tomorrow.', 'Keep this overall page comment tomorrow.']);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
});
