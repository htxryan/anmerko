import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('browser workflows install both locked framework fixtures with a compatible Node patch', async () => {
  for (const path of ['.github/workflows/check.yml', '.github/workflows/desktop.yml']) {
    const source = await readFile(path, 'utf8');
    assert.match(source, /node-version: 24\.15\.0/, path);
    assert.match(source, /tests\/fixtures\/component-context\/package-lock\.json/, path);
    assert.match(source, /tests\/fixtures\/component-context\/angular\/package-lock\.json/, path);
    assert.match(source, /npm run test:context-fixtures:setup/, path);
    assert.ok(source.indexOf('npm run test:context-fixtures:setup') > source.indexOf('run: npm ci'), path);
  }
});

test('desktop setup preserves old release checkouts and fails present fixture setup normally', async () => {
  const source = await readFile('.github/workflows/desktop.yml', 'utf8');
  assert.match(source, /if \[ -f tests\/fixtures\/component-context\/package\.json \] \|\| \[ -f tests\/fixtures\/component-context\/angular\/package\.json \]; then\s+npm run test:context-fixtures:setup\s+fi/);
  const setup = await readFile('scripts/browsers/setup-component-fixtures.mjs', 'utf8');
  assert.match(setup, /'ci', '--ignore-scripts', '--legacy-peer-deps'/);
  assert.match(setup, /'ci', '--ignore-scripts'\], angular/);
  assert.match(setup, /metadata\.version !== '22\.1\.7'/);
  assert.match(setup, /result\.status !== 0/);
});
