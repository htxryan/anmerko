import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { browserTarget, browserManifest } from '../../scripts/extension/browser-targets.mjs';

const exec = promisify(execFile);
const source = JSON.parse(await readFile('public/manifest.json', 'utf8'));
const version = JSON.parse(await readFile('package.json', 'utf8')).version;
// Every target requests the shared set; Chrome, Edge, and Firefox add the journey APIs.
const sharedPermissions = ['activeTab', 'scripting', 'storage', 'clipboardWrite'];
const journeyPermissions = ['alarms', 'webNavigation'];

test('existing CLI aliases keep their output paths and unknown targets fail', () => {
  assert.equal(browserTarget([]).outdir, 'dist');
  assert.deepEqual(browserTarget(['--target', 'chrome']), browserTarget([]));
  assert.deepEqual(browserTarget(['--target', 'chromium']), browserTarget([]));
  assert.deepEqual(browserTarget(['--firefox']), browserTarget(['--target', 'firefox']));
  assert.deepEqual(browserTarget(['--target', 'orion']), {
    name: 'orion', label: 'Orion for iOS', outdir: 'dist-orion', syntax: 'safari16.4', format: 'iife', archiveSuffix: '-orion', journeys: false,
  });
  for (const args of [['--target', 'opera'], ['--target'], ['--unknown'], ['--firefox', '--target', 'chromium']]) {
    assert.throws(() => browserTarget(args));
  }
});

test('journeys ship in every target except Orion', () => {
  for (const target of ['chrome', 'firefox', 'orion']) assert.equal(browserTarget(['--target', target]).journeys, target !== 'orion', target);
});

test('browser manifests keep the shared permissions, version, and Firefox identities', () => {
  const original = structuredClone(source);
  const manifest = target => browserManifest(source, version, browserTarget(['--target', target]));
  assert.deepEqual(source.permissions, [...sharedPermissions, 'sidePanel']);
  for (const candidate of [source, manifest('chrome'), manifest('firefox'), manifest('orion')]) {
    assert.equal(candidate.optional_permissions, undefined);
    assert.equal(candidate.optional_host_permissions, undefined);
  }
  assert.deepEqual(manifest('chrome'), { ...source, version, permissions: [...source.permissions, ...journeyPermissions] });
  const firefox = manifest('firefox');
  assert.equal(firefox.version, version);
  assert.deepEqual(firefox.background, { scripts: ['background.js'] });
  assert.equal(firefox.browser_specific_settings.gecko.id, 'briefmark@briefmark.app');
  assert.equal(firefox.name, 'anmerko');
  assert.equal(firefox.sidebar_action.default_title, 'anmerko');
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, '142.0');
  assert.equal(firefox.browser_specific_settings.gecko_android.strict_min_version, '142.0');
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
  assert.equal(firefox.sidebar_action.default_panel, 'sidebar.html');
  assert.equal(firefox.sidebar_action.default_title, 'anmerko');
  assert.equal(firefox.sidebar_action.open_at_install, false);
  assert.deepEqual(firefox.permissions, [...sharedPermissions, ...journeyPermissions]);
  assert.equal(firefox.minimum_chrome_version, undefined);
  assert.equal(firefox.side_panel, undefined);
  assert.equal(firefox.host_permissions, undefined);
  const orion = manifest('orion');
  assert.equal(orion.version, version);
  assert.deepEqual(orion.permissions, sharedPermissions);
  assert.deepEqual(orion.background, { scripts: ['background.js'] });
  assert.equal(orion.action.default_popup, 'popup.html');
  assert.equal(orion.minimum_chrome_version, undefined);
  assert.equal(orion.side_panel, undefined);
  assert.equal(orion.sidebar_action, undefined);
  assert.equal(orion.browser_specific_settings, undefined);
  assert.equal(orion.host_permissions, undefined);
  assert.deepEqual(source, original, 'transforms must not contaminate another target');
});

