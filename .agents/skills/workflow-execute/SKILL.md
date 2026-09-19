---
name: workflow-execute
description: Execute an existing implementation plan in a dedicated git worktree through manual browser testing and a pull request with green checks. Use when asked to implement or deliver a given plan.
---

# Execute a plan

Load each linked skill through the host's native skill mechanism, or read its
`SKILL.md`, when its step begins. Follow the
[HTML plan contract](../../references/html-plans.md) and read the supplied HTML
plan's embedded specification and task list (default `tasks/plan.html`). Reuse
prior decisions and approvals, and resolve blocking gaps before coding. If given
a legacy multi-file plan, consolidate it under that contract before execution,
preserving its requirements, task state, evidence, and incoming links. Follow the
contract's diagram rule during conversion and updates: rendered Mermaid or another
graphical format, never ASCII/text art.

1. [git-workflow-and-versioning](../git-workflow-and-versioning/SKILL.md):
   create a dedicated git worktree and `codex/<feature>` branch from the intended
   PR base, or reuse the current worktree if already dedicated to this plan.
   Carry the selected HTML plan into it, including uncommitted changes,
   without unrelated edits. Run implementation and verification in that worktree.
2. [incremental-implementation](../incremental-implementation/SKILL.md) with
   [test-driven-development](../test-driven-development/SKILL.md): execute the
   plan in order, verifying each slice and updating completion and evidence in
   the saved HTML as you go. Keep its section/task anchors and left navigation
   intact; browser-only checkbox state does not update the plan file.
   Use [debugging-and-error-recovery](../debugging-and-error-recovery/SKILL.md)
   whenever implementation or verification fails.
3. [browser-testing-with-devtools](../browser-testing-with-devtools/SKILL.md):
   run the app from the worktree and manually exercise the planned browser
   scenarios using the host's available interactive browser tools. Inspect the
   rendered result, console, and network; record steps, outcomes, and screenshots.
   Automated browser tests alone do not satisfy this step.
4. [code-review-and-quality](../code-review-and-quality/SKILL.md), then
   [documentation-and-adrs](../documentation-and-adrs/SKILL.md) where needed:
   address findings and update affected documentation. Re-run affected checks
   and browser scenarios after fixes; verify the final change against the plan.
5. [git-workflow-and-versioning](../git-workflow-and-versioning/SKILL.md):
   commit, push, and open or update the feature PR with the plan and verification
   evidence. Apply [ci-cd-and-automation](../ci-cd-and-automation/SKILL.md)'s
   quality-gate guidance to the existing CI: wait for every applicable required
   check on the latest PR commit to pass. Honor documented path-based skips for
   unaffected jobs and report them separately. Diagnose failures, fix, push, and repeat without
   disabling or weakening checks; missing or pending checks are not green.

Done means the plan is complete, manual browser evidence is recorded, and a
reviewable PR has green applicable required checks on its latest commit. Return the PR URL,
worktree path, and verification summary. If access, infrastructure, or a user
decision blocks progress, report the blocker and remaining work; do not claim
delivery. This workflow ends at the PR; merging and deployment require separate
authorization.
