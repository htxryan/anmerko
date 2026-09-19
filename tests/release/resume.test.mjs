import assert from 'node:assert/strict';
import { test } from 'node:test';
import { missingReleaseAssets, assertPromotionBranch } from '../../scripts/release/release-resume.mjs';

test('publication resumes only missing assets and never replaces existing bytes', () => {
  const expected = { 'package.zip': 'a'.repeat(64), 'validation.json': 'b'.repeat(64) };
  const release = { target_commitish: 'source', prerelease: true, assets: [{ name: 'package.zip', digest: `sha256:${expected['package.zip']}` }] };
  assert.deepEqual(missingReleaseAssets(release, 'source', expected), ['validation.json']);
  const completed = { ...release, assets: [...release.assets, { name: 'validation.json', digest: `sha256:${expected['validation.json']}` }] };
  assert.deepEqual(missingReleaseAssets(completed, 'source', expected), []);
  for (const override of [{ target_commitish: 'other' }, { prerelease: false },
    { assets: [{ name: 'package.zip', digest: 'sha256:wrong' }] },
    { assets: [{ name: 'unexpected.zip', digest: 'sha256:wrong' }] }, { assets: [...release.assets, ...release.assets] }]) {
    assert.throws(() => missingReleaseAssets({ ...release, ...override }, 'source', expected));
  }
});
test('promotion retry verifies the existing branch instead of resetting it', () => {
  const commit = { parents: [{ sha: 'base' }] }, expected = { sequence: 2 };
  const comparison = { status: 'ahead', total_commits: 1, files: [{ filename: 'releases/approved.json' }] };
  assert.doesNotThrow(() => assertPromotionBranch(commit, comparison, expected, expected));
  assert.throws(() => assertPromotionBranch(commit, comparison, { sequence: 3 }, expected));
  assert.throws(() => assertPromotionBranch(commit, { ...comparison, total_commits: 2 }, expected, expected));
  assert.throws(() => assertPromotionBranch(commit, { ...comparison, files: [{ filename: 'src/runtime.ts' }] }, expected, expected));
});
