import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
await mkdir('public/icons', { recursive: true });
for (const size of [16, 48, 128]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:0}</style><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="${size}" height="${size}"><rect width="128" height="128" rx="34" fill="#345ee9"/><path d="M35 86 86 35M40 35h46v46" fill="none" stroke="white" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>`);
  await page.screenshot({ path: `public/icons/${size}.png`, scale: 'css', omitBackground: true });
}
await browser.close();
