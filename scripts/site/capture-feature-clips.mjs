// Silent annotated feature clips for the brochure Features page.
//
// Records real extension flows in bundled Chromium (headless with HEADLESS=1):
// a red cursor dot and pulse highlights baked in as a DOM overlay, step
// captions logged with timestamps and burned into a dedicated panel below the
// picture at encode time. Raw WebM + per-clip SRTs stay in
// tasks/feature-clips/ (ignored); MP4s go to site/public/media/features/
// with posters reused from site/public/screenshots/. Shared machinery lives
// in ./clip-helpers.mjs.
//
// Usage:
//   npm run build
//   HEADLESS=1 CLIP_VIEWPORT=1068x668 CLIP_SCALE=800:-2 FFMPEG=/path/to/ffmpeg \
//     node scripts/site/capture-feature-clips.mjs [element|screenshot|global|component|export]
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { startFixtureServer } from '../../tests/fixtures/component-context/server.mjs';
import {
  repoRoot as root, clipConfig, caption, hideOverlay, pulse, glide, centerOf,
  clickAt, dragSlow, launch, activate, panel, setupPage, finish, composePip, mediaDuration, clipCues,
} from './clip-helpers.mjs';
import { recordTerminalPaste } from './capture-terminal-opencode.mjs';

const rawDir = join(root, 'tasks/feature-clips');
const outDir = join(root, 'site/public/media/features');
const only = process.argv[2];
const { viewport } = clipConfig();

const SALAD = 'https://saladrecipefinder.com/';
const saladReady = page => page.getByRole('heading', { name: 'Find a salad.', exact: true }).waitFor();

async function elementClip() {
  const session = await launch();
  try {
    const { page, ss } = await setupPage(session, SALAD, saladReady);
    const selectButton = panel(page).getByRole('button', { name: 'Select Element', exact: true });
    const headline = page.getByRole('heading', { name: 'Find a salad.', exact: true });
    const comment = panel(page).getByLabel('Comment', { exact: true });
    const save = panel(page).getByRole('button', { name: 'Save', exact: true });
    await caption(page, 'Select Element, then click the headline');
    await glide(page, await centerOf(selectButton), 750);
    await clickAt(page, await centerOf(selectButton));
    await pulse(page, 'h1');
    await glide(page, await centerOf(headline), 750);
    await page.waitForTimeout(500);
    await pulse(page, 'h1');
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(900);
    await caption(page, 'Write feedback, then Save');
    await glide(page, await centerOf(comment), 700);
    await clickAt(page, await centerOf(comment), 450);
    await comment.pressSequentially('Make the headline more specific.', { delay: 35 });
    await page.waitForTimeout(900);
    await glide(page, await centerOf(save), 700);
    await clickAt(page, await centerOf(save));
    await caption(page, 'Saved with page context');
    await page.waitForTimeout(1600);
    page._clipSs = ss;
    await finish(session, page, { name: 'element', outDir, srtDir: rawDir, rawDir });
  } catch (error) {
    await session.context.close().catch(() => {});
    await rm(session.temp, { recursive: true, force: true });
    throw error;
  }
}

async function screenshotClip() {
  const session = await launch();
  try {
    const { page, ss } = await setupPage(session, SALAD, saladReady);
    const size = page.viewportSize();
    const take = panel(page).getByRole('button', { name: 'Take Screenshot' });
    const use = page.getByRole('button', { name: 'Use Screenshot', exact: true });
    const comment = panel(page).getByLabel('Comment', { exact: true });
    const save = panel(page).getByRole('button', { name: 'Save', exact: true });
    await caption(page, 'Take Screenshot, then drag a region');
    await glide(page, await centerOf(take), 750);
    await clickAt(page, await centerOf(take), 600);
    await hideOverlay(page, true);
    await dragSlow(page,
      { x: size.width * 0.15, y: size.height * 0.35 },
      { x: size.width * 0.62, y: size.height * 0.72 });
    await hideOverlay(page, false);
    await caption(page, 'Adjust, then Use Screenshot');
    await glide(page, await centerOf(use), 750);
    await clickAt(page, await centerOf(use));
    await caption(page, 'Describe the region, then Save');
    await glide(page, await centerOf(comment), 700);
    await clickAt(page, await centerOf(comment), 450);
    await comment.pressSequentially('This card needs more contrast.', { delay: 35 });
    await page.waitForTimeout(900);
    await glide(page, await centerOf(save), 700);
    await clickAt(page, await centerOf(save));
    await caption(page, 'Saved with its crop');
    await page.waitForTimeout(1600);
    page._clipSs = ss;
    await finish(session, page, { name: 'screenshot', outDir, srtDir: rawDir, rawDir });
  } catch (error) {
    await session.context.close().catch(() => {});
    await rm(session.temp, { recursive: true, force: true });
    throw error;
  }
}

