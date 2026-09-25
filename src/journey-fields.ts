import { JOURNEY_LIMITS } from './journey-limits';
import { stripUrlCredentials, type JourneyFieldChangeEvent } from './journey-events';
import type { DraftFieldValue } from './journey-core';
import { journeySelectorPath, parentAcrossShadow } from './journey-selector';
import { createUuid } from './uuid';

export interface JourneyFieldsOptions {
  sessionId: string;
  epoch: number;
  documentToken: string;
  startedAt: string;
  onFieldCommit(commit: JourneyFieldCommit): void | Promise<void>;
}

/**
 * Commit shape emitted through `onFieldCommit`.
 *
 * A commit is a complete `JourneyFieldChangeEvent`:
 * `{ kind: 'field-change', id, observedAt, elapsedMs, sourceUrl, target,
 *    enteredValue, image: { status: 'pending', captureId } }`.
 * The event `id` and image `captureId` are unique per commit and preserved
 * when the commit is merged into a batch.
 *
 * Commits deliberately carry NO batch placement (`sessionId`, `epoch`,
 * `documentToken`, `localCounter`, event order). Sequencing — including
 * placing field commits observed before a click into the same ordered batch
 * ahead of that click — is owned by the journey recorder at integration
 * time. Integration requirement: attach fields BEFORE the click recorder so
 * this module's capture-phase click flush runs before the click batch is
 * created. `sessionId`/`epoch`/`documentToken` are accepted here so the
 * recorder merge can stamp batches without re-deriving owner identity.
 */
export type JourneyFieldCommit = JourneyFieldChangeEvent;

type FieldElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
type FieldKind = 'text' | 'select' | 'check';

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'tel', 'url', 'number']);
const UI_HOSTS = new Set(['anmerko-overlay', 'anmerko-journey-strip']);
// Secret cues come from a field's name, id, and autocomplete (identifiers)
// and from its label, aria-label, aria-labelledby text, and placeholder
// (prose). Matching is fail-closed: ambiguous security, payment, and banking
// controls are omitted. Text is split into lowercase tokens on
// non-alphanumerics and camelCase boundaries.
//
// Whole-word cues match a single token (trailing digits ignored, so `cvv2`
// matches) or two adjacent tokens joined (`account no`, `acctNo`,
// `sort-code`), so short cues never match inside longer words: `cardboard`,
// `spinner`, and `accountNotes` stay recordable.
const SECRET_WORDS = new Set([
  'password', 'passwd', 'pwd', 'passcode', 'passphrase', 'passkey',
  'secret', 'secrets', 'token', 'tokens', 'apikey', 'credential', 'credentials',
  'ssn', 'cvv', 'cvc', 'csc', 'cvn', 'cvd', 'otp', 'totp', 'hotp', 'pin', '2fa', 'mfa',
  'iban', 'mnemonic', 'expiry', 'expiration', 'mmyy', 'mmyyyy',
  'accountno', 'accountnum', 'acctno', 'acctnum', 'acctnumber', 'accno', 'accnum', 'accnumber',
  'routingno', 'routingnum', 'sortcode',
  'authcode', 'accesscode', 'resetcode', 'logincode', 'smscode', 'activationcode',
  'licensekey', 'licencekey', 'productkey', 'activationkey', 'recoverykey', 'encryptionkey',
  'signingkey', 'sshkey', 'masterkey',
]);
// Identifier-only words: in label or placeholder prose they are too ambiguous
// (`Boarding pass`, `Cc`, `Card title`).
const IDENTIFIER_SECRET_WORDS = new Set(['pass', 'pw', 'card', 'cc', 'ccnum', 'ccn', 'cid']);
// Distinctive compounds matched anywhere once separators are removed
// (`userPassword`, `one-time-code`, `x_api_key`, `Security code`). `code`,
// `number`, `key`, and `name` alone are never cues, so postal, promo,
// coupon, and confirmation codes, phone numbers, and account or display
// names stay recordable.
const COMPOUND_SECRET_PATTERN = new RegExp([
  'password', 'passwd', 'passphrase', 'passcode', 'secret', 'apikey', 'onetime', 'totp', 'hotp', 'twofactor',
  'cardnum', 'creditcard', 'debitcard', 'cardholder', 'nameoncard', 'cardverification', 'cardsecurity', 'ccnum',
  'socialsecurity', 'securitycode', 'securityanswer', 'verificationcode', 'verifycode', 'recoverycode', 'backupcode',
  'privatekey', 'accesskey', 'seedphrase', 'recoveryphrase', 'mnemonic',
  'accountnumber', 'routingnumber', 'bankaccount', '(?:exp|expiry|expiration)(?:month|year|date|mm|yy)',
].join('|'));
const SENSITIVE_AUTOCOMPLETE = new Set(['current-password', 'new-password', 'one-time-code']);

