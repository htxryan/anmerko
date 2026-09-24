import { test, expect } from '@playwright/test';

test('all declared fixture routes serve their pinned local runtime under strict CSP', async ({ page, request }) => {
  const origin = 'http://127.0.0.1:4177';
  const health = await (await request.get(`${origin}/healthz`)).json();
  expect(health).toMatchObject({ service: 'anmerko-component-context-fixtures', version: 1, ready: true });
  const routes = await (await request.get(`${origin}/routes.json`)).json();
  expect(routes).toHaveLength(health.routeCount);
  expect(routes.some((route: any) => route.framework === 'react')).toBe(true);
  const errors: string[] = [];
  const externalRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(`${origin}/`)) externalRequests.push(request.url()); });
  for (const route of routes) {
    const response = await page.goto(`${origin}${route.path}`);
    expect(response?.headers()['content-security-policy']).toContain("connect-src 'none'");
    await page.waitForFunction(() => {
      const fixture = (window as any).__ANMERKO_FIXTURE__ || (window as any).__BRIEFMARK_ANGULAR_FIXTURE__;
      return fixture?.ready;
    });
    const fixture = await page.evaluate(() => (window as any).__ANMERKO_FIXTURE__ || (window as any).__BRIEFMARK_ANGULAR_FIXTURE__);
    expect(fixture.framework).toBe(route.framework);
    expect(fixture.framework === 'angular' ? fixture.runtime.buildMode : fixture.mode).toBe(route.mode);
    if (route.framework === 'react' || route.framework === 'vue') expect(fixture.runtimeVersion).toBe(route.version);
    if (route.framework === 'angular') expect(fixture.runtime.angularVersion).toBe(route.version);
  }
  expect(errors).toEqual([]);
  expect(externalRequests).toEqual([]);
});
