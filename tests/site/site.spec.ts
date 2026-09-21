import { test, expect, devices } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

test('homepage overview video starts on the illustration and is keyboard playable', async ({ page, request }) => {
  const mediaRequests: string[] = [];
  page.on('request', req => {
    if (req.url().split('?')[0].endsWith('/media/anmerko-homepage.mp4')) mediaRequests.push(req.url());
  });
  await page.goto('/');
  const video = page.getByLabel('anmerko demo');

  await expect(video).toHaveAttribute('poster', '/product-illustration.svg');
  await expect(video).toHaveAttribute('preload', 'none');
  await expect(video).toHaveJSProperty('autoplay', false);
  await expect(video).toHaveJSProperty('paused', true);
  await expect(video).toHaveAttribute('playsinline', '');
  await expect(video.locator('track[kind="captions"]')).toHaveAttribute('src', '/media/anmerko-homepage.en.vtt');
  await expect(video.locator('track[kind="captions"]')).toHaveAttribute('srclang', 'en');
  expect(mediaRequests).toEqual([]);

  const [mediaResponse, captionsResponse] = await Promise.all([
    request.get('/media/anmerko-homepage.mp4'),
    request.get('/media/anmerko-homepage.en.vtt'),
  ]);
  expect(mediaResponse.ok()).toBe(true);
  expect(mediaResponse.headers()['content-type']).toContain('video/mp4');
  expect(captionsResponse.ok()).toBe(true);
  expect(captionsResponse.headers()['content-type']).toContain('text/vtt');

  expect(await video.evaluate(element => (element as HTMLVideoElement).canPlayType('video/mp4; codecs="avc1.640028, mp4a.40.2"'))).not.toBe('');
  await video.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).paused)).toBe(false);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime), { timeout: 5_000 }).toBeGreaterThan(0);
  expect(mediaRequests.length).toBeGreaterThan(0);
});

test('footer attribution and support links show new-tab icons and open from the keyboard', async ({ page, context }) => {
  const destination = 'https://buymeacoffee.com/htxryan';
  const requests: string[] = [];
  await context.route(url => url.hostname === 'ryanhenderson.dev' || url.hostname === 'buymeacoffee.com' || url.hostname.endsWith('.buymeacoffee.com'), route => {
    requests.push(route.request().url());
    return route.fulfill({ contentType: 'text/html', body: '<title>Support destination</title>' });
  });
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const footer = page.getByRole('contentinfo');
    const attribution = footer.getByRole('link', { name: 'Ryan Henderson' });
    const support = footer.getByRole('link', { name: 'Buy me a coffee (opens in new tab)' });
    await expect(footer.locator('p')).toHaveText('Made by Ryan Henderson');
    await expect(attribution).toHaveAttribute('href', 'https://ryanhenderson.dev/');
    await expect(attribution).toHaveAttribute('target', '_blank');
    await expect(attribution).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(attribution.locator('svg')).toBeVisible();
    await expect(support.locator('svg').last()).toBeVisible();
    await expect(support).toHaveText('Buy me a coffee');
    await expect(support).toHaveAttribute('href', destination);
    await expect(support).toHaveAttribute('target', '_blank');
    await expect(support).toHaveAttribute('rel', 'noopener noreferrer');
    await attribution.focus();
    await page.keyboard.press('Tab');
    await expect(support).toBeFocused();
    await expect(support).toHaveCSS('outline-style', 'solid');
    await expect(support).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  }
  expect(requests).toEqual([]);
  const opened = context.waitForEvent('page');
  await page.keyboard.press('Enter');
  const supportTab = await opened;
  await expect(supportTab).toHaveURL(destination);
  expect(await supportTab.evaluate(() => window.opener)).toBeNull();
  await expect(page).toHaveURL('http://127.0.0.1:4175/');
  await supportTab.close();
  await page.getByRole('contentinfo').getByRole('link', { name: 'Ryan Henderson (opens in new tab)', exact: true }).focus();
  const authorOpened = context.waitForEvent('page');
  await page.keyboard.press('Enter');
  const authorTab = await authorOpened;
  await expect(authorTab).toHaveURL('https://ryanhenderson.dev/');
  expect(await authorTab.evaluate(() => window.opener)).toBeNull();
  await expect(page).toHaveURL('http://127.0.0.1:4175/');
  await authorTab.close();
});