function isFieldElement(value: unknown): value is FieldElement {
  return value instanceof HTMLInputElement
    || value instanceof HTMLSelectElement
    || value instanceof HTMLTextAreaElement;
}

function fieldKind(element: FieldElement): FieldKind | null {
  if (element instanceof HTMLSelectElement) return 'select';
  if (element instanceof HTMLTextAreaElement) return 'text';
  const type = element.type.toLowerCase();
  if (TEXT_INPUT_TYPES.has(type)) return 'text';
  if (type === 'checkbox' || type === 'radio') return 'check';
  return null;
}

function insideExtensionUi(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (UI_HOSTS.has(current.localName)) return true;
    current = parentAcrossShadow(current);
  }
  return false;
}

// Label text excludes option and default-value text of fields it wraps, and
// is bounded because a label element can wrap a large subtree.
const NON_LABEL_TAGS = new Set(['select', 'option', 'optgroup', 'datalist', 'textarea', 'script', 'style', 'template']);
const MAX_LABEL_CHARACTERS = 512;

function cueTokens(text: string): string[] {
  return text
    .replace(/([a-z\d])(?=[A-Z])|([A-Z])(?=[A-Z][a-z])/g, '$1$2 ')
    .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hasSecretCues(text: string, identifier: boolean): boolean {
  const tokens = cueTokens(text);
  const secret = (word: string) => SECRET_WORDS.has(word) || (identifier && IDENTIFIER_SECRET_WORDS.has(word));
  if (tokens.some((token, index) => secret(token) || secret(token.replace(/\d+$/, ''))
    || (index > 0 && secret(tokens[index - 1] + token)))) return true;
  return COMPOUND_SECRET_PATTERN.test(tokens.join(''));
}

function hasRevealCues(haystack: string): boolean {
  return /(show|reveal|toggle|unmask)/.test(haystack) && /(pass|pwd|pw)/.test(haystack);
}

function sensitiveAutocomplete(value: string | null): boolean {
  if (!value) return false;
  return value.toLowerCase().split(/\s+/)
    .some(token => SENSITIVE_AUTOCOMPLETE.has(token) || token.startsWith('cc-'));
}

function boundedText(node: Node): string {
  let text = '';
  let visited = 0;
  const visit = (current: Node): void => {
    if (++visited > 256 || text.length >= MAX_LABEL_CHARACTERS) return;
    if (current instanceof Text) { text += current.data; return; }
    if (current instanceof Element && NON_LABEL_TAGS.has(current.localName)) return;
    for (let child = current.firstChild; child; child = child.nextSibling) visit(child);
  };
  visit(node);
  return text;
}

// Each prose source is checked on its own, so words from different sources
// never pair up.
function proseCues(element: FieldElement): string[] {
  const texts = [element.getAttribute('aria-label') ?? '', element.getAttribute('placeholder') ?? ''];
  for (const label of Array.from(element.labels ?? []).slice(0, 4)) texts.push(boundedText(label));
  const ids = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).slice(0, 8);
  const root = element.getRootNode();
  if (ids.length && (root instanceof Document || root instanceof ShadowRoot)) {
    texts.push(ids.map(id => {
      const labelElement = root.getElementById(id);
      return labelElement ? boundedText(labelElement) : '';
    }).join(' '));
  }
  return texts.filter(Boolean);
}

// `wasPassword` holds fields seen as password inputs during this journey: a
// show-password toggle that turns one into text does not make it collectible.
function isSensitive(element: FieldElement, wasPassword: WeakSet<Element>): boolean {
  if (wasPassword.has(element)) return true;
  if (element instanceof HTMLInputElement && element.type.toLowerCase() === 'password') return true;
  if (sensitiveAutocomplete(element.getAttribute('autocomplete'))) return true;
  const identifiers = [element.getAttribute('name'), element.getAttribute('id'), element.getAttribute('autocomplete')]
    .filter((part): part is string => part !== null).join(' ');
  if (hasSecretCues(identifiers, true) || hasRevealCues(identifiers.toLowerCase())) return true;
  return proseCues(element).some(text => hasSecretCues(text, false));
}

// Structural eligibility only (no sensitive classification): used to mark
// fields dirty. Sensitive exclusion is enforced again immediately before
// every read, so controls that change into an excluded state cannot leak.
function structurallyEligible(element: Element): element is FieldElement {
  if (!isFieldElement(element) || fieldKind(element) === null) return false;
  if (element.disabled) return false;
  if (element instanceof HTMLInputElement && element.type.toLowerCase() === 'hidden') return false;
  if (element.hasAttribute('hidden')) return false;
  return !insideExtensionUi(element);
}

function collectible(element: Element, wasPassword: WeakSet<Element>): element is FieldElement {
  return structurallyEligible(element) && !isSensitive(element, wasPassword);
}

