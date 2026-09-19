# Workflow plan format

The project-owned `workflow-*` skills produce and consume one self-contained HTML
plan, defaulting to `tasks/plan.html` unless the user specifies another location.
This contract overrides the Markdown output defaults in the composed upstream
skills; their exploration, specification, task sizing, and verification guidance
still applies.

## One complete artifact

- Include the specification, scope, assumptions and decisions, architecture,
  ordered tasks and dependencies, acceptance criteria, automated and manual
  verification, risks, open questions, and sources in the same HTML page.
- Inline all CSS and any JavaScript. The saved file must open directly and work
  offline without a server, build step, CDN, external font, or adjacent asset.
  Citations and repository source links may be external references, but must not
  supply content required to understand or execute the plan.
- Use the HTML as the canonical plan and task-status record. Do not also generate
  parallel `SPEC.md`, `plan.md`, or `todo.md` copies. Preserve an explicitly required
  external tracker by including task IDs, criteria and dependencies in the HTML
  and identifying which system owns status.
- Update task status and evidence in the saved artifact during execution. Do not
  imply that interactive checkboxes or browser storage update the versioned file.

## Navigation and readability

- Provide a persistent left-side panel on desktop with anchor links to section
  headers and task headings. Use stable, unique heading IDs and a clear hierarchy.
- On narrow screens, adapt the same navigation into a compact, accessible menu
  without obscuring the content or causing page overflow.
- Use semantic headings, a labelled navigation landmark, keyboard-operable links,
  a skip link, visible focus, readable contrast, and print styles. All plan content
  and anchor navigation must remain usable without JavaScript.
- Verify the saved file in a browser at desktop and narrow widths. Check section
  links, keyboard navigation, layout, console, and that rendering makes no external
  asset requests. Distinguish proposed work from completed/verified work.

## Diagrams

- Use Mermaid or another graphical format for architecture, dependency, flow,
  sequence, and similar diagrams. Do not use ASCII art, Unicode box-drawing, or
  whitespace-aligned text diagrams, including examples copied from upstream skills.
- Show the rendered graphic in the delivered plan; a Mermaid source fence alone
  is not a diagram. Prefer Mermaid rendered to inline SVG, or an equivalent
  embedded SVG/HTML graphic. Keep it self-contained and usable offline and without
  JavaScript; do not load a diagram renderer from a CDN.
- Give graphics accessible names and descriptions, readable labels, clear
  relationships, and responsive sizing or a labelled scroll container. Verify
  the rendered result when browser access permits. Code samples, commands, and
  ordinary dependency lists remain text.

## Handoff and existing work

Carry the same HTML artifact into execution, read its embedded specification and
tasks, and keep its anchors/status/evidence current. When converting an existing
plan, replace text-art diagrams with rendered graphics and preserve all substantive
requirements, task IDs, completion state, decisions,
verification steps, and sources. Update incoming links and retire only the copies
superseded by the conversion. Do not overwrite unrelated incomplete plans.
