import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { releaseArtifactsFromState } from './release-names.mjs';

export function candidateArchiveFiles(state) {
  const names = releaseArtifactsFromState(state);
  return [names.chrome, names.listed, names.listedSource, names.web, names.webSource, 'state-001.json'];
}

async function main() {
  const [statePath, outputPath] = process.argv.slice(2);
  assert.ok(statePath && outputPath, 'Expected state and output paths');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  execFileSync('tar', ['-czf', outputPath, '-C', dirname(statePath), ...candidateArchiveFiles(state)]);
}

if (import.meta.main) await main();
