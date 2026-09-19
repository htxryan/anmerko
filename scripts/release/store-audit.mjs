import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createAmoJwtProvider, createChromeServiceAccountTokenProvider, createChromeStoreClient } from './store-api.mjs';

// Only allowlisted values enter the report. Author/account details, contact
// addresses, private source URLs and freeform reviewer text never leave memory.
const versionNumber = value => typeof value === 'string' && /^\d+(?:\.\d+){1,3}$/.test(value) ? value : null;
const localeKeys = value => Object.keys(value || {}).filter(key => /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(key)).sort();
const textAudit = value => {
  // AMO wraps outgoing links separately from their translations.
  if (value && typeof value === 'object' && Object.hasOwn(value, 'url')) value = value.url;
  const values = typeof value === 'string' ? [value] : Object.values(value || {}).filter(v => typeof v === 'string');
  return { configured: values.some(Boolean), locales: typeof value === 'string' ? [] : localeKeys(value), canonicalOrigin: values.some(v => v.includes('https://anmerko.com')), currentNameMentioned: values.some(v => /\banmerko\b/i.test(v)), currentNameOnly: values.length > 0 && values.every(v => v === 'anmerko') };
};
const pickEnum = (value, allowed) => allowed.includes(value) ? value : null;
const boolean = value => typeof value === 'boolean' ? value : null;
const safeInteger = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const stringList = value => Array.isArray(value) ? value.filter(v => typeof v === 'string' && /^[A-Za-z0-9_.<>:*/-]+$/.test(v) && v.length < 120 && !v.includes('@')) : null;

export function sanitizeChromeStatus(status) {
  const revision = value => value ? {
    state: pickEnum(value.state, ['ITEM_STATE_UNSPECIFIED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS', 'PENDING_REVIEW', 'STAGED', 'REJECTED', 'CANCELLED']),
    distributionChannels: (value.distributionChannels || []).map(channel => ({ version: versionNumber(channel.crxVersion), deployPercentage: safeInteger(channel.deployPercentage) })),
  } : null;
  return { lastAsyncUploadState: pickEnum(status.lastAsyncUploadState, ['UPLOAD_STATE_UNSPECIFIED', 'SUCCEEDED', 'FAILED', 'IN_PROGRESS', 'NOT_FOUND']), takenDown: boolean(status.takenDown), warned: boolean(status.warned), published: revision(status.publishedItemRevisionStatus), submitted: revision(status.submittedItemRevisionStatus) };
}

