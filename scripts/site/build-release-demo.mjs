import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { basename, resolve, join } from 'node:path';
import { digest } from '../release/approved-release.mjs';

// Archive candidate UI for release evidence. The live website separately builds
// its demo from the current shared UI through Astro, never from this archive.
export async function buildReleaseDemo(sourceRoot, output) {
  sourceRoot = resolve(sourceRoot); output = resolve(output);
  await mkdir(output, { recursive: true });
  await build({ absWorkingDir: sourceRoot, entryPoints: ['site/src/scripts/demo-launcher.ts'],
    outdir: output, entryNames: 'demo-launcher-[hash]', chunkNames: 'demo-runtime-[hash]',
    bundle: true, splitting: true, format: 'esm', target: 'chrome142', minify: true,
    plugins: [{ name: 'approved-demo-styles', setup(builder) {
      builder.onResolve({ filter: /\.css\?url&no-inline$/ }, args => ({
        path: resolve(args.resolveDir, args.path.split('?')[0]), namespace: 'release-css',
      }));
      builder.onLoad({ filter: /.*/, namespace: 'release-css' }, async args => {
        const bytes = await readFile(args.path);
        const name = `${basename(args.path, '.css')}-${digest(bytes).slice(0, 16)}.css`;
        await writeFile(join(output, name), bytes);
        return { contents: `export default ${JSON.stringify(`/_astro/${name}`)};`, loader: 'js' };
      });
    } }],
  });
  const files = await readdir(output);
  const entry = files.find(name => name.startsWith('demo-launcher-') && name.endsWith('.js'));
  if (!entry) throw new Error('Missing candidate demo entry');
  return { entry: `/_astro/${entry}`, files: Object.fromEntries(await Promise.all(files.map(async name => [
    `/_astro/${name}`, { file: name, sha256: digest(await readFile(join(output, name))) },
  ]))) };
}
