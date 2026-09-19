import { createHmac, createSign, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CHROME_ORIGIN = 'https://chromewebstore.googleapis.com';
const AMO_ORIGIN = 'https://addons.mozilla.org';
const sleepDefault = ms => new Promise(resolve => setTimeout(resolve, ms));
const b64url = value => Buffer.from(value).toString('base64url');

export class StoreApiError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message); this.name = 'StoreApiError'; this.status = status; this.code = code; this.details = details;
  }
}

function assertString(value, name) {
  if (typeof value !== 'string' || !value) throw new TypeError(`${name} is required`);
  return value;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function request(fetch, url, init, { retries = 3, sleep = sleepDefault, timeoutMs = 30000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    let response, body; const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { const attemptInit = typeof init === 'function' ? await init() : init; response = await fetch(url, { ...attemptInit, signal: controller.signal }); body = await responseBody(response); }
    catch (error) {
      if (attempt >= retries) throw new StoreApiError(`Store request failed: ${error.message}`, { code: 'NETWORK_ERROR' });
      await sleep(250 * 2 ** attempt); continue;
    } finally { clearTimeout(timer); }
    if (response.ok) return body;
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      await sleep(250 * 2 ** attempt); continue;
    }
    const detail = typeof body === 'string' ? body.slice(0, 500) : body;
    throw new StoreApiError(`Store request failed with HTTP ${response.status}`, { status: response.status, code: body?.error?.status || body?.code, details: detail });
  }
}

export function createChromeOAuthTokenProvider({ fetch = globalThis.fetch, clientId, clientSecret, refreshToken }) {
  [clientId, clientSecret, refreshToken].forEach((v, i) => assertString(v, ['clientId', 'clientSecret', 'refreshToken'][i]));
  return async () => {
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
    const data = await request(fetch, GOOGLE_TOKEN_URL, { method: 'POST', body });
    return assertString(data?.access_token, 'Google access token');
  };
}

export function createChromeServiceAccountTokenProvider({ fetch = globalThis.fetch, clientEmail, privateKey, tokenUrl = GOOGLE_TOKEN_URL, now = () => Date.now() }) {
  assertString(clientEmail, 'clientEmail'); assertString(privateKey, 'privateKey');
  return async () => {
    const issued = Math.floor(now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({ iss: clientEmail, scope: 'https://www.googleapis.com/auth/chromewebstore', aud: tokenUrl, iat: issued, exp: issued + 3600 }));
    const signer = createSign('RSA-SHA256'); signer.update(`${header}.${claim}`); signer.end();
    const assertion = `${header}.${claim}.${signer.sign(privateKey).toString('base64url')}`;
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion });
    const data = await request(fetch, tokenUrl, { method: 'POST', body });
    return assertString(data?.access_token, 'Google access token');
  };
}

function chromeVersions(status) {
  const versions = [];
  for (const key of ['publishedItemRevisionStatus', 'submittedItemRevisionStatus'])
    for (const channel of status?.[key]?.distributionChannels || []) if (channel.crxVersion) versions.push({ kind: key, version: channel.crxVersion, state: status[key].state });
  return versions;
}

