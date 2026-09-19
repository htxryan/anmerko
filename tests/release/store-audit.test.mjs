import assert from 'node:assert/strict';
import test from 'node:test';
import { auditAmo, sanitizeChromeStatus } from '../../scripts/release/store-audit.mjs';

const json = value => new Response(JSON.stringify(value));
test('AMO audit uses only authenticated GETs and excludes private text, accounts and URLs', async () => {
  const calls = [], secret = 'private@example.test';
  const fetch = async (url, init) => {
    calls.push([url, init]);
    if (url.includes('/authors/')) return json([{ role: 'owner', email: secret, user_id: 123 }]);
    if (url.includes('/eula_policy/')) return json({ privacy_policy: { 'en-US': secret + ' Retired Product' } });
    if (url.includes('/versions/')) return json({ next: null, results: [{ id: 7, version: '0.5.4', channel: 'listed', source: 'https://private/source', approval_notes: secret + ' Retired Product', file: { status: 'unreviewed', hash: 'sha256:' + 'a'.repeat(64), permissions: ['activeTab'] } }] });
    return json({ guid: 'fixture@example.test', default_locale: 'en-US', slug: 'retired-product', status: 'nominated', name: { 'en-US': 'Retired Product', de: 'Retired Product' }, homepage: { url: { 'en-US': 'https://retired.example.test' }, outgoing: 'https://private/redirect' }, description: { 'en-US': secret }, authors: [{ email: secret }], support_email: { 'en-US': secret }, previews: [{ id: 3, image_url: 'https://private/image', caption: { 'en-US': 'Retired Product' } }] });
  };
  const value = await auditAmo({ fetch, jwt: () => 'token', addonId: 'fixture@example.test' });
  assert.ok(calls.every(([, init]) => init.method === 'GET' && init.redirect === 'error' && init.headers.Authorization === 'JWT token'));
  assert.ok(calls.some(([url]) => url.includes('filter=all_with_unlisted')));
  assert.deepEqual(value.fields.name.locales, ['de', 'en-US']);
  assert.equal(value.fields.name.currentNameMentioned, false);
  assert.equal(value.fields.name.currentNameOnly, false);
  assert.deepEqual(value.fields.homepage.locales, ['en-US']);
  assert.equal(value.fields.homepage.canonicalOrigin, false);
  assert.equal(value.slugConfigured, true);
  assert.equal(value.slugCurrent, false);
  assert.equal(value.versions[0].sourceSubmitted, true);
  assert.equal(value.versions[0].approvalNotes.currentNameOnly, false);
  assert.equal(value.supportEmailConfigured, true);
  assert.equal(value.authorEndpointAccessConfirmed, true);
  assert.deepEqual(value.authorRoles, { owners: 1, developers: 0 });
  assert.ok(!JSON.stringify(value).includes(secret));
  assert.ok(!JSON.stringify(value).includes('https://private'));
});
test('AMO audit reports canonical current public copy without returning raw text', async () => {
  const secret = 'current-private@example.test';
  const fetch = async url => {
    if (url.includes('/authors/')) return json([]);
    if (url.includes('/eula_policy/')) return json({ privacy_policy: { 'en-US': secret } });
    if (url.includes('/versions/')) return json({ next: null, results: [] });
    return json({
      guid: 'current@example.test', default_locale: 'en-US', slug: 'anmerko', status: 'public',
      name: { 'en-US': 'Anmerko' }, summary: { 'en-US': 'Collect feedback with ANMERKO.' },
      homepage: { url: { 'en-US': 'https://anmerko.com' } }, support_email: { 'en-US': secret },
    });
  };
  const value = await auditAmo({ fetch, jwt: () => 'token', addonId: 'current@example.test' });
  assert.equal(value.slugConfigured, true);
  assert.equal(value.slugCurrent, true);
  assert.equal(value.fields.name.currentNameMentioned, true);
  assert.equal(value.fields.summary.currentNameMentioned, true);
  assert.equal(value.fields.homepage.canonicalOrigin, true);
  assert.ok(!JSON.stringify(value).includes(secret));
  assert.ok(!JSON.stringify(value).includes('Collect feedback'));
});
test('AMO audit rejects unexpected GUID and bounds pagination without following response URLs', async () => {
  await assert.rejects(auditAmo({ fetch: async () => json({ guid: 'wrong' }), jwt: () => 'token', addonId: 'fixture@example.test' }), /identity/);
  const calls = [];
  const fetch = async url => { calls.push(url); return json(url.includes('/authors/') ? [] : url.includes('/versions/') ? { next: 'https://attacker.test/', results: [] } : url.includes('/eula_policy/') ? {} : { guid: 'fixture@example.test' }); };
  await assert.rejects(auditAmo({ fetch, jwt: () => 'token', addonId: 'fixture@example.test', maxPages: 2 }), /pagination/);
  assert.ok(calls.every(url => url.startsWith('https://addons.mozilla.org/api/v5/')));
});
test('Chrome status allowlist excludes publisher identity and response extras', () => {
  const value = sanitizeChromeStatus({ name: 'publishers/private/items/id', secret: 'private', lastAsyncUploadState: 'SUCCEEDED', publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.5.4', deployPercentage: 100, private: 'private' }] } });
  assert.equal(value.published.distributionChannels[0].version, '0.5.4');
  assert.ok(!JSON.stringify(value).includes('private'));
});
