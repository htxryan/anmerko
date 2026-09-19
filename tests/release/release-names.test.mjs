import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseArtifacts, releaseArtifactsFromCandidate, releaseArtifactsFromState } from '../../scripts/release/release-names.mjs';
import { candidateArchiveFiles } from '../../scripts/release/archive-release-candidate.mjs';

test('new releases use the anmerko artifact family', () => {
  assert.deepEqual(releaseArtifacts('0.6.0'), {
    product: 'anmerko',
    chrome: 'anmerko-0.6.0.zip',
    edge: 'anmerko-0.6.0-edge.zip',
    listed: 'anmerko-0.6.0-firefox-unsigned.zip',
    listedSource: 'anmerko-0.6.0-firefox-source.zip',
    web: 'anmerko-0.6.0.1-firefox-unsigned.zip',
    webSource: 'anmerko-0.6.0.1-firefox-source.zip',
    listedXpi: 'anmerko-0.6.0-firefox.xpi',
    xpi: 'anmerko-0.6.0.1-firefox.xpi',
  });
});

test('candidate archives retain the exact filenames committed by state', () => {
  const names = releaseArtifacts('0.6.0');
  const files = Object.fromEntries(['chrome', 'listed', 'listedSource', 'web', 'webSource'].map(key => [names[key], 'a'.repeat(64)]));
  assert.deepEqual(candidateArchiveFiles({ version: '0.6.0', files }), [
    names.chrome, names.listed, names.listedSource, names.web, names.webSource, 'state-001.json',
  ]);
});

test('saved candidates reject unknown products, mixed versions and wrong browser files', () => {
  assert.throws(() => releaseArtifacts('0.6.0', 'retired-product'), /artifact family/);
  const candidate = () => ({ version: '0.6.0', browsers: {
    chrome: { filename: releaseArtifacts('0.6.0').chrome },
    firefox: { filename: releaseArtifacts('0.6.0').listedXpi },
  } });
  assert.equal(releaseArtifactsFromCandidate(candidate()).product, 'anmerko');
  for (const filename of ['retired-product-0.6.0-firefox.xpi', releaseArtifacts('0.5.4').listedXpi,
    releaseArtifacts('0.6.0').listed, releaseArtifacts('0.6.0').chrome]) {
    const invalid = candidate(); invalid.browsers.firefox.filename = filename;
    assert.throws(() => releaseArtifactsFromCandidate(invalid), /artifact family/);
  }
});

test('resume requires every current artifact and rejects foreign files', () => {
  const names = releaseArtifacts('0.6.0');
  const state = () => ({ version: '0.6.0', files: Object.fromEntries(
    ['chrome', 'listed', 'listedSource', 'web', 'webSource'].map(key => [names[key], 'a'.repeat(64)])) });
  assert.equal(releaseArtifactsFromState(state()).product, 'anmerko');
  assert.throws(() => releaseArtifactsFromState({ version: '0.6.0', files: {} }), /artifact family/);
  for (const filename of ['retired-product-0.6.0-firefox-source.zip', 'anmerko', '0.6.0']) {
    const invalid = state(); invalid.files[filename] = 'a'.repeat(64);
    assert.throws(() => releaseArtifactsFromState(invalid), /unknown artifact/);
  }
});
