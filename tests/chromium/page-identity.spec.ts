import { test, expect } from '@playwright/test';
import { samePage, buildPrompt, type Note } from '../../src/core';

test('Google homepage reload tokens do not hide existing saved comments', () => {
  const original = 'https://www.google.com/';
  expect(samePage(original, original + '?zx=1789315766051')).toBe(true);
  expect(samePage(original + '?zx=100', original + '?zx=200')).toBe(true);
  expect(samePage(original + '?q=anmerko&zx=100', original + '?q=anmerko&zx=200')).toBe(true);
  expect(samePage('https://google.com/?zx=100', 'https://google.com/?zx=200')).toBe(true);
});

test('page matching keeps meaningful queries, routes, and unrelated websites separate', () => {
  for (const [first, second] of [
    ['https://www.google.com/?q=one&zx=100', 'https://www.google.com/?q=two&zx=200'],
    ['https://www.google.com/#/one', 'https://www.google.com/#/two'],
    ['https://example.com/?zx=100', 'https://example.com/?zx=200'],
    ['https://example.com/?id=1', 'https://example.com/?id=2'],
    ['https://example.com/one', 'https://example.com/two'],
    ['https://www.google.com/', 'https://www.google.com.example.com/'],
    ['https://www.google.com/', ''],
  ]) expect(samePage(first, second)).toBe(false);
});

test('export groups comments across refresh tokens without rewriting saved URLs', () => {
  const first: Note = {
    id: 'original', pageUrl: 'https://www.google.com/?zx=100', pageTitle: 'Google', comment: 'First comment',
    createdAt: '2020-01-01T00:00:00Z', updatedAt: '2020-01-01T00:00:00Z',
    element: { tag: 'textarea', selectorPath: ['#search'], text: '', label: 'Search', viewport: { width: 1280, height: 720 } },
  };
  const second = { ...first, id: 'later', pageUrl: 'https://www.google.com/?zx=200', comment: 'Later comment' };
  const prompt = buildPrompt([first, second]);
  expect(prompt).toContain('2 comments across 1 page');
  expect(prompt).toContain('- **URL:** `https://www.google.com/?zx=100`');
  expect(prompt).toContain('First comment');
  expect(prompt).toContain('Later comment');
  expect(first.pageUrl).toBe('https://www.google.com/?zx=100');
  expect(second.pageUrl).toBe('https://www.google.com/?zx=200');
});
