import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { browserTarget, browserManifest } from './browser-targets.mjs';
import { buildVersion } from './build-version.mjs';

const target = browserTarget();
const { build } = await import('esbuild');
const { outdir } = target;
// Tells the bundles whether this target includes journeys (Orion does not).
const define = { __TARGET_JOURNEYS__: String(target.journeys) };
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
// A target without journeys ships no journey page or scripts.
const journeyFiles = new Set(['journey.html']);
await cp('public', outdir, { recursive: true, filter: source => target.journeys || !journeyFiles.has(basename(source)) });
const manifest = browserManifest(JSON.parse(await readFile('public/manifest.json', 'utf8')),
  buildVersion(JSON.parse(await readFile('package.json', 'utf8')).version), target);
await writeFile(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
const journeyEntryPoints = target.journeys ? { 'journey-observer': 'src/journey-observer.ts', journey: 'src/journey-page.ts' } : {};
// Without journeys, the define leaves journey modules imported but unused.
// Declaring them free of side effects lets esbuild drop them whole. It keeps
// any it still uses, but drops the top-level code of those it does not, so
// code that Orion needs at load time belongs outside journey-* modules.
const unusedJourneyModules = {
  name: 'unused-journey-modules',
  setup(build) {
    build.onResolve({ filter: /^\.\/journey-/ }, async ({ path, kind, importer, resolveDir, pluginData }) => {
      if (pluginData?.journeyModule) return undefined;
      const resolved = await build.resolve(path, { kind, importer, resolveDir, pluginData: { journeyModule: true } });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      return { path: resolved.path, namespace: resolved.namespace, sideEffects: false };
    });
  },
};
const plugins = target.journeys ? [] : [unusedJourneyModules];
await build({ entryPoints: { content: 'src/extension-content.ts', popup: 'src/popup.ts', ...journeyEntryPoints }, bundle: true, outdir,
  format: 'iife', target: target.syntax, loader: { '.css': 'text' }, define, plugins });
await build({ entryPoints: ['src/background.ts'], bundle: true, outdir, format: target.format, target: target.syntax, define, plugins });
console.log(`Built anmerko for ${target.label} → ${outdir}/`);
