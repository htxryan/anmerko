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

A journey captures a problem that takes several actions to reproduce: ordered clicks, page changes, a screenshot per step, and your expected and actual results for a coding agent. Journeys are kept separately from comments. They aren't available on iPhone (Edge or Orion).

Choose **Record journey** from **More Comment Options** on a website. No permission prompt appears: the journey uses the access you granted when you activated anmerko there. In the sidebar, the journey opens in the sidebar. With the floating panel, it opens in a journey tab; choose **Start journey** there and anmerko returns to the website tab and minimizes the panel until recording ends. Each journey tab starts one journey.

Recording starts after the first screenshot succeeds. Wait for the **Recording** strip at the bottom of the page before you click. To finish, choose **Stop** on the strip, **Stop journey** in the sidebar, or anmerko in the browser toolbar.

**Include entered values** is off each time you open a journey, even if the last one used it. When on, anmerko records a field's value once you finish changing it — never keystrokes — for text boxes, menus, checkboxes, and radio buttons. Password inputs are always skipped, as are fields whose autocomplete, name, or ID marks them as payment, one-time code, or other secret fields. Other fields are recorded even when they hold private data, and screenshots and full URLs can still show values either way; review everything before sharing.

### When recording ends

A journey records one tab on the website address where it started: the same domain, subdomain, port, and `http` or `https`. It stops after 5 minutes or 30 steps, counting the starting view, or when its screenshots reach their storage limit.

- Single-page app route changes and `#` changes keep recording in every browser.
- In Chrome and Edge, reloads and links to other pages at the same address keep recording and add a navigation step.
- Firefox withdraws anmerko's page access whenever a new page loads, even at the same address. A reload or link ends the journey there; the navigation step and earlier steps are kept, but the new page has no screenshot. The Firefox journey view says so before you start.
- Going to a different domain, subdomain, or port, or switching between `http` and `https`, ends the journey. The click that left is recorded; the new page is not.
- Switching to another tab, window, or app, closing the tab, or opening a browser page also ends it.

Steps recorded before the stop are kept, and review explains why recording ended. Review appears in the sidebar or journey tab where you started; clicking anmerko in the toolbar opens it in a journey tab. Save or discard the review before you record again, then activate anmerko from the toolbar on the page you want to record.

## Review a journey

Enter an **Expected result** and an **Actual result**, up to 4,000 characters each. Each step shows its action, time since the start, full URLs, and its screenshot or why it has none.

- **Remove step** asks for confirmation. Other steps keep their numbers, and you can't remove the only remaining step.
- **Mask screenshot** covers a region you drag or enter with an opaque block. Masks flatten the image and cannot be undone. **Remove screenshot** asks for confirmation on the step; in the mask editor it removes the screenshot at once. When steps share a screenshot, the change applies to all of them. Tall screenshots fit whole; **Enlarge screenshot** shows one wider.
- **Redact** replaces a source, destination, or screenshot URL, or a click's label, with `[redacted]`, and a note names what was redacted. A click label can repeat text you typed, such as a search suggestion, even with entered values off.
- **Edit value** or **Remove value** changes an entered value. The original leaves the journey, and the value is marked as edited.

To save, enter both results, keep at least one screenshot, wait for pending screenshots, and confirm that the journey retains full URLs, entered values, and kept screenshots. Then choose **Save journey**. **Discard journey** asks for confirmation before deleting unsaved steps and screenshots.

A review lasts 30 minutes from when it opens; anmerko then discards unsaved changes, and a reopened journey keeps its saved copy. Two minutes before, anmerko's toolbar button shows **!** on the recorded tab. Closing the browser also discards unsaved journeys.

After saving, choose **Copy Prompt**, **Download Markdown + Images**, or **Record another journey** (**Done** in a journey tab).

### Saved journeys

**Saved journeys** in the journey view lists each journey by its expected result or starting page, with its save time, step count, and a **Spans pages** label when it covers more than one page. The sidebar's comment list shows them too.

- **Reopen** opens a saved journey for editing. Saving again replaces the saved copy; **Discard journey** closes an unchanged one without confirmation.
- **Delete** and **Delete all journeys** ask for confirmation. Deleting never removes files you exported, and **Delete All Comments** does not remove journeys.

## Share a journey

Copy or download from a saved review. Saving comes first, and unsaved changes are never exported: after editing a reopened journey, save again. See [Send to your agent](/docs/send-to-your-agent/#share-a-recorded-journey).

## Try the demo

Choose **Try the Demo** on the [home page](/). It uses the same comment controls; screenshots and journeys require the extension. Demo comments/settings survive close/reopen but clear on reload or navigation. Copy anything you want to keep.
