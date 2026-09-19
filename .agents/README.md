# Project agent skills

This checkout includes 25 skills from [Addy Osmani’s agent-skills](https://github.com/addyosmani/agent-skills), pinned to [be4e44a](https://github.com/addyosmani/agent-skills/tree/be4e44a9fbc5e8df0beaefadbb28bd22ee61cc39) on September 12, 2026 under the [MIT license](LICENSE), plus three project workflows:

| Workflow | Purpose |
| --- | --- |
| [workflow-define-and-plan](skills/workflow-define-and-plan/SKILL.md) | Explore, interview, and write an HTML spec/plan |
| [workflow-execute](skills/workflow-execute/SKILL.md) | Implement a plan in a worktree, browser-test, and open a PR with green checks |
| [workflow-define-plan-execute](skills/workflow-define-plan-execute/SKILL.md) | Define, plan, then execute |

These workflows use the [HTML plan contract](references/html-plans.md): one self-contained plan with left navigation, specification, tasks, inline assets, and graphical diagrams.

## Discovery and layout

Codex and OpenCode discover `.agents/skills/` natively; Claude uses relative `.claude/skills/` symlinks. Start a new session or refresh discovery after changes. Preserve symlinks when cloning, including Windows symlink support. No per-user registration is needed.

- `skills/`: upstream and project workflow instructions.
- `references/`: shared checklists and the project HTML contract; `.claude/references` links here.
- `agents/`, `docs/agents.md`: reviewer reference material, not registered agents.
- `AGENTS.md` / `CLAUDE.md`: brief guidance; skills load on demand.

Upstream hooks/command wrappers are excluded. Host integrations such as browser tools remain separate prerequisites. Run the local `idea-refine` helper from the repository root.

## Update

1. Check out the desired upstream revision in a temporary directory.
2. Replace upstream files and license; preserve project `workflow-*` skills, `references/html-plans.md`, and other local additions.
3. Reapply the helper-path adjustment and update `.claude/skills/` symlinks.
4. Update this revision/date/count; verify frontmatter, symlinks, references, and `opencode debug skill` discovery.
