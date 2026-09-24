---
title: Privacy and limitations
description: What anmerko saves, shares, and can access.
---

## Data

The extension makes no network requests. It has no analytics, AI calls, or cloud sync. Saved comments stay in the browser profile until deleted or the extension is removed. Unsaved drafts stay in memory.

anmerko stores comments, page titles/full URLs, selected element context and selectors, confirmed screenshot crops, and settings locally. These support annotation, filtering, and export. They are not sent to the developer or used for advertising, sale, or credit decisions. anmerko does not capture full HTML or source files, run an agent, or share automatically.

Element capture excludes form values and editable text. Other captured text and URLs may still be private; screenshots include all visible pixels within the crop, including form contents. Review exports before sharing.

Optional **Capture component context** is off by default. When enabled, new element comments may include a bounded path of React, Vue, Angular, or Preact component names and a framework-metadata label. Names may reveal application structure; Vue's inferred names can match source filename basenames. The reader does not collect props, state, event handlers, inputs, signals, source paths, source files, stacks, or full framework objects. Angular's own inspection helpers may populate its debug cache while finding ownership.

These names are untrusted website data. Debug metadata can remain exposed on deployed Vue or Angular sites; its presence does not prove a site is a development build. Hints stay local with the comment and appear in exports you request. Turning capture off leaves saved hints intact; remove a hint while editing and save to delete it from that comment.

You can edit, delete, and export feedback. Deleting comments does not delete exported files. There is no sync, import, or automatic transfer between profiles/installations. Simultaneous edits use the last saved change.

anmerko’s use of information received from Google APIs follows the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies) and [Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

## Permissions

| Permission | Use |
| --- | --- |
| `activeTab` | Access the website after activation |
| `scripting` | Add annotation controls and, when enabled, inspect bounded component-name metadata on the selected page |
| `storage` | Save feedback and settings locally |
| `clipboardWrite` | Copy the requested prompt |
| `sidePanel` | Open the Chrome or Edge sidebar |

There is no persistent all-sites permission.

## Limits

anmerko targets Chrome, Edge, and Firefox on desktop, and Edge and Firefox for Android on mobile. Use ordinary HTTP(S) websites; settings, extension stores, PDF viewers, and other protected pages cannot be annotated.

Selection reaches the top document and open shadow roots, not iframes, closed shadow roots, or individual canvas shapes. Screenshots can include their visible pixels. Website changes may break element locating; saved feedback remains available. Floating panels cannot be freely dragged.

## Website and demo

Help pages and the demo load from Cloudflare. These pages add no analytics, tracking scripts, cookies, or forms; the extension sends them no feedback.

The demo keeps comments/settings in memory, isolated from extension data. Close/reopen retains them; reload/navigation clears them. Copying requires your action. Screenshots and component-context capture require the extension.
