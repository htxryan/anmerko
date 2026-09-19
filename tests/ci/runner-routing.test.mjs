import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const mac = ['self-hosted', 'macOS', 'ARM64', 'macbook-macos-vm'];
const linux = ['self-hosted', 'Linux', 'ARM64', 'macbook-linux'];
function field(workflow, job, name) {
  const source = readFileSync(`.github/workflows/${workflow}.yml`, 'utf8');
  const block = source.match(new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  \\w[^\\n]*:\\n|$(?![\\s\\S]))`, 'm'))?.[1];
  assert.ok(block, `${workflow}/${job} exists`);
  return block.match(new RegExp(`^    ${name}: (.+)$`, 'm'))?.[1];
}
function fields(workflow, job, name) {
  const source = readFileSync(`.github/workflows/${workflow}.yml`, 'utf8');
  const block = source.match(new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  \\w[^\\n]*:\\n|$(?![\\s\\S]))`, 'm'))?.[1];
  assert.ok(block, `${workflow}/${job} exists`);
  const nested = block.match(new RegExp(`^    ${name}:\\n([\\s\\S]*?)(?=^    \\w[^\\n]*:|^  \\w|$(?![\\s\\S]))`, 'm'))?.[1];
  assert.ok(nested, `${workflow}/${job}/${name} exists`);
  return Object.fromEntries([...nested.matchAll(/^      ([-\w]+): (.+)$/gm)].map(([, key, value]) => [key, value]));
}
function evaluate(value, { mode, os = 'macos-latest', trusted = true, privateRepo = true,
  eventName = 'pull_request', scope = 'full', runId = '10', runAttempt = '1',
  artifactPrefix = 'anmerko', source = 'source-sha', chrome = true, firefox = true,
  signedXpi = '' } = {}) {
  if (!value.startsWith('${{')) return value.slice(1, -1).split(',').map(s => s.trim());
  // These routing expressions use the shared JS/GitHub boolean/string subset.
  // Evaluate actual workflow fields to protect the private/public runner boundary.
  const run = new Function('github', 'vars', 'inputs', 'needs', 'fromJSON', 'startsWith', 'format', 'cancelled',
    `return (${value.slice(3, -2)});`);
  return run({ repository: 'owner/repo', event_name: eventName, run_id: runId,
    run_attempt: runAttempt, sha: 'workflow-sha', event: {
    repository: { private: privateRepo }, pull_request: { head: { repo: { full_name: trusted ? 'owner/repo' : 'fork/repo' } } },
  } }, { LINUX_RUNNER_MODE: mode, LOCAL_MACOS_RUNNER: '["macos-latest"]' },
  { os, 'artifact-prefix': artifactPrefix, source, chrome, firefox, 'signed-xpi': signedXpi },
  { changes: { outputs: { scope } } }, JSON.parse, (a, b) => a.toLowerCase().startsWith(b.toLowerCase()),
  (...args) => args.slice(1).reduce((result, argument, index) => result.replaceAll(`{${index}}`, argument), args[0]),
  () => false);
}

test('macOS routing reserves the private runner for internal work', () => {
  for (const os of ['macos-latest', 'macos-26', 'macos-27', 'macos-15-intel']) {
    for (const mode of [undefined, 'local', 'hosted']) {
      assert.deepEqual(evaluate(field('desktop', 'desktop', 'runs-on'), { os, mode }), mac);
      assert.deepEqual(evaluate(field('desktop', 'desktop', 'runs-on'),
        { os, mode, trusted: false }), [os]);
      assert.deepEqual(evaluate(field('desktop', 'desktop', 'runs-on'),
        { os, mode, privateRepo: false }), [os]);
    }
  }
  assert.deepEqual(evaluate(field('desktop', 'desktop', 'runs-on'),
    { eventName: 'push' }), mac);
  assert.deepEqual(evaluate(field('desktop', 'desktop', 'runs-on'),
    { eventName: 'push', privateRepo: false }), ['macos-latest']);
  assert.equal(evaluate(field('desktop', 'desktop', 'if'), { trusted: false }), true);
  assert.equal(evaluate(field('desktop', 'desktop', 'if'), { os: 'windows-latest' }), false);
});

