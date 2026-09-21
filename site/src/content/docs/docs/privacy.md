---
title: Privacy and limitations
description: What anmerko saves, shares, and can access.
---

## Data

The extension makes no network requests. It has no analytics, AI calls, or cloud sync. Saved comments stay in the browser profile until deleted or the extension is removed. Unsaved drafts stay in memory.

anmerko stores comments, page titles/full URLs, selected element context and selectors, confirmed screenshot crops, and settings locally. These support annotation, filtering, and export. They are not sent to the developer or used for advertising, sale, or credit decisions. anmerko does not capture full HTML or source files, run an agent, or share automatically.

Element capture excludes form values and editable text. Other captured text and URLs may still be private; screenshots include all visible pixels within the crop, including form contents. Review exports before sharing.

A journey records only after explicit start and stop. It stores clicks with target context, page URLs, per-step screenshots, your summaries, and — only when you opt in per launch — committed field changes, never keystrokes. Password, payment, and suspected secret fields are always skipped. Screenshots and full URLs can still show visible values, so every image and URL stays reviewable, maskable, and removable before export. Solid masks flatten pixels irreversibly; redacted text leaves the draft entirely. Saved snapshots and temporary session state stay in the browser profile; deleting a journey removes its snapshot.

You can edit, delete, and export feedback. Deleting comments does not delete exported files. There is no sync, import, or automatic transfer between profiles/installations. Simultaneous edits use the last saved change.

anmerko’s use of information received from Google APIs follows the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies) and [Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

## Permissions

| Permission | Use |
| --- | --- |
| `activeTab` | Access the website after activation |
| `scripting` | Add annotation controls |
| `storage` | Save feedback and settings locally |
| `clipboardWrite` | Copy the requested prompt |
| `sidePanel` | Open the Chrome or Edge sidebar |
| `webNavigation` (optional) | Observe page changes for journey capture |
| host access (optional) | Record journeys across websites after approval |

There is no persistent all-sites permission by default. Starting a journey requests optional access once; you can keep it for future journeys or remove it in browser settings. Removing it stops an active recording.

## Limits

anmerko targets Chrome, Edge, and Firefox on desktop, and Edge and Firefox for Android on mobile. Use ordinary HTTP(S) websites; settings, extension stores, PDF viewers, and other protected pages cannot be annotated.

Selection reaches the top document and open shadow roots, not iframes, closed shadow roots, or individual canvas shapes. Screenshots can include their visible pixels. Website changes may break element locating; saved feedback remains available. Floating panels cannot be freely dragged.

## Website and demo

Help pages and the demo load from Cloudflare. These pages add no analytics, tracking scripts, cookies, or forms; the extension sends them no feedback.

The demo keeps comments/settings in memory, isolated from extension data. Close/reopen retains them; reload/navigation clears them. Copying requires your action. Screenshots require the extension.
