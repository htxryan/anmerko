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

A journey captures a failure that unfolds over several actions: ordered clicks, page changes, a screenshot per step, and your expected-versus-actual summary for a coding agent. Static comments stay unchanged. Orion on iPhone does not include journeys.

Choose **Record journey** from **More Comment Options** on a website. No permission prompt appears: the journey uses the access granted when you activated anmerko on that site. Recording starts only after an initial screenshot succeeds — wait for the recording indicator before interacting. With the floating panel, **Record journey** opens a journey tab where you choose **Start journey**; the panel minimizes while you record and returns when recording ends; use **Stop** on the recording strip to finish. Each journey tab starts one journey; to record another, choose **Record journey** again on the website tab. A journey records the website address where it started: the same domain, subdomain, port, and `http` or `https`. SPA route changes and hash changes keep recording in every browser. In Chrome and Edge, reloads and links to other pages at that address keep recording too. Firefox withdraws anmerko's page access whenever a new page loads, even at the same address, so a reload or link there ends the journey; the navigation and earlier steps are kept. The Firefox journey view says so before you start. Going to a different domain, subdomain, or port, or switching between `http` and `https`, ends the journey and opens review — the click that left is recorded, but the departure is not. Up to 5 minutes or 30 steps in one tab. **Stop journey** ends recording and opens review; closing the tab, switching windows, or losing the page ends it for review instead. Review explains why recording stopped. To record again, save or discard that review first — until then the toolbar reopens it — then activate anmerko from the toolbar on the page you want to record.

**Include entered values** is off for every launch, even if the last journey enabled it. When on, anmerko records committed field changes only — never keystrokes — and skips passwords, payment and secret fields. Screenshots and full URLs can still show visible values either way; review everything before sharing.

Reloading the page records a navigation step. Chrome and Edge continue recording; Firefox ends the journey there. A suspended browser session recovers the recording; the first click and its navigation stay ordered.

## Review a journey

Review starts with **Expected result** and **Actual result** — both are required to save, up to 4,000 characters each. Every step shows its action, timing, full source URL, and screenshot state. Tall screenshots show whole; **Enlarge screenshot** shows one larger. Remove steps you don't need; sequence numbers stay stable. Screenshots are kept unless you **Mask** or **Remove** them: drag or enter a region to cover it with an opaque block, which flattens permanently and cannot be undone. A step's **Remove screenshot** asks for confirmation; the mask editor's **Remove screenshot** removes it at once. When steps share one screenshot, the change applies to all of them. **Redact** source, navigation destination, and image URLs to `[redacted]` without breaking step and image links; a note beside each field names what was redacted. Edit or clear captured values; edited values are marked and originals leave the draft. **Discard journey** asks for confirmation before it deletes unsaved steps and screenshots. A reopened journey you haven't changed closes at once; its saved copy stays.

Acknowledge that full URLs, entered values, and kept screenshots are retained, then **Save journey**. The confirmation offers **Copy Prompt**, **Download Markdown + Images**, and **Record another journey**, or **Done** in a journey tab. Saved journeys appear once each in **Saved journeys**, named by their expected result or starting page, with the local save time, step count, and a **Spans pages** label when they cover more than one page on that site. Reopen a saved journey to keep editing; saving again stores a new revision. Delete one journey or all of them with confirmation; deletion removes the snapshots but never exported files.

## Share a journey

Copy or download from a saved review — saving comes first, and raw drafts are never exported. A reopened journey you haven't changed shares right away; after edits, save again. See [Send to your agent](/docs/send-to-your-agent/).

## Try the demo

Choose **Try the Demo** on the [home page](/). It uses the same comment controls; screenshots require the extension. Demo comments/settings survive close/reopen but clear on reload or navigation. Copy anything you want to keep.
