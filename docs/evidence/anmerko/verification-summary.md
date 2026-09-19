# Release and platform verification summary

This summary retains the public conclusions from the private operational audit
and manual acceptance records created during the September 2026 rename and
0.5.5 release. Raw dashboard captures, API responses, local-machine details,
and test transcripts are retained outside the public source tree.

## Release status

- The immutable 0.5.5 website packages were built from the approved source,
  reproduced where required, and matched the approved release manifest.
- The approved Chrome ZIP, Edge ZIP, and Mozilla-signed Firefox XPI were
  published on the website and passed native installation and core behavior
  checks on their supported desktop platforms.
- The signed Firefox XPI passed native Firefox Android installation and core
  behavior checks.
- Edge 0.5.5 became publicly available on 15 September 2026, Chrome 0.5.5 on
  16 September 2026, and Firefox 0.5.5 on 18 September 2026.
- Chrome 0.5.5 passed installation from its public listing and its core native
  workflow on macOS. The installed runtime payload matched the approved
  candidate; manifest differences were limited to expected store identity and
  update metadata.
- Firefox 0.5.5 passed installation from its public AMO listing and an extended
  native workflow on macOS. Its signed listed runtime payload matched the
  approved candidate and the signed website build outside the expected
  manifest-version difference.
- The extended Firefox run covered drafts and keyboard editing, shadow-root and
  form context, zoomed and scrolled screenshot crops, navigation and tab-switch
  cancellation, background stop-and-wake recovery, clipboard fallback, full
  restart persistence, and post-restart editing. Permanent deletion, an
  Escape-specific cancellation result, and a user-revoked clipboard permission
  remain unverified.
- The listed Firefox artifact advertises desktop and Android compatibility. Its
  runtime comparison supports the existing Android provenance but does not
  claim a fresh installation through the Android AMO interface.
- The completed release is recorded by the approved
  [0.5.5 release record](https://github.com/htxryan/anmerko/releases/tag/automation-0-5-5-519a8c1e3417c68d3094e63f3c879f4262ba08e3).

## Platform status

- Native Chrome, Edge, and Firefox desktop testing covered installation,
  version identity, feedback capture and export, dark-mode persistence, and
  recovery from protected or disconnected pages.
- Public-store installation and core behavior are verified on macOS for all
  three desktop browsers. This satisfies the practical store-launch policy.
  Windows and Linux coverage, managed updates, and remaining minimum-version
  cases continue as maintenance work and do not block the completed launch.
- Native Firefox Android testing covered signed installation, feedback capture
  and export, clipboard behavior, reload persistence, and ordinary HTTP and
  HTTPS pages.
- Edge Android support is based on the product owner's native confirmation.
  Automated regressions cover the Edge Android user agent and narrow touch UI;
  they do not claim independent native Android acceptance.

## Website and operations status

- The canonical website, documentation, privacy, support, download, and legacy
  redirect routes were verified after normal production deployment.
- The old host redirects to the canonical homepage and drops paths and query
  strings.
- Store identities, the Firefox GUID, published support contact, signed
  installers, and approved package hashes remain unchanged. Machine-local path
  metadata was redacted from a historical receipt, and its integrity pin was
  updated to the sanitized receipt bytes.

Public source records conclusions and stable public references only. Provider
account identifiers, deployment identifiers, owner-dashboard URLs, credential
details, machine paths, raw API payloads, and private audit evidence must stay
outside Git.
