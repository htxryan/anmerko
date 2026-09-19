import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAmoClient, createAmoJwtProvider, createChromeStoreClient, StoreApiError } from '../../scripts/release/store-api.mjs';
import { firefoxReviewNotes } from '../../scripts/release/release-deliver.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fixture = async name => { const dir = await mkdtemp(join(tmpdir(), 'store-api-')); const path = join(dir, name); await writeFile(path, Buffer.from('exact-bytes')); return path; };

test('Chrome resumes matching submitted version without upload or publish', async () => {
  const calls = [], fetch = async (url, init = {}) => { calls.push([url, init]); return json({ submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '0.5.3' }] } }); };
  const client = createChromeStoreClient({ fetch, accessToken: async () => 'secret', publisherId: 'publisher', itemId: 'item' });
  const result = await client.release({ zipPath: '/unused', expectedVersion: '0.5.3' });
  assert.equal(result.uploaded.resumed, true); assert.equal(result.published.resumed, true);
  assert.equal(calls.length, 3); assert.ok(calls.every(([, init]) => !init.body));
});

test('Chrome uploads exact bytes then publishes DEFAULT', async () => {
  const path = await fixture('chrome.zip'), calls = []; let statusCount = 0;
  const fetch = async (url, init = {}) => { calls.push([url, init]); if (url.includes(':upload')) return json({ uploadState: 'SUCCEEDED', crxVersion: '0.5.3' }); if (url.includes(':publish')) return json({ state: 'PENDING_REVIEW' }); statusCount++; return json(statusCount === 2 ? { lastAsyncUploadState: 'SUCCEEDED' } : {}); };
  const client = createChromeStoreClient({ fetch, accessToken: async () => 'secret', publisherId: 'p', itemId: 'i', sleep: async () => {} });
  await client.release({ zipPath: path, expectedVersion: '0.5.3' });
  const upload = calls.find(([url]) => url.includes(':upload')); assert.equal(Buffer.compare(upload[1].body, Buffer.from('exact-bytes')), 0);
  const publish = calls.find(([url]) => url.includes(':publish')); assert.deepEqual(JSON.parse(publish[1].body), { publishType: 'DEFAULT_PUBLISH' });
  assert.ok(calls.every(([, init]) => init.headers.Authorization === 'Bearer secret'));
});

test('Chrome publishes immediately after a synchronous successful upload', async () => {
  const path = await fixture('chrome-sync.zip'); let statusCalls = 0, publishCalls = 0;
  const fetch = async url => {
    if (url.includes(':upload')) return json({ uploadState: 'SUCCEEDED', crxVersion: '0.5.4' });
    if (url.includes(':publish')) { publishCalls++; return json({ state: 'PENDING_REVIEW' }); }
    statusCalls++; return json({ lastAsyncUploadState: 'NOT_FOUND' });
  };
  const client = createChromeStoreClient({ fetch, accessToken: async () => 'secret', publisherId: 'p', itemId: 'i', sleep: async () => {} });
  await client.release({ zipPath: path, expectedVersion: '0.5.4' });
  assert.equal(publishCalls, 1);
  assert.equal(statusCalls, 3, 'Only upload preflight, publish preflight, and final status are fetched');
});

test('Chrome refuses unrelated active submission', async () => {
  const client = createChromeStoreClient({ fetch: async () => json({ submittedItemRevisionStatus: { distributionChannels: [{ crxVersion: '0.5.4' }] } }), accessToken: async () => 'x', publisherId: 'p', itemId: 'i' });
  await assert.rejects(client.upload({ zipPath: '/unused', expectedVersion: '0.5.3' }), error => error instanceof StoreApiError && error.code === 'ACTIVE_SUBMISSION');
});

