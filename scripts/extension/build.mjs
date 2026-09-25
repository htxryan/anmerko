import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { browserTarget, browserManifest } from './browser-targets.mjs';
import { buildVersion } from './build-version.mjs';

const target = browserTarget();
const { build } = await import('esbuild');
const { outdir } = target;
const define = { __ANMERKO_JOURNEYS__: String(target.journeys) };
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await cp('public', outdir, { recursive: true });
const manifest = browserManifest(JSON.parse(await readFile('public/manifest.json', 'utf8')),
  buildVersion(JSON.parse(await readFile('package.json', 'utf8')).version), target);
await writeFile(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
await build({ entryPoints: { content: 'src/extension-content.ts', 'journey-observer': 'src/journey-observer.ts', popup: 'src/popup.ts', journey: 'src/journey-page.ts' }, bundle: true, outdir,
  format: 'iife', target: target.syntax, loader: { '.css': 'text' }, define });
await build({ entryPoints: ['src/background.ts'], bundle: true, outdir, format: target.format, target: target.syntax, define });
console.log(`Built anmerko for ${target.label} → ${outdir}/`);
