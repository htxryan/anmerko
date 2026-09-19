# Agent guide

[anmerko](README.md) is a website feedback extension targeting Chrome, Edge, and Firefox on desktop, plus Edge and Firefox for Android, with an Astro/Starlight documentation site.

The live product name is lowercase `anmerko`; its canonical origin and repository are `https://anmerko.com` and `htxryan/anmerko`. The prelaunch preview had zero real users, so legacy data migration and preview-to-store transition testing are not release requirements. Preserve registered store identities, signed installer bytes, and verifiable release records. Keep the working published support contact `support@briefmark.app` until a tested replacement is approved. Public release uses a freshly audited snapshot in a new independent repository; keep the original repository and its history private.

Old-host web traffic now redirects to `https://anmerko.com/`, dropping paths and queries; do not reinstate archive compatibility or observation gates. Store publication and supported-platform installation must be verified before activating channel CTAs.

## Ways of Working

- Use pull requests for all changes.
- Use git worktrees for all local work.
- Keep implementation plans in the ignored `tasks/` directory or outside the
  repository. Never force-add plans to Git; use PR descriptions for concise,
  sanitized change and verification summaries.
- Keep personal email addresses, provider account identifiers, private dashboard
  URLs and machine-specific paths out of tracked files. Use generic placeholders
  in documentation and private environment configuration for deployment IDs.
  Keep private audit evidence outside Git.
- The main agent session will typically use Astra, and should do all planning and task breakdown activities. But it should use Sol or Terra subagents (depending on the task) to do individual low-level task execution (like making specific code changes in an area of the code). The goals should be parallelization and token cost optimization. Be sure to strike the right balance between "small enough to one-shot" and "big enough to not burn tokens duplicating context across multiple sessions".
- Manually test all non-documentation updates end to end in a browser whenever
  browser testing applies. Automated tests complement this verification.

## Repository structure

- `src/`: extension logic, browser integration, UI, and styles.
- `public/`: extension manifest, HTML entry points, and icons.
- `scripts/`: build, packaging, browser installation, signing, and preview tools.
- `tests/`, `tests-dev/`, `tests-firefox/`: Chromium, Chrome installer, and Firefox tests.
- `site/`: public website, Cloudflare deployment configuration, and site tests.
- [site/src/content/docs/docs/](site/src/content/docs/docs/): published user documentation.
- [docs/](docs/): repository-only development guides; `demo/`: local test website.
- `dist/`, `dist-firefox/`, `site/dist/`, `artifacts/`: generated output; edit source instead.

## Development

Use Node.js 24+ and run commands from the repository root.

- [Build and test](docs/development.md): setup, architecture, Chrome updates, and validation. Run `npm run check` for extension changes; for site changes, run `npm run site:build`, `npm run site:check`, and `npm run site:test`.
- [CI and releases](docs/release-process.md): fast/full scopes, immutable release candidates, signing/manual evidence, artifact promotion and rollback. Site builds copy approved installer downloads from `releases/approved.json`; never replace them with current source packages. The demo must compile the current shared UI components, layouts, and styles. Never copy UI implementations or serve archived demo bundles.
- [Site deployment](docs/site-deployment.md): public-site deployment and verification. Keep repository-only development guides out of the published build; never modify signed XPI installers.
- [Store publishing](docs/store-distribution.md): listing copy, identities, and reusable assets.

Command definitions live in [package.json](package.json) and [Taskfile.yml](Taskfile.yml); CI checks are in [.github/workflows/check.yml](.github/workflows/check.yml).

## Agent skills

This repository includes Addy Osmani's agent skills and three project-owned
`workflow-*` skills in `.agents/skills/`.
Use the host's native skill discovery to load a matching skill on demand.
OpenCode should load matching skills with its `skill` tool. Keep the full
`using-agent-skills` workflow out of always-loaded instructions.

Shared checklists live in `.agents/references/`. The pack's reviewer personas
are reference material in `.agents/agents/`; they are not registered subagents.
Resolve pack assets from `.agents/`, and write project outputs from the repo
root. Installation details and the pinned revision are in [.agents/README.md](.agents/README.md).
