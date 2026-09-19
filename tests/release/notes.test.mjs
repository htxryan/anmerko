import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseNotes } from '../../scripts/release/release-notes.mjs';

test('release notes identify the actual browser installers and their public guides', () => {
  const candidate = { version: '0.6.0', source: 'a'.repeat(40), browsers: {
    chrome: { filename: 'anmerko-0.6.0.zip' },
    edge: { filename: 'anmerko-0.6.0-edge.zip' },
    firefox: { filename: 'anmerko-0.6.0-firefox.xpi' },
  } };
  const notes = releaseNotes(candidate);
  for (const [browser, artifact] of Object.entries(candidate.browsers)) {
    assert.ok(notes.includes(artifact.filename));
    assert.ok(notes.includes(`https://anmerko.com/docs/install/${browser}/`));
  }
  delete candidate.browsers.firefox;
  const partial = releaseNotes(candidate);
  assert.ok(!partial.includes('anmerko-0.6.0-firefox.xpi'));
  assert.match(partial, /earlier release/);
});