test('trusted private macOS desktop jobs use one FIFO VM queue', () => {
  const concurrency = fields('desktop', 'desktop', 'concurrency');
  assert.equal(concurrency.queue, 'max');
  assert.equal(concurrency['cancel-in-progress'], undefined);
  const group = concurrency.group;
  assert.equal(evaluate(group), 'anmerko-private-macos-vm-desktop');
  assert.equal(evaluate(group, { os: 'macos-26', eventName: 'push' }),
    'anmerko-private-macos-vm-desktop');

  const unique = { runId: '101', runAttempt: '2', artifactPrefix: 'release-proof',
    source: 'candidate-sha', chrome: false, firefox: true, signedXpi: 'signed.xpi' };
  assert.equal(evaluate(group, { ...unique, trusted: false }),
    'desktop-101-2-release-proof-macos-latest-candidate-sha-false-true-signed.xpi');
  assert.equal(evaluate(group, { ...unique, privateRepo: false }),
    'desktop-101-2-release-proof-macos-latest-candidate-sha-false-true-signed.xpi');
  assert.equal(evaluate(group, { ...unique, os: 'ubuntu-latest' }),
    'desktop-101-2-release-proof-ubuntu-latest-candidate-sha-false-true-signed.xpi');
  assert.equal(evaluate(group, { ...unique, runId: '202', runAttempt: '3',
    artifactPrefix: 'other', source: 'other-sha' }), 'anmerko-private-macos-vm-desktop');
});

test('all compatible Linux jobs prefer local and support explicit hosted routing', () => {
  const jobs = { check: ['changes', 'lint', 'chrome', 'firefox', 'site'],
    'release-validation': ['resolve', 'candidate', 'validate'], deploy: ['eligible', 'deploy'] };
  for (const [workflow, names] of Object.entries(jobs)) {
    for (const name of names) {
      const route = field(workflow, name, 'runs-on');
      assert.deepEqual(evaluate(route), linux, `${workflow}/${name} defaults local`);
      assert.deepEqual(evaluate(route, { mode: 'hosted' }), ['ubuntu-latest']);
      assert.deepEqual(evaluate(route, { trusted: false }), ['ubuntu-latest']);
    }
  }
  const releaseController = field('release', 'release', 'runs-on');
  assert.deepEqual(evaluate(releaseController), linux);
  assert.deepEqual(evaluate(releaseController, { mode: 'hosted' }), ['ubuntu-latest']);
  assert.deepEqual(evaluate(field('desktop', 'desktop', 'runs-on'), { os: 'ubuntu-latest' }), ['ubuntu-latest']);
});

test('Linux desktop checks refresh both stable Chromium channels before testing', () => {
  const workflow = readFileSync('.github/workflows/desktop.yml', 'utf8');
  assert.match(workflow, /if \[ "\$RUNNER_OS" != Linux \][\s\S]*else\n\s+# Runner-bundled Chromium channels[\s\S]*npx playwright install --force chrome msedge/);
  assert.match(workflow, /name: Test Chrome[\s\S]*name: Test Edge/);
});

test('runner controls use the anmerko environment contract and documented defaults', () => {
  const files = ['scripts/runners/control.sh', 'scripts/runners/register-linux.sh',
    'scripts/runners/register-macos.sh', 'scripts/runners/install-macos-vm-service.sh',
    'scripts/browsers/test-desktop.mjs', 'tests/shared/desktop-session.mjs', 'docs/store/capture.mjs'];
  const source = files.map(file => readFileSync(file, 'utf8')).join('\n');
  for (const name of ['ANMERKO_DESKTOP_BROWSER', 'ANMERKO_DESKTOP_EXECUTABLE', 'ANMERKO_TART_BIN',
    'ANMERKO_MACOS_VM', 'ANMERKO_DOCKER_CONTEXT', 'ANMERKO_RUNNER_IMAGE', 'ANMERKO_REPOSITORY']) {
    assert.match(source, new RegExp(name));
  }
  const guide = readFileSync('docs/local-runners.md', 'utf8');
  for (const configured of ['anmerko-ci', 'anmerko-actions-runner:2.337.0',
    'anmerko.runner-group=linux', 'anmerko.repository',
    'local.github-actions.{macos-vm,colima}.plist']) {
    assert.ok(guide.includes(configured), `document runner default ${configured}`);
  }
});
