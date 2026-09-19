# Store publishing

The one-button [Release workflow](../release-process.md) publishes Chrome Web Store and Firefox Add-ons updates through their official APIs. Production provides `CWS_SERVICE_ACCOUNT_JSON`, `CWS_PUBLISHER_ID`, `WEB_EXT_API_KEY`, and `WEB_EXT_API_SECRET`. Public listing IDs remain in [listings.json](listings.json); credentials and private publisher identifiers never enter source or artifacts.

The manually dispatched **Store audit** workflow runs only on this repository's
`main` branch and uses those same production integrations to read Chrome status
and AMO author access, listing, policy and all listed/unlisted version state. Its seven-day
`store-audit` artifact contains allowlisted states, versions, hashes, locale
keys and presence/branding flags. It excludes account details, contact addresses,
private source URLs and reviewer text. Keep downloaded audit evidence outside
Git. This workflow has no package upload, publication, cancellation or listing
edit operation. Dispatch with `gh workflow run store-audit.yml --ref main`.

[AMO v5](https://mozilla.github.io/addons-server/topics/api/addons.html#edit)
supports author-authenticated listing edits, icon uploads, previews, privacy
policy and version notes independently of package submission. Its
[translation contract](https://mozilla.github.io/addons-server/topics/api/overview.html#translated-fields)
returns all locales when no `lang` filter is supplied and preserves locales
omitted from a patch. Audit before preparing a concrete metadata change.
[Chrome's v2 reference](https://developer.chrome.com/docs/webstore/api/reference/rest)
and [Edge's update API](https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/addons-api-reference)
document package publication/status operations; the complete listing/media and
verified-site reconciliation still requires their owner dashboards.

The rename reuses Chrome Web Store item `oligkkknbmklalfnkipmheifammnpgpo` and the registered Firefox add-on ID. These opaque package identities preserve the existing update path. Edge 0.5.5 became publicly Live on 2026-09-15 at the [canonical anmerko listing](https://microsoftedge.microsoft.com/addons/detail/anmerko/bfhobiphegcekelfokpcpeepoakkgcka); native store installation and behavior acceptance passed. Chrome 0.5.5 became public on 2026-09-16, and its public macOS store installation and core workflow passed. Firefox 0.5.5 received public approval on 2026-09-18; its signed listed artifact was payload-verified and its public macOS AMO installation and extended workflow passed. The desktop and Android Edge CTAs use its verified listing; the owner confirmed Android functionality ([support provenance](../development.md#edge-android-support-provenance)), rather than independent agent native Android testing. Firefox unlisted 0.5.5.1 remains the approved website download and is accepted in Firefox Android; the public listed 0.5.5 artifact advertises Android compatibility and has the same non-manifest runtime payload. This comparison does not claim a fresh Android AMO UI installation. All approved website downloads are published. See the [verification summary](../evidence/anmerko/verification-summary.md) and [completed store-launch acceptance](validation.md). Use the [reviewable listing copy and source-review kit](listing-copy.md) when entering the dashboard fields.

Use the current anmerko support and privacy URLs in store listing fields. Manage mailbox configuration outside Git; verify receiving and reply delivery before changing a store contact address.

After release, record each store’s actual public version and identity, dashboard URL/slug reconciliation, and native installation evidence before activating its CTA. Chromium ZIP availability does not establish native Edge-store publication, and desktop Firefox automation does not establish Firefox Android installation and behavior.

The current publication, native installation, minimum-version, and managed-update
coverage for the three desktop stores is tracked in the
[desktop store release validation matrix](validation.md). A completed
automated release state does not replace that native evidence.

Repository administrators can replace the private Chrome publisher ID without writing it to a file:

```sh
gh secret set CWS_PUBLISHER_ID --env production
```

The adapters follow the official [Chrome Web Store API v2 reference](https://developer.chrome.com/docs/webstore/api/reference/rest) and [Mozilla Add-ons API v5](https://mozilla.github.io/addons-server/topics/api/addons.html).

Chrome receives the exact tested three-part `VERSION` ZIP and requests normal publication. A matching upload or submission is resumed idempotently. An unrelated active submission stops the Chrome track instead of replacing it.

Mozilla receives two source-reproducible variants. Listed review uses `VERSION`; website signing uses unlisted `VERSION.1`. Release never cancels an unrelated pending listed review. The unlisted XPI must be returned as public signed bytes, retain the expected Mozilla version identity, come from the trusted Mozilla origin, and match every unsigned payload file except `META-INF` signatures.

Store review and website publication have separate state. Chrome and Edge ZIP downloads publish immediately after validation. Firefox downloads publish after unlisted signing and payload verification. Listed Firefox and Chrome review can remain pending without blocking the website; the 15-minute continuation checks pending work without starting another release.

Firefox listed packages use version `V`; the separately signed website/unlisted package uses `V.1`. Submit the matching `anmerko-V-firefox-source.zip` or `anmerko-V.1-firefox-source.zip` for the exact binary under review. The unlisted website track has no custom updater and requires the documented manual same-profile update flow.

New AMO versions include reviewer build instructions in the initial [version creation request](https://mozilla.github.io/addons-server/topics/api/addons.html#version-create). The uploaded source filename and instructions identify the exact candidate archive and `RELEASE_VERSION` command. Resuming an existing version does not edit its source or reviewer notes.

Existing listing identities must be reused because changing extension IDs strands browser-local data. Current listing copy, permissions, reviewer instructions, screenshots, and support/privacy links live under [store assets](README.md).
