import { COMPONENT_CONTEXT_DEFAULT, COMPONENT_CONTEXT_KEY } from './component-context';
import { createSupportIcon } from './support-icon';
import { icon, renderIcons } from './icons';
import { createCommentCard } from './comment-card';
import { privateImage, selectScreenshot } from './screenshot';
import { downloadFile, feedbackArchive } from './export';
import type { Controller, PresentationMode, Runtime, ViewState } from './runtime';
import { statusMessage } from './status';
import { splitMenu } from './split-menu';
import { createUuid } from './uuid';
import { buildPrompt, captureElement, DEFAULT_PROMPT_PREAMBLE, elementHierarchy, pageUrl, readNotes, removeNote, resolveElement, samePage, saveNote, shorten, STORAGE_PREFIX, type Note } from './core';

type Theme = 'light' | 'dark';
const THEME_KEY = 'anmerko:theme';
const PREAMBLE_KEY = 'anmerko:prompt-preamble';
const CONFIRM_DELETE_KEY = 'anmerko:confirm-comment-deletion';
type PendingDeletion = { kind: 'all'; notes: Note[] } | { kind: 'single'; note: Note };
export function mount(runtime: Runtime): Controller {
  const { store, presentation: integration } = runtime;
  const native = integration?.native ?? false;
  // Width alone is not a device test: a desktop sidebar is itself narrow.
  const mobile = !native && (/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent)
    || (matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches));
  let presentation: PresentationMode = native ? 'native' : 'overlay';
  let canDock = false;
  let returnToDock = false;
  let applyingState = false;
  const host = document.createElement('anmerko-overlay');
  // Inline !important prevents ordinary page CSS from moving the extension host.
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:0!important;height:0!important;z-index:2147483647!important;';
  const shadow = host.attachShadow({ mode: 'open' });
  const app = document.createElement('div');
  app.className = native ? 'app native' : 'app';
  app.innerHTML = `
    <aside class="panel" aria-label="anmerko feedback panel">
      <header><span class="logo" aria-hidden="true">↗</span><div class="brand">anmerko</div><button class="icon-button settings-button" aria-label="Extension settings" title="Settings" aria-expanded="false" aria-controls="settings"><span data-icon="settings"></span></button><button class="icon-button dock" hidden aria-label="Dock sidebar" title="Dock sidebar"><span data-icon="pin"></span></button><button class="icon-button minimize" aria-label="Minimize comments" title="Minimize comments"><span data-icon="minus"></span></button><button class="icon-button close" aria-label="Close anmerko" title="Close anmerko"><span data-icon="close"></span></button></header>
      <div class="scope-row"><select aria-label="Comment scope"><option value="page">This page</option><option value="all">All pages</option></select><span class="count">0 comments</span></div>
      <div class="content"><div class="editor-slot"></div><div class="notes"></div></div>
      <section class="settings" id="settings" aria-label="Extension settings" hidden><div class="settings-heading"><button class="settings-back"><span data-icon="back"></span>Back</button><h1>Settings</h1></div><h2 id="theme-label">Appearance</h2><div class="theme-options" role="group" aria-labelledby="theme-label"><button class="theme-option" data-theme="light" aria-pressed="true"><span data-icon="sun"></span>Light</button><button class="theme-option" data-theme="dark" aria-pressed="false"><span data-icon="moon"></span>Dark</button></div><p class="settings-status" role="status" aria-live="polite"></p><section class="preferences" aria-labelledby="preferences-title"><h2 id="preferences-title">Preferences</h2><div class="preference-row"><span id="confirm-delete-label">Show individual comment deletion confirmation</span><button class="confirm-delete-toggle" role="switch" aria-checked="true" aria-labelledby="confirm-delete-label" disabled><span class="switch-track" aria-hidden="true"></span><span class="switch-value" aria-hidden="true">On</span></button></div><p class="preferences-status" role="status" aria-live="polite"></p><div class="preference-row component-context-preference"><span id="component-context-label">Capture component context</span><button class="component-context-toggle" role="switch" aria-checked="false" aria-labelledby="component-context-label" aria-describedby="component-context-help" disabled><span class="switch-track" aria-hidden="true"></span><span class="switch-value" aria-hidden="true">Off</span></button></div><p class="preference-help" id="component-context-help">Add React, Vue or Angular component names to new element comments when debug metadata is available, including deployments that retain Vue or Angular debug tools. Names can reveal application structure; Vue names may match source filename basenames. Source paths and files are not read. Review names before sharing. Turning this off leaves saved hints unchanged.</p><p class="component-context-status" role="status" aria-live="polite"></p></section><div class="preamble-settings"><label for="preamble">Prompt Preamble</label><p id="preamble-help">Text before the comments. Markdown supported.</p><textarea id="preamble" rows="7" aria-describedby="preamble-help" spellcheck="false" disabled></textarea><div class="preamble-actions"><button class="primary save-preamble" disabled><span data-icon="save"></span>Save Preamble</button><button class="secondary reset-preamble" disabled><span data-icon="restore"></span>Restore Default</button></div><p class="preamble-status" role="status" aria-live="polite"></p></div></section>
      <p class="status" role="status" aria-live="polite"></p>
      <button class="danger-button clear-copied" hidden><span data-icon="trash"></span>Delete All Comments</button>
      <footer><section class="intro split-button" role="group" aria-label="Comment Actions"><button class="primary select split-main"><span data-icon="select"></span><span class="button-label">Select Element</span></button><button class="primary comment-options split-options" aria-label="More Comment Options" title="More Comment Options" aria-haspopup="menu" aria-expanded="false" aria-controls="comment-menu"><span data-icon="chevron"></span></button><div class="comment-menu split-menu" id="comment-menu" role="menu" aria-label="Comment Options" hidden><button class="menu-action capture" role="menuitem" tabindex="-1"><span data-icon="camera"></span><span class="button-label">Take Screenshot</span></button><button class="menu-action global-comment" role="menuitem" tabindex="-1"><span data-icon="comment"></span>New Global Comment</button></div></section><div class="footer-buttons split-button" role="group" aria-label="Prompt Actions"><button class="primary copy split-main" disabled><span data-icon="copy"></span>Copy Prompt</button><button class="primary copy-options split-options" aria-label="More Prompt Options" title="More Prompt Options" aria-haspopup="menu" aria-expanded="false" aria-controls="copy-menu" disabled><span data-icon="chevron"></span></button><div class="copy-menu split-menu" id="copy-menu" role="menu" aria-label="Prompt Options" hidden><button class="danger-button delete-all" role="menuitem" tabindex="-1" aria-disabled="true"><span data-icon="trash"></span>Delete All Comments</button></div></div><button class="text-button download" hidden><span data-icon="download"></span>Download Markdown + Images</button><a class="support-link" href="https://buymeacoffee.com/htxryan" target="_blank" rel="noopener noreferrer" aria-label="Buy me a coffee (opens in new tab)" hidden>Buy me a coffee</a></footer>
      <div class="connection-shade" aria-hidden="true" hidden></div>
      <div class="connection-prompt" role="status" tabindex="-1" hidden><span data-icon="connect"></span><p class="connection-instruction">Click anmerko in the browser toolbar to connect this page.</p><p>Browser settings and protected pages cannot be annotated.</p></div>
      <dialog class="delete-dialog" aria-labelledby="delete-title" aria-describedby="delete-description"><form method="dialog"><h2 id="delete-title">Delete All Comments?</h2><p id="delete-description"></p><div class="dialog-actions"><button class="secondary" value="cancel" autofocus><span data-icon="close"></span>Cancel</button><button class="danger-button" value="delete"><span data-icon="trash"></span><span class="button-label">Delete All Comments</span></button></div></form></dialog>
    </aside>
    <div class="minimized-actions" role="group" aria-label="Quick Comment Actions" hidden><button class="quick-action quick-select" aria-label="Select Element" title="Select Element"><span data-icon="select"></span></button><button class="quick-action quick-capture" aria-label="Take Screenshot" title="Take Screenshot"><span data-icon="camera"></span></button><button class="quick-action quick-global-comment" aria-label="New Global Comment" title="New Global Comment"><span data-icon="comment-add"></span></button><button class="resume" hidden aria-label="Show anmerko comments" title="Reopen Comments"><span data-icon="comment"></span><span class="button-label">Comments</span><span data-icon="maximize"></span></button></div>
    <div class="picker-bar" hidden><strong>⌖ Tap or click an element</strong><button><span data-icon="close"></span>Cancel</button></div>
    <div class="editor-shade" aria-hidden="true" hidden><div class="editor-cutout" hidden></div></div>
    <div class="outline" hidden></div><div class="hover-label" hidden></div><div class="pins"></div>`;
  renderIcons(app);
  app.querySelector('.support-link')!.prepend(createSupportIcon());
  app.querySelector('.settings-button')!.setAttribute('aria-label', runtime.settingsLabel);
  app.querySelector('.settings')!.setAttribute('aria-label', runtime.settingsLabel);
  if (!runtime.capture) {
    const capture = app.querySelector<HTMLButtonElement>('.capture')!;
    capture.disabled = true;
    capture.title = runtime.captureUnavailable || 'Screenshots unavailable';
  }
  shadow.append(app);
  document.documentElement.append(host);
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) => shadow.querySelector<T>(selector)!;
  const abort = new AbortController();
  // Outside this shadow root, event.target is the host rather than the input.
  // Page shortcuts (e.g. GitHub's assignee picker) can otherwise steal focus.
  // Bubble after our controls handle the event; preserve native typing,
  // clipboard commands, tab navigation, and anmerko's own save shortcut.
  for (const name of ['keydown', 'keypress', 'keyup']) {
    shadow.addEventListener(name, event => event.stopPropagation(), { signal: abort.signal });
  }
  const panelStatus = statusMessage($('.status'), abort.signal);
  const preambleStatus = statusMessage($('.preamble-status'), abort.signal);
  const settingsStatus = statusMessage($('.settings-status'), abort.signal);
  const preferencesStatus = statusMessage($('.preferences-status'), abort.signal);
  const componentContextStatus = statusMessage($('.component-context-status'), abort.signal);
  let notes: Note[] = [];
  let noteViews: Array<() => void> = [];
  let disposeEditor: (() => void) | undefined;
  let url = native ? '' : pageUrl();
  let title = native ? '' : document.title;
  let draft: Note | null = null;
  let composeOnPage = false;
  let composingFromMinimized = false;
  let picking = false;
  let settings = false;
  let themeVersion = 0;
  let themeSaving = false;
  let preamble = DEFAULT_PROMPT_PREAMBLE;
  let preambleDraft: string | null = null;
  let preambleReady = false;
  let preambleLoading = true;
  let preambleSaving = false;
  let preambleCustom = false;
  let preambleVersion = 0;
  let saving = false;
  let copyFailed = false;
  let copiedComments: Note[] | null = null;
  let pendingDeletion: PendingDeletion | null = null;
  let confirmIndividualDeletion = true;
  let deletionPreferenceVersion = 0;
  let deletionPreferenceSaving = false;
  let componentContextEnabled: boolean = COMPONENT_CONTEXT_DEFAULT;
  let componentContextReady = false;
  let componentContextLoading = true;
  let componentContextSaving = false;
  let componentContextVersion = 0;
  let deleting = false;
  let connectionWarning = false;
  let captureBusy = false;
  let captureAbort: AbortController | null = null;
  let highlighted: Element | null = null;
  let locatedId: string | null = null;
  let readVersion = 0;
  let alive = true;
  let frame = 0;
  let pinsSignature = '';
  let touch: { id: number; x: number; y: number; started: number; moved: boolean; element?: Element } | null = null;
  const touchPointers = new Set<number>();
  let suppressMouseUntil = 0;
  const scope = $('select') as HTMLSelectElement;
  const setCopyMenu = splitMenu($('.footer-buttons'), $<HTMLButtonElement>('.copy-options'), $('#copy-menu'), abort.signal);
  const setCommentMenu = splitMenu($('.intro'), $<HTMLButtonElement>('.comment-options'), $('#comment-menu'), abort.signal);

  function viewState(): ViewState { return { url, pageTitle: native ? title : document.title, draft, scope: scope.value, picking, settings, preambleDraft, capturing: captureBusy, composeOnPage }; }
  function renderPreamble() {
    const field = $<HTMLTextAreaElement>('#preamble');
    const value = preambleDraft ?? preamble;
    if (field.value !== value) field.value = value;
    field.disabled = preambleLoading || preambleSaving;
    $<HTMLButtonElement>('.save-preamble').disabled = field.disabled || preambleDraft === null;
    $<HTMLButtonElement>('.reset-preamble').disabled = field.disabled || (preambleReady && !preambleCustom && preambleDraft === null);
  }
  function renderPrompt() {
    const filtered = visibleNotes();
    if (copiedComments && commentSignature(copiedComments) !== commentSignature(filtered)) copiedComments = null;
    const showClear = !!copiedComments && !settings && !draft;
    $('.clear-copied').hidden = !showClear;
    $<HTMLButtonElement>('.clear-copied').disabled = deleting;
    $('.delete-all').setAttribute('aria-disabled', String(!filtered.length));
    $('.delete-all').title = filtered.length ? '' : 'No comments to delete.';
    $<HTMLButtonElement>('.copy-options').disabled = !filtered.length;
    if ($<HTMLButtonElement>('.copy-options').disabled || connectionWarning) setCopyMenu(false);
    $<HTMLButtonElement>('.copy').disabled = !filtered.length || !preambleReady || deleting;
    $('.download').hidden = settings || (!copyFailed && !filtered.some(note => note.screenshot));
    $<HTMLButtonElement>('.download').disabled = !preambleReady;
  }
  function commentSignature(list: Note[]) {
    return JSON.stringify(list.map(note => [note.id, note.updatedAt, note.comment]));
  }
  function applyPreamble(value: unknown) {
    if (!preambleReady && !preambleLoading) status();
    preambleCustom = typeof value === 'string';
    preamble = typeof value === 'string' ? value : DEFAULT_PROMPT_PREAMBLE;
    preambleReady = true;
    preambleLoading = false;
    if (preambleDraft === preamble) preambleDraft = null;
    renderPreamble();
    renderPrompt();
  }
  async function loadPreamble() {
    const version = preambleVersion;
    try {
      const stored = await store.read(PREAMBLE_KEY);
      if (alive && version === preambleVersion) applyPreamble(stored);
    } catch {
      if (alive && version === preambleVersion) {
        preambleLoading = false;
        renderPreamble();
        preambleStatus('Could not load your preamble. Save or restore to continue.', { error: true });
        status('Could not load prompt settings. Open Settings to save or restore the preamble.', true);
      }
    }
  }
  async function savePreamble(reset = false) {
    if (preambleLoading || preambleSaving) return;
    const value = reset ? undefined : preambleDraft ?? preamble;
    const version = ++preambleVersion;
    preambleSaving = true;
    renderPreamble();
    preambleStatus();
    try {
      if (reset) await store.remove(PREAMBLE_KEY);
      else await store.write(PREAMBLE_KEY, value);
      if (alive) {
        if (version === preambleVersion) applyPreamble(value);
        preambleDraft = null;
        preambleStatus(reset ? 'Default restored.' : 'Preamble saved.');
        syncState();
      }
    } catch { preambleStatus('Could not save your preamble. Your changes are still here. Try again.', { error: true }); }
    finally { preambleSaving = false; renderPreamble(); }
  }
  function applyTheme(value: unknown) {
    const theme: Theme = value === 'dark' ? 'dark' : 'light';
    app.dataset.theme = theme;
    for (const button of shadow.querySelectorAll<HTMLButtonElement>('.theme-option')) {
      button.setAttribute('aria-pressed', String(button.dataset.theme === theme));
    }
  }
  async function loadTheme() {
    const version = themeVersion;
    try {
      const stored = await store.read(THEME_KEY);
      if (alive && version === themeVersion) applyTheme(stored);
    } catch { if (alive && version === themeVersion) settingsStatus('Could not load your theme preference. Choose a theme to try again.', { error: true }); }
  }
  async function saveTheme(theme: Theme) {
    if (themeSaving) return;
    themeSaving = true;
    const version = ++themeVersion;
    const buttons = [...shadow.querySelectorAll<HTMLButtonElement>('.theme-option')];
    buttons.forEach(button => { button.disabled = true; });
    settingsStatus();
    try {
      await store.write(THEME_KEY, theme);
      if (alive) {
        if (version === themeVersion) applyTheme(theme);
        settingsStatus('Theme saved.');
      }
    } catch { settingsStatus('Could not save your theme. Please try again.', { error: true }); }
    finally { themeSaving = false; buttons.forEach(button => { button.disabled = false; }); }
  }
  function applyDeletionPreference(value: unknown) {
    confirmIndividualDeletion = value !== false;
    $('.confirm-delete-toggle').setAttribute('aria-checked', String(confirmIndividualDeletion));
    $('.confirm-delete-toggle .switch-value').textContent = confirmIndividualDeletion ? 'On' : 'Off';
  }
  async function loadDeletionPreference() {
    const version = deletionPreferenceVersion;
    try {
      const value = await store.read(CONFIRM_DELETE_KEY);
      if (alive && version === deletionPreferenceVersion) applyDeletionPreference(value);
    } catch {
      if (alive && version === deletionPreferenceVersion) preferencesStatus('Could not load this preference. Deletion confirmation remains on.', { error: true });
    } finally { if (alive) $<HTMLButtonElement>('.confirm-delete-toggle').disabled = deletionPreferenceSaving; }
  }
  $('.confirm-delete-toggle').addEventListener('click', async () => {
    if (deletionPreferenceSaving) return;
    deletionPreferenceSaving = true;
    const version = ++deletionPreferenceVersion;
    const value = !confirmIndividualDeletion;
    $<HTMLButtonElement>('.confirm-delete-toggle').disabled = true;
    preferencesStatus();
    try {
      await store.write(CONFIRM_DELETE_KEY, value);
      if (alive) {
        if (version === deletionPreferenceVersion) applyDeletionPreference(value);
        preferencesStatus('Preference saved.');
      }
    } catch { if (alive) preferencesStatus('Could not save this preference. Please try again.', { error: true }); }
    finally {
      deletionPreferenceSaving = false;
      if (alive) $<HTMLButtonElement>('.confirm-delete-toggle').disabled = false;
    }
  });
  function renderComponentPreference() {
    const toggle = $<HTMLButtonElement>('.component-context-toggle');
    toggle.setAttribute('aria-checked', String(componentContextReady && componentContextEnabled));
    toggle.disabled = !runtime.captureComponentContext || componentContextLoading || componentContextSaving;
    $('.component-context-toggle .switch-value').textContent = componentContextReady && componentContextEnabled ? 'On' : 'Off';
  }
  function applyComponentPreference(value: unknown) {
    componentContextEnabled = !!runtime.captureComponentContext && value === true;
    componentContextReady = true;
    componentContextLoading = false;
    renderComponentPreference();
  }
  async function loadComponentPreference() {
    if (!runtime.captureComponentContext) {
      componentContextLoading = false;
      renderComponentPreference();
      componentContextStatus('Requires the extension.');
      return;
    }
    const version = componentContextVersion;
    try {
      const value = await store.read(COMPONENT_CONTEXT_KEY);
      if (alive && version === componentContextVersion) applyComponentPreference(value);
    } catch {
      if (alive && version === componentContextVersion) {
        componentContextLoading = false;
        renderComponentPreference();
        componentContextStatus('Could not load component capture. It remains off until you save a preference.', { error: true });
      }
    }
  }
  $('.component-context-toggle').addEventListener('click', async () => {
    if (!runtime.captureComponentContext || componentContextLoading || componentContextSaving) return;
    const value = !(componentContextReady && componentContextEnabled);
    const version = ++componentContextVersion;
    componentContextSaving = true;
    renderComponentPreference();
    componentContextStatus();
    try {
      await store.write(COMPONENT_CONTEXT_KEY, value);
      if (alive) {
        if (version === componentContextVersion) applyComponentPreference(value);
        componentContextStatus('Preference saved.');
      }
    } catch {
      if (alive) componentContextStatus('Could not save component capture. Your previous setting is unchanged.', { error: true });
    } finally {
      componentContextSaving = false;
      if (alive) renderComponentPreference();
    }
  });
  function renderView() {
    $('.settings').hidden = !settings;
    $('.connection-prompt').hidden = !connectionWarning || settings;
    $('.connection-shade').hidden = !connectionWarning || settings;
    $('.settings-button').setAttribute('aria-expanded', String(settings));
    $('.intro').hidden = settings;
    $('.scope-row').hidden = settings;
    $('.content').hidden = settings;
    $('.footer-buttons').hidden = settings;
    $('.support-link').hidden = !settings;
    if (settings) setCommentMenu(false);
    renderPrompt();
    scheduleDraw();
  }
  function setSettings(value: boolean) {
    if (value && composeOnPage) { composeOnPage = false; renderEditor(); }
    settings = value;
    if (value && picking) setPicking(false);
    renderView();
    syncState();
  }
  function syncState() {
    if (applyingState || !alive || !integration) return;
    void integration.sync(viewState(), presentation === 'remote').catch(connectionError);
  }
  function applyState(state: ViewState) {
    if (!alive) return;
    applyingState = true;
    url = state.url;
    if (native) title = state.pageTitle ?? '';
    draft = state.draft;
    composeOnPage = !!draft && !!state.composeOnPage && (native || presentation === 'remote');
    captureBusy = !!state.capturing;
    preambleDraft = typeof state.preambleDraft === 'string' ? state.preambleDraft : null;
    renderPreamble();
    scope.value = state.scope;
    setPicking(state.picking);
    renderEditor();
    setSettings(!!state.settings);
    applyingState = false;
    // Both sidebar startup and toolbar reconnection deliver page state here.
    if (state.url && connectionWarning) setConnectionWarning(false);
  }
  function setConnectionWarning(value: boolean) {
    const prompt = $('.connection-prompt');
    const changed = connectionWarning !== value;
    const restoreFocus = shadow.activeElement === prompt;
    connectionWarning = value;
    if (value) { setCopyMenu(false); setCommentMenu(false); }
    prompt.hidden = !value || settings;
    $('.connection-shade').hidden = prompt.hidden;
    if (value && changed && !settings) prompt.focus({ preventScroll: true });
    else if (!value && restoreFocus) $('.select').focus({ preventScroll: true });
  }
  function connectionError(error?: unknown) {
    setConnectionWarning(true);
    if (error) console.debug('anmerko connection:', error);
  }
  async function changeLayout(mode: string) {
    if (captureBusy) { status('Finish or cancel the screenshot first.'); return; }
    if (saving || preambleSaving || themeSaving || deletionPreferenceSaving || componentContextSaving) { status('Finishing your save…'); return; }
    if (integration?.dockViaToolbar && !native && mode === 'dock') {
      setMinimized(false);
      status('Click anmerko in Firefox’s toolbar or Extensions menu to dock this panel.');
      return;
    }
    try {
      await integration?.changeLayout(mode, viewState(), mobile);
    } catch (error) {
      console.error('anmerko layout:', error);
      status('Could not change layout. Click anmerko in the browser toolbar to open the sidebar.', true);
    }
  }
  function updateDockButton() {
    $('.dock').hidden = !native && (!canDock || mobile);
    $('.dock').replaceChildren(icon(native ? 'unpin' : 'pin'));
    $('.dock').setAttribute('aria-label', native ? 'Float panel' : 'Dock sidebar');
    $('.dock').title = native ? 'Float panel over the page' : integration?.dockViaToolbar ? 'Dock using anmerko’s toolbar icon' : 'Dock sidebar beside the page';
  }

  function updateViewport() {
    const viewport = window.visualViewport;
    app.style.setProperty('--viewport-height', `${viewport?.height ?? innerHeight}px`);
    app.style.setProperty('--viewport-bottom', `${Math.max(0, innerHeight - ((viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight)))}px`);
    scheduleDraw();
  }
  function setMinimized(value: boolean) {
    setCopyMenu(false);
    setCommentMenu(false);
    $('.panel').hidden = !native && ((presentation === 'remote' && !composeOnPage) || value || picking);
    $('.resume').hidden = native || presentation === 'remote' || !value || picking;
    $('.minimized-actions').hidden = $('.resume').hidden;
    $<HTMLButtonElement>('.quick-select').disabled = !!draft || captureBusy;
    $<HTMLButtonElement>('.quick-capture').disabled = !runtime.capture || !!draft || captureBusy;
    $<HTMLButtonElement>('.quick-global-comment').disabled = !!draft || captureBusy;
    if (value && shadow.activeElement instanceof HTMLElement) shadow.activeElement.blur();
    updateViewport();
  }
  let minimizing = false;
  let minimizeAnimation: Animation | undefined;
  async function minimize() {
    if (minimizing || captureBusy) return;
    if (saving || preambleSaving || themeSaving || deletionPreferenceSaving || componentContextSaving) { status('Finishing your save…'); return; }
    // Firefox must close its sidebar within the original user gesture.
    if (native && integration?.dockViaToolbar) { await changeLayout('minimized'); return; }
    const panel = $('.panel');
    let animation: Animation | undefined;
    minimizing = true;
    panel.inert = true;
    try {
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
        animation = panel.animate([
          { transform: 'none', opacity: 1, transformOrigin: 'bottom right' },
          { transform: 'translate(-14px, -14px) scale(.35, .06)', opacity: 0, transformOrigin: 'bottom right' },
        ], { duration: 240, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
        minimizeAnimation = animation;
        try { await animation.finished; } catch { return; }
      }
      if (!alive) return;
      if (native) await changeLayout('minimized');
      else { returnToDock = false; setMinimized(true); $('.resume').focus({ preventScroll: true }); }
    } finally {
      animation?.cancel();
      minimizeAnimation = undefined;
      panel.inert = false;
      minimizing = false;
    }
  }

  function visibleNotes() { return scope.value === 'all' ? notes : notes.filter(note => samePage(note.pageUrl, url)); }
  function status(text = '', error = false) {
    panelStatus(text, { error });
  }
  function showError(error: unknown) {
    console.error('anmerko:', error);
    if (alive) status(runtime.storageError, true);
  }
  async function refresh() {
    const version = ++readVersion;
    try {
      const loaded = await readNotes(store);
      if (!alive || version !== readVersion) return;
      notes = loaded;
      renderNotes();
    } catch (error) { showError(error); }
  }
  function setPicking(value: boolean) {
    picking = value;
    if (value) locatedId = null;
    setMinimized(false);
    $('.picker-bar').hidden = !value || native;
    $('.select .button-label').textContent = value ? 'Cancel Selection' : 'Select Element';
    touch = null;
    touchPointers.clear();
    highlighted = null;
    $('.outline').hidden = true;
    $('.hover-label').hidden = true;
    drawPins();
    syncState();
  }
  function rectFor(element: Element) {
    const rect = element.getBoundingClientRect();
    return rect.width && rect.height && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth ? rect : null;
  }
  function drawHighlight() {
    if (native) return;
    const rect = !draft && highlighted?.isConnected ? rectFor(highlighted) : null;
    const outline = $('.outline');
    const label = $('.hover-label');
    outline.hidden = !rect;
    label.hidden = !rect || !picking;
    if (!rect) return;
    Object.assign(outline.style, { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    label.textContent = highlighted!.localName + (highlighted!.id ? `#${shorten(highlighted!.id, 35)}` : '');
    Object.assign(label.style, { top: `${Math.max(4, rect.top - 28)}px`, left: `${Math.max(4, Math.min(rect.left, innerWidth - 180))}px` });
  }
  function noteRect(note: Note) {
    if (note.kind === 'page' || !samePage(note.pageUrl, pageUrl())) return null;
    if (note.screenshot) {
      const { region, scroll } = note.screenshot;
      return new DOMRect(region.x + scroll.x - scrollX, region.y + scroll.y - scrollY, region.width, region.height);
    }
    const element = resolveElement(note.element);
    return element ? rectFor(element) : null;
  }
  function drawEditorShade() {
    const shade = $('.editor-shade');
    shade.hidden = native || !draft || !samePage(draft.pageUrl, pageUrl()) || picking || settings
      || (presentation !== 'remote' && $('.panel').hidden);
    if (shade.hidden || !draft) return;
    const rect = noteRect(draft);
    const cutout = $('.editor-cutout');
    const visible = !!rect && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    cutout.hidden = !visible;
    shade.classList.toggle('has-target', visible);
    if (rect && visible) {
      Object.assign(cutout.style, { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    }
  }
  function drawPins() {
    if (native) return;
    const pins = $('.pins');
    const positions = visibleNotes().flatMap((note, index) => {
      if (!samePage(note.pageUrl, url)) return [];
      const rect = noteRect(note);
      if (!rect || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return [];
      return [{ note, index, rect, top: Math.max(2, rect.top - 12), left: Math.max(2, Math.min(rect.left - 12, innerWidth - 26)) }];
    });
    const signature = JSON.stringify([locatedId, picking, positions.map(({ note, index, rect, top, left }) => [note.id, note.updatedAt, index, rect.x, rect.y, rect.width, rect.height, top, left])]);
    if (signature === pinsSignature) return;
    pinsSignature = signature;
    pins.replaceChildren();
    positions.forEach(({ note, index, rect, top, left }) => {
      const outline = document.createElement('div');
      outline.className = 'saved-outline';
      outline.classList.toggle('active', note.id === locatedId);
      outline.dataset.noteId = note.id;
      outline.setAttribute('aria-hidden', 'true');
      Object.assign(outline.style, { top: `${rect.top}px`, left: `${rect.left}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      const pin = document.createElement('button');
      pin.className = 'pin';
      pin.classList.toggle('active', note.id === locatedId);
      pin.dataset.noteId = note.id;
      pin.disabled = picking;
      pin.textContent = String(index + 1);
      pin.setAttribute('aria-label', `Edit comment ${index + 1}`);
      pin.title = shorten(note.comment, 90);
      pin.style.top = `${top}px`;
      pin.style.left = `${left}px`;
      pin.addEventListener('click', () => editNote(note));
      pins.append(outline, pin);
    });
  }
  function draw() { frame = 0; drawEditorShade(); drawHighlight(); drawPins(); }
  function scheduleDraw() { if (alive && !frame) frame = requestAnimationFrame(draw); }
  function liveHierarchy(note: Note) {
    if (!note.element || !samePage(note.pageUrl, pageUrl())) return null;
    const element = resolveElement(note.element);
    return element ? elementHierarchy(element) : null;
  }
  function commentView(note: Note, number: number, editing = false) {
    // Recover ancestry for older comments when their page is available.
    const missingHierarchy = note.element && !note.element.hierarchy?.length;
    const hierarchy = !native && missingHierarchy ? liveHierarchy(note) : null;
    const displayNote: Note = hierarchy && note.element
      ? { ...note, element: { ...note.element, hierarchy } } : note;
    const view = createCommentCard(displayNote, number, editing);
    if (native && missingHierarchy && samePage(note.pageUrl, url)) {
      // The sidebar has its own DOM. Ask the connected page for display-only
      // ancestry; do not scroll, highlight, or rewrite the saved comment.
      void integration!.hierarchy(note).then(parts => {
        if (alive && view.card.isConnected && samePage(note.pageUrl, url) && parts?.length) view.setHierarchy(parts);
      }).catch(() => { /* Keep the saved locator if the page is unavailable. */ });
    }
    if (note.screenshot) {
      const photo = privateImage(note.screenshot.dataUrl, editing ? 'Screenshot to comment on' : 'Comment screenshot');
      photo.className = 'screenshot-preview';
      view.card.querySelector('.note-metadata')!.append(photo);
    }
    const locate = view.card.querySelector<HTMLButtonElement>('.locate')!;
    locate.disabled = !samePage(note.pageUrl, url);
    locate.addEventListener('click', async () => {
      try {
        const found = native ? await integration!.locate(note, false) : locateNote(note, false);
        status(found ? `${note.screenshot ? 'Screenshot region' : 'Element'} highlighted on the page.` : 'This element has changed or is no longer on the page. Your comment is still saved.', !found);
      } catch (error) { connectionError(error); }
    });
    return view;
  }
  function renderNotes() {
    if (locatedId && !notes.some(note => note.id === locatedId)) locatedId = null;
    const filtered = visibleNotes();
    $('.count').textContent = `${filtered.length} comment${filtered.length === 1 ? '' : 's'}`;
    $('.resume .button-label').textContent = `${filtered.length} Comment${filtered.length === 1 ? '' : 's'}`;
    renderPrompt();
    const list = $('.notes');
    noteViews.forEach(dispose => dispose());
    noteViews = [];
    list.replaceChildren();
    if (!filtered.length && !draft) {
      list.innerHTML = '<div class="empty">No comments yet.</div>';
    }
    filtered.forEach((note, index) => {
      const { card, dispose } = commentView(note, index + 1);
      noteViews.push(dispose);
      card.querySelector('.edit')!.addEventListener('click', () => editNote(note));
      card.querySelector('.delete')!.addEventListener('click', () => {
        if (deleting) return;
        if (confirmIndividualDeletion) showDeleteConfirmation({ kind: 'single', note });
        else void deleteComment(note);
      });
      if (scope.value === 'all') {
        const label = card.querySelector<HTMLElement>('.page-label')!;
        label.hidden = false;
        label.textContent = note.pageUrl;
        label.title = note.pageUrl;
      }
      list.append(card);
    });
    drawPins();
  }
  function editNote(note: Note) {
    if (draft) { status('Save or cancel your current draft before editing another comment.', true); return; }
    setMinimized(false);
    draft = structuredClone(note);
    composeOnPage = presentation === 'remote';
    setSettings(false);
    renderEditor();
  }
  function locateNote(note: Note, parent: boolean) {
    if (note.kind === 'page' || !samePage(note.pageUrl, pageUrl())) return null;
    if (note.screenshot) {
      if (parent) return null;
      const { region, scroll } = note.screenshot;
      window.scrollTo({ left: Math.max(0, scroll.x + region.x + region.width / 2 - innerWidth / 2), top: Math.max(0, scroll.y + region.y + region.height / 2 - innerHeight / 2), behavior: 'instant' });
      highlighted = null;
    } else {
      const element = resolveElement(note.element);
      const target = parent
        ? element?.parentElement || (element?.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null) : element;
      if (!target || target === document.documentElement) return null;
      target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      highlighted = parent ? target : null;
      if (parent) { drawHighlight(); return captureElement(target); }
    }
    locatedId = note.id;
    drawHighlight();
    drawPins();
    return true;
  }
  function renderEditor() {
    scheduleDraw();
    if (!draft) composeOnPage = false;
    app.classList.toggle('composing', composeOnPage && !native);
    if (presentation === 'remote') setMinimized(false);
    app.classList.toggle('editing', !!draft);
    const slot = $('.editor-slot');
    disposeEditor?.();
    disposeEditor = undefined;
    slot.replaceChildren();
    $<HTMLButtonElement>('.select').disabled = !!draft || captureBusy || (native && !url);
    $<HTMLButtonElement>('.capture').disabled = !runtime.capture || !!draft || captureBusy || (native && !url);
    $<HTMLButtonElement>('.comment-options').disabled = !!draft || captureBusy || !url;
    $<HTMLButtonElement>('.global-comment').disabled = !!draft || captureBusy || !url;
    if ($<HTMLButtonElement>('.comment-options').disabled) setCommentMenu(false);
    for (const selector of ['.dock', '.minimize', '.settings-button', '.close']) $<HTMLButtonElement>(selector).disabled = captureBusy;
    scope.disabled = captureBusy || (native && !url);
    if (!draft) {
      renderNotes(); syncState();
      if (composingFromMinimized && !captureBusy && !picking) {
        composingFromMinimized = false;
        setMinimized(true);
        $('.resume').focus({ preventScroll: true });
      }
      return;
    }
    if (native && composeOnPage) {
      slot.innerHTML = '<div class="draft-on-page"><p>Write your comment in the editor on the page.</p><button class="secondary edit-in-sidebar" type="button"><span data-icon="edit"></span>Edit in Sidebar</button></div>';
      renderIcons(slot);
      slot.querySelector('.edit-in-sidebar')!.addEventListener('click', () => { composeOnPage = false; renderEditor(); });
      renderNotes();
      syncState();
      return;
    }
    const filtered = visibleNotes();
    const index = filtered.findIndex(note => note.id === draft!.id);
    const view = commentView(draft, index < 0 ? filtered.length + 1 : index + 1, true);
    disposeEditor = view.dispose;
    slot.append(view.card);
    const textarea = slot.querySelector('textarea')!;
    textarea.value = draft.comment;
    const parentButton = slot.querySelector<HTMLButtonElement>('.parent')!;
    parentButton.hidden = !draft.element;
    const element = samePage(draft.pageUrl, url) && draft.element ? resolveElement(draft.element) : null;
    const parent = element?.parentElement || (element?.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null);
    parentButton.disabled = saving || !samePage(draft.pageUrl, url) || (!native && (!parent || parent === document.documentElement));
    parentButton.addEventListener('click', async () => {
      if (native && draft?.element && !saving) {
        try {
          const element = await integration!.locate(draft, true);
          if (element && typeof element !== 'boolean' && draft?.element) { draft.element = element; renderEditor(); }
          else { parentButton.disabled = true; status('No parent element is available on this page.'); }
        } catch (error) { connectionError(error); }
      } else if (draft?.element && parent && !saving && samePage(draft.pageUrl, pageUrl())) { draft.element = captureElement(parent); highlighted = parent; drawHighlight(); renderEditor(); }
    });
    textarea.disabled = saving;
    slot.querySelector<HTMLButtonElement>('.save')!.disabled = saving;
    slot.querySelector<HTMLButtonElement>('.cancel')!.disabled = saving;
    textarea.addEventListener('input', () => { if (draft) { draft.comment = textarea.value; syncState(); } });
    textarea.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void commitDraft(); }
    });
    slot.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); void commitDraft(); });
    slot.querySelector('.cancel')!.addEventListener('click', () => { if (!saving) { draft = null; highlighted = null; renderEditor(); drawHighlight(); status(); } });
    renderNotes();
    slot.scrollIntoView({ block: 'nearest' });
    textarea.focus();
    syncState();
  }
  async function commitDraft() {
    if (!draft || saving) return;
    if (!draft.comment.trim()) { status('Write a comment before saving.', true); return; }
    saving = true;
    const save = $<HTMLButtonElement>('.save');
    save.disabled = true;
    $<HTMLButtonElement>('.cancel').disabled = true;
    const field = $<HTMLTextAreaElement>('#comment');
    field.disabled = true;
    const saved = { ...draft, comment: draft.comment.trim(), updatedAt: new Date().toISOString() };
    try {
      await saveNote(store, saved);
      if (!alive) return;
      if (draft?.id === saved.id) draft = null;
      highlighted = null;
      renderEditor();
      await refresh();
      drawHighlight();
      status('Comment saved.');
    } catch (error) {
      if (!alive) return;
      showError(error);
      save.disabled = false;
      $<HTMLButtonElement>('.cancel').disabled = false;
      field.disabled = false;
    } finally { saving = false; }
  }
  function ownEvent(event: Event) { return event.composedPath().includes(host); }
  async function startCapture() {
    if (!alive || !runtime.capture || draft || captureBusy) return;
    if (native) {
      try { await integration!.startCapture(); }
      catch (error) { connectionError(error); }
      return;
    }
    setPicking(false); setSettings(false); status();
    captureBusy = true;
    captureAbort = new AbortController();
    renderEditor();
    const source = { pageUrl: pageUrl(), pageTitle: document.title };
    try {
      const screenshot = await selectScreenshot(app, mobile, runtime.capture, captureAbort.signal);
      if (screenshot && alive) {
        const time = new Date().toISOString();
        draft = { id: createUuid(), ...source, comment: '', screenshot, createdAt: time, updatedAt: time };
        composeOnPage = presentation === 'remote' || composingFromMinimized;
      }
    } catch (error) {
      if (composingFromMinimized) { composingFromMinimized = false; setMinimized(false); }
      const message = `${error instanceof Error ? error.message : 'Could not capture this page.'} Open anmerko from the toolbar and try again.`;
      status(message, true);
      if (presentation === 'remote') integration?.captureError(message);
    } finally {
      captureBusy = false; captureAbort = null;
      if (alive) { renderEditor(); if (!draft && $('.minimized-actions').hidden) $('.comment-options').focus(); }
    }
  }
  function startGlobalComment() {
    if (!alive || draft || captureBusy || !url || connectionWarning) return;
    setCommentMenu(false);
    const time = new Date().toISOString();
    draft = { id: createUuid(), kind: 'page', pageUrl: native ? url : pageUrl(), pageTitle: native ? title : document.title,
      comment: '', createdAt: time, updatedAt: time };
    // Open synchronously in the document that owns the menu and keyboard focus.
    composeOnPage = composingFromMinimized;
    setPicking(false); setSettings(false); status();
    renderEditor();
  }
  function eventElement(event: Event): Element | undefined {
    return event.composedPath().find(node => node instanceof Element) as Element | undefined;
  }
  function selectElement(element?: Element) {
    if (!element || !element.isConnected || element === document.documentElement) return;
    const time = new Date().toISOString();
    draft = { id: createUuid(), pageUrl: pageUrl(), pageTitle: document.title,
      comment: '', element: captureElement(element), createdAt: time, updatedAt: time };
    composeOnPage = presentation === 'remote' || composingFromMinimized;
    setPicking(false);
    highlighted = element;
    drawHighlight();
    renderEditor();
  }
  document.addEventListener('pointermove', event => {
    if (!picking) return;
    if (event.pointerType === 'touch') {
      if (touch?.id === event.pointerId && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 12) touch.moved = true;
      // Leave browser panning and pinch zoom enabled; don't highlight while scrolling.
      event.stopImmediatePropagation();
      return;
    }
    highlighted = ownEvent(event) ? null : eventElement(event) || null;
    drawHighlight();
  }, { capture: true, signal: abort.signal });
  document.addEventListener('pointerdown', event => {
    // A new gesture on the panel is intentional; compatibility mouse events
    // from the selecting tap have no new pointerdown and remain suppressed.
    if (ownEvent(event)) { suppressMouseUntil = 0; return; }
    if (!picking) return;
    event.stopImmediatePropagation();
    if (event.pointerType !== 'touch') { event.preventDefault(); return; }
    touchPointers.add(event.pointerId);
    if (touchPointers.size > 1) { if (touch) touch.moved = true; return; }
    touch = { id: event.pointerId, x: event.clientX, y: event.clientY, started: performance.now(), moved: false, element: eventElement(event) };
  }, { capture: true, signal: abort.signal });
  document.addEventListener('pointerup', event => {
    if (!picking || ownEvent(event)) return;
    event.stopImmediatePropagation();
    if (event.pointerType !== 'touch') { event.preventDefault(); return; }
    touchPointers.delete(event.pointerId);
    const candidate = touch;
    touch = null;
    suppressMouseUntil = performance.now() + 800;
    if (candidate?.id === event.pointerId && !candidate.moved && !touchPointers.size
      && performance.now() - candidate.started < 700
      && Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) <= 12) {
      event.preventDefault();
      selectElement(candidate.element);
    }
  }, { capture: true, signal: abort.signal });
  document.addEventListener('pointercancel', event => {
    touchPointers.delete(event.pointerId);
    if (touch?.id === event.pointerId) touch = null;
    if (picking) suppressMouseUntil = performance.now() + 800;
  }, { capture: true, signal: abort.signal });
  // Stop site touch handlers while selecting, without cancelling native scrolling.
  for (const name of ['touchstart', 'touchmove', 'touchend']) {
    document.addEventListener(name, event => {
      if ((picking || performance.now() < suppressMouseUntil) && !ownEvent(event)) event.stopImmediatePropagation();
    }, { capture: true, passive: true, signal: abort.signal });
  }
  for (const name of ['mousedown', 'mouseup', 'dblclick', 'auxclick', 'contextmenu']) {
    document.addEventListener(name, event => {
      if (performance.now() >= suppressMouseUntil && (!picking || ownEvent(event))) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, { capture: true, signal: abort.signal });
  }
  document.addEventListener('click', event => {
    // A touch tap can emit a compatibility click after opening the editor.
    // Firefox 142 may retarget it into the newly rendered editor. A fresh panel
    // pointerdown clears this guard so the next deliberate tap still works.
    const touchClick = event instanceof PointerEvent && event.pointerType === 'touch';
    if (performance.now() < suppressMouseUntil && (!ownEvent(event) || touchClick)) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    if (!picking || ownEvent(event)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    selectElement(eventElement(event));
  }, { capture: true, signal: abort.signal });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && picking) { event.preventDefault(); event.stopImmediatePropagation(); cancelSelection(); }
  }, { capture: true, signal: abort.signal });
  document.addEventListener('scroll', scheduleDraw, { capture: true, passive: true, signal: abort.signal });
  window.addEventListener('resize', updateViewport, { signal: abort.signal });
  window.visualViewport?.addEventListener('resize', updateViewport, { signal: abort.signal });
  window.visualViewport?.addEventListener('scroll', updateViewport, { signal: abort.signal });
  $('.select').addEventListener('click', () => { if (!draft) { status(); setPicking(!picking); if (!native) $('.picker-bar button').focus(); } });
  $('.capture').addEventListener('click', event => { if (event.isTrusted) { setCommentMenu(false); void startCapture(); } });
  $('.global-comment').addEventListener('click', startGlobalComment);
  function cancelSelection() {
    setPicking(false);
    if (composingFromMinimized && !draft) {
      composingFromMinimized = false;
      setMinimized(true);
      $('.quick-select').focus({ preventScroll: true });
    } else $('.select').focus();
  }
  $('.picker-bar button').addEventListener('click', cancelSelection);
  $('.quick-select').addEventListener('click', () => {
    if (draft || captureBusy) return;
    composingFromMinimized = true;
    setSettings(false); status(); setPicking(true);
    $('.picker-bar button').focus();
  });
  $('.quick-capture').addEventListener('click', event => {
    if (!event.isTrusted || draft || captureBusy || !runtime.capture) return;
    composingFromMinimized = true;
    void startCapture();
  });
  $('.quick-global-comment').addEventListener('click', () => {
    if (draft || captureBusy) return;
    composingFromMinimized = true;
    startGlobalComment();
  });
  $('.minimize').addEventListener('click', () => { void minimize(); });
  $('.resume').addEventListener('click', () => { if (returnToDock && !mobile) void changeLayout('dock'); else setMinimized(false); });
  $('.dock').addEventListener('click', () => { if (!mobile) void changeLayout(native ? 'overlay' : 'dock'); });
  $('.settings-button').addEventListener('click', () => {
    setSettings(!settings);
    (settings ? $('.settings-back') : $('.settings-button')).focus();
  });
  $('.settings-back').addEventListener('click', () => { setSettings(false); $('.settings-button').focus(); });
  for (const button of shadow.querySelectorAll<HTMLButtonElement>('.theme-option')) {
    button.addEventListener('click', () => void saveTheme(button.dataset.theme as Theme));
  }
  $('#preamble').addEventListener('input', () => {
    const value = $<HTMLTextAreaElement>('#preamble').value;
    preambleDraft = value === preamble ? null : value;
    preambleStatus(preambleDraft === null ? '' : 'Unsaved changes.', { persistent: true });
    renderPreamble();
    syncState();
  });
  $('.save-preamble').addEventListener('click', () => void savePreamble());
  $('.reset-preamble').addEventListener('click', () => void savePreamble(true));
  scope.addEventListener('change', () => { status(); renderNotes(); syncState(); });
  $('.copy').addEventListener('click', async () => {
    setCopyMenu(false);
    const copied = visibleNotes();
    if (!copied.length || !preambleReady || deleting) return;
    const prompt = buildPrompt(copied, preamble);
    try {
      await navigator.clipboard.writeText(prompt);
      if (!alive) return;
      copyFailed = false;
      copiedComments = copied;
      renderPrompt();
      status(`Copied ${copied.length} comment${copied.length === 1 ? '' : 's'}.${copied.some(note => note.screenshot) ? ' Download the images to attach them with the prompt.' : ''}`);
    } catch {
      if (!alive) return;
      copyFailed = true;
      copiedComments = null;
      renderPrompt();
      status('Could not copy. Use Download Markdown + Images to export your comments.', true);
    }
  });
  const deleteDialog = $<HTMLDialogElement>('.delete-dialog');
  function confirmDelete(event: Event) {
    renderPrompt();
    const current = visibleNotes();
    if (!current.length || deleting) return;
    if (saving) { status('Finishing your save…'); return; }
    setCopyMenu(false, event.currentTarget === $('.delete-all'));
    showDeleteConfirmation({ kind: 'all', notes: current });
  }
  function showDeleteConfirmation(request: PendingDeletion) {
    if (deleting || deleteDialog.open) return;
    pendingDeletion = request;
    const all = request.kind === 'all';
    $('#delete-title').textContent = all ? 'Delete All Comments?' : 'Delete Comment?';
    $('.delete-dialog .button-label').textContent = all ? 'Delete All Comments' : 'Delete Comment';
    const description = request.kind === 'single' ? 'this comment'
      : request.notes.length === 1 ? 'this comment' : `all ${request.notes.length} comments`;
    $('#delete-description').textContent = `This will delete ${description}. This cannot be undone.`;
    deleteDialog.returnValue = '';
    deleteDialog.showModal();
  }
  $('.delete-all').addEventListener('click', confirmDelete);
  $('.clear-copied').addEventListener('click', confirmDelete);
  deleteDialog.addEventListener('close', () => {
    const request = pendingDeletion;
    pendingDeletion = null;
    if (deleteDialog.returnValue !== 'delete' || !request) return;
    if (request.kind === 'all') void deleteComments(request.notes);
    else void deleteComment(request.note);
  });
  async function deleteComment(note: Note) {
    if (deleting || !alive) return;
    deleting = true;
    renderPrompt();
    try {
      await removeNote(store, note.id);
      if (!alive) return;
      if (draft?.id === note.id) { draft = null; renderEditor(); }
      await refresh();
      status('Comment deleted.');
    } catch (error) { if (alive) showError(error); }
    finally { deleting = false; if (alive) renderPrompt(); }
  }
  async function deleteComments(confirmed: Note[]) {
    if (deleting || !alive) return;
    deleting = true;
    renderPrompt();
    try {
      // Recheck storage after confirmation so a stale panel cannot clear
      // comments added or edited while the confirmation was open.
      const stored = await readNotes(store);
      const current = scope.value === 'all' ? stored : stored.filter(note => samePage(note.pageUrl, url));
      if (!alive) return;
      if (commentSignature(confirmed) !== commentSignature(current)) {
        copiedComments = null;
        await refresh();
        status('Comments changed. Review them and try again.');
        return;
      }
      const results = await Promise.allSettled(confirmed.map(note => removeNote(store, note.id)));
      if (!alive) return;
      copiedComments = null;
      if (draft && confirmed.some((note, index) => note.id === draft?.id && results[index].status === 'fulfilled')) {
        draft = null;
        highlighted = null;
        renderEditor();
      }
      await refresh();
      const failed = results.filter(result => result.status === 'rejected').length;
      status(failed ? 'Some comments could not be deleted. Try deleting the remaining comments again.' : 'Comments deleted.', !!failed);
    } catch (error) { if (alive) showError(error); }
    finally { deleting = false; if (alive) renderPrompt(); }
  }
  $('.download').addEventListener('click', event => {
    if (!event.isTrusted || !preambleReady || !visibleNotes().length) return;
    try {
      downloadFile(new Blob([feedbackArchive(visibleNotes(), preamble)], { type: 'application/zip' }), 'anmerko-comments.zip');
      status('Download started. Extract the ZIP and attach its images with the prompt.');
    } catch { status('Could not download the files. Your comments are still saved.', true); }
  });
  const unsubscribe = store.subscribe(changes => {
    if (changes[COMPONENT_CONTEXT_KEY]) { ++componentContextVersion; applyComponentPreference(changes[COMPONENT_CONTEXT_KEY].newValue); }
    if (changes[CONFIRM_DELETE_KEY]) { ++deletionPreferenceVersion; applyDeletionPreference(changes[CONFIRM_DELETE_KEY].newValue); }
    if (changes[THEME_KEY]) { ++themeVersion; applyTheme(changes[THEME_KEY].newValue); }
    if (changes[PREAMBLE_KEY]) { ++preambleVersion; applyPreamble(changes[PREAMBLE_KEY].newValue); }
    if (Object.keys(changes).some(key => key.startsWith(STORAGE_PREFIX))) void refresh();
  });
  // Handles SPA route changes without injecting into the page's JavaScript world.
  const navigation = window.setInterval(() => {
    if (native) return;
    if (title !== document.title) { title = document.title; syncState(); }
    const current = pageUrl();
    if (current !== url) {
      captureAbort?.abort();
      url = current;
      locatedId = null;
      setPicking(false);
      if (draft) renderEditor();
      renderNotes();
      status(draft ? 'Page changed. Your draft will be saved to the page where you started the comment.' : 'Showing comments for this page.');
      syncState();
    }
    scheduleDraw();
  }, 650);
  function close(): boolean {
    if (!alive) return true;
    if (saving || preambleSaving || themeSaving || deletionPreferenceSaving || componentContextSaving) { setMinimized(false); status('Finishing your save…'); return false; }
    if (draft?.comment.trim()) { setMinimized(false); status('Save or cancel your draft before closing.', true); setSettings(false); return false; }
    if (preambleDraft !== null) { setMinimized(false); setSettings(true); status('Save or restore your preamble before closing.', true); return false; }
    if (native) { void changeLayout('closed'); return false; }
    dispose();
    return true;
  }
  function dispose() {
    if (!alive) return;
    alive = false;
    minimizeAnimation?.cancel();
    captureAbort?.abort();
    abort.abort();
    unsubscribe();
    clearInterval(navigation);
    cancelAnimationFrame(frame);
    noteViews.forEach(dispose => dispose());
    disposeEditor?.();
    host.remove();
    runtime.onDispose?.();
  }
  function reveal() {
    if (!alive) return;
    minimizeAnimation?.cancel();
    setPicking(false);
    setMinimized(false);
    (settings ? $('#preamble') : draft ? $('#comment') ?? $('.edit-in-sidebar') : $('.select')).focus();
  }
  function present(mode: PresentationMode, dock: boolean, state?: ViewState, notifySidebar = true) {
    if (!alive) return;
    if (mode !== 'remote') captureAbort?.abort();
    canDock = dock && !mobile;
    presentation = mobile && mode === 'remote' ? 'overlay' : mode;
    returnToDock = presentation === 'minimized';
    if (state) applyState(state);
    else if (presentation !== 'remote' && composeOnPage) { composeOnPage = false; renderEditor(); }
    if (presentation === 'closed') close();
    else {
      setMinimized(presentation === 'minimized');
      updateDockButton();
      if (notifySidebar) syncState();
    }
  }
  const controller: Controller = {
    ready: Promise.resolve(), close, dispose, reveal, viewState, applyState, present, startCapture, status,
    sidebarClosed() {
      if (!alive || presentation !== 'remote') return;
      captureAbort?.abort();
      presentation = 'minimized'; returnToDock = true; composeOnPage = false; renderEditor(); setPicking(false); setMinimized(true);
    },
    locate: locateNote,
    hierarchy: liveHierarchy,
    connectionFailed(error) {
      applyState({ url: '', draft: null, scope: 'page', picking: false, settings: false });
      $<HTMLButtonElement>('.select').disabled = true;
      $<HTMLButtonElement>('.capture').disabled = true;
      connectionError(error);
    },
  };
  $('.close').addEventListener('click', close);
  try {
    const styles = runtime.attachStyles(shadow, abort.signal);
    if (styles) {
      host.style.setProperty('visibility', 'hidden', 'important');
      controller.ready = styles.then(() => {
        if (alive) host.style.removeProperty('visibility');
      }).catch(error => { dispose(); throw error; });
    }
    if (native) {
      // The native panel has no page identity until its startup snapshot arrives.
      $<HTMLButtonElement>('.select').disabled = true;
      $<HTMLButtonElement>('.capture').disabled = true;
      $<HTMLButtonElement>('.comment-options').disabled = true;
      $<HTMLButtonElement>('.global-comment').disabled = true;
      scope.disabled = true;
      setConnectionWarning(true);
    }
    integration?.connect(controller, abort.signal);
  } catch (error) { dispose(); throw error; }
  updateDockButton();
  updateViewport();
  applyTheme('light');
  void loadTheme();
  void loadDeletionPreference();
  void loadComponentPreference();
  renderPreamble();
  void loadPreamble();
  void refresh();
  return controller;
}
