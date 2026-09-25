# Extension releases

Press **Run workflow** on **Release** with the default values. The same action is available locally as `task release`. The workflow requires exact full Check evidence and verified signing before promotion. Verify native store installation and Firefox Android behavior separately.

Release snapshots current `main`, finds a successful full **Check** for that exact commit, or dispatches one and returns. Successful explicit Check and Deploy runs dispatch a resume-only continuation, and a new promotion dispatches one after retaining its authorizing evidence. Hourly scheduled continuations recover interrupted work and poll pending store reviews; neither callback nor schedule can start a release. Dependency installation waits until a release is ready for work. Private internal jobs use the local macOS VM; public and fork jobs use hosted macOS runners. Compatible Linux jobs prefer the local ARM64 runner, with the retained hosted x64 route for branded desktop browsers.

The workflow chooses the next three-part version above `package.json` and approved downloads. Store adapters then refuse a conflicting same-version submission and resume a matching one. A recovery may supply the optional version override and adoption switch only when existing bytes are being verified. The source commit, version, Check run, package hashes, and state revisions are stored as append-only release assets. After the atomic candidate is uploaded, its GitHub Release becomes a prerelease so read-only Check jobs can verify it; the prerelease flag remains until website deployment and both stores publish. Re-running the button resumes those bytes.

Chromium and Firefox packages are built once. Every package entry is compared with the exact full Check reports for Linux and macOS; the manifest comparison normalizes only its version back to the tested source version. `RELEASE_VERSION` sets the generated manifest version and package filename. The Firefox source ZIP records the exact reproduction command.

| Destination | Version | Publication |
| --- | --- | --- |
| Chrome/Edge website | `VERSION` | Immediately after validation |
| Chrome Web Store | `VERSION` | Submitted automatically; review continues independently |
| Firefox Add-ons listed | `VERSION` | Submitted automatically; review continues independently |
| Firefox website/unlisted | `VERSION.1` | Mozilla signs it; exact signed bytes and payload are verified before website promotion |

The separate Mozilla versions prevent listed review from colliding with unlisted website signing. An unrelated pending listed review is left untouched. Chrome, Edge, and the legitimately signed Firefox XPI can reach the website while either public store remains under review.

Release writes the exact artifacts and state to GitHub Releases, creates a one-file `releases/approved.json` PR, explicitly dispatches Check for its immutable head, and merges only that checked head. Because GitHub-token merges do not trigger workflows, it then dispatches Check on the resulting `main` and explicitly starts Deploy with that run. Deploy consumes the exact tested `anmerko-production` artifact and verifies current main before publishing.

The promotion PR alone uses a repository-scoped GitHub App identity (`RELEASE_APP_CLIENT_ID` and `RELEASE_APP_PRIVATE_KEY`) with pull-request write and contents read. This lets ordinary required PR checks run without approving a workflow created by GitHub Actions itself. Branch construction, explicit Check dispatch, evidence verification, and exact-head merge retain their existing `GITHUB_TOKEN` permissions.

The GitHub job summary reports website and store states separately. Transient failures and pending reviews are retried by the scheduled continuation. Hash mismatch, stale main, unrelated store submission, failed CI, or multiple pending releases stop safely for inspection.

Only one automated release is active. Automated callbacks and schedules only resume it. After its website promotion deploys and Chrome publishes, another explicit button press may start a newer `main` payload while Firefox review remains pending. The old prerelease keeps its immutable assets and a truthful incomplete state that points to the deterministic newer release; its recorded store status is the historical snapshot at supersession, and Mozilla remains authoritative afterward. No store submission is cancelled or deleted. A planned supersession resumes safely after interruption, and unchanged or unfinished website releases continue normally.

`releases/approved.json` remains the website source of truth and retains the previous manifest hash for rollback. Release-policy PRs also run the callable validation workflow after the PR's own desktop jobs finish, because overlapping hosted macOS Chrome jobs miss component-context deadlines. If the requested main source has only site checks, this read-only proof may select a recent main ancestor with verified browser evidence whose attestation matches that ancestor's own immutable policy. It tests the selected source's candidate packages under the proposed controller and cannot publish. Production releases still require the exact requested source and the current controller's validation policy.

The public repository began with an independently audited, parentless snapshot
and the exact sequence-8 approval manifest. The original repository retains its
private history and historical packages.

Approval schema 2 records installer downloads only. Its sequence-9 migration is
pinned to the exact sequence-8 manifest digest and preserves every browser
object, URL and checksum while removing unused demo metadata. The live demo is
built and tested from current shared source. Obsolete package archives, demo
bundles and one-time recovery code are no longer part of the current tree.
Future promotions and manifest rollbacks use schema 2; deployment recovery may
still capture a previous schema-1 site's manifest unchanged.

Current automation and release asset URLs accept only `htxryan/anmerko`, with
source, run, attempt, filename and hash checks. Release and production
concurrency groups serialize their respective workflows. Promotion author
verification uses the authenticated GitHub App slug returned by the token
action.

## Identity and channel acceptance

The written product and generated package names are lowercase `anmerko`. Reuse existing store item IDs and the registered Firefox GUID; never rewrite historical signed installers, manifests, hashes, or receipts to make them look renamed. The `anmerko:` local storage namespace intentionally starts clean. The owner confirmed the prelaunch preview had zero real users, so legacy data migration and preview-to-store transition validation are not applicable. Preserve historical packages and developer profiles as evidence, use disposable profiles for validation, and require future anmerko updates to retain data within the same installation and profile.

Close a store-launch issue after public approval, a real store installation and core workflow smoke test, package verification, applicable automated regressions, and accurate installation guidance. Additional native platform coverage belongs in its own task. Check managed-update retention when a subsequent release exists. See the [completed launch evidence](store/validation.md).

Website promotion and public store publication are separate results. The immutable 0.5.5 rename candidate is persisted and approved website downloads are published. Edge became publicly Live on 2026-09-15, Chrome on 2026-09-16, and Firefox received public approval on 2026-09-18 ([verification summary](evidence/anmerko/verification-summary.md)). Keep channel CTAs truthful until the corresponding public listing, package identity, and supported-platform installation are verified. Native Edge-store acceptance remains separate from the shared Chromium download. The completed old-domain homepage redirect has no candidate-promotion or observation dependency.

Release 0.5.5 is complete. [Private-archive continuation run 35448181046](https://github.com/htxryan/anmerko-private-archive/actions/runs/35448181046)
recorded durable state 018 with all website channels ready, deployment published,
and Chrome and Firefox published; the
[private-archive 0.5.5 release](https://github.com/htxryan/anmerko-private-archive/releases/tag/automation-0-5-5-519a8c1e3417c68d3094e63f3c879f4262ba08e3)
is final rather than a draft or prerelease.

## Platform scope

Windows remains paused under its existing policy. Re-enable its code, scheduling, and required evidence together through a PR after its hold is resolved.

Manual installation is a permanent alternative to stores. Store activation must
retain the homepage Download manually link, all three approved download links,
Chrome/Edge desktop unpacked instructions and Firefox signed-XPI desktop/Android
steps. Never substitute an Edge Android ZIP installation path.
