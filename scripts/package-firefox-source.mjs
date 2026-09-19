import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildVersion } from './build-version.mjs';

const { name, version: packageVersion } = JSON.parse(await readFile('package.json', 'utf8'));
const version = buildVersion(packageVersion);
const archive = resolve(`artifacts/${name}-${version}-firefox-source.zip`);
const staging = await mkdtemp(join(tmpdir(), 'anmerko-source-'));
try {
  await mkdir('artifacts', { recursive: true });
  await mkdir(join(staging, 'scripts'));
  for (const file of ['src', 'public', 'package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', 'scripts/build.mjs', 'scripts/build-version.mjs', 'scripts/browser-targets.mjs']) {
    await cp(file, join(staging, file), { recursive: true });
  }
  await writeFile(join(staging, 'README-SOURCE.md'), `# anmerko ${version} — Firefox review source\n\nRequires Node.js 24 and npm. Run:\n\n    npm ci\n    RELEASE_VERSION=${version} npm run build:firefox\n\nThe resulting dist-firefox directory is the submitted extension. RELEASE_VERSION changes only manifest.json's version and the archive filename; package.json remains the source family's three-part floor. esbuild bundles TypeScript and embeds panel.css; it does not minify or obfuscate the code. All extension source and icons are included. No network requests, analytics, AI calls, or external runtime libraries are used by the extension.\n\nThis archive contains only files needed to rebuild the Firefox extension, not the brochure or test suite.\n`);
  await rm(archive, { force: true });
  execFileSync('zip', ['-qr', archive, '.'], { cwd: staging });
  console.log(`Packaged ${archive}`);
} finally { await rm(staging, { recursive: true, force: true }); }
