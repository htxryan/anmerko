# anmerko listing copy and review kit

This is ready-to-enter draft copy for the existing Chrome Web Store and Firefox Add-ons records. Keep the real IDs and URLs in `listings.json` until the dashboards return verified replacements.

## Shared fields

| Field | Copy |
| --- | --- |
| Product name | anmerko |
| Short description | Attach comments to webpage elements and copy them as an AI prompt. |
| Firefox summary | Mark up websites with element comments, screenshot comments, and page-wide feedback. Copy a structured prompt or export your feedback for an AI agent. |
| Single purpose | Collect feedback about a webpage and prepare that feedback for the user to share with an AI agent. |
| Homepage | `https://anmerko.com` |
| Support | `https://anmerko.com/support/` |
| Privacy | `https://anmerko.com/support/privacy/` |
| Release note | anmerko is available for Chrome, Edge, and Firefox. Visit anmerko.com for installation instructions and documentation. |

### Detailed description

Turn website feedback into a clear brief for your AI agent.

With anmerko, you can attach comments to webpage elements, capture a region of the page and comment on the image, or leave feedback about the whole page. Review your notes, copy a structured prompt, or export your feedback with its screenshots.

- Point to the element that needs attention.
- Add screenshot comments when visual context matters.
- Collect page-wide feedback alongside specific comments.
- Record a journey of clicks and page changes on one website, with a screenshot per step, when a problem takes several actions to reproduce.
- Keep comments and settings in your browser profile until you delete them.
- Share only when you choose to copy or export.

## Reviewer fields

**Product note:** anmerko stores feedback locally and shares it only through explicit copy or export actions. The package, documentation, listing assets, and support URLs use the current product name. This version adds journeys: after the user chooses **Record journey**, anmerko records ordered clicks, same-origin page changes, and a screenshot per step in that tab, then opens a local review before anything can be copied or exported. It adds two API permissions and no host or optional permissions. `webNavigation` shows "Read your browsing history" in Chrome and Edge and "Access browser activity during navigation" in Firefox; it is used only while a user-started journey is recording, to order same-origin page changes in the recorded tab. Events from other tabs and frames are ignored, and no browsing history is read, stored, or sent. `alarms` shows no warning; it enforces the journey time limit and review expiry.

**Smoke test:** Open a normal HTTPS page. Activate anmerko, save an element comment, capture a region and comment on it, and add page-wide feedback. Inspect the combined prompt, copy or export it, reopen Settings, and follow the support and privacy links in the store listing. Then record a short journey: choose **Record journey** from **More Comment Options**, choose **Start journey**, click a control on the same page, and choose **Stop journey**. In review, enter the expected and actual results, mask part of one screenshot, acknowledge retention, choose **Save journey**, and then **Copy Prompt** or **Download Markdown + Images**.

**Permissions and privacy:**

| Permission | Reviewer explanation |
| --- | --- |
| `activeTab` | Access the current website after the user activates the extension. |
| `scripting` | Add the annotation interface and, while a journey records, the click recorder to the activated website. |
| `storage` | Save comments, settings, and in-progress journey state in the current browser profile. |
| `clipboardWrite` | Copy the structured prompt when the user chooses Copy Prompt. |
| `sidePanel` | Open the Chrome or Edge sidebar. |
| `webNavigation` | While a user-started journey records, order same-origin page loads, route changes, and hash changes in the recorded tab, and end the journey when that tab leaves the starting website. Events from other tabs and frames are ignored; browsing history is never read, stored, or sent. |
| `alarms` | End a recording at the five-minute limit, warn before an unsaved journey review expires, and discard it after 30 idle minutes, even if the background was suspended. |

The extension requests no host permissions or persistent all-sites access. It makes no analytics, AI, or cloud-sync requests. Journey steps, screenshots, and saved journeys stay in the browser profile and leave it only when the user copies or exports them. Its required Firefox data-collection declaration remains `none` only while that statement matches the submitted package and dashboard answers.

## Chrome Web Store entry

Update the existing item `oligkkknbmklalfnkipmheifammnpgpo` by default. Enter the shared name, description, purpose, URLs, privacy answers, reviewer note, five current screenshots, icon, promo tile, and any locale fields actually present in the dashboard. Keep the verified-website field on its current real value until `https://anmerko.com` is live and verified. Do not enable a website CTA until the public listing shows anmerko and the submitted version.

## Firefox Add-ons entry

Keep the registered GUID recorded in `listings.json`. Use the verified `anmerko` name, slug, and canonical URL. Select desktop and Android compatibility only with the matching installation evidence. Do not cancel or replace an unrelated pending review.

For listed version `V`, attach `anmerko-V-firefox-source.zip`. For the website/unlisted version `V.1`, attach `anmerko-V.1-firefox-source.zip`. In each reviewer note, replace the placeholders with the exact submitted version and archive filename. The reviewer should extract that archive and use:

```text
Build with Node.js 24 or later from the extracted source archive root:
npm ci
RELEASE_VERSION=<exact submitted version> npm run build:firefox

The resulting dist-firefox directory is the submitted extension. esbuild bundles TypeScript and embeds panel.css without minifying or obfuscating it. Review the source archive matching this submission. The listed V and website/unlisted V.1 variants are distinct packages. The unlisted package has no custom update URL; users update it manually in the same Firefox profile.
```

Confirm the commands against the source archive receipt before entry. Never substitute one variant's source archive for the other.