async function globalClip() {
  const session = await launch();
  try {
    const { page, ss } = await setupPage(session, SALAD, saladReady);
    const globalItem = panel(page).getByRole('button', { name: 'New Global Comment' });
    const comment = panel(page).getByLabel('Comment', { exact: true });
    const save = panel(page).getByRole('button', { name: 'Save', exact: true });
    await caption(page, 'Choose New Global Comment');
    await glide(page, await centerOf(globalItem), 750);
    await clickAt(page, await centerOf(globalItem), 600);
    await caption(page, 'Describe the whole page, then Save');
    await glide(page, await centerOf(comment), 700);
    await clickAt(page, await centerOf(comment), 450);
    await comment.pressSequentially('Reconsider the page hierarchy.', { delay: 35 });
    await page.waitForTimeout(900);
    await glide(page, await centerOf(save), 700);
    await clickAt(page, await centerOf(save));
    await caption(page, 'Saved with the page title and URL');
    await page.waitForTimeout(1600);
    page._clipSs = ss;
    await finish(session, page, { name: 'global', outDir, srtDir: rawDir, rawDir });
  } catch (error) {
    await session.context.close().catch(() => {});
    await rm(session.temp, { recursive: true, force: true });
    throw error;
  }
}

async function componentClip(fixtureOrigin) {
  const session = await launch();
  try {
    const ready = page => page.waitForFunction(() => globalThis.__ANMERKO_FIXTURE__?.ready === true);
    const { page, ss } = await setupPage(session, `${fixtureOrigin}/react/18.3.1/development`, ready);
    const settings = panel(page).getByRole('button', { name: 'Extension settings' });
    const toggle = panel(page).getByRole('switch', { name: 'Capture component context' });
    const back = panel(page).getByRole('button', { name: 'Back', exact: false });
    const select = panel(page).getByRole('button', { name: 'Select Element', exact: true });
    const target = page.locator('#react-nested-button');
    await caption(page, 'Turn on Capture component context');
    await glide(page, await centerOf(settings), 750);
    await clickAt(page, await centerOf(settings));
    await toggle.waitFor();
    await glide(page, await centerOf(toggle), 650);
    await page.waitForTimeout(500);
    if (await toggle.getAttribute('aria-checked') !== 'true') {
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(650);
    }
    await glide(page, await centerOf(back), 650);
    await clickAt(page, await centerOf(back), 600);
    await caption(page, 'Select the nested button');
    await glide(page, await centerOf(select), 750);
    await clickAt(page, await centerOf(select));
    await pulse(page, '#react-nested-button');
    await glide(page, await centerOf(target), 800);
    await page.waitForTimeout(500);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(900);
    await panel(page).locator('.component-context-path').waitFor();
    await caption(page, 'App › PricingPage › PlanCard › FeedbackButton');
    await page.waitForTimeout(2000);
    page._clipSs = ss;
    await finish(session, page, { name: 'component', outDir, srtDir: rawDir, rawDir });
  } catch (error) {
    await session.context.close().catch(() => {});
    await rm(session.temp, { recursive: true, force: true });
    throw error;
  }
}

