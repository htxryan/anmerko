import { expect, test, type Page } from '@playwright/test';
import { astroIslandContextProbe } from '../../src/astro-island-probe';

const MARKER = 'data-anmerko-context-0123456789abcdef0123456789abcdef';

function islandHtml(inner: string): string {
  return `<!doctype html><html><body>${inner}</body></html>`;
}

async function islandResult(page: Page, selector: string, tag: string): Promise<string | null> {
  await page.evaluate(({ selectorPath, markerName }) => {
    const selected = document.querySelector(selectorPath);
    if (!selected) throw new Error('island target missing');
    selected.setAttribute(markerName, '');
  }, { selectorPath: selector, markerName: MARKER });
  return page.evaluate(astroIslandContextProbe, {
    selectorPath: [selector], expectedTag: tag, markerName: MARKER,
  });
}

test('reports the island frame for a hydrated React island', async ({ page }) => {
  await page.setContent(islandHtml(
    `<astro-island component-export="default" component-url="/_astro/Counter.a1b2c3.js" renderer-url="/_astro/react-client-v2.mjs" client="load"><button id="t">hi</button></astro-island>`,
  ));
  expect(JSON.parse((await islandResult(page, '#t', 'button'))!)).toEqual({
    version: 1, island: true, metadata: 'present', framework: 'react',
    componentExport: 'default', componentUrl: '/_astro/Counter.a1b2c3.js',
    rendererUrl: '/_astro/react-client-v2.mjs', client: 'load', hydrated: true,
  });
});

test('flags unhydrated lazy islands and keeps unknown renderers honest', async ({ page }) => {
  await page.setContent(islandHtml(
    `<astro-island component-export="Counter" component-url="/_astro/C.a.js" renderer-url="/_astro/vue-client.mjs" client="visible"><template data-astro-template><p>fallback</p></template><button id="u">x</button></astro-island>`,
  ));
  const lazy = JSON.parse((await islandResult(page, '#u', 'button'))!);
  expect(lazy.framework).toBe('vue');
  expect(lazy.hydrated).toBe(false);

  await page.setContent(islandHtml(
    `<astro-island component-export="X" renderer-url="/_astro/mycompany-thing.mjs" client="load"><button id="c">x</button></astro-island>`,
  ));
  const custom = JSON.parse((await islandResult(page, '#c', 'button'))!);
  expect(custom.framework).toBeNull();
  expect(custom.componentExport).toBe('X');
});

test('returns absent for stripped islands and null for static output', async ({ page }) => {
  await page.setContent(islandHtml(`<astro-island><button id="b">x</button></astro-island>`));
  expect(JSON.parse((await islandResult(page, '#b', 'button'))!)).toEqual({ version: 1, island: true, metadata: 'absent' });

  await page.setContent(islandHtml(`<button id="p">x</button>`));
  expect(await islandResult(page, '#p', 'button')).toBeNull();
});