function truncateChars(value: string, limit: number): { text: string; truncated: boolean } {
  const chars = Array.from(value);
  if (chars.length <= limit) return { text: value, truncated: false };
  return { text: chars.slice(0, limit).join(''), truncated: true };
}

function readEnteredValue(element: FieldElement, wasPassword: WeakSet<Element>): DraftFieldValue | null {
  if (!collectible(element, wasPassword)) return null;
  if (element instanceof HTMLInputElement && (element.type === 'checkbox' || element.type === 'radio')) {
    return { kind: 'checked', checked: element.checked };
  }
  if (element instanceof HTMLSelectElement) {
    const limit = JOURNEY_LIMITS.maxFieldValueCharacters;
    const values: string[] = [];
    let truncated = false;
    for (const option of Array.from(element.selectedOptions)) {
      if (values.length >= 100) { truncated = true; break; }
      const part = truncateChars(option.text, limit);
      values.push(part.text);
      truncated = truncated || part.truncated;
    }
    return { kind: 'selection', values, multiple: element.multiple, truncated };
  }
  const part = truncateChars(element.value, JOURNEY_LIMITS.maxFieldValueCharacters);
  return { kind: 'text', value: part.text, truncated: part.truncated };
}

function signatureOf(value: DraftFieldValue): string {
  if (value.kind === 'text') return `text:${value.value}`;
  if (value.kind === 'selection') return `selection:${value.multiple ? 'm' : 's'}:${value.values.join('\u0000')}`;
  return `checked:${value.checked ? '1' : '0'}`;
}

// Generic-label discipline shared with the journey recorder: editable areas
// are described by kind, never by raw value, placeholder, or label text.
function genericLabel(element: FieldElement): string {
  if (element instanceof HTMLSelectElement) return 'select field';
  if (element instanceof HTMLTextAreaElement) return 'text field';
  if (element.type === 'checkbox') return 'checkbox';
  if (element.type === 'radio') return 'radio button';
  return 'text field';
}

function roleFor(element: FieldElement): string {
  if (element instanceof HTMLSelectElement) return 'combobox';
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox') return 'checkbox';
    if (element.type === 'radio') return 'radio';
  }
  return 'textbox';
}

function visibleViewport(): { width: number; height: number } {
  const visual = window.visualViewport;
  return { width: Math.round(visual?.width ?? window.innerWidth), height: Math.round(visual?.height ?? window.innerHeight) };
}

function visibleScroll(): { x: number; y: number } {
  const visual = window.visualViewport;
  return { x: window.scrollX + (visual?.offsetLeft ?? 0), y: window.scrollY + (visual?.offsetTop ?? 0) };
}