test('supported browser targets build clean resources and reject development helpers during packaging', async t => {
  const root = await mkdtemp(join(tmpdir(), 'anmerko-browser-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['src', 'public', 'package.json']) await cp(file, join(root, file), { recursive: true });
  const build = (args, env = process.env) => exec(process.execPath, [resolve('scripts/extension/build.mjs'), ...args], { cwd: root, env });
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'dist/keep.txt'), 'existing Chrome build');
  await assert.rejects(build(['--target', 'opera']));
  assert.equal(await readFile(join(root, 'dist/keep.txt'), 'utf8'), 'existing Chrome build');
  for (const { args, outdir, suffix } of [
    { args: [], outdir: 'dist', suffix: '' },
    { args: ['--firefox'], outdir: 'dist-firefox', suffix: '-firefox-unsigned' },
    { args: ['--target', 'orion'], outdir: 'dist-orion', suffix: '-orion' },
  ]) {
    const pack = () => exec(process.execPath, [resolve('scripts/extension/package.mjs'), ...args], { cwd: root });
    const target = browserTarget(args);
    // Journeys are the target's capability: the retired switch changes nothing.
    await build(args, { ...process.env, ANMERKO_JOURNEYS: target.journeys ? '0' : '1' });
    const manifest = JSON.parse(await readFile(join(root, outdir, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest, browserManifest(source, version, target));
    assert.deepEqual(manifest.permissions.filter(permission => journeyPermissions.includes(permission)),
      target.journeys ? journeyPermissions : [], `${target.name}: journey permissions`);
    // Orion's background bundle drops the journey runtime, not just its activation.
    const background = await readFile(join(root, outdir, 'background.js'), 'utf8');
    for (const marker of [/\bfunction bindJourneyExtension\(/, /\.webNavigation\b/, /\.alarms\.onAlarm\b/]) {
      assert.equal(marker.test(background), target.journeys, `${target.name}: ${marker}`);
    }
    const files = await readdir(join(root, outdir));
    for (const name of ['content.js', 'background.js', 'popup.js', 'sidebar.html', 'unavailable.html', 'icons']) {
      assert.ok(files.includes(name), `${target.name}: ${name}`);
    }
    // Orion ships no journey page or scripts, and its content script carries no
    // journey launch, review offer, saved list, recording strip or view, and no
    // journey model, limits, export or availability check behind them.
    const journeyFiles = ['journey.html', 'journey.js', 'journey-observer.js'];
    for (const name of journeyFiles) assert.equal(files.includes(name), target.journeys, `${target.name}: ${name}`);
    const content = await readFile(join(root, outdir, 'content.js'), 'utf8');
    for (const marker of ['ANMERKO_JOURNEY_OPEN', 'ANMERKO_JOURNEY_PENDING', 'ANMERKO_JOURNEY_PHASE', 'Record journey', 'Review journey', 'Saved journeys',
      'anmerko journey recording', 'anmerko-journey-strip', '.journey-view', 'function attachJourneyPanel(', 'function mountJourneyUI(',
      'function createJourneyClient(', 'function bindJourneyPage(', 'function validateJourneyDraft(', 'var JOURNEY_LIMITS =',
      'function journeyArchiveFiles(', 'function journeyPromptSection(', 'function journeysAvailable(', 'function stripUrlCredentials(']) {
      assert.equal(content.includes(marker), target.journeys, `${target.name}: content.js ${marker}`);
    }
    // Every bundle reads the capability from the build: an unreplaced define
    // would silently leave journeys out.
    for (const name of ['content.js', 'background.js', 'popup.js', ...target.journeys ? ['journey.js', 'journey-observer.js'] : []]) {
      assert.doesNotMatch(await readFile(join(root, outdir, name), 'utf8'), /__TARGET_JOURNEYS__|ANMERKO_JOURNEYS/, `${target.name}: ${name}`);
    }
    await pack();
    const archive = join(root, `artifacts/anmerko-${version}${suffix}.zip`);
    const zip = await readFile(archive);
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    const { stdout: entries } = await exec('unzip', ['-Z1', archive]);
    assert.match(entries, /^manifest\.json$/m, 'the extension manifest is at the ZIP root');
    assert.doesNotMatch(entries, new RegExp(`^anmerko-${version.replaceAll('.', '\\.')}${suffix.replaceAll('.', '\\.')}/`), 'the ZIP has no redundant wrapper directory');
    for (const helper of ['anmerko-dev-install.js', 'retired-dev-install.js']) {
      await writeFile(join(root, outdir, helper), 'test helper');
      await assert.rejects(pack(), error => /Development update helper/.test(error.stderr));
      assert.deepEqual(await readFile(archive), zip, 'rejection preserves the previous archive');
      await rm(join(root, outdir, helper));
    }
    for (const marker of ['ANMERKO_DEV_VERIFY', 'RETIRED_DEV_VERIFY']) {
      await writeFile(join(root, outdir, 'background.js'), marker);
      await assert.rejects(pack(), error => /Development update helper/.test(error.stderr));
    }
    await build(args);
    assert.ok(!(await readFile(join(root, outdir, 'background.js'), 'utf8')).includes('RETIRED_DEV_VERIFY'));
    await pack();
  }
});

test('the listed and unlisted Firefox review source archives reproduce their explicit versions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'anmerko-review-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts/extension'), { recursive: true });
  for (const file of ['src', 'public', 'package.json', 'package-lock.json', 'tsconfig.json', 'LICENSE', 'scripts/extension/build.mjs', 'scripts/extension/build-version.mjs', 'scripts/extension/browser-targets.mjs']) {
    await cp(file, join(root, file), { recursive: true });
  }
  for (const releaseVersion of [version, `${version}.1`]) {
    const env = { ...process.env, RELEASE_VERSION: releaseVersion };
    await exec(process.execPath, [resolve('scripts/extension/build.mjs'), '--firefox'], { cwd: root, env });
    await exec(process.execPath, [resolve('scripts/extension/package-firefox-source.mjs')], { cwd: root, env });
    const unpacked = join(root, `review-${releaseVersion}`);
    await exec('unzip', ['-q', join(root, `artifacts/anmerko-${releaseVersion}-firefox-source.zip`), '-d', unpacked]);
    assert.match(await readFile(join(unpacked, 'README-SOURCE.md'), 'utf8'), new RegExp(`RELEASE_VERSION=${releaseVersion.replaceAll('.', '\\.')}`));
    // Use the installed, locked dependencies without downloading another copy.
    await symlink(resolve('node_modules'), join(unpacked, 'node_modules'), 'junction');
    await exec(process.execPath, [join(unpacked, 'scripts/extension/build.mjs'), '--firefox'], { cwd: unpacked, env });
    for (const file of await readdir(join(root, 'dist-firefox'), { recursive: true, withFileTypes: true })) {
      if (!file.isFile()) continue;
      const original = join(file.parentPath, file.name);
      const relative = original.slice(join(root, 'dist-firefox').length + 1);
      assert.deepEqual(await readFile(join(unpacked, 'dist-firefox', relative)), await readFile(original), `${releaseVersion}: ${relative}`);
    }
  }
});
