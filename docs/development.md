# Build and test

Use Node.js 24.15.0+ from the repository root (the isolated Angular fixture compiler requires that patch or Node 26+). Work in a git worktree and submit changes through a PR. **Current browser targets are Chrome, Edge, and Firefox on desktop, Edge and Firefox for Android, and Edge and Orion for iPhone.**

## Quick start

```sh
npm ci
npm run test:context-fixtures:setup
npx playwright install chromium
npm run check
npm run demo
```

The demo runs at `http://127.0.0.1:4173`. At `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select `dist/`. After rebuilding, reload the extension and refresh the website.
Its local test page is maintained at `tests/fixtures/demo/index.html`.

| Command | Purpose |
| --- | --- |
| `npm run build` | Build the unpacked extension in `dist/` |
| `npm run check` | Lint, typecheck, build, installer tests, and Chromium tests |
| `npm run test:context-fixtures:setup` | Install locked React/Vue and isolated Angular test dependencies and build local fixtures |
| `npm run package` | Build a versioned ZIP in `artifacts/` |
| `npm run package:orion` | Build `artifacts/anmerko-<version>-orion.zip` for folder-based installation in Orion on iPhone |
| `npm run test:desktop -- --browser chrome` | Test installed Chrome with the production manifest |
| `npm run test:android` | Test release Firefox for Android on a running emulator or device (after `npm run build:firefox`) |
| `npm run test:desktop -- --browser chrome --manual` | Open a disposable profile for native UI checks |
| `node scripts/extension/icons.mjs` | Regenerate extension icons |

[Taskfile.yml](../Taskfile.yml) provides equivalent Task commands. Manually test browser changes end to end; automated tests complement that check.

Native Chrome tests need a headed session (Xvfb on Linux). Their experimental CDP commands are unavailable in Chrome 142, so minimum-version support needs separate native checks. Use `--executable /absolute/path/to/chrome` for a nonstandard binary. Runs save source, browser/OS, hashes, and results under `artifacts/desktop-*/`; `--manual` waits for Ctrl+C and does not mark scenarios passed automatically. Release requirements are in [the release guide](release-process.md).

## Update a local Chrome installation

On macOS, `npm run chrome:install` builds this checkout, reloads its existing installation, and verifies the new background worker. Refresh the website afterward. Save drafts first.

Keep the same absolute `dist/` path and Chrome profile to retain the extension ID and saved data. For a path alias, supply the ID from Chrome's Details page:

```sh
npm run chrome:install -- --extension-id YOUR_EXTENSION_ID
```

A missing/disabled installation, wrong profile, build error, or missing acknowledgement fails the command. Other platforms use Chrome's **Reload** button.

The updater briefly creates development helpers and a loopback listener. Wait for the update to finish before starting another build. Normal builds remove the helpers, and packaging rejects them.

## Claude Code cloud sessions

Cloud sessions run on Ubuntu 24.04 x86_64 VMs as root, with Node 22 and Xvfb preinstalled. The repository's SessionStart hook ([.claude/settings.json](../.claude/settings.json)) runs [scripts/cloud/session-start.sh](../scripts/cloud/session-start.sh) only when `CLAUDE_CODE_REMOTE=true`. It adds Node 24 to `PATH` and starts [scripts/cloud/setup.sh](../scripts/cloud/setup.sh) in the background, logging to `/tmp/anmerko-cloud-setup.log`. The setup script installs Node 24, npm and fixture dependencies, Playwright Chromium, stable Chrome and Edge, and Firefox stable and 142.0 with geckodriver. Repeat runs skip current dependencies.

```sh
scripts/cloud/e2e.sh                  # every suite, in CI order
scripts/cloud/e2e.sh chrome firefox   # any of: static chrome edge chromium firefox android
```

`e2e.sh` waits for provisioning. It runs lint and typecheck, stable Chrome and Edge with the production manifest under `xvfb-run`, then `npm run package`, installer tests and the Playwright Chromium suite, including touch and Edge Android emulation. Firefox stable and 142.0 follow, then `npm run package:firefox`, which lints the package that Firefox for Android installs. It prints a pass/fail summary and exits non-zero on any failure.

Provisioning downloads from `nodejs.org`, `dl.google.com`, `packages.microsoft.com`, the Playwright CDN, and Mozilla's `ftp.mozilla.org` and `product-details.mozilla.org`. Several of these hosts are outside the default Trusted allowlist. Choose **Full** network access, or add them to a **Custom** list. To cache provisioning in the environment snapshot, set the environment's setup script to:

```sh
#!/bin/bash
# The repository is cloned before this runs.
script=$(find /home -maxdepth 5 -path '*/scripts/cloud/setup.sh' -print -quit)
[ -n "$script" ] && bash "$script" >/tmp/anmerko-cloud-setup.log 2>&1 || true
```

Cold provisioning takes about three minutes, within the five-minute setup-script limit, and the full matrix about ten more. Cloud VMs are Firecracker microVMs without `/dev/kvm`, so the Android emulator cannot run there. Validate Firefox for Android installation in an emulator on a KVM-capable host or on a device (`npm run firefox:android`).

## Website and documentation

```sh
npm run site:build
npm run site:check
npm run site:test
npm run site:dev
```

Preview: `http://127.0.0.1:4174`. The browser suite uses port 4175. Rebuild after content or shared UI changes.

