import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const section = (filters, name, next) => filters.slice(filters.indexOf(`${name}:`), next ? filters.indexOf(`\n${next}:`) : undefined);

test('all framework fixtures and page probes select the full browser matrix', async () => {
  const filters = await readFile('.github/filters.yml', 'utf8');
  for (const [name, next] of [['chrome', 'firefox'], ['firefox', 'site'], ['highrisk', 'releasegate']]) {
    const scope = section(filters, name, next);
    assert.ok(scope.includes("'tests/fixtures/component-context/**'"), `${name}: Angular and shared fixture-only edits must run browser checks`);
    assert.ok(scope.includes("'scripts/browsers/setup-component-fixtures.mjs'"), `${name}: fixture setup must run browser checks`);
  }
  const highrisk = section(filters, 'highrisk', 'releasegate');
  for (const path of ['src/react-context-probe.ts', 'src/vue-context-probe.ts', 'src/angular-context-probe.ts', 'src/component-context*.ts']) {
    assert.ok(highrisk.includes(`'${path}'`), `${path} must force full browser validation`);
  }
});

test('journey modules that bind browser APIs select the full browser matrix', async () => {
  const filters = await readFile('.github/filters.yml', 'utf8');
  const highrisk = section(filters, 'highrisk', 'releasegate');
  // Each of these talks to a browser API, extension messaging or an injected entry point.
  const integration = {
    'src/journey-extension.ts': /webNavigation\.|\.alarms|\.tabs\.|\.scripting|storage\.session/,
    'src/journey-feature.ts': /webNavigation|alarms/,
    'src/journey-page-bridge.ts': /runtime\.(?:connect|sendMessage)/,
    'src/journey-observer.ts': /ensureJourneyPage/,
    'src/journey-page.ts': /extensionApi\(\)/,
    'src/journey-client.ts': /runtime\.(?:sendMessage|onMessage)/,
    'src/journey-messaging.ts': /sender\.id/,
    'src/journey-store.ts': /indexedDB\.open/,
  };
  for (const [path, binding] of Object.entries(integration)) {
    assert.match(await readFile(path, 'utf8'), binding, `${path} no longer binds the browser API this policy assumes`);
    assert.ok(highrisk.includes(`'${path}'`), `${path} must force full browser validation`);
  }
  assert.doesNotMatch(highrisk, /'src\/journey-\*/, 'pure journey model, UI and export modules keep the fast scope');
});

test('standalone release and deployment helpers select their required CI jobs', async () => {
  const filters = await readFile('.github/filters.yml', 'utf8');
  const common = section(filters, 'common', 'extension');
  const site = section(filters, 'site', 'highrisk');
  const releasegate = section(filters, 'releasegate');

  assert.match(common, /scripts\/release\/archive-release-candidate\.mjs/,
    'candidate archive changes must select every shared validation target');
  assert.match(releasegate, /scripts\/release\/archive-release-candidate\.mjs/,
    'candidate archive changes must run release proof');
  for (const path of ['.github/workflows/check.yml', '.github/filters.yml', 'scripts/ci/ci-policy.mjs',
    'scripts/ci/reuse-ci.mjs', 'scripts/ci/continue-release.mjs']) {
    assert.match(releasegate, new RegExp(path.replaceAll('.', '\\.').replaceAll('/', '\\/')),
      `${path} changes must run release proof`);
  }
  assert.match(site, /scripts\/deployment\/capture-deployment-state\.mjs/,
    'deployment-state changes must run the site and deployment checks');
});

test('unit-test and site helper edits cannot force unrelated browser matrices', async () => {
  const filters = await readFile('.github/filters.yml', 'utf8');
  const common = section(filters, 'common', 'extension');
  const highrisk = section(filters, 'highrisk', 'releasegate');
  const releasegate = section(filters, 'releasegate');
  for (const paths of [common, highrisk, releasegate]) {
    assert.doesNotMatch(paths, /'tests-(?:ci|release)\/\*\*'/);
  }
  assert.doesNotMatch(highrisk, /'scripts\/\*\*'/,
    'site, media and reporting scripts must not force full browser validation');
  assert.doesNotMatch(common, /workflows\/deploy\.yml/);
  assert.match(section(filters, 'site', 'highrisk'), /workflows\/deploy\.yml/);
  const workflow = await readFile('.github/workflows/check.yml', 'utf8');
  assert.match(workflow, /- run: node --test tests\/ci\/\*\.test\.mjs tests\/release\/\*\.test\.mjs/,
    'unit tests must still run unconditionally in Changed paths');
});
