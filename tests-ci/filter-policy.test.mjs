import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const section = (filters, name, next) => filters.slice(filters.indexOf(`${name}:`), next ? filters.indexOf(`\n${next}:`) : undefined);

test('standalone release and deployment helpers select their required CI jobs', async () => {
  const filters = await readFile('.github/filters.yml', 'utf8');
  const common = section(filters, 'common', 'extension');
  const site = section(filters, 'site', 'highrisk');
  const releasegate = section(filters, 'releasegate');

  assert.match(common, /scripts\/archive-release-candidate\.mjs/,
    'candidate archive changes must select every shared validation target');
  assert.match(releasegate, /scripts\/archive-release-candidate\.mjs/,
    'candidate archive changes must run release proof');
  for (const path of ['.github/workflows/check.yml', '.github/filters.yml', 'scripts/ci-policy.mjs', 'scripts/reuse-ci.mjs']) {
    assert.match(releasegate, new RegExp(path.replaceAll('.', '\\.').replaceAll('/', '\\/')),
      `${path} changes must run release proof`);
  }
  assert.match(site, /scripts\/capture-deployment-state\.mjs/,
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
  assert.match(workflow, /- run: node --test tests-ci\/\*\.test\.mjs tests-release\/\*\.test\.mjs/,
    'unit tests must still run unconditionally in Changed paths');
});
