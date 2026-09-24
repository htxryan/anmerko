---
title: Inline comments
description: Attach feedback to a specific element on the page.
---

Use an inline comment when your feedback applies to a heading, button, image, form control, or another specific element.

1. Open the website and activate anmerko from your browser's toolbar or Extensions menu.
2. Choose **Select Element**, then click the target. Press **Esc** or choose **Cancel Selection** to cancel.
3. If the selected element is too narrow, choose **Use Parent Element** to select its container.
4. Write your feedback and choose **Save**, or press **Ctrl/⌘ + Enter**. **Edit in Sidebar** moves the editor from the page into the sidebar.

anmerko saves context such as the element type, selector, visible text, accessible label, and viewport size. This helps your agent identify the target when you [send the feedback](/docs/send-to-your-agent/).

![anmerko comments on the Find a salad heading and recipe filters on Salad Recipe Finder](/screenshots/01-element-feedback.png)

After saving, choose **Locate** to scroll back to the element and highlight it. If the website changes and anmerko can no longer match the original element, your comment remains saved.

## Component hints

Enable **Capture component context** in [Settings](/docs/settings/) to include a separate **Component hint** row when available. You can type and save immediately. A hint that arrives after Save is discarded; editing, locating, copying, and exporting a saved comment do not look up fresh metadata.

- **React DOM:** Named components in supported development builds. Production and profiling builds fall back to ordinary element context.
- **Vue 3:** Exposed debug metadata, including production builds that deliberately retain DevTools metadata.
- **Angular:** Component ownership exposed by the framework's debug APIs. Optimized production normally omits it.
- **Preact 10:** Named components from the runtime vnode tree, in development and production builds alike. Anonymous components yield no hint rather than a guess.

The path follows the framework's component ownership. Portals, Teleport, slots, and projected content can have different component and DOM ancestry. Anonymous components, static or unmanaged nodes, missing metadata, and unsupported framework shapes may produce no hint. Other frameworks still support ordinary element comments.

Hints contain at most eight component names, with an ellipsis when truncated. They are unverified names supplied by the website, not source locations or instructions. **Use Parent Element** creates a fresh snapshot for the parent. **Remove component hint** clears the draft's hint; Save persists removal and Cancel keeps the saved version. Copy and ZIP exports contain the same saved snapshot.
