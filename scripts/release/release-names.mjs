import assert from 'node:assert/strict';

export const CURRENT_PRODUCT = 'anmerko';
export const FIREFOX_GUID = 'briefmark@briefmark.app';

export function releaseArtifacts(version, product = CURRENT_PRODUCT) {
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Expected a three-part release version');
  assert.equal(product, CURRENT_PRODUCT, 'Unknown release artifact family');
  const webVersion = `${version}.1`;
  return {
    product,
    chrome: `${product}-${version}.zip`,
    edge: `${product}-${version}-edge.zip`,
    listed: `${product}-${version}-firefox-unsigned.zip`,
    listedSource: `${product}-${version}-firefox-source.zip`,
    web: `${product}-${webVersion}-firefox-unsigned.zip`,
    webSource: `${product}-${webVersion}-firefox-source.zip`,
    listedXpi: `${product}-${version}-firefox.xpi`,
    xpi: `${product}-${webVersion}-firefox.xpi`,
  };
}

export function releaseArtifactsFromState(state) {
  const names = releaseArtifacts(state.version);
  const required = [names.chrome, names.listed, names.listedSource, names.web, names.webSource];
  assert.ok(required.every(name => Object.hasOwn(state.files || {}, name)),
    'Persisted release state must contain the current artifact family');
  const allowed = Object.entries(names).filter(([key]) => key !== 'product').map(([, name]) => name);
  assert.ok(Object.keys(state.files).every(name => allowed.includes(name)),
    'Persisted release state contains an unknown artifact');
  return names;
}

export function releaseArtifactsFromCandidate(candidate) {
  const browsers = Object.entries(candidate.browsers || {});
  assert.ok(browsers.length, 'Persisted candidate has no browser artifacts');
  const key = { chrome: 'chrome', edge: 'edge', firefox: 'listedXpi' };
  const names = releaseArtifacts(candidate.version);
  assert.ok(browsers.every(([browser, artifact]) => key[browser] && artifact.filename === names[key[browser]]),
    'Persisted candidate must contain the current artifact family');
  return names;
}
