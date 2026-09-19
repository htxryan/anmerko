import assert from 'node:assert/strict';

export const CURRENT_PRODUCT = 'anmerko';
export const LEGACY_PRODUCT = 'briefmark';
export const FIREFOX_GUID = 'briefmark@briefmark.app';

export function releaseArtifacts(version, product = CURRENT_PRODUCT) {
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Expected a three-part release version');
  assert.ok([CURRENT_PRODUCT, LEGACY_PRODUCT].includes(product), 'Unknown release artifact family');
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
  const required = names => [names.chrome, names.listed, names.listedSource, names.web, names.webSource];
  const matches = [CURRENT_PRODUCT, LEGACY_PRODUCT].filter(product => {
    const names = releaseArtifacts(state.version, product);
    return required(names).every(name => Object.hasOwn(state.files || {}, name));
  });
  assert.equal(matches.length, 1, 'Persisted release state must identify exactly one artifact family');
  const names = releaseArtifacts(state.version, matches[0]);
  const other = matches[0] === CURRENT_PRODUCT ? LEGACY_PRODUCT : CURRENT_PRODUCT;
  assert.ok(!Object.keys(state.files).some(name => name.startsWith(`${other}-${state.version}`)),
    'Persisted release state mixes old and new artifact families');
  return names;
}

export function releaseArtifactsFromCandidate(candidate) {
  const browsers = Object.entries(candidate.browsers || {});
  assert.ok(browsers.length, 'Persisted candidate has no browser artifacts');
  const key = { chrome: 'chrome', edge: 'edge', firefox: 'listedXpi' };
  const matches = [CURRENT_PRODUCT, LEGACY_PRODUCT].filter(product => {
    const names = releaseArtifacts(candidate.version, product);
    return browsers.every(([browser, artifact]) => key[browser] && artifact.filename === names[key[browser]]);
  });
  assert.equal(matches.length, 1, 'Persisted candidate must identify exactly one artifact family');
  return releaseArtifacts(candidate.version, matches[0]);
}
