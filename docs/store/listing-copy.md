# anmerko listing copy and review kit

This is ready-to-enter draft copy for the existing Chrome Web Store and Firefox Add-ons records. It does not claim that a dashboard was changed, a name or slug is available, or a listing is published. Keep the real IDs and URLs in `listings.json` until the dashboards return verified replacements.

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
- Keep comments and settings in your browser profile until you delete them.
- Share only when you choose to copy or export.

No account or AI API key is required. anmerko does not send feedback to the developer, run an AI agent, or share automatically.

## Reviewer fields

**Product note:** anmerko stores feedback locally and shares it only through explicit copy or export actions. The package, documentation, listing assets, and support URLs use the current product name. No new permissions are requested.

**Smoke test:** Open a normal HTTPS page. Activate anmerko, save an element comment, capture a region and comment on it, and add page-wide feedback. Inspect the combined prompt, copy or export it, reopen Settings, and follow the support and privacy links in the store listing. No account or paid service is needed.

**Permissions and privacy:**

| Permission | Reviewer explanation |
| --- | --- |
| `activeTab` | Access the current website after the user activates the extension. |
| `scripting` | Add the annotation interface to the activated website. |
| `storage` | Save comments and settings in the current browser profile. |
| `clipboardWrite` | Copy the structured prompt when the user chooses Copy Prompt. |
| `sidePanel` | Open the Chrome or Edge sidebar. |

The extension requests no persistent all-sites permission. It makes no analytics, AI, or cloud-sync requests. Its required Firefox data-collection declaration remains `none` only while that statement matches the submitted package and dashboard answers.

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
