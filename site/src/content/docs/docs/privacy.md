---
title: Privacy and limitations
description: What anmerko saves, shares, and can access.
---

## Data

The extension makes no network requests. It has no analytics, AI calls, or cloud sync. Saved comments stay in the browser profile until deleted or the extension is removed. Unsaved drafts stay in memory.

anmerko stores comments, page titles/full URLs, selected element context and selectors, confirmed screenshot crops, saved journeys, and settings locally. These support annotation, filtering, and export. They are not sent to the developer or used for advertising, sale, or credit decisions. anmerko does not capture full HTML or source files, run an agent, or share automatically.

Element capture excludes form values and editable text. Other captured text and URLs may still be private; screenshots include all visible pixels within the crop, including form contents. Review exports before sharing.

A journey records only after you choose **Start journey**, only in that tab, and only until it stops. It records clicks with target context, same-origin page URLs, a screenshot per step, your expected and actual results, and — only when you turn on **Include entered values** for that journey — finished field changes, never keystrokes. Password inputs are always skipped, even after a show-password control switches them to plain text during the journey, as are fields whose autocomplete, name, ID, label, or placeholder marks them as payment, banking, one-time code, or other secret fields; other fields are recorded even when they hold private data. Screenshots and full URLs can still show visible values, so before saving you can mask or remove any screenshot, redact any URL or click label, and edit or clear any entered value. Masks flatten pixels irreversibly; redacted and edited text leaves the journey entirely.

An unsaved journey is held in the browser's session storage. It is cleared when you discard it, when the browser closes, or 30 minutes after its review opens. Saved journeys stay in the browser profile until you delete them or remove the extension; deleting a journey removes its steps and screenshots.

Optional **Capture component context** is off by default. When enabled, new element comments may include a bounded path of React, Vue, Angular, or Preact component names and a framework-metadata label. Names may reveal application structure; Vue's inferred names can match source filename basenames. The reader does not collect props, state, event handlers, inputs, signals, source paths, source files, stacks, or full framework objects. Angular's own inspection helpers may populate its debug cache while finding ownership.

These names are untrusted website data. Debug metadata can remain exposed on deployed Vue or Angular sites; its presence does not prove a site is a development build. Hints stay local with the comment and appear in exports you request. Turning capture off leaves saved hints intact; remove a hint while editing and save to delete it from that comment.

You can edit, delete, and export feedback. Deleting comments or journeys does not delete exported files. There is no sync, import, or automatic transfer between profiles/installations. Simultaneous edits use the last saved change.

anmerko’s use of information received from Google APIs follows the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies) and [Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).

## Permissions

| Permission | Use |
| --- | --- |
| `activeTab` | Access the site after you activate anmerko |
| `scripting` | Add annotation controls and the journey click recorder, and, when enabled, inspect bounded component-name metadata on the selected page |
| `storage` | Save feedback and settings locally, and hold an unsaved journey for the browser session |
| `clipboardWrite` | Copy the requested prompt |
| `sidePanel` | Open the Chrome or Edge sidebar |
| `alarms` | End a recording at 5 minutes and discard an unsaved journey 30 minutes after its review opens |
| `webNavigation` | Order page changes in the tab you record |

Chrome and Edge show `webNavigation` as “Read your browsing history” and Firefox as “Access browser activity during navigation”. anmerko never reads your browser history. Navigation events are used only for the tab being recorded, and only the same-origin page URLs that become journey steps are kept, locally, with that journey.

Firefox packages omit `sidePanel`. When anmerko updates from a version without journeys, desktop Chrome and Edge turn anmerko off until you accept the `webNavigation` warning, and Firefox waits for your approval before updating.

anmerko holds no host permissions and no optional permissions, and never prompts for site access. `activeTab` covers only the website address where you activate it — in Firefox, only until that page reloads or opens another page — so a journey records only where you started it. A different domain, subdomain, port, or protocol ends the journey, and in Firefox so does any page load.

Journeys aren't available on iPhone. Edge on iPhone installs the desktop Edge package and lists the same permissions; Orion's package omits `alarms`, `sidePanel`, and `webNavigation`.

## Limits

anmerko targets Chrome, Edge, and Firefox on desktop, and Edge and Firefox for Android on mobile. Use ordinary HTTP(S) websites; settings, extension stores, PDF viewers, and other protected pages cannot be annotated.

Selection reaches the top document and open shadow roots, not iframes, closed shadow roots, or individual canvas shapes. Screenshots can include their visible pixels. Journeys record clicks in the top document, not inside iframes. Website changes may break element locating; saved feedback remains available. Floating panels cannot be freely dragged.

## Website and demo

Help pages and the demo load from Cloudflare. These pages add no analytics, tracking scripts, cookies, or forms; the extension sends them no feedback.

The demo keeps comments/settings in memory, isolated from extension data. Close/reopen retains them; reload/navigation clears them. Copying requires your action. Screenshots, journeys, and component-context capture require the extension.
