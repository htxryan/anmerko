// Shared helpers for brochure-site recordings (feature clips, homepage video).
//
// Silent annotated captures: real UI driven in bundled Chromium (headed by
// default, HEADLESS=1 for windowless runs), captions and an exaggerated red
// cursor baked in as a DOM overlay, trimmed H.264 MP4 output. See
// docs/feature-clips.md for the locked look and honesty constraints.
import { mkdtemp, cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

export const repoRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));

export function clipConfig() {
  const viewport = (() => {
    const match = /^(\d+)x(\d+)$/.exec(process.env.CLIP_VIEWPORT || '');
    return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 1280, height: 800 };
  })();
  return {
    viewport,
    scale: process.env.CLIP_SCALE || '960:-2',
    ffmpeg: process.env.FFMPEG || 'ffmpeg',
    headless: process.env.HEADLESS === '1',
  };
}

// Final output dimensions: scaled picture plus the 140px caption panel.
export function captionDims(config = clipConfig()) {
  const w = parseInt(config.scale, 10);
  const h = Math.round((config.viewport.height * w) / config.viewport.width / 2) * 2 + 150;
  return { w, h };
}

export const OVERLAY = `(() => {
  if (document.getElementById('anmerko-clip-ui')) return;
  const style = document.createElement('style');
  style.textContent = \`
    #anmerko-clip-ui { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; font-family: system-ui, sans-serif; }
    #anmerko-clip-cursor { position: absolute; width: 34px; height: 34px; border-radius: 50%;
      background: #f5222d; border: 4px solid #fff; box-shadow: 0 2px 10px rgba(0,0,0,.55), 0 0 0 5px rgba(245,34,45,.35);
      transform: translate(-50%,-50%); }
    .anmerko-clip-pulse { outline: 4px solid #345ee9 !important; outline-offset: 4px; animation: anmerko-clip-pulse 1s ease-in-out infinite; }
    @keyframes anmerko-clip-pulse { 50% { outline-color: rgba(52,94,233,.25); } }
  \`;
  const ui = document.createElement('div');
  ui.id = 'anmerko-clip-ui';
  ui.innerHTML = '<div id="anmerko-clip-cursor"></div>';
  document.documentElement.append(style, ui);
  const dot = document.getElementById('anmerko-clip-cursor');
  dot.style.left = (globalThis.innerWidth / 2) + 'px';
  dot.style.top = (globalThis.innerHeight - 100) + 'px';
  addEventListener('mousemove', event => {
    const dot = document.getElementById('anmerko-clip-cursor');
    dot.hidden = false;
    dot.style.left = event.clientX + 'px';
    dot.style.top = event.clientY + 'px';
  }, { passive: true });
})()`;

// Captions are logged with wall-clock times and burned into a dedicated
// panel below the video at encode time (see finish/encode) — never overlaid
// on the recorded pixels, so they can be large and never cover the action.
export async function caption(page, text) {
  await page.evaluate(text => {
    globalThis.__clipCaptions = globalThis.__clipCaptions || [];
    globalThis.__clipCaptions.push({ text, at: Date.now() });
  }, text);
  await page.waitForTimeout(450);
}

export async function clipCues(page) {
  const list = await page.evaluate(() => globalThis.__clipCaptions || []);
  return { list, born: page._clipBorn, ss: page._clipSs || 0 };
}

function srtStamp(seconds) {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = (clamped % 60).toFixed(3).padStart(6, '0');
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${secs.replace('.', ',')}`;
}

// Captions for the final timeline: video time = wall clock minus recording
// birth minus the head trim, plus an optional offset (second acts).
export function formatSrt({ list, born, ss }, offset = 0, startIndex = 0, endCap = Infinity) {
  assert.ok(born, 'clip birth must be set before encoding captions');
  return list.map((cue, i) => {
    const start = Math.max(0, (cue.at - born) / 1000 - ss + offset);
    const next = list[i + 1];
    const end = Math.min(
      next ? Math.max(start + 0.5, (next.at - born) / 1000 - ss + offset) : start + 30,
      endCap,
    );
    return `${startIndex + i + 1}\n${srtStamp(start)} --> ${srtStamp(end)}\n${cue.text}\n`;
  }).join('\n');
}

export async function writeSrt(srtPath, cues, offset = 0) {
  const { writeFile: writeSrtFile } = await import('node:fs/promises');
  await writeSrtFile(srtPath, formatSrt(cues, offset));
}

// 150px panel under the picture, large centered type. Two lines allowed.
// Single quotes protect the style commas from the filter parser. libass lays SRT out at a default
// 384x288 (the subtitles original_size option does not move it), so PlayRes
// is overridden to the real output size — without that, fonts render ~2x
// oversized and spill out of the band. Captions may wrap to two lines;
// 40px type with side margins stays inside the 150px band, and
// MarginV centers the line in the panel.
export function captionFilter(srtPath, config = clipConfig()) {
  const escaped = srtPath.replace(/\\/g, '\\\\').replace(/:/g, '\\:');
  const dims = captionDims(config);
  return `pad=iw:ih+150:0:0:color=#111722,subtitles='${escaped}':force_style='PlayResX=${dims.w},PlayResY=${dims.h},FontName=Helvetica,FontSize=40,PrimaryColour=&HFFFFFF,Alignment=2,MarginV=44,MarginL=40,MarginR=40,BorderStyle=1,Outline=1'`;
}

