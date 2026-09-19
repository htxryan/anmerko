// Run after npm run build. Uses the production manifest and real activeTab capture.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { resolveBrowser } from '../../scripts/browsers/test-desktop.mjs';
import { createDesktopSession } from '../../tests/shared/desktop-session.mjs';
import { sidebar } from '../../tests/shared/chromium-sidebar.ts';
import { copyPrompt } from '../../tests/shared/clipboard.ts';

process.chdir(fileURLToPath(new URL('../../', import.meta.url)));
process.env.ANMERKO_DESKTOP_BROWSER = 'chrome';
process.env.ANMERKO_DESKTOP_EXECUTABLE = resolveBrowser('chrome');
const output = resolve('site/public/screenshots');
await mkdir(output, { recursive: true });
const session = await createDesktopSession({ scenario: 'store-screenshots' });
const page = session.page;
const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
const captures = [];
async function capture(name) {
  await page.mouse.move(8, 8);
  await page.screenshot({ path: resolve(output, name), scale: 'css', animations: 'disabled' });
  const bytes = await readFile(resolve(output, name));
  expect(bytes.readUInt32BE(16)).toBe(1280);
  expect(bytes.readUInt32BE(20)).toBe(800);
  captures.push({ file: name, sha256: createHash('sha256').update(bytes).digest('hex') });
  console.log(`Captured ${name}`);
}
async function comment(target, text) {
  await panel.getByRole('button', { name: 'Select Element', exact: true }).click();
  await target.click();
  await panel.getByLabel('Comment', { exact: true }).fill(text);
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
}
try {
  await page.goto('https://saladrecipefinder.com/');
  await expect(page.getByRole('heading', { name: 'Find a salad.', exact: true })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await session.activate();
  const dock = await sidebar(session.context, page);
  await dock.click('.dock');
  await expect(panel).toBeVisible();
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(session.evidence.viewport.width);
  // Resize the native window: viewport emulation changes captureVisibleTab's
  // pixel mapping and would crop the wrong part of the real browser surface.
  const cdp = await session.context.newCDPSession(page);
  const { windowId } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setContentsSize', { windowId, width: 1280, height: 800 });
  await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual({ width: 1280, height: 800 });
  await comment(page.getByRole('heading', { name: 'Find a salad.', exact: true }), 'Make the headline more specific: “Find your next favorite salad.”');
  await comment(page.getByText('Ingredients & diets', { exact: true }), 'Make the ingredient filters easier to discover. Show a few popular diets before expanding.');
  await expect(panel.locator('.note')).toHaveCount(2);
  await capture('01-element-feedback.png');
  const example = await copyPrompt(page);
  await writeFile(resolve('site/src/content/docs/docs/example-prompt.md'),
    '---\ntitle: Example prompt\ndescription: Real anmerko feedback exported from Salad Recipe Finder.\n---\n\n'
    + 'These two element comments were copied from [Salad Recipe Finder](https://saladrecipefinder.com/). Screenshot exports also reference PNGs; attach those separately.\n\n'
    + '```markdown\n' + example.trimEnd() + '\n```\n');

  await panel.getByRole('button', { name: 'More Comment Options' }).click();
  await panel.getByRole('menuitem', { name: 'Take Screenshot' }).click();
  await expect(page.getByRole('dialog', { name: 'Select screenshot region' })).toBeVisible();
  await page.mouse.move(90, 530); await page.mouse.down();
  await page.mouse.move(446, 668, { steps: 10 }); await page.mouse.up();
  await page.getByRole('button', { name: 'Use Screenshot', exact: true }).click();
  await panel.getByLabel('Comment', { exact: true }).fill('Give recipe cards a little more breathing room and make paid extras easier to scan.');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.locator('.note')).toHaveCount(3);
  await panel.locator('.note').last().scrollIntoViewIfNeeded();
  await capture('02-screenshot-feedback.png');

  await panel.getByRole('button', { name: 'More Comment Options' }).click();
  await panel.getByRole('menuitem', { name: 'New Global Comment' }).click();
  await panel.getByLabel('Comment', { exact: true }).fill('Keep the recipe finder simple: clear filters, readable ingredients, and an obvious way to save favorites.');
  await capture('03-global-comment.png');
  await panel.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(panel.locator('.note')).toHaveCount(4);
  const prompt = await copyPrompt(page);
  expect(prompt).toContain('https://saladrecipefinder.com/');
  expect(prompt).toContain('4 comments across 1 page');
  expect(prompt).toContain('Keep the recipe finder simple');
  expect(prompt).not.toContain('data:image');
  await capture('04-prompt-export.png');
  await writeFile(resolve(session.output, 'salad-feedback.md'), prompt);

  await panel.getByRole('button', { name: 'Extension settings' }).click();
  await panel.getByRole('button', { name: 'Dark', exact: false }).click();
  await expect(panel.getByRole('link', { name: 'Buy me a coffee', exact: false })).toBeVisible();
  await capture('05-settings.png');
  await panel.getByRole('button', { name: 'Back', exact: false }).click();
  const downloading = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Download Markdown + Images', exact: true }).click();
  await (await downloading).saveAs(resolve(session.output, 'salad-feedback.zip'));
  session.evidence.result = 'passed';
  await writeFile(resolve('docs/store/capture.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), source: session.evidence.sourceSha,
    extensionVersion: session.evidence.version, browser: session.evidence.engine.product,
    website: 'https://saladrecipefinder.com/', viewport: { width: 1280, height: 800 },
    method: 'Unpacked production Chrome manifest, activeTab action, shared floating UI, real screenshot capture; no UI substitutions.',
    captures,
  }, null, 2) + '\n');
} finally { await session.close(); }