export function attachJourneyFields(options: JourneyFieldsOptions): () => void {
  if (window.top !== window) return () => {};
  const startedMs = Date.parse(options.startedAt);
  const pending = new Set<FieldElement>();
  const composing = new WeakSet<FieldElement>();
  const lastCommitted = new WeakMap<FieldElement, string>();
  const wasPassword = new WeakSet<Element>();
  const observedRoots = new WeakSet<Node>();
  let disposed = false;

  // Composed path reaches the true target inside open shadow roots; closed
  // roots degrade to their host (which is never an eligible field).
  const trueTarget = (event: Event): Element | null => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    const first = path.length > 0 ? path[0] : event.target;
    return first instanceof Element ? first : null;
  };

  // Password tracking: every password input in the document and its open
  // shadow roots is remembered when attached, inserted, or retyped, before a
  // reveal toggle can turn it into text. A shadow root attached after its
  // host was inserted is found when the user first interacts inside it.
  const notePassword = (element: Element): void => {
    if (element instanceof HTMLInputElement && element.type.toLowerCase() === 'password') wasPassword.add(element);
  };
  const scan = (root: Node): void => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = root instanceof Element ? root : walker.nextNode(); node; node = walker.nextNode()) {
      const element = node as Element;
      notePassword(element);
      if (element.shadowRoot) observeRoot(element.shadowRoot);
    }
  };
  const observer = new MutationObserver(records => {
    if (disposed) return;
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.oldValue?.trim().toLowerCase() === 'password' && record.target instanceof HTMLInputElement) {
          wasPassword.add(record.target);
        }
        if (record.target instanceof Element) notePassword(record.target);
      } else {
        for (const node of Array.from(record.addedNodes)) if (node instanceof Element) scan(node);
      }
    }
  });
  const observeRoot = (root: Document | ShadowRoot): void => {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true });
    scan(root);
  };
  const noteTarget = (target: Element | null): void => {
    if (target === null) return;
    notePassword(target);
    const root = target.getRootNode();
    if (root instanceof ShadowRoot) observeRoot(root);
  };

  const emit = (element: FieldElement): void => {
    if (composing.has(element)) return;
    const enteredValue = readEnteredValue(element, wasPassword);
    if (enteredValue === null) { pending.delete(element); return; }
    const signature = signatureOf(enteredValue);
    pending.delete(element);
    if (lastCommitted.get(element) === signature) return;
    lastCommitted.set(element, signature);
    let sourceUrl: string;
    try { sourceUrl = stripUrlCredentials(location.href); }
    catch { return; }
    const now = new Date();
    const commit: JourneyFieldCommit = {
      kind: 'field-change',
      id: createUuid(),
      observedAt: now.toISOString(),
      elapsedMs: Number.isFinite(startedMs) ? Math.max(0, now.getTime() - startedMs) : 0,
      sourceUrl,
      target: {
        tag: element.localName,
        role: roleFor(element),
        selectorPath: journeySelectorPath(element),
        label: genericLabel(element),
        editable: true,
        viewport: visibleViewport(),
        scroll: visibleScroll(),
      },
      enteredValue,
      image: { status: 'pending', captureId: createUuid() },
    };
    try {
      const delivered = options.onFieldCommit(commit);
      if (delivered && typeof (delivered as Promise<void>).catch === 'function') {
        void (delivered as Promise<void>).catch(() => {});
      }
    } catch { /* Field capture must remain passive when its consumer rejects a commit. */ }
  };

  const flush = (element: FieldElement): void => {
    if (disposed || !pending.has(element)) return;
    emit(element);
  };

  const markDirty = (element: Element | null): void => {
    if (disposed || element === null || !structurallyEligible(element)) return;
    pending.add(element);
  };

  const flushPending = (): void => {
    if (disposed) return;
    for (const element of Array.from(pending)) emit(element);
  };

  // Never installed: keydown/keypress/keyup listeners. Keystrokes, key names,
  // and per-keystroke values are never observed; a trusted edit only marks
  // the field dirty, and the value is read once at commit time.
  //
  // IME discipline: a composing input is still a trusted user edit, so it
  // marks the field dirty — but no commit may happen while composition is
  // active ("not committed until it finishes"). `compositionend` (which the
  // browser may dispatch as untrusted when a blur commits the composition)
  // only lifts that suppression; the value is still read later at a trusted
  // commit trigger (change, focus exit, submit, or pre-click flush).
  const onInput = (event: Event): void => {
    if (disposed || !event.isTrusted) return;
    const target = trueTarget(event);
    noteTarget(target);
    if ((event as InputEvent).isComposing === true) {
      if (target !== null && isFieldElement(target)) composing.add(target);
      markDirty(target);
      return;
    }
    if (target !== null && isFieldElement(target)) composing.delete(target);
    markDirty(target);
  };

  const onCompositionEnd = (event: CompositionEvent): void => {
    if (disposed) return;
    const target = trueTarget(event);
    if (target !== null && isFieldElement(target)) composing.delete(target);
  };

  const onChange = (event: Event): void => {
    if (disposed || !event.isTrusted) return;
    const target = trueTarget(event);
    if (target !== null && isFieldElement(target)) flush(target);
  };

  const onFocusIn = (event: FocusEvent): void => {
    if (disposed || !event.isTrusted) return;
    noteTarget(trueTarget(event));
  };

  const onFocusOut = (event: FocusEvent): void => {
    if (disposed || !event.isTrusted) return;
    const target = trueTarget(event);
    if (target !== null && isFieldElement(target)) flush(target);
  };

  const onSubmit = (event: SubmitEvent): void => {
    if (disposed || !event.isTrusted) return;
    const form = event.target instanceof HTMLFormElement ? event.target : null;
    if (form === null) return;
    for (const element of Array.from(pending)) {
      if (element.form === form) emit(element);
    }
  };

  const onClick = (event: MouseEvent): void => {
    if (disposed || !event.isTrusted) return;
    const target = trueTarget(event);
    noteTarget(target);
    flushPending();
    // The click itself toggles checkable controls (their input/change events
    // arrive after this capture phase), so commit the toggled state now when
    // it differs from the last commit. Unchanged controls suppress via
    // signature; excluded controls (e.g. reveal-password) never commit.
    if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) emit(target);
  };

  document.addEventListener('input', onInput, true);
  document.addEventListener('compositionend', onCompositionEnd, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('submit', onSubmit, true);
  document.addEventListener('click', onClick, true);
  observeRoot(document);
  return () => {
    if (disposed) return;
    disposed = true;
    pending.clear();
    observer.disconnect();
    document.removeEventListener('input', onInput, true);
    document.removeEventListener('compositionend', onCompositionEnd, true);
    document.removeEventListener('change', onChange, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('focusout', onFocusOut, true);
    document.removeEventListener('submit', onSubmit, true);
    document.removeEventListener('click', onClick, true);
  };
}
