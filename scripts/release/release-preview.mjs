import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const directory = 'artifacts/release-candidate';
const candidate = JSON.parse(await readFile(join(directory, 'candidate.json'), 'utf8'));
const approved = JSON.parse(await readFile('releases/approved.json', 'utf8'));
await mkdir('releases/preview', { recursive: true });
for (const [browser, artifact] of Object.entries(candidate.browsers)) {
  const location = `releases/preview/${artifact.filename}`;
  await cp(join(directory, artifact.filename), location);
  approved.browsers[browser] = { source: candidate.source, version: candidate.version, artifact: { ...artifact, location } };
}
await writeFile('releases/approved.json', JSON.stringify(approved, null, 2) + '\n');