test('store API requests have a configurable bounded timeout', async () => {
  const fetch = (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  const client = createChromeStoreClient({ fetch, accessToken: async () => 'x', publisherId: 'p', itemId: 'i', retries: 0, requestTimeoutMs: 5 });
  await assert.rejects(client.fetchStatus(), error => error.code === 'NETWORK_ERROR' && error.message.includes('aborted'));
});

test('uncertain Chrome upload reconciles status without repeating package POST', async () => {
  const path = await fixture('chrome.zip'); let statusCalls = 0, uploadCalls = 0;
  const fetch = async url => {
    if (url.includes(':upload')) { uploadCalls++; throw new Error('connection closed'); }
    statusCalls++; return json(statusCalls === 1 ? {} : { submittedItemRevisionStatus: { distributionChannels: [{ crxVersion: '0.5.3' }] } });
  };
  const client = createChromeStoreClient({ fetch, accessToken: async () => 'x', publisherId: 'p', itemId: 'i' });
  const result = await client.upload({ zipPath: path, expectedVersion: '0.5.3' });
  assert.equal(result.resumed, true); assert.equal(uploadCalls, 1);
});

test('AMO JWT is HS256 and does not expose the secret', () => {
  const token = createAmoJwtProvider({ issuer: 'issuer', secret: 'very-secret', now: () => 1000, nonce: () => 'nonce' })();
  const [header, payload] = token.split('.').slice(0, 2).map(value => JSON.parse(Buffer.from(value, 'base64url')));
  assert.equal(header.alg, 'HS256'); assert.deepEqual(payload, { iss: 'issuer', jti: 'nonce', iat: 1, exp: 61 }); assert.ok(!token.includes('very-secret'));
});

test('AMO listed release uploads exact package and source in one version creation', async () => {
  const zipPath = await fixture('firefox.zip'), sourceZipPath = await fixture('source.zip'), calls = []; let created = false;
  const fetch = async (url, init = {}) => { calls.push([url, init]); if (url.includes('/versions/v0.5.3/')) return created ? json({ id: 44, version: '0.5.3', channel: 'listed', file: { status: 'unreviewed' } }) : json({}, 404); if (url.endsWith('/addons/upload/')) return json({ uuid: 'upload-1' }, 201); if (url.endsWith('/addons/upload/upload-1/')) return json({ uuid: 'upload-1', processed: true, valid: true }); if (url.endsWith('/versions/')) { created = true; return json({ id: 44, version: '0.5.3', channel: 'listed' }, 201); } return json({ id: 44 }); };
  const client = createAmoClient({ fetch, jwt: () => 'token', addonId: 'fixture-addon@example.test', sleep: async () => {} });
  const result = await client.releaseListed({ zipPath, sourceZipPath, version: '0.5.3', metadata: { license: 'mpl-2.0', approval_notes: 'Exact source build instructions', release_notes: { 'en-US': 'Fixes' } } });
  assert.equal(result.resumed, false);
  const upload = calls.find(([url]) => url.endsWith('/addons/upload/'))[1].body; assert.equal(Buffer.from(await upload.get('upload').arrayBuffer()).toString(), 'exact-bytes'); assert.equal(upload.get('channel'), 'listed');
  const create = calls.find(([url]) => url.endsWith('/versions/'))[1].body; assert.equal(Buffer.from(await create.get('source').arrayBuffer()).toString(), 'exact-bytes'); assert.equal(create.get('upload'), 'upload-1');
  assert.equal(create.get('approval_notes'), 'Exact source build instructions');
  assert.equal(create.get('license'), 'mpl-2.0');
  assert.deepEqual(JSON.parse(calls.find(([, init]) => init.method === 'PATCH')[1].body), { release_notes: { 'en-US': 'Fixes' } });
});

for (const channel of ['listed', 'unlisted']) {
  test(`AMO ${channel} resume leaves existing reviewer notes unchanged`, async () => {
    const calls = [], existing = { id: 44, version: '0.5.4', channel, approval_notes: '', file: { status: 'public' } };
    const client = createAmoClient({ fetch: async (url, init = {}) => { calls.push([url, init]); return json(existing); }, jwt: () => 'token', addonId: 'fixture-addon@example.test' });
    const method = channel === 'listed' ? 'releaseListed' : 'signUnlisted';
    const result = await client[method]({ zipPath: '/unused', sourceZipPath: '/unused', version: '0.5.4', metadata: { approval_notes: 'New instructions' } });
    assert.equal(result.resumed, true);
    assert.equal(result.version.approval_notes, '');
    assert.ok(calls.every(([, init]) => !init.body && (!init.method || init.method === 'GET')));
  });
}

test('AMO notes-only creation includes notes before response without a later PATCH', async () => {
  const calls = [];
  const client = createAmoClient({ fetch: async (url, init) => {
    calls.push([url, init]);
    assert.equal(init.method, 'POST');
    assert.equal(init.body.get('approval_notes'), 'Build this exact version');
    return json({ id: 44, version: '0.5.4.1', channel: 'unlisted' }, 201);
  }, jwt: () => 'token', addonId: 'fixture-addon@example.test' });
  await client.createVersion({ uploadId: 'upload-1', metadata: { approval_notes: 'Build this exact version' } });
  assert.equal(calls.length, 1);
});

for (const version of ['0.5.5', '0.5.5.1']) {
  test(`AMO ${version} source filename agrees with exact reviewer instructions`, async () => {
    const filename = `anmerko-${version}-firefox-source.zip`, sourceZipPath = await fixture(filename);
    let requests = 0;
    const client = createAmoClient({ fetch: async (_url, init) => {
      requests++;
      assert.equal(init.method, 'POST');
      assert.equal(init.body.get('source').name, filename);
      assert.equal(Buffer.from(await init.body.get('source').arrayBuffer()).toString(), 'exact-bytes');
      assert.ok(init.body.get('approval_notes').includes(`source archive ${filename} for extension version ${version}.`));
      assert.ok(init.body.get('approval_notes').includes(`RELEASE_VERSION=${version} npm run build:firefox`));
      return json({ id: 44, version }, 201);
    }, jwt: () => 'token', addonId: 'fixture-addon@example.test' });
    await client.createVersion({ uploadId: 'upload-1', sourceZipPath, metadata: { approval_notes: firefoxReviewNotes(version, sourceZipPath) } });
    assert.equal(requests, 1);
  });
}

test('AMO refuses same version across listed and unlisted channels', async () => {
  const client = createAmoClient({ fetch: async () => json({ id: 6483536, version: '0.5.3', channel: 'listed' }), jwt: () => 'token', addonId: 'fixture-addon@example.test' });
  await assert.rejects(client.signUnlisted({ zipPath: '/unused', version: '0.5.3' }), error => error.code === 'VERSION_CHANNEL_CONFLICT');
});


test('AMO accepts the official unreviewed status without polling again', async () => {
  let calls = 0;
  const client = createAmoClient({ fetch: async () => { calls++; return json({ id: 6483536, version: '0.5.3', channel: 'listed', file: { status: 'unreviewed' } }); }, jwt: () => 'token', addonId: 'id' });
  const result = await client.waitForVersion({ version: '0.5.3', attempts: 2 });
  assert.equal(result.id, 6483536); assert.equal(calls, 1);
});

test('AMO retries use a fresh one-time JWT', async () => {
  const authorizations = []; let jwtCalls = 0;
  const fetch = async (_url, init) => { authorizations.push(init.headers.Authorization); return authorizations.length === 1 ? json({}, 503) : json({ id: 10 }); };
  const client = createAmoClient({ fetch, jwt: () => `token-${++jwtCalls}`, addonId: 'id', sleep: async () => {} });
  assert.equal((await client.getVersion('0.5.4')).id, 10);
  assert.deepEqual(authorizations, ['JWT token-1', 'JWT token-2']);
});

test('uncertain AMO version creation reconciles instead of retrying POST', async () => {
  const zipPath = await fixture('firefox.zip'); let created = false, createCalls = 0;
  const fetch = async (url, init = {}) => {
    if (url.includes('/versions/v0.5.4/')) return created ? json({ id: 45, version: '0.5.4', channel: 'unlisted', file: { status: 'public' } }) : json({}, 404);
    if (url.endsWith('/addons/upload/')) return json({ uuid: 'upload-2' }, 201);
    if (url.endsWith('/addons/upload/upload-2/')) return json({ processed: true, valid: true });
    if (url.endsWith('/versions/') && init.method === 'POST') { createCalls++; created = true; throw new Error('connection closed'); }
    throw new Error(`unexpected ${url}`);
  };
  const client = createAmoClient({ fetch, jwt: () => 'token', addonId: 'id', sleep: async () => {} });
  const result = await client.signUnlisted({ zipPath, version: '0.5.4' });
  assert.equal(result.resumed, true); assert.equal(result.version.id, 45); assert.equal(createCalls, 1);
});

test('AMO signed download enforces version id, public status, origin and preserves bytes', async () => {
  const bytes = Buffer.from([0, 255, 1, 2]); let downloadHeaders;
  const fetch = async (url, init) => {
    if (typeof url === 'string') return json({ id: 10, file: { status: 'public', url: 'https://addons.mozilla.org/file.xpi' } });
    downloadHeaders = init.headers; return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
  const client = createAmoClient({ fetch, jwt: () => 'token', addonId: 'id' });
  assert.deepEqual(await client.downloadSignedXpi({ version: '0.5.4', expectedVersionId: 10 }), bytes);
  assert.equal(downloadHeaders.Authorization, 'JWT token');
});

test('AMO download rejects an untrusted origin before generating download authorization', async () => {
  let jwtCalls = 0;
  const client = createAmoClient({ fetch: async () => json({ id: 10, file: { status: 'public', url: 'https://example.com/file.xpi' } }), jwt: () => { jwtCalls++; return 'token'; }, addonId: 'id' });
  await assert.rejects(client.downloadSignedXpi({ version: '0.5.4', expectedVersionId: 10 }), error => error.code === 'UNTRUSTED_ORIGIN');
  assert.equal(jwtCalls, 1, 'JWT is used for the API lookup only, never sent to the untrusted download origin');
});
