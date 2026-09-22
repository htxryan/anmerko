// Real-footage homepage video for the brochure site (replaces the synthetic
// overview animation with the same silent annotated style as the feature
// clips). Records the homepage demo in bundled Chromium, encodes trimmed
// H.264, and writes matching caption cues.
//
// Usage:
//   npm run site:build   (the demo runs from site/dist)
//   HEADLESS=1 CLIP_VIEWPORT=1280x800 CLIP_SCALE=960:-2 FFMPEG=/path/to/ffmpeg \
//     node scripts/site/capture-homepage-video.mjs
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  repoRoot as root, clipConfig, caption, pulse, glide, centerOf,
  clickAt, launch, panel, setupPage, finish,
} from './clip-helpers.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8', '.json': 'application/json',
  '.wasm': 'application/wasm', '.zip': 'application/zip',
};

function serve(dist) {
  return new Promise(done => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        const file = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
        if (file !== dist && !file.startsWith(`${dist}/`)) { res.writeHead(403); res.end(); return; }
        const target = url.pathname.endsWith('/') || !extname(url.pathname) ? join(file, 'index.html') : file;
        const body = await readFile(target);
        res.writeHead(200, { 'Content-Type': TYPES[extname(target)] || 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404); res.end();
      }
    }).listen(0, '127.0.0.1', () => done(server));
  });
}

function stamp(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = (seconds % 60).toFixed(3).padStart(6, '0');
  return `${String(minutes).padStart(2, '0')}:${rest}`;
}

async function durationOf(ffmpeg, file) {
  const probe = spawnSync(ffmpeg, ['-i', file], { encoding: 'utf8' });
  const match = /Duration: (\d+):(\d+):([\d.]+)/.exec(`${probe.stderr}${probe.stdout}`);
  assert.ok(match, 'could not read video duration');
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

process.chdir(root);
const config = clipConfig();
const server = await serve(join(root, 'site/dist'));
const origin = `http://127.0.0.1:${server.address().port}`;
const session = await launch(config);
try {
  const ready = page => page.locator('#headline').waitFor();
  const { page, ss } = await setupPage(session, `${origin}/`, ready, { activateTab: false });
  page._clipSs = ss;
  const demo = page.getByRole('button', { name: 'Try the Demo' });
  const select = panel(page).getByRole('button', { name: 'Select Element', exact: true });
  const headline = page.locator('#headline');
  const comment = panel(page).getByLabel('Comment', { exact: true });
  const save = panel(page).getByRole('button', { name: 'Save', exact: true });
  const copy = panel(page).getByRole('button', { name: 'Copy Prompt', exact: true });
  await caption(page, 'Turn website feedback into an AI prompt');
  await page.waitForTimeout(1200);
  await glide(page, await centerOf(demo), 800);
  await clickAt(page, await centerOf(demo));
  await caption(page, 'Try the demo: click the headline');
  await glide(page, await centerOf(select), 750);
  await clickAt(page, await centerOf(select));
  await pulse(page, '#headline');
  await glide(page, await centerOf(headline), 750);
  await page.waitForTimeout(500);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(800);
  await caption(page, 'Write feedback, then Save');
  await glide(page, await centerOf(comment), 700);
  await clickAt(page, await centerOf(comment), 450);
  await comment.pressSequentially('Make this headline clearer.', { delay: 35 });
  await page.waitForTimeout(800);
  await glide(page, await centerOf(save), 700);
  await clickAt(page, await centerOf(save));
  await caption(page, 'Copy Prompt hands your agent the brief');
  await glide(page, await centerOf(copy), 750);
  await clickAt(page, await centerOf(copy));
  await page.waitForTimeout(2000);
  const outDir = join(root, 'site/public/media');
  const srtDir = join(root, 'tasks/feature-clips');
  const { mkdir: ensureDir } = await import('node:fs/promises');
  await ensureDir(srtDir, { recursive: true });
  await finish(session, page, { name: 'anmerko-homepage', outDir, srtDir, rawDir: srtDir, config });
  const duration = await durationOf(config.ffmpeg, join(outDir, 'anmerko-homepage.mp4'));
  const cues = [
    'Turn website feedback into an AI prompt.',
    'Try the demo: click the headline.',
    'Save the comment with its page context.',
    'Copy Prompt hands your agent the brief.',
  ];
  const edges = [0, 0.28, 0.55, 0.78, 1].map(fraction => fraction * duration);
  const vtt = `WEBVTT\n\n${cues.map((text, index) =>
    `${stamp(edges[index])} --> ${stamp(edges[index + 1])}\n${text}`).join('\n\n')}\n`;
  await writeFile(join(outDir, 'anmerko-homepage.en.vtt'), vtt);
  console.log(`Wrote captions (${duration.toFixed(1)}s)`);
} finally {
  await new Promise(done => server.close(done));
}
console.log('Done → site/public/media/anmerko-homepage.mp4');
