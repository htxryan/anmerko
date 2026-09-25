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

test('a password revealed as text stays excluded for the rest of the journey', async ({ page }) => {
  await page.setContent(`
    <input type="password" name="field-a" id="field-a">
    <button type="button" id="toggle-a">Show</button>
    <input type="text" name="field-b" id="field-b">
    <input type="text" name="nickname" id="nickname">
    <button type="button" id="other">Other</button>
    <section id="later"></section>
    <script>
      document.querySelector('#toggle-a').addEventListener('click', () => {
        const field = document.querySelector('#field-a');
        field.type = field.type === 'password' ? 'text' : 'password';
      });
    </script>
  `);
  const seen: unknown[] = [];
  await attach(page, seen);

  // Reveal, type, then flush while the field is plain text.
  await page.click('#toggle-a');
  await page.fill('#field-a', 'revealed-secret-1');
  await page.click('#other');
  // Type while revealed, then hide: the click flush runs while it is text.
  await page.fill('#field-a', 'revealed-secret-2');
  await page.click('#toggle-a');
  // Typed while masked, revealed, edited further, then committed by focus exit.
  await page.fill('#field-a', 'revealed-secret-3');
  await page.click('#toggle-a');
  await page.locator('#field-a').press('End');
  await page.keyboard.type('-more');
  await page.keyboard.press('Tab');

  // A text field that becomes a password and is revealed again.
  await page.evaluate(() => { (document.querySelector('#field-b') as HTMLInputElement).type = 'password'; });
  await page.evaluate(() => { (document.querySelector('#field-b') as HTMLInputElement).type = 'text'; });
  await page.fill('#field-b', 'revealed-secret-4');
  await page.click('#other');

  // A password field added later, and one inside an open shadow root added
  // later, are both revealed within the task that inserted them.
  await page.evaluate(() => {
    const late = document.createElement('input');
    late.type = 'password';
    late.id = 'late';
    document.querySelector('#later')!.append(late);
    late.type = 'text';
    const host = document.createElement('field-host');
    const root = host.attachShadow({ mode: 'open' });
    const shadowField = document.createElement('input');
    shadowField.type = 'password';
    shadowField.id = 'shadow-field';
    root.append(shadowField);
    document.querySelector('#later')!.append(host);
  });
  await page.evaluate(() => {
    (document.querySelector('field-host')!.shadowRoot!.querySelector('#shadow-field') as HTMLInputElement).type = 'text';
  });
  await page.fill('#late', 'revealed-secret-5');
  await page.click('#other');
  await page.locator('field-host #shadow-field').fill('revealed-secret-6');
  await page.click('#other');

  // A shadow root attached after its host was inserted, revealed by a
  // toggle inside it.
  await page.evaluate(() => {
    const host = document.createElement('late-host');
    document.querySelector('#later')!.append(host);
    setTimeout(() => {
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<input type="password" id="late-shadow"><button type="button" id="late-toggle">Show</button>';
      root.querySelector('#late-toggle')!.addEventListener('click', () => {
        (root.querySelector('#late-shadow') as HTMLInputElement).type = 'text';
      });
    }, 0);
  });
  await page.locator('late-host #late-toggle').click();
  await page.locator('late-host #late-shadow').fill('revealed-secret-7');
  await page.click('#other');

  // Ordinary fields are still recorded.
  await page.fill('#nickname', 'green otter');
  await page.click('#other');

  expect(seen).toHaveLength(1);
  expect((seen[0] as any).enteredValue).toEqual({ kind: 'text', value: 'green otter', truncated: false });
  expect(JSON.stringify(seen)).not.toContain('revealed-secret');
  expectAllBatchesValid(seen);
});

