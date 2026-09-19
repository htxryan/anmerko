import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPublicSource, scanPublicText } from '../scripts/check-public-source.mjs';

const privateEmail = ['person', 'private-company.example'].join('@');
const privateMacPath = ['', 'Users', 'named-user', 'project'].join('/');
const privateLinuxPath = ['', 'home', 'named-user', 'project'].join('/');
const privateDashboard = ['https:/', 'dash.cloudflare.com', 'profile'].join('/');
const privateAccount = `account_${'id'} = ${'a'.repeat(32)}`;
const nestedPrivateAccount = JSON.stringify({ account: { id: 'b'.repeat(32) } }, null, 2);
const encodedMacPath = ['', 'Users', 'encoded-user', 'project'].join('%2F');
const escapedWindowsPath = ['C:', 'Users', 'encoded-user', 'project'].join('\\\\');
const privateFileUrl = ['file:', '', '', 'Users', 'file-user', 'project'].join('/');

test('public-source scan rejects private identities without returning matched values', () => {
  const source = [privateEmail, privateMacPath, privateLinuxPath, privateDashboard, privateAccount].join('\n');
  const findings = scanPublicText(source, 'fixture.txt');
  assert.deepEqual(findings.map(({ line, rule }) => [line, rule]), [
    [1, 'personal-email'],
    [2, 'machine-user-path'],
    [3, 'machine-user-path'],
    [4, 'private-dashboard-url'],
    [5, 'provider-account-id'],
  ]);
  assert.ok(findings.every(finding => !JSON.stringify(finding).includes('named-user')));
});

test('public-source scan rejects encoded and escaped local paths', () => {
  const findings = scanPublicText([encodedMacPath, escapedWindowsPath, privateFileUrl].join('\n'));
  assert.deepEqual(findings.map(({ line, rule }) => [line, rule]), [
    [1, 'machine-user-path'],
    [2, 'machine-user-path'],
    [3, 'machine-user-path'],
    [3, 'machine-file-url'],
  ]);
});

test('public-source scan catches an account object without exposing its identifier', () => {
  const findings = scanPublicText(nestedPrivateAccount, 'provider.json');
  assert.deepEqual(findings, [{ file: 'provider.json', line: 2, rule: 'provider-account-id' }]);
  assert.ok(!JSON.stringify(findings).includes('b'.repeat(32)));
});

test('public-source scan permits documented public identities and generic examples', () => {
  const source = [
    ['support', 'briefmark.app'].join('@'),
    ['briefmark', 'briefmark.app'].join('@'),
    ['person', 'example.com'].join('@'),
    ['', 'home', 'runner', 'work'].join('/'),
    'https://developers.cloudflare.com/workers/',
    'https://chrome.google.com/webstore/detail/example/public-id',
    'https://addons.mozilla.org/en-US/firefox/addon/example/',
  ].join('\n');
  assert.deepEqual(scanPublicText(source), []);
});

test('public-source check ignores deleted tracked paths but fails on other read errors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'public-source-read-'));
  try {
    assert.deepEqual(await checkPublicSource([join(directory, 'deleted.txt')]), []);
    await assert.rejects(checkPublicSource([directory]), error => error?.code === 'EISDIR');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('public-source check scans a tracked symlink target instead of following it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'public-source-link-'));
  const link = join(directory, 'reference');
  try {
    await symlink(['', 'Users', 'linked-user', 'reference'].join('/'), link);
    assert.deepEqual(await checkPublicSource([link]), [{ file: link, line: 1, rule: 'machine-user-path' }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
