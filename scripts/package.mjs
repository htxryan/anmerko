import { execFileSync } from 'node:child_process';
import { mkdir, rm, readFile, readdir } from 'node:fs/promises';
import { browserTarget } from './browser-targets.mjs';
import { buildVersion } from './build-version.mjs';
const target = browserTarget();
const { name, version: packageVersion } = JSON.parse(await readFile('package.json', 'utf8'));
const version = buildVersion(packageVersion);
const { outdir } = target;
if ((await readdir(outdir)).some(file => /^(?:briefmark|anmerko)-dev-install\./.test(file)) ||
    /(?:BRIEFMARK|ANMERKO)_DEV_VERIFY/.test(await readFile(`${outdir}/background.js`, 'utf8'))) {
  throw new Error(`Development update helper detected. Run node scripts/build.mjs --target ${target.name} to rebuild clean resources before packaging.`);
}
const archive = `${name}-${version}${target.archiveSuffix}.zip`;
await mkdir('artifacts', { recursive: true });
await rm(`artifacts/${archive}`, { force: true });
execFileSync('zip', ['-qr', `../artifacts/${archive}`, '.'], { cwd: outdir });
console.log(`Packaged artifacts/${archive}`);
