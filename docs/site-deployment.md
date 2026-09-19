# Site deployment

`anmerko-site` serves public `site/dist/` at `anmerko.com`; `anmerko-support` serves `/support/` and `/support/privacy/`. Configuration lives in `site/wrangler.jsonc` and `site/support/wrangler.jsonc`. Both use static assets and have no bindings.

## Continuous deployment

1. Relevant main changes run **Check → Site**, building the current shared demo and hash-verified approved downloads.
2. **Deploy** accepts a successful main-push Check, or a Release-supplied successful explicit Check for the exact current main commit. It downloads that run's `anmerko-production` artifact without rebuilding.
3. The main-restricted production environment supplies `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` only during publication. Both Worker configs receive dry runs without embedding the private account ID.
4. Deployment verifies every live route and asset byte, redirects, and 404s, with bounded propagation retries.

Ordinary PR/manual Check artifacts and skipped Site jobs cannot deploy. The explicit path is restricted to Release after its exact promotion PR merges and must match current main. Repository-only docs skip Site; shared `src/**` changes select it. Deploy uses non-cancelling production concurrency. A delayed run must prove ancestry and unchanged website, shared UI, favicon, and approved-manifest inputs; uncertain comparisons block deployment.

Evidence retains previous Worker versions, approval manifests, and route results for 30 days. On the first deployment, the exact missing state of both new Workers and the valid legacy approved manifest are recorded as rollback references. Later deployments require and retain the previous manifest from `anmerko.com`; mixed Worker state, authentication failures, network failures, and malformed manifests stop publication. Approved assets and Git history outlive CI retention.

The first-deployment exception is deliberately narrow: both new Workers must return Cloudflare's exact missing-script response, the legacy manifest must match the reviewed sequence-6 SHA-256 digest, and current `briefmark-site` and `briefmark-support` versions are captured. If only one new Worker exists, stop. Inspect its recorded deployment, either roll it back/delete that partial bootstrap under an approved recovery or complete the missing half from the same trusted artifact, then rerun only when both new Workers have a consistent state. Never treat a mixed state or another API error as a fresh bootstrap.

For a transient failure, rerun Deploy while inputs remain current and its seven-day Site artifact exists. Otherwise rerun the original main-push Check. Worker updates are sequential: inspect both after a partial failure. Restore recorded versions with:

```sh
npx wrangler rollback VERSION_ID --config site/wrangler.jsonc
npx wrangler rollback SUPPORT_VERSION_ID --config site/support/wrangler.jsonc
```

Coordinate recovery with queued production runs. For durable installer rollback, use a [manifest PR](release-process.md).

## Local validation

```sh
npm run site:build
npm run site:check
npm run site:test
npx wrangler dev --config site/wrangler.jsonc --port 4180
```

`npm run site:dev` provides a simpler preview on port 4174. Private approved assets require authenticated `gh` or `GH_TOKEN` with repository contents read. Builds verify hashes; never modify signed artifacts or substitute freshly built downloads.

Browser tests use the actual Wrangler configuration. Manually check docs navigation/search, Chrome download, narrow layout, console, and downloaded bytes. Repository-only guides and removed installation pages must return 404.

For authorized manual recovery, use the exact successful Check artifact for the eligible source commit. Verify its archive digest and approved installer hashes, authenticate with `npx wrangler whoami`, verify the account/domain, and dry-run both configs against those extracted assets. With the artifact extracted under `release/`, publish with `npx --no-install wrangler deploy --config site/wrangler.jsonc --assets release/site/dist` and `npx --no-install wrangler deploy --config site/support/wrangler.jsonc --assets release/artifacts/store-site`, then run `node scripts/verify-site-deployment.mjs release`. Do not rebuild during privileged recovery: `npm run store:deploy` rebuilds support output and is not the tested-artifact recovery command. Never bypass release approval.

## Public assets and privacy

Astro supplies per-page CSP; the build hashes Starlight inline scripts and places CSP before scripts. Pagefind uses same-origin files and WebAssembly. Headers prevent framing and MIME sniffing. Public pages allow indexing; the 404 page uses `noindex`. No analytics or external search service is configured.

The support build uses shared privacy Markdown and emits only help, privacy, headers, and 404 output. Tests reject stale installers and extra files. Verify `/support` redirects to `/support/`, help/privacy return 200, and unknown support paths return 404.

`workers_dev` and `preview_urls` remain disabled; inspect actual domain bindings after route changes.

`www.anmerko.com` uses the separate `site/wrangler-www.jsonc` redirect Worker.
Normal Deploy updates only site and support; a reviewed www configuration change
requires a separate dry run, deployment, and canonical redirect verification.

## Legacy domain

The owner approved a simple immediate redirect from the old domain to the new
homepage, dropping old paths and queries. See the [cutover record](legacy-domain-cutover.md)
for the exact Cloudflare rule, verification, and rollback. This supersedes the
previous archive-preservation and observation gates for the old domain in #76.
