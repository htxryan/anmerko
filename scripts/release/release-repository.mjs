import assert from 'node:assert/strict';

export const RELEASE_REPOSITORIES = Object.freeze(['htxryan/anmerko']);

export function activeRepository(environment = process.env) {
  const repository = environment.GITHUB_REPOSITORY || RELEASE_REPOSITORIES[0];
  assert.ok(RELEASE_REPOSITORIES.includes(repository), `Unexpected repository: ${repository}`);
  return repository;
}

export function parseReleaseAssetLocation(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^https:\/\/github\.com\/htxryan\/(?<name>anmerko)\/releases\/download\/(?<tag>[A-Za-z0-9_-]+)\/(?<filename>[A-Za-z0-9_.-]+)$/);
  if (match?.[0] !== value || ['.', '..'].includes(match.groups.filename)) return null;
  return { repository: `htxryan/${match.groups.name}`, tag: match.groups.tag, filename: match.groups.filename };
}
