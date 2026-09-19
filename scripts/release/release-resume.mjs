import assert from 'node:assert/strict';

// An interrupted upload may resume only when every retained byte still matches.
export function missingReleaseAssets(release, source, expected) {
  assert.equal(release.target_commitish, source, 'Existing release has another source');
  assert.equal(release.prerelease, true, 'Unexpected existing release type');
  const names = new Set();
  for (const asset of release.assets) {
    assert.ok(!names.has(asset.name), 'Duplicate existing release asset');
    names.add(asset.name);
    assert.ok(Object.hasOwn(expected, asset.name), 'Unexpected existing release asset');
    assert.equal(asset.digest, `sha256:${expected[asset.name]}`, `Existing release asset differs: ${asset.name}`);
  }
  return Object.keys(expected).filter(name => !names.has(name));
}

export function assertPromotionBranch(commit, comparison, actual, expected) {
  assert.equal(commit.parents.length, 1, 'Unexpected promotion branch history');
  assert.equal(comparison.status, 'ahead');
  assert.equal(comparison.total_commits, 1, 'Unexpected promotion branch commits');
  assert.deepEqual(comparison.files.map(file => file.filename), ['releases/approved.json'], 'Unexpected promotion branch changes');
  assert.deepEqual(actual, expected, 'Existing promotion branch has another manifest');
}