test('labels, aria-label, aria-labelledby, and placeholders are secret cues', async ({ page }) => {
  await page.setContent(`
    <label for="c1">Password</label><input type="text" id="c1" name="first">
    <label>Security code <input type="text" id="c2" name="second"></label>
    <input type="text" id="c3" name="third" aria-label="Recovery code">
    <span id="c4-label">Card verification value</span><input type="text" id="c4" name="fourth" aria-labelledby="c4-label">
    <span id="c5-a">Your</span><span id="c5-b">one-time code</span><input type="text" id="c5" name="fifth" aria-labelledby="c5-a c5-b">
    <input type="text" id="c6" name="sixth" placeholder="MM / YY">
    <input type="text" id="c7" name="seventh" placeholder="Enter your PIN">
    <textarea id="c8" name="eighth" placeholder="Secret recovery phrase"></textarea>
    <label for="c9">Account number</label><input type="text" id="c9" name="ninth">
    <label for="c10">IBAN</label><input type="text" id="c10" name="tenth">
    <input type="checkbox" id="c11" name="eleventh"><label for="c11">Show password</label>
    <label for="c12">Card title</label><input type="text" id="c12" name="twelfth">
    <label for="c13">Account name</label><input type="text" id="c13" name="thirteenth">
    <input type="text" id="c14" name="fourteenth" placeholder="Promo code">
    <input type="text" id="c15" name="fifteenth" aria-label="Postal code">
    <span id="c16-label">Display name</span><input type="text" id="c16" name="sixteenth" aria-labelledby="c16-label">
    <label>Country <select id="c17" name="seventeenth"><option>Secret island</option><option>Norway</option></select></label>
    <button type="button" id="other">Other</button>
  `);
  const seen: unknown[] = [];
  await attach(page, seen);

  for (let index = 1; index <= 16; index++) {
    if (index === 11) continue;
    await page.fill(`#c${index}`, `value-c${index}`);
    await page.click('#other');
  }
  await page.check('#c11');
  // Real keyboard type-ahead: option text inside a wrapping label is no cue.
  await page.focus('#c17');
  await page.keyboard.press('n');
  await page.keyboard.press('Tab');

  const recorded = seen.map(commit => (commit as any).enteredValue);
  expect(recorded).toEqual([
    { kind: 'text', value: 'value-c12', truncated: false },
    { kind: 'text', value: 'value-c13', truncated: false },
    { kind: 'text', value: 'value-c14', truncated: false },
    { kind: 'text', value: 'value-c15', truncated: false },
    { kind: 'text', value: 'value-c16', truncated: false },
    { kind: 'selection', values: ['Norway'], multiple: false, truncated: false },
  ]);
  expectAllBatchesValid(seen);
});

test('secret, verification, banking, and card-expiry names are excluded without over-matching ordinary fields', async ({ page }) => {
  const excluded = [
    'securityCode', 'security-code', 'verificationCode', 'verification_code', 'mfa_code', 'private_key',
    'privateKey', 'access_key', 'mnemonic', 'seed_phrase', 'recovery_code', 'backup-code', 'iban',
    'account_number', 'routing_number', 'exp_month', 'expYear', 'card-expiry', 'expiration_date',
    'cvv2', 'card_cvc', 'cardCVV', 'cvcCode', 'CVV', 'csc', 'cvn', 'cvd', 'security_answer', 'passphrase',
    'api-key', 'client_secret', 'authCode', 'twoFactorCode', 'otpCode', 'license_key', 'acctNo', 'sort_code',
    'SSNField', 'user_pw', 'recovery_phrase', 'bank_account',
  ];
  const recordable = [
    'account_name', 'accountNotes', 'display_name', 'displayName', 'email', 'search', 'comment',
    'postal_code', 'promo_code', 'coupon-code', 'country_code', 'confirmation_code', 'username',
    'company', 'passenger', 'keyword', 'product_keyword', 'expected_date', 'experience', 'discard_reason',
    'spinner_label', 'phone_number', 'order-number',
  ];
  await page.setContent('<form id="fields"></form><button type="button" id="other">Other</button>');
  await page.evaluate(([excluded, recordable]) => {
    const form = document.querySelector('#fields')!;
    [...excluded, ...recordable].forEach((name, index) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.name = name;
      input.id = `n${index}`;
      form.append(input);
    });
    for (const name of ['exp_month', 'size']) {
      const select = document.createElement('select');
      select.name = name;
      select.id = `select-${name}`;
      select.innerHTML = '<option>January</option><option>February</option>';
      form.append(select);
    }
  }, [excluded, recordable]);
  const seen: unknown[] = [];
  await attach(page, seen);

  const names = [...excluded, ...recordable];
  for (const [index, name] of names.entries()) {
    await page.fill(`#n${index}`, `value:${name}`);
    await page.click('#other');
  }
  for (const name of ['exp_month', 'size']) {
    await page.focus(`#select-${name}`);
    await page.keyboard.press('f');
    await page.keyboard.press('Tab');
  }

  const values = seen.map(commit => {
    const entered = (commit as any).enteredValue;
    return entered.kind === 'text' ? entered.value : `selection:${entered.values.join(',')}`;
  });
  expect(values).toEqual([...recordable.map(name => `value:${name}`), 'selection:February']);
  expectAllBatchesValid(seen);
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
