import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { copyApprovedDownloads } from '../release/approved-release.mjs';

// Pagefind 1.5.2 service shutdown can truncate Starlight's generated files.
// The CLI waits for pending writes: https://github.com/Pagefind/pagefind/issues/1271
const pagefindCli = fileURLToPath(new URL('./runner/bin.cjs', import.meta.resolve('pagefind')));
execFileSync(process.execPath, [pagefindCli, '--site', 'site/dist'], { stdio: 'inherit' });

const approved = JSON.parse(await readFile('releases/approved.json', 'utf8'));
await copyApprovedDownloads(approved);
await cp('public/icons/128.png', 'site/dist/favicon.png');
// Astro hashes bundled scripts but skips Starlight's `is:inline` scripts.
// Hash the final bytes of every inline script and enforce the policy before
// the first script, including the theme bootstrap in <head>.
for (const file of (await readdir('site/dist', { recursive: true })).filter(file => file.endsWith('.html'))) {
  const path = `site/dist/${file}`;
  let html = await readFile(path, 'utf8');
  const meta = html.match(/<meta http-equiv="content-security-policy" content="([^"]+)"\s*\/?\s*>/);
  if (!meta) throw new Error(`Missing Content Security Policy in ${file}`);
  const hashes = new Set();
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc\s*=/.test(script[1])) hashes.add(`'sha256-${createHash('sha256').update(script[2]).digest('base64')}'`);
  }
  const policy = meta[1].replace(/script-src [^;]+/, `script-src 'self' 'wasm-unsafe-eval' ${[...hashes].join(' ')}`);
  html = html.replace(meta[0], '').replace(/<head>/, `<head><meta http-equiv="content-security-policy" content="${policy}">`);
  await writeFile(path, html);
}
console.log('Built public anmerko site and documentation → site/dist/');
