import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

// This public build has an explicit content allowlist, separate from site/dist.
// Never copy the private brochure, search index, or installers into this output.
const output = 'artifacts/store-site';
const template = await readFile('store-site/page.html', 'utf8');
const markdown = await createMarkdownProcessor({ syntaxHighlight: false });
await rm(output, { recursive: true, force: true });
await mkdir(`${output}/support/privacy`, { recursive: true });
for (const [source, destination, title] of [
  ['store-site/help.md', 'support/index.html', 'Help with anmerko'],
  ['site/src/content/docs/docs/privacy.md', 'support/privacy/index.html', 'Privacy policy'],
]) {
  const sourceText = await readFile(source, 'utf8');
  const { code } = await markdown.render(sourceText.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''));
  const path = `/${destination.replace(/index\.html$/, '')}`;
  const canonical = `<link rel="canonical" href="https://anmerko.com${path}">`;
  await writeFile(`${output}/${destination}`, template.replaceAll('{{title}}', title).replace('{{canonical}}', canonical).replace('{{content}}', code));
}
await writeFile(`${output}/404.html`, template.replaceAll('{{title}}', 'Page not found').replace('{{canonical}}', '').replace('{{content}}', '<p><a href="/support/">Return to anmerko help</a>.</p>'));
const css = template.match(/<style>([\s\S]*?)<\/style>/)[1];
const styleHash = createHash('sha256').update(css).digest('base64');
await writeFile(`${output}/_headers`, `/*
  Content-Security-Policy: default-src 'none'; style-src 'sha256-${styleHash}'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Cache-Control: public, max-age=300
`);
console.log('Built public anmerko help and privacy → artifacts/store-site/');