// https://mozilla.github.io/addons-server/topics/api/addons.html documents
// detail, all_with_unlisted version list, and eula_policy GET endpoints.
export async function auditAmo({ fetch = globalThis.fetch, jwt, addonId, maxPages = 20 }) {
  assert.equal(typeof jwt, 'function'); assert.ok(addonId); assert.ok(Number.isInteger(maxPages) && maxPages > 0 && maxPages <= 20);
  const base = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(addonId)}/`;
  const get = async suffix => {
    const response = await fetch(base + suffix, { method: 'GET', redirect: 'error', headers: { Authorization: `JWT ${jwt()}` }, signal: AbortSignal.timeout(30000) });
    if (!response.ok) { const error = new Error('AMO audit failed'); error.status = response.status; throw error; }
    return response.json();
  };
  const addon = await get(''); assert.equal(addon.guid, addonId, 'AMO identity mismatch');
  // https://mozilla.github.io/addons-server/topics/api/authors.html#author-list
  // documents author access; upstream also permits reviewer read access.
  const authors = await get('authors/'); assert.ok(Array.isArray(authors), 'Invalid AMO authors');
  const policy = await get('eula_policy/'), versions = [];
  for (let page = 1; ; page++) {
    const result = await get(`versions/?filter=all_with_unlisted&page_size=50&page=${page}`);
    assert.ok(Array.isArray(result.results), 'Invalid AMO version list');
    for (const value of result.results) {
      versions.push({
        id: safeInteger(value.id), version: versionNumber(value.version),
        channel: pickEnum(value.channel, ['listed', 'unlisted', 'enterprise']),
        status: pickEnum(value.file?.status, ['public', 'disabled', 'unreviewed']),
        reviewed: Boolean(value.reviewed), sourceSubmitted: Boolean(value.source),
        authorFieldsVisible: Object.hasOwn(value, 'source') || Object.hasOwn(value, 'approval_notes'),
        approvalNotes: textAudit(value.approval_notes), releaseNotes: textAudit(value.release_notes),
        hash: /^sha256:[a-f0-9]{64}$/.test(value.file?.hash) ? value.file.hash : null,
        compatibility: Object.fromEntries(['firefox', 'android'].filter(app => value.compatibility?.[app]).map(app => [app, {
          min: versionNumber(value.compatibility[app].min),
          max: value.compatibility[app].max === '*' ? '*' : versionNumber(value.compatibility[app].max),
        }])),
        permissions: stringList(value.file?.permissions),
        hostPermissions: stringList(value.file?.host_permissions),
        dataCollectionPermissions: stringList(value.file?.data_collection_permissions),
      });
    }
    if (!result.next) break;
    // Never follow server-supplied pagination URLs with credentials.
    assert.ok(page < maxPages, 'AMO pagination limit exceeded');
  }
  return {
    identityPreserved: true, defaultLocale: localeKeys({ [addon.default_locale]: true })[0] || null,
    authorEndpointAccessConfirmed: true,
    authorRoles: { owners: authors.filter(value => value.role === 'owner').length, developers: authors.filter(value => value.role === 'developer').length },
    slugConfigured: typeof addon.slug === 'string' && addon.slug.length > 0, slugCurrent: addon.slug === 'anmerko',
    status: pickEnum(addon.status, ['public', 'deleted', 'disabled', 'rejected', 'nominated', 'incomplete']),
    disabled: boolean(addon.is_disabled),
    fields: Object.fromEntries(['name', 'summary', 'description', 'homepage', 'support_url', 'developer_comments'].map(key => [key, textAudit(addon[key])])),
    supportEmailConfigured: textAudit(addon.support_email).configured,
    privacyPolicy: textAudit(policy.privacy_policy), eula: textAudit(policy.eula),
    previews: (addon.previews || []).map(value => ({
      id: safeInteger(value.id), caption: textAudit(value.caption), position: safeInteger(value.position),
      dimensions: Array.isArray(value.image_size) ? value.image_size.map(safeInteger) : null,
    })),
    versions,
  };
}

export async function main() {
  assert.equal(process.env.GITHUB_REPOSITORY, 'htxryan/anmerko');
  assert.equal(process.env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  const listings = JSON.parse(await readFile(new URL('../../docs/store/listings.json', import.meta.url)));
  const report = { schema: 1, auditedAt: new Date().toISOString(), source: process.env.GITHUB_SHA, readOnly: true };
  let failed = false;
  for (const store of ['chrome', 'firefox']) {
    try {
      if (store === 'firefox') report.firefox = await auditAmo({ jwt: createAmoJwtProvider({ issuer: process.env.WEB_EXT_API_KEY, secret: process.env.WEB_EXT_API_SECRET }), addonId: listings.mozillaAddOns.addonId });
      else {
        const account = JSON.parse(process.env.CWS_SERVICE_ACCOUNT_JSON);
        const client = createChromeStoreClient({ accessToken: createChromeServiceAccountTokenProvider({ clientEmail: account.client_email, privateKey: account.private_key }), publisherId: process.env.CWS_PUBLISHER_ID, itemId: listings.chromeWebStore.listingId, retries: 0 });
        report.chrome = sanitizeChromeStatus(await client.fetchStatus());
      }
    } catch (error) {
      // Provider bodies and arbitrary exception messages can include secrets.
      report[store] = { failed: true, httpStatus: safeInteger(error.status), code: pickEnum(error.code, ['NETWORK_ERROR', 'AUTHENTICATION_ERROR']) };
      failed = true;
    }
  }
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/store-audit.json', JSON.stringify(report, null, 2) + '\n');
  if (failed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
