import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseArtifacts, releaseArtifactsFromCandidate, releaseArtifactsFromState } from '../../scripts/release-names.mjs';
import { candidateArchiveFiles } from '../../scripts/archive-release-candidate.mjs';

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

test('candidate archives preserve the filename family selected by state', () => {
  const names = releaseArtifacts('0.5.4', 'briefmark');
  const files = Object.fromEntries(['chrome', 'listed', 'listedSource', 'web', 'webSource'].map(key => [names[key], 'a'.repeat(64)]));
  assert.deepEqual(candidateArchiveFiles({ version: '0.5.4', files }), [
    names.chrome, names.listed, names.listedSource, names.web, names.webSource, 'state-001.json',
  ]);
});

test('saved candidates resume exact old or new filenames and reject mixed Firefox files', () => {
  const candidate = product => ({ version: '0.5.4', browsers: {
    chrome: { filename: releaseArtifacts('0.5.4', product).chrome },
    firefox: { filename: releaseArtifacts('0.5.4', product).listedXpi },
  } });
  assert.equal(releaseArtifactsFromCandidate(candidate('briefmark')).product, 'briefmark');
  assert.equal(releaseArtifactsFromCandidate(candidate('anmerko')).product, 'anmerko');
  assert.equal(releaseArtifactsFromCandidate({ version: '0.5.4', browsers: {
    firefox: { filename: releaseArtifacts('0.5.4', 'briefmark').listedXpi },
  } }).product, 'briefmark');
  const mixed = candidate('briefmark'); mixed.browsers.firefox.filename = releaseArtifacts('0.5.4').listedXpi;
  assert.throws(() => releaseArtifactsFromCandidate(mixed), /exactly one/);
});

test('resume selects only the artifact family committed by trusted state', () => {
  const source = 'a'.repeat(64);
  const state = (version, product) => ({ version, files: Object.fromEntries(
    ['chrome', 'listed', 'listedSource', 'web', 'webSource'].map(key => [releaseArtifacts(version, product)[key], source])) });
  assert.equal(releaseArtifactsFromState(state('0.5.4', 'briefmark')).product, 'briefmark');
  assert.equal(releaseArtifactsFromState(state('0.6.0', 'anmerko')).product, 'anmerko');
  assert.throws(() => releaseArtifactsFromState({ version: '0.6.0', files: {} }), /exactly one/);
  const mixed = state('0.6.0', 'anmerko'); mixed.files['briefmark-0.6.0-firefox-source.zip'] = source;
  assert.throws(() => releaseArtifactsFromState(mixed), /mixes old and new/);
});
