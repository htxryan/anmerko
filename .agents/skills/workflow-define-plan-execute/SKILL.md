---
name: workflow-define-plan-execute
description: Take an initial feature idea through exploration, an interview, planning, implementation, and a pull request with green checks and manual browser evidence. Use when asked to define and deliver a feature end to end.
---

# Define, plan, and execute

1. Run [workflow-define-and-plan](../workflow-define-and-plan/SKILL.md) with the
   initial idea. Complete its interview and review checkpoints with the user.
2. Pass the resulting self-contained HTML plan, including its specification,
   task list, and confirmed decisions, directly to
   [workflow-execute](../workflow-execute/SKILL.md). Continue into execution once
   the plan is approved; reuse the existing answers and approvals.

Load each workflow through the host's native skill mechanism, or read its linked
`SKILL.md`. Follow the [HTML plan contract](../../references/html-plans.md): the
plan is one page with inline assets, a left-side header navigator, and rendered
Mermaid or other graphical diagrams, never ASCII/text art. Preserve
that same artifact when moving into the worktree; do not split it into Markdown
specification, plan, and task-list copies.
Completion and blockers follow `workflow-execute`; return its PR and evidence.
