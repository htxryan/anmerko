import assert from 'node:assert/strict';

export const HISTORICAL_REPOSITORIES = Object.freeze(['htxryan/briefmark', 'htxryan/anmerko']);

export function activeRepository(environment = process.env) {
  const repository = environment.GITHUB_REPOSITORY || HISTORICAL_REPOSITORIES[1];
  assert.ok(HISTORICAL_REPOSITORIES.includes(repository), `Unexpected repository: ${repository}`);
  return repository;
}

export function parseReleaseAssetLocation(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^https:\/\/github\.com\/htxryan\/(?<name>briefmark|anmerko)\/releases\/download\/(?<tag>[A-Za-z0-9_-]+)\/(?<filename>[A-Za-z0-9_.-]+)$/);
  if (match?.[0] !== value || ['.', '..'].includes(match.groups.filename)) return null;
  return { repository: `htxryan/${match.groups.name}`, tag: match.groups.tag, filename: match.groups.filename };
}
