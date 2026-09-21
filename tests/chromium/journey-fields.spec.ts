import { expect, test, type Page } from '@playwright/test';
import { buildSync } from 'esbuild';
import { validateJourneyEventBatch } from '../../src/journey-events';

type FieldsWindow = typeof globalThis & {
  anmerkoJourneyFields: {
    attachJourneyFields(options: {
      sessionId: string;
      epoch: number;
      documentToken: string;
      startedAt: string;
      onFieldCommit(commit: unknown): void;
    }): () => void;
  };
  disposeJourneyFields?: () => void;
};

const bundle = buildSync({
  entryPoints: ['src/journey-fields.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'anmerkoJourneyFields',
}).outputFiles[0].text;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function attach(page: Page, seen: unknown[]) {
  await page.exposeFunction('reportFieldCommit', (commit: unknown) => { seen.push(commit); });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const state = globalThis as FieldsWindow;
    state.disposeJourneyFields = state.anmerkoJourneyFields.attachJourneyFields({
      sessionId: 'session-1',
      epoch: 3,
      documentToken: 'document-1',
      startedAt: new Date(Date.now() - 100).toISOString(),
      onFieldCommit: commit => {
        void (globalThis as unknown as { reportFieldCommit(commit: unknown): Promise<void> }).reportFieldCommit(commit);
      },
    });
  });
}

const dispose = (page: Page) => page.evaluate(() => (globalThis as FieldsWindow).disposeJourneyFields?.());

function batchOf(commit: unknown, counter: number) {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    epoch: 3,
    documentToken: 'document-1',
    localCounter: counter,
    events: [commit],
  };
}

