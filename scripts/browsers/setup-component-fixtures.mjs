import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (!(major === 24 && minor >= 15 || major >= 26)) {
  throw new Error('Component fixtures require Node 24.15.0+ (or Node 26+) for the pinned Angular compiler.');
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run npm run test:context-fixtures:setup from the repository root.');
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Fixture setup failed: ${args.slice(1).join(' ')}`);
}
const fixtures = fileURLToPath(new URL('../../tests/fixtures/component-context/', import.meta.url));
const angular = fileURLToPath(new URL('../../tests/fixtures/component-context/angular/', import.meta.url));
// Aliased React peers intentionally represent separate runtime versions. The
// fixture bundler maps every bare React import to its matching pinned alias.
run([npm, 'ci', '--ignore-scripts', '--legacy-peer-deps'], fixtures);
run([npm, 'ci', '--ignore-scripts'], angular);
// The reviewed esbuild hook selects/verifies its platform binary. Other nested
// package hooks are unnecessary for these ahead-of-time fixture builds.
run([npm, 'rebuild', 'esbuild'], angular);
for (const name of ['core', 'compiler', 'compiler-cli', 'cli', 'build']) {
  const metadata = JSON.parse(readFileSync(`${angular}node_modules/@angular/${name}/package.json`, 'utf8'));
  if (metadata.version !== '22.1.7') throw new Error(`Unexpected Angular ${name} version`);
}
run([npm, 'run', 'build'], angular);
run(['tests/fixtures/component-context/server.mjs', '--build']);