async function exportClip() {
  const session = await launch();
  try {
    // Seed two comments off-camera: this page's recording is discarded, but
    // profile storage is shared, so the recorded page opens with both saved.
    const seed = await session.context.newPage();
    await seed.goto(SALAD);
    await saladReady(seed);
    await activate(session, seed);
    const seedPanel = panel(seed);
    await seedPanel.getByRole('button', { name: 'Select Element', exact: true }).click();
    await seed.getByRole('heading', { name: 'Find a salad.', exact: true }).click();
    await seedPanel.getByLabel('Comment', { exact: true }).fill('Make the headline more specific.');
    await seedPanel.getByRole('button', { name: 'Save', exact: true }).click();
    await seedPanel.locator('.note').nth(0).waitFor();
    await seedPanel.getByRole('button', { name: 'New Global Comment' }).click();
    await seedPanel.getByLabel('Comment', { exact: true }).fill('Reconsider the page hierarchy.');
    await seedPanel.getByRole('button', { name: 'Save', exact: true }).click();
    await seedPanel.locator('.note').nth(1).waitFor();
    await seed.close();
    session.t0 = Date.now();
    const mark = label => console.log(`Export timeline: ${label} +${((Date.now() - session.t0) / 1000).toFixed(1)}s`);
    const { page, ss } = await setupPage(session, SALAD, saladReady);
    mark('recorded page ready');
    await panel(page).locator('.note').nth(1).waitFor();
    const copy = panel(page).getByRole('button', { name: 'Copy Prompt', exact: true });
    await caption(page, 'Two comments saved — Copy Prompt builds the brief');
    await glide(page, await centerOf(copy), 800);
    await clickAt(page, await centerOf(copy));
    await panel(page).locator('.status').getByText('Copied').waitFor();
    mark('copied status shown');
    const brief = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(brief.includes('2 comments'), 'the copied brief must hold both comments');
    await writeFile(join(rawDir, 'export-brief.md'), brief);
    // Let the Copied confirmation read before the browser act ends.
    await page.waitForTimeout(1200);
    const firstVideo = await page.video().path();
    // Freeze the browser act here: otherwise this recording keeps running
    // (silently stretching the pre-alt-tab pause) until the context closes.
    const cues1 = await clipCues(page);
    await page.close();
    // Real paste, real terminal: the brief goes into a fresh opencode prompt.
    // The prompt is never submitted — no tokens burn, nothing runs.
    const { page: pastePage, video: secondVideo, preRoll } = await recordTerminalPaste({
      context: session.context, viewport, briefText: brief,
      captionText: 'Then paste into your agent of choice',
    });
    const cues2 = await clipCues(pastePage);
    await session.context.close();
    const ffmpeg = clipConfig().ffmpeg;
    const browserLength = await mediaDuration(ffmpeg, firstVideo) - Math.max(0, ss);
    const tabAt = Math.max(1, browserLength - 0.8);
    await composePip({
      browser: firstVideo, terminal: secondVideo,
      ssBrowser: ss, ssTerminal: preRoll, tabAt,
      cues1, cues2, srtPath: join(rawDir, 'export.srt'),
      output: join(outDir, 'export.mp4'),
    });
    {
      const { cp: copyRawDir } = await import('node:fs/promises');
      await copyRawDir(join(session.temp, 'video'), join(rawDir, 'raw', 'export'), { recursive: true });
    }
    await rm(session.temp, { recursive: true, force: true });
  } catch (error) {
    await session.context.close().catch(() => {});
    await rm(session.temp, { recursive: true, force: true });
    throw error;
  }
}

process.chdir(root);
await mkdir(rawDir, { recursive: true });
await mkdir(outDir, { recursive: true });
const clips = { element: elementClip, screenshot: screenshotClip, global: globalClip, export: exportClip };
let fixtureServer;
if (!only || only === 'component') {
  fixtureServer = await startFixtureServer();
  clips.component = () => componentClip(fixtureServer.origin);
}
try {
  const names = only ? [only] : ['element', 'screenshot', 'global', 'component', 'export'];
  for (const name of names) {
    assert.ok(clips[name], `unknown clip: ${name}`);
    await clips[name]();
  }
} finally {
  await fixtureServer?.close();
}
console.log(`Done → ${outDir}`);
