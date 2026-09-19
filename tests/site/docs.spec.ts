import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

const docsRoot = 'site/src/content/docs/docs';
const files = (await readdir(docsRoot, { recursive: true })).filter(file => /\.mdx?$/.test(file));
const routes = files.map(file => '/docs/' + file.replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '') + (file === 'index.md' ? '' : '/'));

test('landing links to docs and every docs page and internal anchor resolves', async ({ page, request }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Documentation' }).click();
  await expect(page).toHaveURL(/\/docs\/$/);
  const links = new Set<string>();
  for (const route of routes) {
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('meta[name="robots"][content*="noindex"]')).toHaveCount(0);
    expect(response?.headers()['x-robots-tag']).toBeUndefined();
    await expect(page.locator('meta[http-equiv="content-security-policy"]')).toHaveAttribute('content', /script-src/);
    for (const href of await page.locator('a[href]').evaluateAll(elements => elements.map(a => (a as HTMLAnchorElement).href))) {
      if (href.startsWith('http://127.0.0.1:4175/')) links.add(href);
    }
  }
  for (const href of links) {
    const url = new URL(href);
    const response = await request.get(url.pathname);
    expect(response.status(), href).toBe(200);
    if (url.hash) {
      const html = await response.text();
      expect(html, href).toContain(`id="${decodeURIComponent(url.hash.slice(1))}"`);
    }
  }
  for (const slug of ['development', 'firefox-development', 'site-deployment', 'platforms', 'install/android', 'install/brave']) {
    const response = await request.get(`/docs/${slug}/`);
    expect(response.status(), `Unpublished guide ${slug} must stay off the site`).toBe(404);
  }
  for (const path of ['/docs/screenshots-and-export', '/docs/screenshots-and-export/']) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(301);
    expect(response.headers().location).toBe('/docs/send-to-your-agent/');
  }
  expect(errors).toEqual([]);
});

test('generated search scripts are complete JavaScript', async () => {
  const directory = 'site/dist/pagefind';
  const scripts = (await readdir(directory)).filter(file => file.endsWith('.js'));
  expect(scripts.length).toBeGreaterThan(0);
  for (const file of scripts) {
    execFileSync(process.execPath, ['--check', '--input-type=module'], {
      input: await readFile(`${directory}/${file}`), encoding: 'utf8',
    });
  }
});

test('documentation search works with the production content security policy', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/docs/');
  await page.getByRole('button', { name: 'Search', exact: false }).click();
  await page.getByRole('textbox', { name: 'Search', exact: true }).fill('Take Screenshot');
  const result = page.locator('.pagefind-ui__result-link').filter({ hasText: /Screenshot comments/ }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(/\/docs\/usage\/screenshot-comments\//);
  expect(errors).toEqual([]);
});

test('example prompt wraps inside its container without changing the copyable text', async ({ page }) => {
  const source = await readFile(`${docsRoot}/example-prompt.md`, 'utf8');
  const prompt = source.split('```markdown\n')[1].split('```')[0];
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/docs/example-prompt/');
    const block = page.locator('.sl-markdown-content pre');
    await expect(block).toBeVisible();
    expect(await block.locator('code').textContent()).toBe(prompt);
    const size = await block.evaluate(element => ({
      content: element.scrollWidth,
      container: element.clientWidth,
      page: document.documentElement.scrollWidth,
    }));
    expect(size.content, `Prompt overflows its container at ${width}px`).toBeLessThanOrEqual(size.container);
    expect(size.page).toBeLessThanOrEqual(width);
    if (width === 1440 || width === 390) {
      await page.screenshot({ path: `artifacts/anmerko-example-prompt-${width}.png`, fullPage: true });
    }
  }
});

test('docs support mobile navigation and keep content within the viewport', async ({ page }) => {
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ['/docs/', '/docs/install/', '/docs/install/chrome/', '/docs/install/edge/', '/docs/install/firefox/', '/docs/install/edge-android/', '/docs/install/firefox-android/', '/docs/usage/', '/docs/usage/inline-comments/', '/docs/usage/screenshot-comments/', '/docs/usage/global-comments/', '/docs/send-to-your-agent/', '/docs/settings/']) {
      await page.goto(route);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), route).toBeLessThanOrEqual(width);
    }
    await page.goto('/docs/install/chrome/');
    if (width < 800) {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await page.locator('#starlight__sidebar a[href="/docs/usage/"]').click();
      await expect(page.locator('h1')).toHaveText('Add comments');
      await page.goto('/docs/install/chrome/');
    }
    await page.screenshot({ path: `artifacts/anmerko-docs-${width}.png`, fullPage: true });
  }
});

