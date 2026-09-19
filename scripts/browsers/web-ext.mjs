import { spawnSync } from 'node:child_process';

// Mozilla's linter crashes under Node 24.14 on this macOS host. Keep its CLI on
// a separate, pinned Node 22 runtime; do not change the app's Node 24 toolchain.
const result = spawnSync('npx', ['--yes', '--package', 'node@22.23.2', 'node',
  'node_modules/web-ext/bin/web-ext.js', ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