function expectCommitShape(commit: any) {
  expect(Object.keys(commit).sort()).toEqual(
    ['elapsedMs', 'enteredValue', 'id', 'image', 'kind', 'observedAt', 'sourceUrl', 'target'],
  );
  expect(commit.kind).toBe('field-change');
  expect(commit.id).toMatch(UUID_PATTERN);
  expect(commit.image.status).toBe('pending');
  expect(commit.image.captureId).toMatch(UUID_PATTERN);
  expect(Number.isFinite(Date.parse(commit.observedAt))).toBe(true);
  expect(commit.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(commit.sourceUrl.startsWith('http://127.0.0.1:4173/recorder')).toBe(true);
  expect(commit.target.editable).toBe(true);
}

function expectAllBatchesValid(seen: unknown[]) {
  expect(seen.length).toBeGreaterThan(0);
  seen.forEach((commit, index) => {
    expect(validateJourneyEventBatch(batchOf(commit, index + 1)).ok).toBe(true);
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/recorder?item=green&item=large#start');
});

test('text edits commit once on blur with schema-valid payloads and generic targets', async ({ page }) => {
  await page.setContent('<input type="text" name="nickname" id="nickname"><button type="button" id="other">Other</button>');
  const seen: unknown[] = [];
  await attach(page, seen);

  await page.fill('#nickname', 'green otter');
  await page.click('#other');

  expect(seen).toHaveLength(1);
  const commit = seen[0] as any;
  expectCommitShape(commit);
  expect(commit.enteredValue).toEqual({ kind: 'text', value: 'green otter', truncated: false });
  expect(commit.target).toMatchObject({ tag: 'input', role: 'textbox', label: 'text field', editable: true });
  expect(commit.target.selectorPath.at(-1)).toBe('input');
  expect(JSON.stringify(commit.target)).not.toContain('green otter');
  expectAllBatchesValid(seen);
});

test('duplicate observations of the same value commit once; a later edit commits again', async ({ page }) => {
  await page.setContent('<input type="text" name="nickname" id="nickname"><button type="button" id="other">Other</button>');
  const seen: unknown[] = [];
  await attach(page, seen);

  await page.fill('#nickname', 'green otter');
  await page.click('#other');
  expect(seen).toHaveLength(1);

  await page.fill('#nickname', 'green otter');
  await page.click('#other');
  expect(seen).toHaveLength(1);

  await page.fill('#nickname', 'blue heron');
  await page.click('#other');
  expect(seen).toHaveLength(2);
  expect((seen[1] as any).enteredValue).toEqual({ kind: 'text', value: 'blue heron', truncated: false });
  expectAllBatchesValid(seen);
});

test('a trusted click flushes a dirty field even when focus never leaves it', async ({ page }) => {
  await page.setContent(`
    <input type="text" name="nickname" id="nickname">
    <button type="button" id="go" onmousedown="event.preventDefault()">Go</button>
  `);
  const seen: unknown[] = [];
  await attach(page, seen);

  await page.fill('#nickname', 'harbor seal');
  await page.click('#go');

  expect(seen).toHaveLength(1);
  expect((seen[0] as any).enteredValue).toEqual({ kind: 'text', value: 'harbor seal', truncated: false });
  expectAllBatchesValid(seen);
});

test('password, suspected-secret, and sensitive-autocomplete controls are excluded fail-closed', async ({ page }) => {
  await page.setContent(`
    <input type="password" name="pw" id="pw">
    <input type="text" name="user-token" id="f-token">
    <input type="text" name="login" id="login-passwd">
    <input type="text" name="chosen" id="f-new" autocomplete="new-password">
    <input type="text" name="old" id="f-current" autocomplete="current-password">
    <input type="text" name="cc" id="f-cc" autocomplete="cc-number">
    <input type="text" name="code" id="f-otp" autocomplete="one-time-code">
    <input type="text" name="cvv-field" id="f-cvv">
    <input type="password" id="pw2">
    <input type="checkbox" id="show-pw">
    <button type="button" id="other">Other</button>
  `);
  const seen: unknown[] = [];
  await attach(page, seen);

  for (const selector of ['#pw', '#f-token', '#login-passwd', '#f-new', '#f-current', '#f-cc', '#f-otp', '#f-cvv', '#pw2']) {
    await page.fill(selector, 's3cret-value');
    await page.click('#other');
  }
  await page.check('#show-pw');
  await page.click('#other');

  expect(seen).toEqual([]);
});

test('a password field switched to text stays excluded when secret cues remain', async ({ page }) => {
  await page.setContent('<input type="password" name="account-password" id="secret-field"><button type="button" id="other">Other</button>');
  const seen: unknown[] = [];
  await attach(page, seen);

  await page.fill('#secret-field', 's3cret-value');
  await page.click('#other');
  expect(seen).toEqual([]);

  await page.evaluate(() => {
    document.querySelector('#secret-field')!.setAttribute('type', 'text');
  });
  await page.fill('#secret-field', 's3cret-value');
  await page.click('#other');
  expect(seen).toEqual([]);
});

test('IME composition never marks a field dirty; the control input commits', async ({ page }) => {
  await page.setContent('<input type="text" name="city" id="city"><button type="button" id="other">Other</button>');
  const seen: unknown[] = [];
  await attach(page, seen);

  // Trusted IME composition through CDP: marked text is in progress, so
  // nothing may commit until the composition finishes (here: on blur).
  await page.click('#city');
  const session = await page.context().newCDPSession(page);
  await session.send('Input.imeSetComposition', { text: 'きょうと', selectionStart: 3, selectionEnd: 3 });
  await page.waitForTimeout(150);
  expect(seen).toEqual([]);

  await page.click('#other');
  expect(seen).toHaveLength(1);
  expect((seen[0] as any).enteredValue).toEqual({ kind: 'text', value: 'きょうと', truncated: false });
  expectAllBatchesValid(seen);
});

test('select, checkbox, and radio commits use display labels and checked state', async ({ page }) => {
  await page.setContent(`
    <select name="size" id="size">
      <option value="s">Small</option>
      <option value="l">Large pack</option>
    </select>
    <select name="colors" id="colors" multiple>
      <option value="r">Red</option>
      <option value="g">Green</option>
      <option value="b">Blue</option>
    </select>
    <input type="checkbox" name="gift" id="gift">
    <input type="radio" name="ship" value="fast" id="ship-fast">
    <input type="radio" name="ship" value="slow" id="ship-slow">
  `);
  const seen: unknown[] = [];
  await attach(page, seen);

  // Single select via real keyboard type-ahead; multiselect via real clicks.
  await page.focus('#size');
  await page.keyboard.press('l');
  await page.keyboard.press('Tab');
  await page.click('#colors option[value="r"]');
  await page.click('#colors option[value="b"]', { modifiers: ['ControlOrMeta'] });
  await page.check('#gift');
  await page.check('#ship-fast');

  expect(seen).toHaveLength(5);
  const [size, colorsRed, colorsBoth, gift, ship] = seen as any[];
  expect(size.enteredValue).toEqual({ kind: 'selection', values: ['Large pack'], multiple: false, truncated: false });
  expect(size.target).toMatchObject({ tag: 'select', role: 'combobox', label: 'select field' });
  expect(colorsRed.enteredValue).toEqual({ kind: 'selection', values: ['Red'], multiple: true, truncated: false });
  expect(colorsBoth.enteredValue).toEqual({ kind: 'selection', values: ['Red', 'Blue'], multiple: true, truncated: false });
  expect(gift.enteredValue).toEqual({ kind: 'checked', checked: true });
  expect(gift.target).toMatchObject({ tag: 'input', role: 'checkbox', label: 'checkbox' });
  expect(ship.enteredValue).toEqual({ kind: 'checked', checked: true });
  expect(ship.target).toMatchObject({ tag: 'input', role: 'radio', label: 'radio button' });
  expect(JSON.stringify(seen)).not.toContain('"fast"');
  seen.forEach(expectCommitShape);
  expectAllBatchesValid(seen);
});

test('submit flushes dirty fields during dispatch before navigation', async ({ page }) => {
  await page.setContent(`
    <form action="/recorder-submitted" method="get">
      <input type="text" name="nickname" id="nickname">
      <button type="submit" id="save">Save</button>
    </form>
  `);
  const seen: unknown[] = [];
  const order: string[] = [];
  await page.exposeFunction('reportSubmitSeen', () => { order.push('submit'); });
  await page.exposeFunction('reportFieldCommit', (commit: unknown) => {
    seen.push(commit);
    order.push('commit');
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(() => {
    const state = globalThis as FieldsWindow;
    state.disposeJourneyFields = state.anmerkoJourneyFields.attachJourneyFields({
      sessionId: 'session-1',
      epoch: 3,
      documentToken: 'document-1',
      startedAt: new Date(Date.now() - 100).toISOString(),
      onFieldCommit: commit => {
        void (globalThis as unknown as { reportFieldCommit(commit: unknown): Promise<void> }).reportFieldCommit(commit);
      },
    });
    document.querySelector('form')!.addEventListener('submit', () => {
      void (globalThis as unknown as { reportSubmitSeen(): Promise<void> }).reportSubmitSeen();
    });
  });

  await page.fill('#nickname', 'harbor seal');
  await page.click('#save');
  await page.waitForURL(/recorder-submitted/);

  expect(order).toEqual(['commit', 'submit']);
  expect(seen).toHaveLength(1);
  expect((seen[0] as any).enteredValue).toEqual({ kind: 'text', value: 'harbor seal', truncated: false });
  expectAllBatchesValid(seen);
});

test('oversized values truncate to the field limit with an explicit flag', async ({ page }) => {
  await page.setContent('<input type="text" name="bio" id="bio"><button type="button" id="other">Other</button>');
  const seen: unknown[] = [];
  await attach(page, seen);

  await page.fill('#bio', `${'あ'.repeat(1_995)}1234567890`);
  await page.click('#other');

  expect(seen).toHaveLength(1);
  const entered = (seen[0] as any).enteredValue;
  expect(entered.kind).toBe('text');
  expect(entered.truncated).toBe(true);
  expect(Array.from(entered.value as string)).toHaveLength(2_000);
  expectAllBatchesValid(seen);
});

test('off by default: pre-attach edits never snapshot, and disposal stops everything', async ({ page }) => {
  await page.setContent('<input type="text" name="nickname" id="nickname"><button type="button" id="other">Other</button>');

  await page.fill('#nickname', 'before attach');
  await page.click('#other');

  const seen: unknown[] = [];
  await attach(page, seen);
  await page.click('#other');
  expect(seen).toEqual([]);

  await page.fill('#nickname', 'after attach');
  await page.click('#other');
  expect(seen).toHaveLength(1);

  await dispose(page);
  await page.fill('#nickname', 'after dispose');
  await page.click('#other');
  expect(seen).toHaveLength(1);
  expectAllBatchesValid(seen);
});

test('hidden, disabled, file, range, and contenteditable controls never commit; values stay out of keys', async ({ page }) => {
  await page.setContent(`
    <input type="text" name="note" id="note">
    <input type="text" name="blocked" id="blocked">
    <input type="hidden" name="tok" id="tok" value="preset">
    <input type="file" name="upload" id="upload">
    <input type="range" name="vol" id="vol" value="7">
    <div contenteditable="true" id="editor">hello</div>
    <button type="button" id="other">Other</button>
  `);
  const seen: unknown[] = [];
  await attach(page, seen);

  // `#blocked` is typed while enabled, then disabled before commit: the
  // trusted change must be dropped by the pre-read exclusion re-check.
  // `#vol` (range) exercises a real trusted edit on an ineligible kind.
  await page.evaluate(() => {
    document.querySelector('#blocked')!.removeAttribute('disabled');
  });
  await page.fill('#note', 'field note');
  await page.fill('#blocked', 'typed while enabled');
  await page.evaluate(() => {
    document.querySelector('#blocked')!.setAttribute('disabled', '');
  });
  await page.focus('#vol');
  await page.keyboard.press('ArrowRight');
  await page.click('#other');

  await page.click('#editor');
  await page.keyboard.type(' plus more');
  await page.click('#other');

  expect(seen).toHaveLength(1);
  expect((seen[0] as any).enteredValue).toEqual({ kind: 'text', value: 'field note', truncated: false });
  expect(JSON.stringify(seen)).not.toMatch(/typed while enabled|preset|plus more/);
  expectAllBatchesValid(seen);
});

test('attachment inside a child frame is a noop', async ({ page }) => {
  await page.setContent('<iframe id="child"></iframe>');
  const frame = page.frames()[1];
  await frame.setContent('<input type="text" name="nickname" id="nickname">');
  await frame.addScriptTag({ content: bundle });
  await frame.evaluate(() => {
    const state = globalThis as FieldsWindow & { frameCommits: unknown[] };
    state.frameCommits = [];
    state.anmerkoJourneyFields.attachJourneyFields({
      sessionId: 'session-1',
      epoch: 3,
      documentToken: 'document-1',
      startedAt: new Date().toISOString(),
      onFieldCommit: commit => { state.frameCommits.push(commit); },
    });
  });
  // Fully trusted real-user path: fill, then Tab out so change/focusout
  // fire as trusted. With no listeners installed, nothing may be collected.
  await frame.fill('#nickname', 'frame value');
  await frame.locator('#nickname').press('Tab');
  const frameCommits = await frame.evaluate(
    () => (globalThis as FieldsWindow & { frameCommits: unknown[] }).frameCommits,
  );
  expect(frameCommits).toEqual([]);
});
