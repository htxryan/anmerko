---
title: Settings
description: Choose appearance, component context, deletion confirmation, and a prompt introduction.
---

Open the gear button in the panel header. Saved settings apply across tabs in this browser profile.

## Appearance

Choose **Light** (default) or **Dark** for anmerko's panels and journey tabs.

![Current anmerko settings beside Salad Recipe Finder](/screenshots/05-settings.png)

## Preferences

- **Show individual comment deletion confirmation** (on by default).
  - Turn it off for immediate individual deletion.
  - **Delete All Comments** always asks for confirmation.
- **Capture component context** (off by default).
  - Enable it to add a component-name hint to new element comments when the website exposes supported React, Vue, Angular, or Preact metadata.
  - Applies across tabs in this browser profile.
  - Names can reveal application structure. Vue's inferred names may match source filename basenames, although anmerko does not read source files or paths. Review the hint before sharing it.
  - **Remove component hint** removes it from the current draft; Save keeps that change and Cancel discards it. Turning capture off stops new lookups and retains hints already saved with comments.
  - The website demo shows **Requires the extension** because it cannot collect component context. See [component hints](/docs/usage/inline-comments/#component-hints) for framework limits.

## Prompt Preamble

Edit the introduction and click **Save Preamble**. Markdown is supported; an empty field omits it. **Restore Default** restores:

> Comments collected with anmerko. Page URLs and captured context are listed with each comment.

Comment copies and ZIP exports use the last saved preamble; journey exports don't use it. Failed saves retain your edits. Save before closing or refreshing; layout changes keep unfinished edits while the document stays open.
