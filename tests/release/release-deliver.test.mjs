import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertPromotionAuthor, assertSignedVariant, chromeReviewState, firefoxReviewNotes, promotableCheck, successfulDeploy } from '../../scripts/release/release-deliver.mjs';
import { activeRepository } from '../../scripts/release/release-repository.mjs';
const active = activeRepository();
const inactive = 'htxryan/other';

test('Firefox reviewer instructions match each exact submitted version and source archive', () => {
  for (const version of ['0.5.5', '0.5.5.1']) {
    const archive = `anmerko-${version}-firefox-source.zip`;
    const notes = firefoxReviewNotes(version, `/private/candidate/${archive}`);
    assert.ok(notes.includes(`source archive ${archive} for extension version ${version}.`));
    assert.ok(notes.includes(`npm ci\nRELEASE_VERSION=${version} npm run build:firefox`));
    assert.ok(notes.includes('Node.js 24 or later'));
    assert.ok(notes.includes('dist-firefox'));
    assert.ok(!notes.includes('/private/'));
    const other = version === '0.5.5' ? '0.5.5.1' : '0.5.5';
    assert.ok(!notes.includes(`RELEASE_VERSION=${other} npm`));
  }
});

test('Mozilla signing may add META-INF only and cannot alter extension payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anmerko-signed-'));
  try {
    const unsignedDir = join(root, 'unsigned'), signedDir = join(root, 'signed');
    execFileSync('mkdir', ['-p', unsignedDir, join(signedDir, 'META-INF')]);
    const manifest = '{"version":"0.5.4.1","browser_specific_settings":{"gecko":{"id":"briefmark@briefmark.app"}}}';
    await writeFile(join(unsignedDir, 'manifest.json'), manifest); await writeFile(join(unsignedDir, 'code.js'), 'same');
    await writeFile(join(signedDir, 'manifest.json'), manifest); await writeFile(join(signedDir, 'code.js'), 'same'); await writeFile(join(signedDir, 'META-INF', 'mozilla.rsa'), 'signed');
    execFileSync('zip', ['-qr', join(root, 'unsigned.zip'), '.'], { cwd: unsignedDir }); execFileSync('zip', ['-qr', join(root, 'signed.xpi'), '.'], { cwd: signedDir });
    assert.doesNotThrow(() => assertSignedVariant(join(root, 'signed.xpi'), join(root, 'unsigned.zip'), '0.5.4.1'));
    await writeFile(join(signedDir, 'code.js'), 'changed'); execFileSync('zip', ['-qrFS', join(root, 'signed.xpi'), '.'], { cwd: signedDir });
    assert.throws(() => assertSignedVariant(join(root, 'signed.xpi'), join(root, 'unsigned.zip'), '0.5.4.1'), /changed payload/);
    await writeFile(join(signedDir, 'code.js'), 'same'); await writeFile(join(signedDir, 'manifest.json'), '{"version":"0.5.4.1","browser_specific_settings":{"gecko":{"id":"wrong@example.com"}}}');
    execFileSync('zip', ['-qrFS', join(root, 'signed.xpi'), '.'], { cwd: signedDir });
    assert.throws(() => assertSignedVariant(join(root, 'signed.xpi'), join(root, 'unsigned.zip'), '0.5.4.1'), /GUID changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Chrome state distinguishes a published revision from review', () => {
  assert.equal(chromeReviewState({ status: { publishedItemRevisionStatus: { distributionChannels: [{ crxVersion: '0.5.3' }] } } }, '0.5.3'), 'published');
  assert.equal(chromeReviewState({ status: { submittedItemRevisionStatus: { distributionChannels: [{ crxVersion: '0.5.4' }] } } }, '0.5.4'), 'pending-review');
});

test('promotion accepts only a successful explicit Check for the exact immutable PR head', () => {
  const head = 'a'.repeat(40), base = { path: '.github/workflows/check.yml', head_sha: head, head_branch: 'main', event: 'workflow_dispatch',
    repository: { full_name: active }, head_repository: { full_name: active }, status: 'completed', conclusion: 'success' };
  assert.deepEqual(promotableCheck([base], head), base);
  for (const patch of [{ head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { status: 'in_progress' }, { conclusion: 'failure' }]) {
    assert.equal(promotableCheck([{ ...base, ...patch }], head), null);
  }
  assert.equal(promotableCheck([{ ...base, repository: { full_name: inactive } }], head), null);
  assert.equal(promotableCheck([{ ...base, head_repository: { full_name: inactive } }], head), null);
});

test('deployment success requires both live repository identities', () => {
  const head = 'a'.repeat(40), base = { path: '.github/workflows/deploy.yml', head_sha: head, event: 'workflow_dispatch',
    repository: { full_name: active }, head_repository: { full_name: active }, status: 'completed', conclusion: 'success' };
  assert.deepEqual(successfulDeploy([base], head), base);
  assert.equal(successfulDeploy([{ ...base, repository: { full_name: inactive } }], head), null);
  assert.equal(successfulDeploy([{ ...base, head_repository: { full_name: inactive } }], head), null);
});

test('private account identifiers come from the production environment', async () => {
  const listings = JSON.parse(await readFile('docs/store/listings.json', 'utf8'));
  assert.equal(listings.chromeWebStore.publisherId, undefined);
  assert.equal(listings.chromeWebStore.dashboardUrl, undefined);
  assert.equal(listings.edgeAddOns.productId, undefined);
  for (const config of ['site/wrangler.jsonc', 'site/support/wrangler.jsonc']) {
    assert.doesNotMatch(await readFile(config, 'utf8'), /"account_id"/);
  }
  const workflow = await readFile('.github/workflows/release.yml', 'utf8');
  assert.match(workflow, /CWS_PUBLISHER_ID: \$\{\{ secrets\.CWS_PUBLISHER_ID \}\}/);
  const deploy = await readFile('.github/workflows/deploy.yml', 'utf8');
  assert.match(deploy, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  assert.match(deploy, /\[ -z "\$CLOUDFLARE_ACCOUNT_ID" \]/);
  const controller = await readFile('scripts/release/release-deliver.mjs', 'utf8');
  assert.match(controller, /publisherId: process\.env\.CWS_PUBLISHER_ID/);
});


test('promotion authors match the authenticated release App or built-in Actions identity', () => {
  assert.doesNotThrow(() => assertPromotionAuthor({ login: 'anmerko-release[bot]' }, 'anmerko-release'));
  assert.doesNotThrow(() => assertPromotionAuthor({ login: 'github-actions[bot]' }, 'anmerko-release'));
  assert.throws(() => assertPromotionAuthor({ login: 'other[bot]' }, 'anmerko-release'), /unexpected author/);
  assert.throws(() => assertPromotionAuthor({ login: 'anmerko-release' }, 'anmerko-release'), /unexpected author/);
  assert.throws(() => assertPromotionAuthor({ login: 'anmerko-release[bot]' }, ''), /unexpected author/);
  assert.throws(() => assertPromotionAuthor({ login: 'anmerko-release[bot]' }, 'anmerko-release[bot]'), /Invalid/);
});
