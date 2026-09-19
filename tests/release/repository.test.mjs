import assert from 'node:assert/strict';
import { test } from 'node:test';
import { activeRepository, parseReleaseAssetLocation } from '../../scripts/release/release-repository.mjs';

test('active repository uses the exact workflow identity with the current local default', () => {
  assert.equal(activeRepository({}), 'htxryan/anmerko');
  assert.equal(activeRepository({ GITHUB_REPOSITORY: 'htxryan/anmerko' }), 'htxryan/anmerko');
  for (const value of ['other/anmerko', 'htxryan/other', 'HTXRYAN/anmerko', 'htxryan/anmerko\n']) {
    assert.throws(() => activeRepository({ GITHUB_REPOSITORY: value }), /Unexpected repository/);
  }
});

test('release locations accept only exact current repository assets', () => {
  for (const repository of ['anmerko']) {
    assert.deepEqual(
      parseReleaseAssetLocation(`https://github.com/htxryan/${repository}/releases/download/automation-0-5-4-source/file.zip`),
      { repository: `htxryan/${repository}`, tag: 'automation-0-5-4-source', filename: 'file.zip' },
    );
  }
  for (const value of [
    'https://github.com/other/anmerko/releases/download/tag/file.zip',
    'https://github.com/htxryan/other/releases/download/tag/file.zip',
    'https://example.com/htxryan/anmerko/releases/download/tag/file.zip',
    'https://github.com/htxryan/anmerko/releases/download/tag/.',
    'https://github.com/htxryan/anmerko/releases/download/tag/..',
    'https://github.com/htxryan/anmerko/releases/download/tag/%2e%2e',
    'https://github.com/htxryan/anmerko/releases/download/tag/file.zip\n',
  ]) assert.equal(parseReleaseAssetLocation(value), null);
});
