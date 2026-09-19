---
name: workflow-define-and-plan
description: Explore a feature idea, interview the user, and produce one self-contained HTML specification and implementation plan with a left-side section navigator. Use when asked to define and plan before implementation.
---

# Define and plan

Load each linked skill through the host's native skill mechanism, or read its
`SKILL.md`, when its step begins. Carry forward the user's answers and approvals.
Read the [HTML plan contract](../../references/html-plans.md) before producing
artifacts; it overrides the composed skills' Markdown output defaults and requires
rendered Mermaid or other graphical diagrams instead of ASCII/text art.

1. [idea-refine](../idea-refine/SKILL.md): inspect the relevant repository code
   and explore the idea, alternatives, constraints, and a promising direction.
2. [interview-me](../interview-me/SKILL.md): flesh out that direction with the
   user, one question at a time, until the outcome, scope, and success criteria
   are confirmed. Revisit exploration if the answers change the direction.
3. [spec-driven-development](../spec-driven-development/SKILL.md): complete
   the scope check and Specify phase using the confirmed intent; include the spec
   in the HTML plan.
   Leave implementation to the execution workflow.
4. [planning-and-task-breakdown](../planning-and-task-breakdown/SKILL.md): turn
   the spec into ordered implementation tasks with acceptance criteria and
   automated and manual browser verification steps. Embed the task list in the
   same self-contained `tasks/plan.html`, with the required left-side header
   navigation. Preserve existing work, verify the HTML in a browser, and obtain review.

Return the HTML path and relevant section anchors, decisions, and unresolved
questions. Stop at the plan; `workflow-execute` consumes this same artifact.