test('the header theme toggle remembers the choice across reloads and documentation', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Switch to dark theme' }).press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(17, 23, 34)');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto('/docs/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.goto('/');
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.getByRole('button', { name: 'Switch to light theme' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.getByRole('button', { name: 'Switch to light theme' }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('desktop keeps installation above the fold, shows three feature columns, and the manual link opens installation docs in the same tab', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await mkdir('artifacts', { recursive: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1366, height: 650 }, { width: 1024, height: 600 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page).toHaveTitle('anmerko — Website feedback for AI');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://anmerko.com/');
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute('content', 'https://anmerko.com/');
    await expect(page.getByRole('heading', { level: 1 })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('region', { name: 'Install the Browser Extension' })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('tablist', { name: 'Choose your desktop browser' })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    const features = page.getByRole('region', { name: 'Why anmerko' });
    await expect(features.getByRole('article', { name: 'Private', exact: true })).toContainText('Comments stay local until you choose to copy or export them.');
    const boxes = [];
    for (const name of ['Easy', 'Universal', 'Private']) {
      const heading = features.getByRole('heading', { name, exact: true });
      await expect(heading).toBeVisible();
      boxes.push((await heading.boundingBox())!);
    }
    expect(boxes[0].y).toBe(boxes[1].y);
    expect(boxes[1].y).toBe(boxes[2].y);
    expect(boxes[0].x + boxes[0].width).toBeLessThan(boxes[1].x);
    expect(boxes[1].x + boxes[1].width).toBeLessThan(boxes[2].x);
    await page.screenshot({ path: `artifacts/anmerko-site-${viewport.width}x${viewport.height}.png`, fullPage: true });
    if (viewport.width === 1440) await page.screenshot({ path: 'artifacts/anmerko-site-desktop.png', fullPage: true });
  }
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByRole('link', { name: 'GitHub (opens in new tab)', exact: true })).toHaveAttribute('href', 'https://github.com/htxryan/anmerko');
  await expect(navigation.getByRole('link', { name: 'Report Issue (opens in new tab)', exact: true })).toHaveAttribute('href', 'https://github.com/htxryan/anmerko/issues/new');
  const chromeStore = page.getByRole('tabpanel', { name: 'Chrome' }).getByRole('link', { name: 'Chrome Web Store', exact: true });
  await expect(chromeStore).toHaveAttribute('href', 'https://chromewebstore.google.com/detail/anmerko/oligkkknbmklalfnkipmheifammnpgpo');
  await expect(page.getByRole('tabpanel', { name: 'Chrome' })).toContainText('Desktop Google Chrome 142 or later');
  const manualLink = page.getByRole('link', { name: 'Download manually', exact: true });
  await expect(manualLink).toHaveAttribute('href', '/docs/install/');
  await expect(manualLink).not.toHaveAttribute('target', '_blank');
  await manualLink.click();
  await expect(page).toHaveURL(/\/docs\/install\/$/);
  await expect(page.getByRole('heading', { name: 'Installation', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('narrow desktop windows retain installation and have no horizontal overflow', async ({ page }) => {
  for (const width of [768, 600, 512, 481, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/');
    await expect(page.getByRole('tabpanel', { name: 'Chrome' }).getByRole('link', { name: 'Chrome Web Store', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.getByRole('link', { name: 'Download manually', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('link', { name: 'Report Issue (opens in new tab)', exact: true })).toBeInViewport({ ratio: 1 });
    const header = (await page.getByRole('banner').boundingBox())!;
    const toggle = (await page.getByRole('button', { name: /Switch to (light|dark) theme/ }).boundingBox())!;
    expect(toggle.x + toggle.width).toBeLessThanOrEqual(header.x + header.width);
    for (const name of ['Chrome', 'Edge', 'Firefox']) {
      await expect(page.getByRole('tab', { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
    if (width < 600) {
      const features = page.getByRole('region', { name: 'Why anmerko' });
      const easy = (await features.getByRole('article', { name: 'Easy', exact: true }).boundingBox())!;
      const universal = (await features.getByRole('article', { name: 'Universal', exact: true }).boundingBox())!;
      const privateFeature = (await features.getByRole('article', { name: 'Private', exact: true }).boundingBox())!;
      expect(easy.y + easy.height).toBeLessThan(universal.y);
      expect(universal.y + universal.height).toBeLessThan(privateFeature.y);
    }
    await mkdir('artifacts', { recursive: true });
    await page.screenshot({ path: `artifacts/anmerko-site-mobile-${width}.png`, fullPage: true });
    if (width === 390) await page.screenshot({ path: 'artifacts/anmerko-site-mobile.png', fullPage: true });
  }
});

test('desktop and mobile choices can be switched without losing keyboard navigation or the manual link', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Edge', exact: true }).click();
  const switchToMobile = page.getByRole('button', { name: 'Install for mobile browsers', exact: true });
  await expect(switchToMobile).toBeVisible();
  await switchToMobile.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tablist')).toHaveAccessibleName('Choose your mobile browser');
  await expect(page.getByRole('tab')).toHaveCount(3);
  const edge = page.getByRole('tab', { name: 'Edge', exact: true });
  await expect(edge).toBeFocused();
  await expect(edge).toHaveAccessibleDescription('Android / iPhone');
  const edgePanel = page.getByRole('tabpanel', { name: 'Edge' });
  await expect(edgePanel).toContainText('Microsoft Edge for Android');
  await expect(edgePanel.getByRole('link', { name: 'Install on Android', exact: true })).toHaveAttribute('href', 'https://microsoftedge.microsoft.com/addons/detail/anmerko/bfhobiphegcekelfokpcpeepoakkgcka');
  await expect(edgePanel).toContainText('Microsoft Edge for iPhone');
  await expect(edgePanel.getByRole('link', { name: 'Install on iPhone', exact: true })).toHaveAttribute('href', '/docs/install/edge-iphone/');
  await expect(page.getByRole('link', { name: 'Chrome Web Store', exact: true })).toBeHidden();
  for (const [name, os, label, href, requirements] of [
    ['Firefox', 'Android', 'Firefox Add-ons', 'https://addons.mozilla.org/en-US/firefox/addon/anmerko/', 'Firefox for Android 142 or later. Not available on iOS.'],
    ['Orion', 'iPhone', 'Install in Orion', '/docs/install/orion-iphone/', 'Orion on iPhone'],
  ]) {
    const tab = page.getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAccessibleDescription(os);
    await expect(tab.getByText('SOON', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('tabpanel')).toHaveAccessibleName(name);
    await expect(page.getByRole('tabpanel')).toContainText(requirements);
    await expect(page.getByRole('tabpanel').getByRole('link', { name: label, exact: true })).toHaveAttribute('href', href);
    await expect(page.getByRole('link', { name: 'Download manually', exact: true })).toBeVisible();
  }
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Edge', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Orion', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Install for desktop browsers', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.getByRole('tab', { name: 'Edge', exact: true })).toBeFocused();
  await expect(page.getByRole('tablist')).toHaveAccessibleName('Choose your desktop browser');
  // Resizing is not a device change and must not override the visitor's explicit choice.
  await page.setViewportSize({ width: 320, height: 844 });
  await expect(page.getByRole('tablist')).toHaveAccessibleName('Choose your desktop browser');
  await page.getByRole('button', { name: 'Install for mobile browsers', exact: true }).click();
  await page.getByRole('tab', { name: 'Orion', exact: true }).click();
  await page.getByRole('tabpanel').getByRole('link', { name: 'Install in Orion', exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/install\/orion-iphone\/$/);
  await expect(page.getByRole('heading', { name: 'Orion on iPhone', exact: true })).toBeVisible();
});

test('phones and tablets start on mobile choices, while touch laptops remain on desktop', async ({ browser }) => {
  const errors: string[] = [];
  const iphone = devices['iPhone 13'];
  const scenarios = [
    { name: 'android', device: devices['Pixel 5'], mobile: true, selected: 'Edge', desktopSelected: 'Chrome' },
    { name: 'iphone', device: iphone, mobile: true, selected: 'Orion', desktopSelected: 'Chrome' },
    { name: 'iphone-chrome', device: { ...iphone, userAgent: iphone.userAgent.replace(/Version\/[\d.]+/, 'CriOS/140.0.0.0') }, mobile: true, selected: 'Orion', desktopSelected: 'Chrome' },
    { name: 'iphone-edge', device: { ...iphone, userAgent: iphone.userAgent.replace(/Version\/[\d.]+/, 'EdgiOS/140.0.0.0') }, mobile: true, selected: 'Edge', desktopSelected: 'Edge' },
    { name: 'iphone-firefox', device: { ...iphone, userAgent: iphone.userAgent.replace(/Version\/[\d.]+/, 'FxiOS/140.0.0.0') }, mobile: true, selected: 'Orion', desktopSelected: 'Firefox' },
    {
      name: 'ipad',
      device: {
        ...devices['iPad Pro 11'],
        userAgent: devices['iPad Pro 11'].userAgent.replace(/^Mozilla\/5\.0 \([^)]*\)/, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)'),
      },
      mobile: true,
      selected: 'Edge',
      desktopSelected: 'Chrome',
    },
    { name: 'touch-laptop', device: { ...devices['Desktop Chrome'], hasTouch: true }, mobile: false, selected: 'Chrome', desktopSelected: 'Chrome' },
  ];
  for (const scenario of scenarios) {
    const { defaultBrowserType: _, ...device } = scenario.device;
    const context = await browser.newContext(device);
    if (scenario.name === 'ipad') {
      await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 }));
    }
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      await page.goto('http://127.0.0.1:4175/');
      await expect(page.getByRole('tablist')).toHaveAccessibleName(`Choose your ${scenario.mobile ? 'mobile' : 'desktop'} browser`);
      await expect(page.getByRole('tab')).toHaveCount(3);
      const platformSwitch = page.getByRole('button', { name: `Install for ${scenario.mobile ? 'desktop' : 'mobile'} browsers`, exact: true });
      await expect(platformSwitch).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole('link', { name: 'Download manually', exact: true })).toBeInViewport({ ratio: 1 });
      if (scenario.mobile) {
        const switchBox = (await platformSwitch.boundingBox())!;
        expect(page.viewportSize()!.height - switchBox.y - switchBox.height).toBeGreaterThanOrEqual(16);
        await expect(page.getByRole('tab', { name: scenario.selected, exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator(`#tab-desktop-${scenario.desktopSelected.toLowerCase()}`)).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('tab', { name: 'Chrome', exact: true })).toBeHidden();
        await expect(page.getByRole('tab', { name: 'Brave', exact: true })).toBeHidden();
        await page.setViewportSize({ width: 320, height: 844 });
        for (const name of ['Edge', 'Firefox', 'Orion']) {
          await expect(page.getByRole('tab', { name, exact: true })).toBeInViewport({ ratio: 1 });
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
      await page.screenshot({ path: `artifacts/anmerko-install-${scenario.name}.png`, fullPage: true });
    } catch (error) {
      await page.screenshot({ path: `artifacts/anmerko-install-${scenario.name}-failure.png`, fullPage: true });
      const layoutPath = `artifacts/anmerko-install-${scenario.name}-layout.json`;
      await writeFile(layoutPath, JSON.stringify(await page.evaluate(() => ({
          viewport: { width: innerWidth, height: innerHeight, scale: visualViewport?.scale },
          elements: [...document.querySelectorAll('.header, .layout, .intro, .intro h1, .intro > p, .demo-controls, .install, .install h2, .browser-tabs, .browser-panel, .install-links, .releases, .platform-choice, .platform-switch')].map(element => ({
            className: element.className,
            bounds: element.getBoundingClientRect().toJSON(),
            font: getComputedStyle(element).font,
          })),
        }))));
      await test.info().attach(`install-${scenario.name}-layout`, { contentType: 'application/json', path: layoutPath });
      throw error;
    } finally {
      await context.close();
    }
  }
  expect(errors).toEqual([]);
});

test('browser tabs show the approved desktop stores and support keyboard navigation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('/');
  const names = ['Chrome', 'Edge', 'Firefox'];
  const chrome = page.getByRole('tab', { name: 'Chrome', exact: true });
  const card = page.getByRole('region', { name: 'Install the Browser Extension' });
  const stores = {
    Chrome: {
      label: 'Chrome Web Store',
      href: 'https://chromewebstore.google.com/detail/anmerko/oligkkknbmklalfnkipmheifammnpgpo',
      requirements: 'Desktop Google Chrome 142 or later',
    },
    Edge: {
      label: 'Microsoft Edge Add-ons',
      href: 'https://microsoftedge.microsoft.com/addons/detail/anmerko/bfhobiphegcekelfokpcpeepoakkgcka',
      requirements: 'Desktop Microsoft Edge',
    },
    Firefox: {
      label: 'Firefox Add-ons',
      href: 'https://addons.mozilla.org/en-US/firefox/addon/anmerko/',
      requirements: 'Desktop Firefox 142 or later',
    },
  };
  await expect(chrome).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName('Chrome');
  const initialHeight = (await card.boundingBox())!.height;
  for (const name of names) {
    const tab = page.getByRole('tab', { name, exact: true });
    await expect(tab.locator('img')).toHaveJSProperty('naturalWidth', 64);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    await expect(tab).toHaveAttribute('tabindex', '0');
    await expect(page.getByRole('tab', { selected: true })).toHaveCount(1);
    const panel = page.getByRole('tabpanel');
    await expect(panel).toHaveCount(1);
    await expect(panel).toHaveAccessibleName(name);
    const store = stores[name as keyof typeof stores];
    await expect(tab.getByText('SOON', { exact: true })).toHaveCount(0);
    await expect(panel.getByRole('link', { name: store.label, exact: true })).toHaveAttribute('href', store.href);
    await expect(panel).toContainText(store.requirements);
    const manual = page.getByRole('link', { name: 'Download manually', exact: true });
    await expect(manual).toBeVisible();
    const installBox = (await card.locator('.install').boundingBox())!;
    expect((await manual.boundingBox())!.y).toBeGreaterThan(installBox.y + installBox.height);
    expect((await card.boundingBox())!.height).toBe(initialHeight);
  }
  // Arrow keys wrap; Home/End jump to the first/last browser. Selection follows focus.
  await page.keyboard.press('ArrowRight');
  await expect(chrome).toBeFocused();
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName('Chrome');
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Firefox', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(chrome).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Edge', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Firefox', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tabpanel', { name: 'Firefox', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Home');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tabpanel', { name: 'Chrome', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Chrome Web Store', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Download manually', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});
