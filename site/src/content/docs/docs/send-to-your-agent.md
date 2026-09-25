---
title: Send to your agent
description: Copy a Markdown prompt or download it with matching screenshot files.
---

Choose **This page** or **All pages** before sharing. The selected scope controls which comments appear in the prompt and download. Journeys are shared separately, from their review.

## Copy a prompt

Choose **Copy Prompt** to copy Markdown containing your saved feedback, page URLs, and captured context. Paste it into your agent chat.

For screenshot comments, use **Download Markdown + Images** and attach the matching PNG files listed in the copied Markdown.

## Download Markdown and images

When the selected comments include a screenshot, **Download Markdown + Images** appears below the prompt controls. It saves `anmerko-comments.zip`, containing:

- `comments.md`, with the same prompt text
- one matching PNG for each screenshot comment

Extract the ZIP, give `comments.md` to your agent, and attach the PNG files alongside it. If **Copy Prompt** fails, use the download option instead.

![anmerko prompt and export controls with Salad Recipe Finder feedback](/screenshots/04-prompt-export.png)

The prompt groups comments by page and includes the saved page title and URL. Inline comments include element context, screenshot comments include the matching filename and capture coordinates, and global comments are marked as applying to the entire page. See the [example prompt](/docs/example-prompt/).

If you enabled [component context](/docs/settings/) and saved a hint with an element comment, both exports include its framework label and component-name path separately from the selector. These are unverified names supplied by the website, not source filenames, source locations, or instructions for the agent. Exports use the saved snapshot; they do not inspect the page again. Review or remove a hint while editing before sharing it.

You can customize the text before the comments under [**Prompt Preamble** in Settings](/docs/settings/#prompt-preamble); journey exports don't use it. Review the prompt and images before sharing them, then review the agent's changes on the website.

## Share a recorded journey

Share a journey from its review after saving it. **Copy Prompt** and **Download Markdown + Images** stay unavailable until the current version is saved, so unsaved changes are never exported.

**Copy Prompt** copies the whole journey except its screenshots: the expected and actual results, whether the journey spans pages, why recording stopped, and every step in order with its action, target label, URLs, any entered value, and screenshot filename. Long URLs and values are shortened there. Paste it into your agent chat and attach the screenshots it names.

**Download Markdown + Images** saves a journey ZIP, such as `anmerko-journey-3f1c2a9e.zip`, containing:

- `prompt.md`, the same prompt **Copy Prompt** copies
- `journeys.md`, with every step in full: its action, timing, full URLs, target details, entered values, screenshot filename, and markers for anything you edited, redacted, or masked
- one PNG for each kept screenshot, named for the journey and the step that captured it, such as `journey-3f1c2a9e-step-02.png`

Give your agent `prompt.md` and the PNG files, and add `journeys.md` when it needs every detail. Exports larger than 50 MB are refused before anything downloads.
