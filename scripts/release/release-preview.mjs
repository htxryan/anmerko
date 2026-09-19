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
approved.demo = { source: candidate.source, version: candidate.version, entry: candidate.demo.entry, files: {} };
for (const [route, artifact] of Object.entries(candidate.demo.files)) {
  const location = `releases/preview/${artifact.file}`;
  await cp(join(directory, 'demo', artifact.file), location);
  approved.demo.files[route] = { location, sha256: artifact.sha256 };
}
await writeFile('releases/approved.json', JSON.stringify(approved, null, 2) + '\n');
