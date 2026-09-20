---
title: Send to your agent
description: Copy a Markdown prompt or download it with matching screenshot files.
---

Choose **This page** or **All pages** before sharing. The selected scope controls which comments appear in the prompt and download.

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

You can customize the text before the comments under [**Prompt Preamble** in Settings](/docs/settings/#prompt-preamble). Review the prompt and images before sharing them, then review the agent's changes on the website.