// Slow, followable pointer glide. Playwright jumps straight to click targets,
// so every move goes through here first; the overlay dot tracks mousemove.
export async function glide(page, to, duration = 1000) {
  const from = await page.evaluate(() => ({
    x: globalThis.__clipX ?? globalThis.innerWidth / 2,
    y: globalThis.__clipY ?? globalThis.innerHeight - 100,
  }));
  const steps = Math.max(8, Math.round(duration / 40));
  for (let i = 1; i <= steps; i++) {
    const point = { x: from.x + (to.x - from.x) * (i / steps), y: from.y + (to.y - from.y) * (i / steps) };
    await page.mouse.move(point.x, point.y);
    await page.evaluate(point => { globalThis.__clipX = point.x; globalThis.__clipY = point.y; }, point);
    await page.waitForTimeout(30);
  }
}

export async function centerOf(locator) {
  const box = await locator.boundingBox();
  assert.ok(box, 'clip target must be visible');
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export async function clickAt(page, point, pause = 650) {
  await page.mouse.move(point.x, point.y);
  await page.waitForTimeout(500);
  await page.mouse.down();
  await page.mouse.up();
  await page.evaluate(point => { globalThis.__clipX = point.x; globalThis.__clipY = point.y; }, point);
  await page.waitForTimeout(pause);
}

// Slow region drag for the screenshot flow. The overlay stays hidden while
// the button is down so captions never end up inside the captured crop.
export async function dragSlow(page, from, to, duration = 1100) {
  await page.mouse.move(from.x, from.y);
  await page.waitForTimeout(400);
  await page.mouse.down();
  const steps = Math.max(8, Math.round(duration / 50));
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.x + (to.x - from.x) * (i / steps), from.y + (to.y - from.y) * (i / steps));
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.evaluate(to => { globalThis.__clipX = to.x; globalThis.__clipY = to.y; }, to);
  await page.waitForTimeout(600);
}

export async function hideOverlay(page, hidden) {
  await page.evaluate(hidden => {
    document.getElementById('anmerko-clip-ui').style.display = hidden ? 'none' : '';
  }, hidden);
}

export async function pulse(page, selector) {
  await page.evaluate(selector => {
    document.querySelector(selector)?.classList.add('anmerko-clip-pulse');
  }, selector);
}

export async function launch(config = clipConfig()) {
  const temp = await mkdtemp(join(tmpdir(), 'anmerko-clips-'));
  // Test-harness activation, mirroring the Chromium suite: automation cannot
  // click a toolbar, so the temporary copy exposes the production
  // activateTab behind a bootstrap hook and grants <all_urls> (automation
  // cannot grant activeTab, and tabs.captureVisibleTab accepts no narrower
  // grant). All injection, storage, and UI code is production code, so every
  // recorded pixel is the production interface. (Branded Chrome ignores
  // --load-extension under automation here, hence bundled Chromium. The
  // temporary copy is discarded after recording.)
  const extension = join(temp, 'extension');
  await cp(join(repoRoot, 'dist'), extension, { recursive: true });
  const manifestPath = join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = ['<all_urls>'];
  manifest.background.service_worker = 'test-bootstrap.js';
  await writeFile(join(extension, 'test-bootstrap.js'),
    "import { activateTab } from './background.js'; globalThis.__testActivateTab = activateTab;");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(join(temp, 'profile'), {
    channel: 'chromium',
    headless: config.headless,
    viewport: config.viewport,
    recordVideo: { dir: join(temp, 'video'), size: config.viewport },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      `--window-size=${config.viewport.width + 26},${config.viewport.height + 100}`, '--no-first-run', '--no-default-browser-check'],
  });
  context.setDefaultTimeout(15000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const t0 = Date.now();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  return { context, worker, temp, t0 };
}

export async function activate(session, page) {
  await page.bringToFront();
  await session.worker.evaluate(async url => {
    const tab = (await chrome.tabs.query({})).find(tab => tab.url === url);
    if (!tab?.id) throw new Error('Clip tab not found');
    await globalThis.__testActivateTab(tab.id);
  }, page.url());
  await panel(page).getByRole('button', { name: 'Select Element', exact: true }).waitFor();
}

export const panel = page => page.getByRole('complementary', { name: 'anmerko feedback panel' });

export async function setupPage(session, url, waitFor, { activateTab = true } = {}) {
  // Warm page: absorbs slow loads off-camera; its video is discarded.
  const warm = await session.context.newPage();
  await warm.goto(url);
  if (waitFor) await waitFor(warm);
  await warm.close();
  const page = await session.context.newPage();
  // The recording starts at page creation, so trims measure from here —
  // not from session start (a warm page may have run in between).
  const born = Date.now();
  await page.goto(url);
  if (waitFor) await waitFor(page);
  // The homepage demo runs extension-free by design; activating would inject
  // a second production panel next to the demo's own.
  if (activateTab) await activate(session, page);
  await page.evaluate(OVERLAY);
  page._clipBorn = born;
  page._clipSs = (Date.now() - born) / 1000 - 0.4;
  return { page, ss: page._clipSs };
}

