# Contributing

Thanks for helping improve anmerko. Keep each change focused, test what it
affects, and submit it through a pull request.

## Set up a worktree

Use Node.js 24 or later. From an existing checkout, create a branch in a new
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

## Validate the change

- Extension changes: `npm run check`
- Site or published documentation changes: `npm run site:build`,
  `npm run site:check`, and `npm run site:test`
- Shared UI changes under `src/`: run both the extension and site checks
- Repository-only documentation under `docs/`: review links and formatting

Manually test non-documentation changes end to end in an affected browser when
browser testing applies. Automated checks complement this verification.

## Open a pull request

Keep the pull request small and scoped to one purpose. Explain the user-visible
result and list the automated and manual checks you ran.

See [Build and test](development.md) for architecture and detailed validation.
See [CI and releases](release-process.md) for CI scopes and release procedures.