test('store guides identify each browser bundle and retain approved manual alternatives', async ({ page }) => {
  const approved = JSON.parse(await readFile('releases/approved.json', 'utf8')).browsers;
  for (const [browser, installation, artifactBrowser] of [
    ['chrome', 'chrome://extensions', 'chrome'],
    ['edge', 'edge://extensions', 'chrome'],
    ['firefox', 'about:addons', 'firefox'],
  ]) {
    await page.goto(`/docs/install/${browser}/`);
    const content = page.locator('.sl-markdown-content');
    await expect(content).toContainText(installation);
    const download = content.locator(`a[href="/downloads/${approved[artifactBrowser].artifact.filename}"]`);
    await expect(download).toBeVisible();
    await expect(download).toContainText(`Download for ${browser[0].toUpperCase() + browser.slice(1)} (${approved[artifactBrowser].version})`);
  }
  await page.goto('/docs/install/firefox-android/');
  await expect(page.locator('.sl-markdown-content')).toContainText('Android 10 or later');
  await expect(page.locator('.sl-markdown-content')).toContainText('Install extension from file');
  await page.goto('/docs/install/');
  await expect(page.getByRole('heading', { name: 'Installation', exact: true })).toBeVisible();
  const content = page.locator('.sl-markdown-content');
  for (const [group, links] of [
    ['Desktop', [['Chrome', '/docs/install/chrome/'], ['Edge', '/docs/install/edge/'], ['Firefox', '/docs/install/firefox/']]],
    ['Android', [['Edge', '/docs/install/edge-android/'], ['Firefox', '/docs/install/firefox-android/']]],
  ] as const) {
    const section = content.getByRole('heading', { name: group, exact: true }).locator('xpath=../following-sibling::ul[1]');
    for (const [label, href] of links) await expect(section.getByRole('link', { name: label, exact: true })).toHaveAttribute('href', href);
  }
  const sidebar = page.locator('#starlight__sidebar');
  const installation = sidebar.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Installation$/ }) }).first();
  const desktop = installation.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Desktop$/ }) }).first();
  const android = installation.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Android$/ }) }).first();
  await expect(desktop.getByRole('link', { name: 'Chrome', exact: true })).toHaveAttribute('href', '/docs/install/chrome/');
  await expect(desktop.getByRole('link', { name: 'Edge', exact: true })).toHaveAttribute('href', '/docs/install/edge/');
  await expect(desktop.getByRole('link', { name: 'Firefox', exact: true })).toHaveAttribute('href', '/docs/install/firefox/');
  await expect(android.getByRole('link', { name: 'Edge', exact: true })).toHaveAttribute('href', '/docs/install/edge-android/');
  await expect(android.getByRole('link', { name: 'Firefox', exact: true })).toHaveAttribute('href', '/docs/install/firefox-android/');
  await expect(page.locator('a[href*="install/brave"]')).toHaveCount(0);
});

test('public approved download bytes remain intact', async ({ request }) => {
  const browsers = JSON.parse(await readFile('releases/approved.json', 'utf8')).browsers;
  for (const browser of Object.values(browsers) as { artifact: { filename: string; sha256: string } }[]) {
    const response = await request.get(`/downloads/${browser.artifact.filename}`);
    expect(response.status()).toBe(200);
    expect(createHash('sha256').update(await response.body()).digest('hex')).toBe(browser.artifact.sha256);
  }
});

 test('active Edge store retains an exact approved desktop manual alternative', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Edge', exact: true }).click();
  await expect(page.getByRole('tabpanel').getByRole('link', { name: 'Microsoft Edge Add-ons', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Download manually', exact: true }).click();
  await page.locator('.sl-markdown-content').getByRole('heading', { name: 'Desktop', exact: true })
    .locator('xpath=../following-sibling::ul[1]').getByRole('link', { name: 'Edge', exact: true }).click();
  const channels = JSON.parse(await readFile('releases/approved.json', 'utf8')).browsers;
  const approved = channels.chrome.artifact;
  expect(approved.sha256).toBe(channels.edge.artifact.sha256);
  const download = page.locator('.sl-markdown-content').getByRole('link', { name: /Download for Edge/ });
  await expect(download).toHaveAttribute('href', `/downloads/${approved.filename}`);
  const response = await request.get(await download.getAttribute('href') as string);
  expect(createHash('sha256').update(await response.body()).digest('hex')).toBe(approved.sha256);
  await expect(page.getByRole('heading', { name: 'Install manually', exact: true })).toBeVisible();
});
