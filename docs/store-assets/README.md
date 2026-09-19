# Store assets

Use [listings.json](listings.json) for existing store identities and [store publishing](../store-distribution.md) for submission steps. Replace the entire screenshot set in every listing and locale when refreshing these images; do not retain old screenshots or add the brochure illustration to a store.

| Asset | Contents |
| --- | --- |
| [01-element-feedback.png](../../site/public/screenshots/01-element-feedback.png) | Element comments on the heading and recipe filters |
| [02-screenshot-feedback.png](../../site/public/screenshots/02-screenshot-feedback.png) | A real recipe-card capture and its comment |
| [03-global-comment.png](../../site/public/screenshots/03-global-comment.png) | The global comment editor |
| [04-prompt-export.png](../../site/public/screenshots/04-prompt-export.png) | Copy confirmation and Markdown/PNG export |
| [05-settings.png](../../site/public/screenshots/05-settings.png) | Dark appearance, preferences, preamble, and support link |
| [chrome/](chrome/) | Branding only: 440×280 promo tile, 1400×560 marquee, and 128px icon |

The five screenshots are opaque RGB PNGs at 1280×800, captured on [Salad Recipe Finder](https://saladrecipefinder.com/) with the current shared anmerko floating UI. [capture.json](capture.json) records the exact source commit, browser, date, and image hashes. Documentation and store uploads use these same files, without duplicate browser-specific copies. The capture script uses Chrome; these images do not establish native acceptance for other browsers.

The [product illustration](../../site/public/product-illustration.svg) belongs exclusively on the brochure page. Its store export and export layout have been removed. The promo tiles contain branding, not product UI.

## Recapture

```sh
npm ci
npm run build
node docs/store-assets/capture.mjs
```

The script opens a disposable installed-Chrome profile, loads the unchanged production manifest, grants access through the extension action, and exercises element comments, real region capture, global comments, copying, ZIP export, and settings. It resizes the native viewport to 1280×800; do not use viewport emulation for native screenshot capture. No DOM, CSS, or screenshot substitutions are used.

Review every image before uploading. If Salad Recipe Finder changes its layout, adjust the recipe-card crop in the script. Check the thumbnail matches the outlined region, the relevant comment is readable, the current controls are present, and PNG dimensions remain exact. Current requirements: [Chrome](https://developer.chrome.com/docs/webstore/images), [Firefox](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/), [Edge](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension).
