import type { Note } from './core';
import { icon, renderIcons } from './icons';
import { createUuid } from './uuid';
import { normalizeComponentContext, type ComponentContextV1 } from './component-context';

const elementTypes: Record<string, string> = {
  textarea: 'Text Area', input: 'Input', select: 'Select', button: 'Button', a: 'Link',
  img: 'Image', p: 'Paragraph', div: 'Container', span: 'Text', form: 'Form', em: 'Emphasis', strong: 'Strong Text',
  h1: 'Heading', h2: 'Heading', h3: 'Heading', h4: 'Heading', h5: 'Heading', h6: 'Heading',
};

export function createCommentCard(note: Note, number: number, editing = false, removeContext?: () => void) {
  const card = document.createElement(editing ? 'form' : 'article');
  card.className = editing ? 'editor' : 'note';
  card.innerHTML = `<div class="note-top"><span class="number"></span><strong class="note-title"></strong><div class="note-actions" role="group" aria-label="Comment actions"><button class="text-button locate" type="button" aria-label="Locate"><span data-icon="select"></span></button></div></div>
    <div class="note-metadata"><div class="note-kind"><span data-icon="field"></span><span class="tag"></span></div><div class="hierarchy"><code class="selector"></code><button class="text-button hierarchy-toggle" type="button" aria-label="Show Full Element Hierarchy" aria-expanded="false" hidden></button></div><div class="page-label" hidden></div></div>
    <div class="comment-body"><textarea class="comment" rows="3"></textarea></div>`;
  if (note.screenshot) card.querySelector('.note-kind [data-icon]')!.setAttribute('data-icon', 'camera');
  if (note.kind === 'page') {
    card.querySelector('.note-kind [data-icon]')!.setAttribute('data-icon', 'comment');
    card.querySelector<HTMLElement>('.locate')!.hidden = true;
  }
  if (editing) {
    card.querySelector('.note-actions')!.insertAdjacentHTML('beforeend', '<span class="editing-badge"><span data-icon="edit"></span>Editing</span>');
    card.querySelector('.note-kind')!.insertAdjacentHTML('beforeend', '<button class="text-button parent" type="button" aria-label="Use Parent Element" title="Use Parent Element"><span data-icon="parent"></span></button>');
    card.querySelector('.comment-body')!.insertAdjacentHTML('beforeend', '<div class="editor-actions"><span class="shortcut">⌘ / Ctrl + Enter to save</span><button class="secondary cancel" type="button"><span data-icon="close"></span>Cancel</button><button class="primary save" type="submit"><span data-icon="save"></span>Save</button></div>');
  } else {
    card.querySelector('.note-actions')!.insertAdjacentHTML('beforeend', '<button class="text-button edit" type="button" aria-label="Edit"><span data-icon="edit"></span></button><button class="text-button delete" type="button" aria-label="Delete"><span data-icon="trash"></span></button>');
  }
  renderIcons(card);
  card.querySelector('.number')!.textContent = String(number);
  card.querySelector('.number')!.setAttribute('aria-label', `Comment Number ${number}`);
  const type = note.element ? elementTypes[note.element.tag] || note.element.tag.charAt(0).toUpperCase() + note.element.tag.slice(1) : note.screenshot ? 'Screenshot' : 'Page';
  const title = note.element ? note.element.label || note.element.text || `Unnamed ${type}` : note.screenshot ? 'Screenshot' : 'Global Comment';
  const heading = card.querySelector<HTMLElement>('.note-title')!;
  heading.textContent = title;
  heading.title = title;
  card.querySelector('.tag')!.textContent = note.screenshot ? `${note.screenshot.width} × ${note.screenshot.height} px` : type;
  const field = card.querySelector('textarea')!;
  field.textContent = note.comment;
  field.readOnly = !editing;
  if (editing) { field.id = 'comment'; field.placeholder = 'Add a comment'; field.maxLength = 10000; field.required = true; }
  field.setAttribute('aria-label', editing ? 'Comment' : `Comment ${number}`);
  const hierarchy = card.querySelector<HTMLElement>('.hierarchy')!;
  hierarchy.hidden = !note.element;
  const path = card.querySelector<HTMLElement>('.selector')!;
  const toggle = card.querySelector<HTMLButtonElement>('.hierarchy-toggle')!;
  path.id = `hierarchy-${createUuid()}`;
  toggle.setAttribute('aria-controls', path.id);
  if (note.element) field.setAttribute('aria-describedby', path.id);
  const componentSlot = document.createElement('div');
  card.querySelector('.note-metadata')!.append(componentSlot);
  function setComponentContext(value?: ComponentContextV1) {
    componentSlot.replaceChildren();
    const context = normalizeComponentContext(value);
    if (!context) return;
    const row = document.createElement('div');
    row.className = 'component-context';
    const label = document.createElement('strong');
    const framework = { react: 'React', vue: 'Vue', angular: 'Angular', preact: 'Preact' }[context.framework];
    label.textContent = `Component hint · ${framework}`;
    const provenance = document.createElement('span');
    provenance.className = 'component-context-source';
    provenance.textContent = context.framework === 'react' ? 'Development metadata'
      : context.framework === 'preact' ? 'Runtime metadata'
      : 'Debug metadata';
    const names = document.createElement('code');
    names.className = 'component-context-path';
    names.textContent = (context.truncated ? '… → ' : '') + context.path.join(' → ');
    const description = document.createElement('span');
    description.className = 'component-context-disclaimer';
    description.textContent = 'Page-provided names; review before sharing.';
    row.append(label, provenance, names, description);
    if (editing && removeContext) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'text-button remove-component-context';
      remove.textContent = 'Remove component hint';
      remove.addEventListener('click', removeContext);
      row.append(remove);
    }
    componentSlot.append(row);
  }
  setComponentContext(note.element?.componentContext);
  // Older comments still have their original locator path available.
  let parts = note.element?.hierarchy?.length ? note.element.hierarchy : note.element?.selectorPath || [];
  let expanded = false;
  function render() {
    path.textContent = parts.join(' > ');
    path.title = path.textContent;
    if (!card.isConnected || !hierarchy.clientWidth) return;
    hierarchy.classList.toggle('expanded', expanded);
    toggle.setAttribute('aria-expanded', String(expanded));
    toggle.setAttribute('aria-label', expanded ? 'Collapse Element Hierarchy' : 'Show Full Element Hierarchy');
    toggle.replaceChildren(icon(expanded ? 'collapse' : 'expand'));
    toggle.hidden = !expanded;
    if (expanded || path.scrollWidth <= path.clientWidth + 1) return;
    toggle.hidden = false;
    const tail = parts.slice(-Math.min(3, parts.length));
    do {
      path.textContent = (tail.length < parts.length ? '... ' : '') + tail.join(' > ');
      if (path.scrollWidth <= path.clientWidth + 1 || tail.length === 1) break;
      tail.shift();
    } while (tail.length);
  }
  toggle.addEventListener('click', () => { expanded = !expanded; render(); });
  // Initialize hierarchy text before the first layout; resizing controls truncation.
  render();
  const observer = new ResizeObserver(render);
  observer.observe(hierarchy);
  return {
    card,
    setComponentContext,
    setHierarchy(value: string[]) { parts = value; render(); },
    dispose: () => observer.disconnect(),
  };
}