export async function finish(session, page, { name, outDir, srtDir, rawDir, config = clipConfig() }) {
  const video = await page.video().path();
  const cues = await clipCues(page);
  await session.context.close();
  const videos = await readdir(join(session.temp, 'video'));
  assert.ok(videos.length >= 1, 'a recording must exist');
  const srtPath = join(srtDir, `${name}.srt`);
  await writeSrt(srtPath, cues);
  await encode({ input: video, output: join(outDir, `${name}.mp4`), ss: page._clipSs, srtPath, config });
  // Keep the raw capture: style-only changes (caption type, panel) can
  // re-encode from raw without re-recording the browser.
  if (rawDir) {
    const { cp: copyRaw } = await import('node:fs/promises');
    await copyRaw(join(session.temp, 'video'), join(rawDir, 'raw', name), { recursive: true });
  }
  await rm(session.temp, { recursive: true, force: true });
}

export async function encode({ input, output, ss, srtPath, config = clipConfig() }) {
  const start = Math.max(0, ss).toFixed(2);
  const result = spawnSync(config.ffmpeg, [
    '-y', '-ss', start, '-i', input,
    '-vf', `scale=${config.scale},${captionFilter(srtPath, config)}`,
    '-c:v', 'libx264', '-crf', '29', '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', output,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `ffmpeg failed for ${output}: ${result.stderr?.slice(-2000)}`);
  console.log(`Captured ${output} (trimmed ${Number(start).toFixed(1)}s off the front)`);
}

// Join several page recordings (a clip spanning two tabs) then encode as one.
export async function concatEncode({ inputs, output, ss, config = clipConfig() }) {
  const { mkdtemp: mkTemp, writeFile: writeTempFile } = await import('node:fs/promises');
  const { tmpdir: osTmp } = await import('node:os');
  const dir = await mkTemp(join(osTmp(), 'anmerko-concat-'));
  const list = join(dir, 'list.txt');
  await writeTempFile(list, inputs.map(file => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'));
  const start = Math.max(0, ss).toFixed(2);
  const combined = join(dir, 'combined.webm');
  const joinResult = spawnSync(config.ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', combined], { encoding: 'utf8' });
  assert.equal(joinResult.status, 0, `ffmpeg concat failed: ${joinResult.stderr?.slice(-2000)}`);
  await encode({ input: combined, output, ss: Number(start), config });
  await rm(dir, { recursive: true, force: true });
}

export async function mediaDuration(ffmpeg, file) {
  const probe = spawnSync(ffmpeg, ['-i', file], { encoding: 'utf8' });
  const match = /Duration: (\d+):(\d+):([\d.]+)/.exec(`${probe.stderr}${probe.stdout}`);
  assert.ok(match, `could not read duration of ${file}`);
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

// Picture-in-picture composite: the terminal recording slides in over the
// browser recording as if the user Alt+Tabbed to it. Both sources are real
// captures; only their arrangement is staged (disclosed in docs).
// Terminal takes ~62% width, bottom-right, sliding in over 0.5s at tabAt.
export async function composePip({ browser, terminal, ssBrowser, ssTerminal, tabAt, output, cues1, cues2, srtPath, config = clipConfig() }) {
  const fgWidth = 660;
  const slide = 0.5;
  const { writeFile: writeCombinedSrt } = await import('node:fs/promises');
  await writeCombinedSrt(srtPath, formatSrt(cues1, 0, 0, tabAt) + '\n' + formatSrt(cues2, tabAt, cues1.list.length));
  const filter = `[0:v]tpad=stop_mode=clone:stop_duration=30[bg];`
    + `[1:v]scale=${fgWidth}:-2,format=yuva420p,fade=t=in:st=${tabAt.toFixed(2)}:d=${slide}:alpha=1,`
    + `drawbox=x=0:y=0:w=iw:h=ih:c=white@0.85:t=3[fg];`
    + `[bg][fg]overlay=x='W-(w+32)*min(1\\,max(0\\,(t-${tabAt})/${slide}))':y='H-h-32':enable='gte(t\\,${tabAt})'[comp];`
    + `[comp]scale=${config.scale},${captionFilter(srtPath, config)}`;
  const result = spawnSync(config.ffmpeg, [
    '-y', '-ss', Math.max(0, ssBrowser).toFixed(2), '-i', browser,
    '-ss', Math.max(0, ssTerminal).toFixed(2), '-itsoffset', tabAt.toFixed(2), '-i', terminal,
    '-filter_complex', filter, '-t', (tabAt + 8).toFixed(2),
    '-c:v', 'libx264', '-crf', '29', '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', output,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, `ffmpeg PiP composite failed: ${result.stderr?.slice(-2000)}`);
  console.log(`Composited ${output} (alt-tab at ${tabAt.toFixed(1)}s)`);
}