export function createChromeStoreClient({ fetch = globalThis.fetch, accessToken, publisherId, itemId, retries = 3, sleep = sleepDefault, requestTimeoutMs = 30000 }) {
  assertString(publisherId, 'publisherId'); assertString(itemId, 'itemId');
  if (typeof accessToken !== 'function') throw new TypeError('accessToken must be a function');
  const name = `publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(itemId)}`;
  const call = async (path, init = {}, options = {}) => request(fetch, `${CHROME_ORIGIN}${path}`, { ...init, headers: { Authorization: `Bearer ${await accessToken()}`, ...init.headers } }, { retries, sleep, timeoutMs: requestTimeoutMs, ...options });
  const mutate = async (path, init) => { try { return await call(path, init, { retries: 0 }); } catch (error) { if (error.code === 'NETWORK_ERROR' || error.status === 429 || error.status >= 500) error.code = 'UNCERTAIN_MUTATION'; throw error; } };
  const fetchStatus = () => call(`/v2/${name}:fetchStatus`);
  const upload = async ({ zipPath, expectedVersion }) => {
    assertString(expectedVersion, 'expectedVersion');
    const status = await fetchStatus();
    const existing = chromeVersions(status);
    if (existing.some(v => v.version === expectedVersion)) return { resumed: true, status };
    const submitted = existing.find(v => v.kind === 'submittedItemRevisionStatus');
    if (submitted) throw new StoreApiError(`Chrome has an unrelated submitted version ${submitted.version}`, { code: 'ACTIVE_SUBMISSION', details: submitted });
    const bytes = await readFile(zipPath);
    try { return { resumed: false, upload: await mutate(`/upload/v2/${name}:upload`, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: bytes }) }; }
    catch (error) { if (error.code !== 'UNCERTAIN_MUTATION') throw error; const reconciled = await fetchStatus(); if (chromeVersions(reconciled).some(v => v.version === expectedVersion)) return { resumed: true, status: reconciled }; throw error; }
  };
  const waitForUpload = async ({ expectedVersion, attempts = 20, intervalMs = 3000 }) => {
    for (let i = 0; i < attempts; i++) {
      const status = await fetchStatus();
      if (chromeVersions(status).some(v => v.version === expectedVersion) || status.lastAsyncUploadState === 'SUCCEEDED') return status;
      if (['FAILED', 'UPLOAD_FAILED'].includes(status.lastAsyncUploadState)) throw new StoreApiError('Chrome upload failed', { code: status.lastAsyncUploadState, details: status });
      if (i + 1 < attempts) await sleep(intervalMs);
    }
    throw new StoreApiError('Timed out waiting for Chrome upload', { code: 'TIMEOUT' });
  };
  const publish = async ({ expectedVersion }) => {
    const status = await fetchStatus(); const versions = chromeVersions(status);
    if (versions.some(v => v.kind === 'publishedItemRevisionStatus' && v.version === expectedVersion)) return { resumed: true, status };
    const submitted = versions.find(v => v.kind === 'submittedItemRevisionStatus');
    if (submitted && submitted.version !== expectedVersion) throw new StoreApiError(`Chrome has an unrelated submitted version ${submitted.version}`, { code: 'ACTIVE_SUBMISSION' });
    if (submitted?.version === expectedVersion) return { resumed: true, status };
    try { return { resumed: false, publish: await mutate(`/v2/${name}:publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ publishType: 'DEFAULT_PUBLISH' }) }) }; }
    catch (error) { if (error.code !== 'UNCERTAIN_MUTATION') throw error; const reconciled = await fetchStatus(); if (chromeVersions(reconciled).some(v => v.kind === 'submittedItemRevisionStatus' && v.version === expectedVersion)) return { resumed: true, status: reconciled }; throw error; }
  };
  const release = async input => { const uploaded = await upload(input); if (!uploaded.resumed && uploaded.upload?.uploadState !== 'SUCCEEDED') await waitForUpload(input); const published = await publish(input); return { uploaded, published, status: await fetchStatus() }; };
  return { fetchStatus, upload, waitForUpload, publish, release };
}

export function createAmoJwtProvider({ issuer, secret, now = () => Date.now(), nonce = randomUUID }) {
  assertString(issuer, 'issuer'); assertString(secret, 'secret');
  return () => {
    const issued = Math.floor(now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({ iss: issuer, jti: nonce(), iat: issued, exp: issued + 60 }));
    return `${header}.${claim}.${createHmac('sha256', secret).update(`${header}.${claim}`).digest('base64url')}`;
  };
}

export function createAmoClient({ fetch = globalThis.fetch, jwt, addonId, retries = 3, sleep = sleepDefault, allowedDownloadOrigins = [AMO_ORIGIN], downloadTimeoutMs = 30000, maxDownloadBytes = 250 * 1024 * 1024, requestTimeoutMs = 30000 }) {
  assertString(addonId, 'addonId'); if (typeof jwt !== 'function') throw new TypeError('jwt must be a function');
  const addon = encodeURIComponent(addonId), api = `${AMO_ORIGIN}/api/v5`;
  const call = (path, init = {}, options = {}) => request(fetch, `${api}${path}`, () => ({ ...init, headers: { Authorization: `JWT ${jwt()}`, ...init.headers } }), { retries, sleep, timeoutMs: requestTimeoutMs, ...options });
  const mutate = async (path, init) => { try { return await call(path, init, { retries: 0 }); } catch (error) { if (error.code === 'NETWORK_ERROR' || error.status === 429 || error.status >= 500) error.code = 'UNCERTAIN_MUTATION'; throw error; } };
  const getVersion = version => call(`/addons/addon/${addon}/versions/v${encodeURIComponent(version)}/`);
  const findVersion = async version => { try { return await getVersion(version); } catch (e) { if (e.status === 404) return null; throw e; } };
  const createUpload = async ({ zipPath, channel }) => {
    if (!['listed', 'unlisted'].includes(channel)) throw new TypeError('channel must be listed or unlisted');
    const form = new FormData(); form.append('upload', new Blob([await readFile(zipPath)]), 'extension.zip'); form.append('channel', channel);
    return mutate('/addons/upload/', { method: 'POST', body: form });
  };
  const waitForUpload = async ({ uploadId, attempts = 40, intervalMs = 3000 }) => {
    for (let i = 0; i < attempts; i++) {
      const upload = await call(`/addons/upload/${encodeURIComponent(uploadId)}/`);
      if (upload.valid === true && upload.processed === true) return upload;
      if (upload.processed === true && upload.valid === false) throw new StoreApiError('AMO validation failed', { code: 'VALIDATION_FAILED', details: upload.validation });
      if (i + 1 < attempts) await sleep(intervalMs);
    } throw new StoreApiError('Timed out waiting for AMO upload', { code: 'TIMEOUT' });
  };
  const createVersion = async ({ uploadId, sourceZipPath, metadata = {} }) => {
    const form = new FormData(); form.append('upload', uploadId);
    if (sourceZipPath) form.append('source', new Blob([await readFile(sourceZipPath)]), basename(sourceZipPath));
    if (metadata.license) form.append('license', metadata.license);
    if (metadata.approval_notes !== undefined) form.append('approval_notes', metadata.approval_notes);
    const version = await mutate(`/addons/addon/${addon}/versions/`, { method: 'POST', body: form });
    const complex = Object.fromEntries(Object.entries(metadata).filter(([key]) => !['license', 'approval_notes'].includes(key)));
    if (Object.keys(complex).length) await call(`/addons/addon/${addon}/versions/${version.id}/`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(complex) });
    return version;
  };
  const waitForVersion = async ({ version, attempts = 40, intervalMs = 3000 }) => {
    for (let i = 0; i < attempts; i++) { const value = await getVersion(version); if (value.file?.status === 'public' || value.file?.status === 'unreviewed') return value; if (['disabled','rejected'].includes(value.file?.status)) throw new StoreApiError('AMO version failed', { code: value.file.status, details: value }); if (i + 1 < attempts) await sleep(intervalMs); }
    throw new StoreApiError('Timed out waiting for AMO version', { code: 'TIMEOUT' });
  };
  const release = async ({ zipPath, sourceZipPath, version, channel, metadata = {} }) => {
    const existing = await findVersion(version);
    if (existing) {
      if (existing.channel !== channel) throw new StoreApiError(`AMO version ${version} already exists in ${existing.channel}`, { code: 'VERSION_CHANNEL_CONFLICT', details: { id: existing.id, channel: existing.channel } });
      return { resumed: true, version: await waitForVersion({ version }) };
    }
    let upload;
    try { upload = await createUpload({ zipPath, channel }); } catch (error) { if (error.code === 'UNCERTAIN_MUTATION') { const reconciled = await findVersion(version); if (reconciled) return { resumed: true, version: await waitForVersion({ version }) }; } throw error; }
    await waitForUpload({ uploadId: upload.uuid });
    let created;
    try { created = await createVersion({ uploadId: upload.uuid, sourceZipPath, metadata }); } catch (error) { if (error.code === 'UNCERTAIN_MUTATION') { const reconciled = await findVersion(version); if (reconciled?.channel === channel) return { resumed: true, upload, version: await waitForVersion({ version }) }; } throw error; }
    return { resumed: false, upload, version: await waitForVersion({ version: created.version || version }) };
  };
  const downloadSignedXpi = async ({ version, expectedVersionId }) => {
    if (!Number.isInteger(expectedVersionId)) throw new TypeError('expectedVersionId is required for a newly signed XPI');
    const current = await getVersion(version);
    if (current.id !== expectedVersionId) throw new StoreApiError('AMO version identity changed', { code: 'VERSION_MISMATCH' });
    if (current.file?.status !== 'public' || !current.file?.url) throw new StoreApiError('AMO version is not signed and public', { code: 'NOT_SIGNED' });
    const url = new URL(current.file.url); if (url.protocol !== 'https:' || !allowedDownloadOrigins.includes(url.origin)) throw new StoreApiError('AMO returned an untrusted download origin', { code: 'UNTRUSTED_ORIGIN' });
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), downloadTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { Authorization: `JWT ${jwt()}` } });
      if (!response.ok) throw new StoreApiError(`Signed XPI download failed with HTTP ${response.status}`, { status: response.status });
      const declared = Number(response.headers.get('content-length')); if (declared > maxDownloadBytes) throw new StoreApiError('Signed XPI exceeds size limit', { code: 'TOO_LARGE' });
      const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length > maxDownloadBytes) throw new StoreApiError('Signed XPI exceeds size limit', { code: 'TOO_LARGE' });
      return bytes;
    } finally { clearTimeout(timer); }
  };
  return { getVersion, createUpload, waitForUpload, createVersion, waitForVersion, releaseListed: input => release({ ...input, channel: 'listed' }), signUnlisted: input => release({ ...input, channel: 'unlisted' }), downloadSignedXpi };
}
