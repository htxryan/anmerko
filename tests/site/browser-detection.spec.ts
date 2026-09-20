import { test, expect, devices } from '@playwright/test';

const chrome = devices['Desktop Chrome'].userAgent;
const iphone = devices['iPhone 13'].userAgent;
const edgeAndroid = `${devices['Pixel 5'].userAgent} EdgA/153.0.4234.32`;

test('first load selects the detected browser when it is offered for the device', async ({ browser }) => {
  const scenarios = [
    { name: 'Chrome', ua: chrome },
    { name: 'Edge', ua: `${chrome} Edg/150.0.0.0` },
    { name: 'Firefox', ua: devices['Desktop Firefox'].userAgent },
    { name: 'Chrome', ua: `${chrome} Brave` },
    { name: 'Chrome', ua: 'UnknownBrowser/1.0' },
    { name: 'Edge', ua: edgeAndroid, mobile: true },
    { name: 'Firefox', ua: `${devices['Pixel 5'].userAgent} Firefox/142.0`, mobile: true },
    { name: 'Orion', ua: `${iphone} EdgiOS/150.0.0.0`, mobile: true, desktopName: 'Edge' },
    { name: 'Orion', ua: `${iphone} FxiOS/150.0`, mobile: true, desktopName: 'Firefox' },
    { name: 'Orion', ua: iphone, mobile: true, desktopName: 'Chrome' },
    { name: 'Orion', ua: `${iphone} CriOS/150.0.0.0`, mobile: true, desktopName: 'Chrome' },
    { name: 'Orion', ua: `${iphone} Brave`, mobile: true, desktopName: 'Chrome' },
  ];
  for (const scenario of scenarios) {
    const context = await browser.newContext({ userAgent: scenario.ua });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto('/');
      await expect(page.getByRole('tablist')).toHaveAccessibleName(`Choose your ${scenario.mobile ? 'mobile' : 'desktop'} browser`);
      await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(scenario.name);
      await expect(page.getByRole('tabpanel')).toHaveAccessibleName(scenario.name);
      if (scenario.mobile && scenario.name === 'Edge') {
        await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleDescription('Android');
        await expect(page.getByRole('tabpanel')).toContainText('Microsoft Edge for Android. Not available on iOS.');
      }
      if (scenario.mobile && scenario.name === 'Firefox') {
        await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleDescription('Android');
        await expect(page.getByRole('tabpanel')).toContainText('Firefox for Android 142 or later. Not available on iOS.');
        await expect(page.getByRole('tabpanel').getByRole('link', { name: 'Firefox Add-ons', exact: true })).toHaveAttribute('href', 'https://addons.mozilla.org/en-US/firefox/addon/anmerko/');
      }
      if (scenario.mobile && scenario.name === 'Orion') {
        await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleDescription('iPhone');
        await expect(page.getByRole('tabpanel')).toContainText('Orion on iPhone');
        await expect(page.getByRole('tabpanel').getByRole('link', { name: 'Install in Orion', exact: true })).toHaveAttribute('href', '/docs/install/orion-iphone/');
        await expect(page.locator(`#tab-desktop-${scenario.desktopName!.toLowerCase()}`)).toHaveAttribute('aria-selected', 'true');
      }
      const manual = scenario.mobile ? 'Firefox' : scenario.name === 'Firefox' ? 'Edge' : 'Firefox';
      await page.getByRole('tab', { name: manual, exact: true }).click();
      await page.setViewportSize({ width: 320, height: 844 });
      await expect(page.getByRole('tab', { selected: true })).toHaveAccessibleName(manual);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
});

 test('Android Edge shows its store and retains mobile keyboard selection at 320 pixels', async ({ browser }) => {
  const context = await browser.newContext({ ...devices['Pixel 5'], viewport: { width: 320, height: 844 }, userAgent: edgeAndroid });
  const page = await context.newPage();
  try {
    await page.goto('/');
    const edge = page.getByRole('tab', { name: 'Edge', exact: true });
    await expect(edge).toHaveAttribute('aria-selected', 'true');
    await expect(edge).toHaveAccessibleDescription('Android');
    await expect(page.getByRole('tabpanel')).toContainText('Microsoft Edge for Android');
    await expect(page.getByRole('tabpanel').getByRole('link')).toHaveAttribute('href', 'https://microsoftedge.microsoft.com/addons/detail/anmerko/bfhobiphegcekelfokpcpeepoakkgcka');
    await edge.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Firefox', exact: true })).toBeFocused();
    await expect(page.getByRole('tabpanel')).toContainText('Firefox for Android 142 or later. Not available on iOS.');
    await expect(page.getByRole('tabpanel').getByRole('link', { name: 'Firefox Add-ons', exact: true })).toHaveAttribute('href', 'https://addons.mozilla.org/en-US/firefox/addon/anmerko/');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Orion', exact: true })).toBeFocused();
    await expect(page.getByRole('tabpanel')).toContainText('Orion on iPhone');
    await page.keyboard.press('ArrowRight');
    await expect(edge).toBeFocused();
    await page.getByRole('button', { name: 'Install for desktop browsers', exact: true }).click();
    await page.getByRole('button', { name: 'Install for mobile browsers', exact: true }).click();
    await expect(edge).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  } finally { await context.close(); }
});
