import { expect, type Page } from '@playwright/test';

export async function copyPrompt(page: Page): Promise<string> {
  await page.bringToFront();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
  const panel = page.getByRole('complementary', { name: 'anmerko feedback panel' });
  // Require a fresh write even when the previous Copied status is still visible.
  await page.evaluate(() => navigator.clipboard.writeText(''));
  await panel.getByRole('button', { name: 'Copy Prompt', exact: true }).click();
  await expect(panel.locator('.status')).toContainText('Copied');
  // Windows exposes CRLF through the system clipboard; exports use canonical LF.
  let prompt = '';
  await expect.poll(async () => prompt = (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n')).not.toBe('');
  return prompt;
}
