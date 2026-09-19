import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
  site: 'https://anmerko.com',
  output: 'static',
  trailingSlash: 'always',
  markdown: { syntaxHighlight: false },
  security: {
    csp: {
      directives: ["default-src 'self'", "img-src 'self' data:", "base-uri 'none'", "object-src 'none'", "form-action 'none'"],
      // Pagefind runs its local search index in WebAssembly.
      scriptDirective: { resources: ["'self'", "'wasm-unsafe-eval'"] },
      styleDirective: { resources: [{ resource: "'self'", kind: 'element' }, { resource: "'unsafe-inline'", kind: 'attribute' }] },
    },
  },
  integrations: [starlight({
    title: 'anmerko',
    description: 'Install anmerko, add comments, and export feedback.',
    favicon: '/favicon.png',
    customCss: ['./src/styles/docs.css'],
    components: { SiteTitle: './src/components/SiteTitle.astro' },
    credits: false,
    disable404Route: true,
    expressiveCode: false,
    pagination: false,
    sidebar: [
      { label: 'Overview', slug: 'docs' },
      { label: 'Installation', items: [
        { label: 'Overview', slug: 'docs/install' },
        { label: 'Install in Chrome', slug: 'docs/install/chrome' },
        { label: 'Install in Edge', slug: 'docs/install/edge' },
        { label: 'Install in Firefox', slug: 'docs/install/firefox' },
      ] },
      { label: 'Usage', items: [
        { label: 'Add comments', items: [
          { label: 'Overview', slug: 'docs/usage' },
          { label: 'Inline comments', slug: 'docs/usage/inline-comments' },
          { label: 'Screenshot comments', slug: 'docs/usage/screenshot-comments' },
          { label: 'Global comments', slug: 'docs/usage/global-comments' },
        ] },
        { label: 'Send to your agent', slug: 'docs/send-to-your-agent' },
        { label: 'Settings', slug: 'docs/settings' },
      ] },
      { label: 'Reference', items: [
        { label: 'Example prompt', slug: 'docs/example-prompt' },
        { label: 'Privacy and limitations', slug: 'docs/privacy' },
        { label: 'Troubleshooting', slug: 'docs/troubleshooting' },
        { label: 'Release notes', slug: 'docs/releases' },
      ] },
    ],
  })],
});
