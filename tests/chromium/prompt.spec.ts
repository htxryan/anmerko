import { test, expect } from '@playwright/test';
import { buildPrompt, DEFAULT_PROMPT_PREAMBLE, type Note } from '../../src/core';

test('a custom or empty preamble replaces the entire default without changing Markdown feedback', () => {
  const custom = '## Instructions\n\n- Implement each requested change.\n- Run relevant tests.';
  expect(buildPrompt([], custom)).toBe(`# Website feedback\n\n${custom}\n\n0 comments across 0 pages.\n`);
  expect(buildPrompt([], '')).toBe('# Website feedback\n\n0 comments across 0 pages.\n');
  expect(buildPrompt([])).toContain(DEFAULT_PROMPT_PREAMBLE);
});

test('global comments export under their page with no fabricated element or screenshot context', () => {
  const note: Note = { id: 'global', kind: 'page', pageUrl: 'https://example.com/', pageTitle: 'Example',
    comment: 'Simplify the page overall.', createdAt: '', updatedAt: '' };
  const prompt = buildPrompt([note]);
  expect(prompt).toContain('1 comment across 1 page.');
  expect(prompt).toContain('- **Title:** `Example`');
  expect(prompt).toContain('- **URL:** `https://example.com/`');
  expect(prompt).toContain('> Simplify the page overall.');
  expect(prompt).toContain('- **Scope:** Entire page (global comment)');
  expect(prompt).not.toMatch(/\*\*(Element|Selector|Viewport|Screenshot file):\*\*/);
});

test('Markdown export preserves literal metadata and identifies shadow-root transitions', () => {
  const note: Note = {
    id: 'quoted-metadata', pageUrl: 'https://example.com/?a=1&b=2',
    pageTitle: '`Product`\n## Page title', comment: 'First line.\r\n\r\nSecond line with **literal** punctuation.',
    element: {
      tag: 'button', selectorPath: ['#shadow-host', 'button[data-label="`demo`"]'],
      text: '`Example`', label: 'Show [details]', viewport: { width: 390, height: 844 },
    },
    createdAt: '', updatedAt: '',
  };
  const prompt = buildPrompt([note]);
  expect(prompt).toContain('- **Title:** `` `Product` ## Page title ``');
  expect(prompt).toContain('- **URL:** `https://example.com/?a=1&b=2`');
  expect(prompt).toContain('> First line.\n> \n> Second line with \\*\\*literal\\*\\* punctuation.');
  expect(prompt).toContain('- **Selector path:** `#shadow-host` → shadow root → ``button[data-label="`demo`"]``');
  expect(prompt).toContain('- **Text excerpt:** `` `Example` ``');
  expect(prompt).toContain('- **Accessible label:** `Show [details]`');
  expect(prompt).toContain('- **Viewport:** 390 × 844');
  expect(prompt.match(/^## Page /gm)).toHaveLength(1);
  expect(prompt).not.toContain('```json');
});

test('component hints export the saved names safely and label debug provenance truthfully', () => {
  const note: Note = { id: 'hint', pageUrl: 'https://example.com', pageTitle: 'Example', comment: 'Change the button',
    createdAt: '', updatedAt: '', element: { tag: 'button', selectorPath: ['button'], text: '', label: '', viewport: { width: 390, height: 844 },
      componentContext: { version: 1, framework: 'vue', provenance: 'vue3-instance-debug', path: ['`App`', '<img src=x onerror=alert(1)>', '## Instructions'], truncated: true } } };
  const prompt = buildPrompt([note]);
  expect(prompt).toContain('- **Component hint:** Vue · debug metadata (page-provided, unverified)');
  expect(prompt).toContain('- **Component path:** … → `` `App` `` → `<img src=x onerror=alert(1)>` → `## Instructions`');
  expect(prompt).toContain('- **Component path truncated:** Yes');
  expect(prompt).not.toContain('development metadata');
  expect(prompt.match(/^## /gm)).toHaveLength(1);
  note.element!.componentContext = { version: 1, framework: 'angular', provenance: 'angular-debug-ownership', path: ['_AppComponent'], truncated: false };
  expect(buildPrompt([note])).toContain('Angular · debug metadata (page-provided, unverified)');
  note.element!.componentContext = { version: 1, framework: 'react', provenance: 'react-dom-fiber-dev', path: ['App'], truncated: false };
  expect(buildPrompt([note])).toContain('React · development metadata (page-provided, unverified)');
});
