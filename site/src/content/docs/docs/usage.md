---
title: Add comments
description: Organize website feedback by page and choose the right comment type.
---

anmerko saves each comment locally in this browser profile with the page URL where you started it. **This page** shows comments for the current page; **All pages** shows comments saved across websites in the profile. The selected scope also controls which comments anmerko copies or downloads.

Changing a URL's query parameters or fragment can show a different set of comments.

Choose the comment type that best identifies what you want changed:

- [Inline comments](/docs/usage/inline-comments/) point to a specific element.
- [Screenshot comments](/docs/usage/screenshot-comments/) capture a visible region.
- [Global comments](/docs/usage/global-comments/) describe the whole current page.

Write your feedback and choose **Save**, or press **Ctrl/⌘ + Enter**. A draft stays available when you move between the floating panel and sidebar while the document remains open. Save before refreshing, navigating away, or closing the page. If the page changes before you save, the draft still belongs to the URL where you started it.

## Manage comments

Click a numbered page marker to edit its comment. Hover over a comment card or focus it with the keyboard to reveal **Edit** and **Delete**. For inline and screenshot comments, **Locate** returns to the saved target when it is still available.

[Settings](/docs/settings/#preferences) controls confirmation for deleting individual comments. **Delete All Comments** applies to the selected **This page** or **All pages** scope and always asks for confirmation.

## Manage the panel

**Float panel** overlays the website; **Dock sidebar** returns beside it. **Minimize comments** leaves a reopen button. Layout changes retain drafts while the document stays open; save before refreshing or navigating away.

The sidebar follows the active tab. Activate anmerko from the toolbar on each new site to grant access.

## Record a journey

A journey captures a failure that unfolds over several actions: ordered clicks, page changes, a screenshot per step, and your expected-versus-actual summary for a coding agent. Static comments stay unchanged.

Choose **Record journey** from **More Comment Options** on a website. No permission prompt appears: the journey uses the access granted when you activated anmerko on that site. Recording starts only after an initial screenshot succeeds — wait for the recording indicator before interacting. A journey records the site where it started: SPA route changes, hash changes, and same-site link clicks keep recording. Navigating to a different site ends the journey and opens review — the click that left is recorded, but the departure is not. Up to 5 minutes or 30 steps in one tab. **Stop journey** ends recording and opens review; closing the tab, switching windows, or losing the page ends it for review instead. Start a new journey later by activating anmerko from the toolbar again.

**Include entered values** is off for every launch, even if the last journey enabled it. When on, anmerko records committed field changes only — never keystrokes — and skips passwords, payment and secret fields. Screenshots and full URLs can still show visible values either way; review everything before sharing.

Reloading the page records a navigation step and continues. A suspended browser session recovers the recording; the first click and its navigation stay ordered.

## Review a journey

Review starts with **Expected result** and **Actual result** — both are required to save, up to 4,000 characters each. Every step shows its action, timing, full source URL, and screenshot state. Remove steps you don't need; sequence numbers stay stable. Screenshots are kept unless you **Mask** or **Remove** them: drag or enter a region to cover it with an opaque block, which flattens permanently and cannot be undone. A step's **Remove screenshot** asks for confirmation; the mask editor's **Remove screenshot** removes it at once. When steps share one screenshot, the change applies to all of them. **Redact** source and image URLs to `[redacted]` without breaking step and image links. Edit or clear captured values; edited values are marked and originals leave the draft.

Acknowledge that full URLs, entered values, and kept screenshots are retained, then **Save journey**. Saved journeys appear once each in **Saved journeys** with a **Spans pages** label when they cover more than one page on that site. Reopen a saved journey to keep editing; saving again stores a new revision. Delete one journey or all of them with confirmation; deletion removes the snapshots but never exported files.

## Share a journey

Copy or download from a saved review — saving comes first, and raw drafts are never exported. See [Send to your agent](/docs/send-to-your-agent/).

## Try the demo

Choose **Try the Demo** on the [home page](/). It uses the same comment controls; screenshots require the extension. Demo comments/settings survive close/reopen but clear on reload or navigation. Copy anything you want to keep.
