# Contributing

Thanks for helping improve anmerko. Documentation, bug reports, fixes, and new
ideas are welcome. Be respectful, constructive, and clear when collaborating.

## Before you start

Search existing [issues](https://github.com/htxryan/anmerko/issues) and
[pull requests](https://github.com/htxryan/anmerko/pulls) before opening a new one.
For a bug, include reproduction steps, expected and actual behavior, and your
anmerko, browser, and operating system versions.

Discuss substantial features in an issue before investing in an implementation.
Small fixes can go directly to a pull request.

## Set up a worktree

External contributors should fork [anmerko](https://github.com/htxryan/anmerko) and clone their
fork. Use Node.js 24 or later. From that checkout, create a branch in a new
worktree, then install the project and Chromium:

```sh
git fetch origin
git worktree add ../anmerko-your-change -b your-branch-name origin/main
cd ../anmerko-your-change
npm ci
npx playwright install chromium
```

Choose a branch and directory name that describe your change. Run commands from
the new worktree's repository root.

## Make the change

- Follow the patterns and style in the surrounding code.
- Keep the change scoped to one purpose.
- Add relevant regression tests and update affected documentation.
- Keep secrets, private data, and generated build output out of Git.

## Validate the change

- Extension changes: `npm run check`
- Site or published documentation changes: `npm run site:build`,
  `npm run site:check`, and `npm run site:test`
- Shared UI changes under `src/`: run both the extension and site checks
- Repository-only documentation under `docs/`: review links and formatting

Manually test non-documentation changes end to end in an affected browser when
browser testing applies. Automated checks complement this verification.

## Open a pull request

Open the pull request against `htxryan/anmerko`'s `main` branch. Link any related
issue, explain the user-visible result, and list the automated and manual checks
you ran. Include screenshots for visible UI changes. Respond to review feedback
and update the pull request as needed.

See [Build and test](development.md) for architecture and detailed validation.
See [CI and releases](release-process.md) for CI scopes and release procedures.