- `site/src/content/docs/docs/`: published Markdown/MDX; navigation in `site/astro.config.mjs`.
- `docs/`: repository-only developer guides.
- `site/src/pages/index.astro`: landing page.
- `site/support/`: source for the standalone help, privacy, and support routes.
- `site/public/product-illustration.svg`: brochure-only artwork.
- `site/public/screenshots/`: current UI captures on [Salad Recipe Finder](https://saladrecipefinder.com/), shared by documentation and [store listings](store/README.md).

`site:build` compiles the current shared demo UI and copies hash-verified installers from `releases/approved.json`. Private release assets require authenticated `gh` with repository read access, or `GH_TOKEN` with contents read. Preserve signed artifacts unchanged. See [deployment](site-deployment.md).

## Architecture

| File | Responsibility |
| --- | --- |
| `src/core.ts` | Element context, stored records, prompt formatting |
| `src/content.ts` | Shared UI and explicit `mount(runtime)`; no browser/document effects on import |
| `src/runtime.ts` | Storage, styling, capture, and presentation contracts |
| `src/extension-content.ts` | Extension entry point, bundled as `content.js` |
| `src/extension-runtime.ts` | Messaging, storage subscriptions, sidebar connections, authorized capture |
| `src/platform.ts` | Browser API adapter |
| `site/src/scripts/demo-launcher.ts`, `demo-runtime.ts` | Lazy demo loading and an isolated in-memory adapter |

The demo imports the same controller and `src/panel.css` as the extension. Keep one UI implementation; adapters supply capabilities. Demo data survives close/reopen, but reload/navigation clears it. Screenshots require the extension. Use same-origin shadow-root styles under the existing CSP.

Guard pending saves and drafts before closing. Disposal removes listeners, subscriptions, and timers. Chrome can reuse a sidebar after `pagehide`; keep its controller until explicit disposal or context destruction.

Chromium tests use disposable profiles and test-only activation/capture permissions; release packages exclude those permissions. Branded Chrome checks use the unchanged production manifest.

Component-context fixtures use port 4177 and strict CSP, with no CDN requests. The shared fixture package pins React/React DOM 18.3.1, 19.2.7 and 19.3.0 plus Vue/compiler-sfc 3.5.43; Angular 22.1.7 has an isolated AOT compiler package. The root setup command installs their committed lockfiles with lifecycle scripts disabled, explicitly rebuilds the reviewed Angular esbuild binary, and builds all modes. React aliases use explicit matching bundler resolution; `--legacy-peer-deps` applies only to that intentional multi-version test package. Neither framework runtimes nor their compilers ship with the extension or demo.

Component names cross the page boundary only as a bounded, independently versioned DTO. A fixed registry runs the three serialized MAIN-world readers on an exact marked target; one valid response and two clean no-matches are required. Any uncertainty omits the hint. The global preference is off by default and rechecked before each probe and before returning. The unsaved draft owns cancellation, so saved snapshots are never backfilled. This avoids a persistent page listener or DevTools hook and keeps existing host permissions unchanged.

Current extension data and page integration use the `anmerko:` storage prefix, `anmerko-sidebar` runtime port, and `anmerko-overlay` / `anmerko-image` hosts. The namespace intentionally starts clean. The owner confirmed the prelaunch preview had zero real users, so no legacy data migration or preview-to-store validation is required. Preserve historical profiles and packages as evidence, use disposable profiles for testing, and keep ordinary anmerko updates compatible with data in the same installation and profile.

## Browser targets

Chrome, Edge, and Firefox share the product implementation. Keep API differences in `src/platform.ts` and `src/docking.ts`, and manifest/build differences in `scripts/extension/browser-targets.mjs`. Edge reuses the Chromium ZIP.

Windows CI builds and checks are temporarily disabled under
[issue #1](https://github.com/htxryan/anmerko/issues/1);
their source and workflow definitions remain. See the
[reactivation policy](release-process.md#platform-scope).

For Firefox, run `npm run build:firefox`, `npm run package:firefox`, and `npm run test:firefox`. Packaging emits an unsigned ZIP and matching review-source ZIP. The active default reuses the registered add-on ID; it is an opaque package identity and an explicit historical exception. Preserve that GUID and every historical signed baseline unchanged.

| Test setting | Purpose |
| --- | --- |
| `FIREFOX_VERSION=142.0` | Require an exact version; default is stable |
| `FIREFOX_BINARY=/absolute/path/to/firefox` | Select an installed executable |
| `FIREFOX_HEADLESS=0` | Show the test browser |
| `FIREFOX_XPI=/absolute/path/to/candidate.xpi` | Test signed installation, upgrade, and restart |

The Mozilla wrapper pins Node 22.23.2 because its linter fails under Node 24. Firefox 142 requires local-path temporary loading. Its retargeted touch clicks need suppression until a fresh pointerdown; ZIP checks must wait for the end record. Keep those shared fixes covered by regressions.

`npm run test:android` installs the latest release Firefox for Android APK (set `FIREFOX_ANDROID_VERSION` to pin a version) on the emulator or device that `adb` selects. It is a quick sanity check: it loads the unchanged `dist-firefox` package as a temporary add-on through geckodriver, activates it through GeckoView's browser-action entry point (the same call Firefox's Extensions menu makes), and confirms the panel opens without docking. Screenshots go to `artifacts/android-firefox-*/`. Desktop suites cover feedback behavior. The **Firefox Android emulator** CI job runs this suite on an API 34 x86_64 emulator on a hosted runner, because the emulator needs KVM. The required **Firefox / Android** check fails when that job fails. This suite does not cover Firefox's native menu rendering or signed store installation.

Signing and publication gates remain in [the release guide](release-process.md).

The development-only `addons-linter` dependency currently inherits `image-size`
through `web-ext`. A package override pins `image-size` 2.0.4 to address
[GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) and
[GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq) until a
compatible `web-ext` release adopts the updated linter. Keep the override scoped
to that dependency chain and remove it after the upstream upgrade.

## CI

[Check](../.github/workflows/check.yml) selects fast or full validation by changed paths and `full-ci`. Repository-only docs skip browser/Site jobs; shared `src/**` changes also select Site. Main may reuse verified identical PR evidence. Check scope and required jobs are defined in the workflow; candidate, publication, and platform gates are described in [the release guide](release-process.md).

CI/release unit tests run on every Check without installing dependencies. Editing
those tests alone selects lint/types, not browser matrices or historical release
proof. Site/deployment helpers select Site without forcing browser checks; browser
build, packaging, permissions, integration, and release-policy changes retain full
coverage. Keep new production helpers assigned to their relevant path filters.

For CI changes, run `node --test tests/ci/*.test.mjs tests/release/*.test.mjs` and `actionlint`.

See [local runners](local-runners.md) for the MacBook macOS/Docker setup, routing
policy and Taskfile start/stop commands. Trusted private macOS jobs use the local
VM; public and fork jobs use hosted macOS runners. Linux can also use hosted runners.

## Brand pronunciation

Pronounce **anmerko** as **ahn mare ko**. The written brand and domain remain
`anmerko` and `anmerko.com` in captions, UI, documentation, and metadata.

The user selected pronunciation audition #2: the joined TTS-only respelling
`ahn-mare-koh`, with Microsoft's stock `en-US-AvaMultilingualNeural` voice at
`+5%` speaking rate. [Listen to the selected reference clip](store/audio/anmerko-pronunciation-reference.mp3).
Its exact synthesis text is “Meet ahn-mare-koh. Website feedback, ready for AI.”
Use the same respelling for spoken brand and domain occurrences.

## Edge Android support provenance

The product owner confirmed anmerko works in Edge on Android on 15 September
2026. See the [verification summary](evidence/anmerko/verification-summary.md). Website regressions cover realistic EdgA detection, device-specific
CTA labels, keyboard selection and narrow layout. Loaded-extension touch tests
use an EdgA UA, with sidePanel available in the Chromium harness, to protect
floating-panel behavior, docking exclusion and tap/save/reopen persistence.
Microsoft's [API support matrix](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/api-support)
lists sidePanel as desktop-only. No Android version minimum is
inferred from the desktop browser requirement.

Manual installation is a permanent alternative to stores. Store activation must
retain the homepage Download manually link, all three approved download links,
Chrome/Edge desktop unpacked instructions and Firefox signed-XPI desktop/Android
steps. Never substitute an Edge Android ZIP installation path.

## Edge iPhone installation

Microsoft's [Edge App Store listing](https://apps.apple.com/us/app/microsoft-edge/id1288723196) advertises iOS extensions. The [iPhone guide](../site/src/content/docs/docs/install/edge-iphone.mdx) uses anmerko's [public Microsoft Edge Add-ons listing](https://microsoftedge.microsoft.com/addons/detail/anmerko/bfhobiphegcekelfokpcpeepoakkgcka) as the primary installation path. If the store page does not work, the guide provides the public item's direct `edge://extensions/?id=<extension-id>` address as an alternative. Extension authors document that route in [Microsoft's extension tracker](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/432#issuecomment-3917523103), with an [iPhone installation report](https://github.com/microsoft/MicrosoftEdge-Extensions/issues/432#issuecomment-3917868742). Keep the brochure's Edge iPhone action pointed at the guide so both paths remain available.
