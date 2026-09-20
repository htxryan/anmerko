import {
  inspectNormalizedJourneyPng,
  maskJourneyPng,
  type JourneyMaskRect,
  type NormalizedJourneyPng,
} from './journey-image';
import { privateImage } from './screenshot';

export interface JourneyImageReviewInput {
  dataUrl: string;
  width: number;
  height: number;
}

export type JourneyImageReviewResult =
  | { kind: 'applied'; image: NormalizedJourneyPng }
  | { kind: 'removed' }
  | { kind: 'cancelled' };

type GeometryKey = keyof JourneyMaskRect;

const GEOMETRY_LABELS: ReadonlyArray<[GeometryKey, string]> = [
  ['x', 'X'],
  ['y', 'Y'],
  ['width', 'Width'],
  ['height', 'Height'],
];

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value));

function validDimensions(input: JourneyImageReviewInput): boolean {
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height)
    || input.width <= 0 || input.height <= 0 || typeof input.dataUrl !== 'string') return false;
  try {
    const inspected = inspectNormalizedJourneyPng(input.dataUrl);
    return inspected.width === input.width && inspected.height === input.height;
  } catch {
    return false;
  }
}

function validRect(rect: JourneyMaskRect, image: JourneyImageReviewInput): boolean {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  return [rect.x, rect.y, rect.width, rect.height, right, bottom].every(Number.isFinite)
    && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0
    && right > rect.x && bottom > rect.y
    && right <= image.width && bottom <= image.height;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (className) result.className = className;
  return result;
}

export function reviewJourneyImage(
  root: HTMLElement,
  input: JourneyImageReviewInput,
  signal: AbortSignal,
): Promise<JourneyImageReviewResult> {
  if (signal.aborted || !validDimensions(input)) return Promise.resolve({ kind: 'cancelled' });

  let sourceDataUrl = input.dataUrl;
  const view = element('section', 'journey-image-review');
  view.setAttribute('role', 'dialog');
  view.setAttribute('aria-label', 'Mask screenshot');

  const heading = element('h2', 'journey-image-review__heading');
  heading.textContent = 'Mask sensitive details';
  heading.tabIndex = -1;
  const help = element('p', 'journey-image-review__help');
  help.textContent = 'Drag over the screenshot or enter an exact region to cover it with an opaque mask.';

  const stage = element('div', 'journey-image-review__stage');
  stage.style.aspectRatio = `${input.width} / ${input.height}`;
  stage.style.width = `min(100%, calc(56vh * ${input.width / input.height}))`;
  let preview: HTMLElement | null = privateImage(sourceDataUrl, 'Screenshot to mask');
  preview.className = 'journey-image-review__preview';
  const selection = element('div', 'journey-image-review__selection');
  selection.hidden = true;
  const drawing = element('div', 'journey-image-review__drawing');
  drawing.setAttribute('aria-label', 'Draw mask region');
  stage.append(preview, selection, drawing);

  const fields = element('fieldset', 'journey-image-review__fields');
  const legend = element('legend');
  legend.textContent = 'Mask region in image pixels';
  fields.append(legend);
  const inputs = {} as Record<GeometryKey, HTMLInputElement>;
  for (const [key, labelText] of GEOMETRY_LABELS) {
    const label = element('label', 'journey-image-review__field');
    const text = element('span');
    text.textContent = labelText;
    const control = element('input');
    control.type = 'number';
    control.inputMode = 'numeric';
    control.step = 'any';
    control.min = key === 'width' || key === 'height' ? '1' : '0';
    control.setAttribute('aria-label', labelText);
    label.append(text, control);
    fields.append(label);
    inputs[key] = control;
  }

  const error = element('p', 'journey-image-review__error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const actions = element('div', 'journey-image-review__actions');
  const remove = element('button', 'journey-image-review__button journey-image-review__button--danger');
  remove.type = 'button';
  remove.textContent = 'Remove screenshot';
  const cancel = element('button', 'journey-image-review__button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const apply = element('button', 'journey-image-review__button journey-image-review__button--primary');
  apply.type = 'button';
  apply.textContent = 'Apply mask';
  apply.disabled = true;
  actions.append(remove, cancel, apply);
  view.append(heading, help, stage, fields, error, actions);
  root.replaceChildren(view);

  return new Promise(resolve => {
    const listeners = new AbortController();
    let alive = true;
    let operation = 0;
    let applying = false;
    let completed: JourneyMaskRect | null = null;
    let draft: JourneyMaskRect = { x: Number.NaN, y: Number.NaN, width: Number.NaN, height: Number.NaN };
    let drag: { pointerId: number; startX: number; startY: number; before: JourneyMaskRect | null } | null = null;
    let multiTouchBlocked = false;
    const pointers = new Set<number>();
    let stageBounds = stage.getBoundingClientRect();

    const currentDraft = (): JourneyMaskRect => ({
      x: inputs.x.valueAsNumber,
      y: inputs.y.valueAsNumber,
      width: inputs.width.valueAsNumber,
      height: inputs.height.valueAsNumber,
    });

    function render() {
      const valid = validRect(draft, input);
      apply.disabled = applying || !valid;
      view.setAttribute('aria-busy', applying ? 'true' : 'false');
      for (const control of Object.values(inputs)) {
        control.disabled = applying;
        control.setAttribute('aria-invalid', valid || control.value === '' ? 'false' : 'true');
      }
      selection.hidden = !completed;
      if (completed) Object.assign(selection.style, {
        left: `${completed.x / input.width * 100}%`,
        top: `${completed.y / input.height * 100}%`,
        width: `${completed.width / input.width * 100}%`,
        height: `${completed.height / input.height * 100}%`,
      });
    }

    function showError() {
      error.textContent = 'The screenshot could not be masked. Adjust the region and try again.';
      error.hidden = false;
    }

    function finish(result: JourneyImageReviewResult) {
      if (!alive) return;
      alive = false;
      operation += 1;
      listeners.abort();
      signal.removeEventListener('abort', abort);
      resizeObserver.disconnect();
      preview?.remove();
      preview = null;
      sourceDataUrl = '';
      view.remove();
      resolve(result);
    }

    const abort = () => finish({ kind: 'cancelled' });
    signal.addEventListener('abort', abort, { once: true });

    function cancelGesture(clearPointers = false) {
      if (!drag) {
        if (clearPointers) {
          pointers.clear();
          multiTouchBlocked = false;
        }
        return;
      }
      const pointerId = drag.pointerId;
      completed = drag.before && { ...drag.before };
      draft = completed ? { ...completed } : currentDraft();
      drag = null;
      try {
        if (drawing.hasPointerCapture(pointerId)) drawing.releasePointerCapture(pointerId);
      } catch { /* The document may already have released this pointer. */ }
      if (clearPointers) {
        pointers.clear();
        multiTouchBlocked = false;
      }
      render();
    }

    function imagePoint(event: PointerEvent) {
      const bounds = drawing.getBoundingClientRect();
      return {
        x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1) * input.width,
        y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1) * input.height,
      };
    }

    function stageSizeChanged(): boolean {
      const nextBounds = stage.getBoundingClientRect();
      const changed = Math.abs(nextBounds.width - stageBounds.width) > .5
        || Math.abs(nextBounds.height - stageBounds.height) > .5;
      stageBounds = nextBounds;
      return changed;
    }

    function outwardRect(first: { x: number; y: number }, second: { x: number; y: number }): JourneyMaskRect {
      const x = Math.floor(Math.min(first.x, second.x));
      const y = Math.floor(Math.min(first.y, second.y));
      return {
        x,
        y,
        width: Math.ceil(Math.max(first.x, second.x)) - x,
        height: Math.ceil(Math.max(first.y, second.y)) - y,
      };
    }

    drawing.addEventListener('pointerdown', event => {
      if (!alive || applying) return;
      pointers.add(event.pointerId);
      if (multiTouchBlocked || pointers.size > 1) {
        multiTouchBlocked = true;
        cancelGesture();
        return;
      }
      event.preventDefault();
      const point = imagePoint(event);
      drag = { pointerId: event.pointerId, startX: point.x, startY: point.y, before: completed && { ...completed } };
      completed = { x: point.x, y: point.y, width: 0, height: 0 };
      try { drawing.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer events have no active capture. */ }
      render();
    }, { signal: listeners.signal });

    drawing.addEventListener('pointermove', event => {
      if (!drag || drag.pointerId !== event.pointerId || pointers.size !== 1) return;
      event.preventDefault();
      const point = imagePoint(event);
      completed = outwardRect({ x: drag.startX, y: drag.startY }, point);
      render();
    }, { signal: listeners.signal });

    const pointerUp = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId) && drag?.pointerId !== event.pointerId) return;
      if (stageSizeChanged()) {
        cancelGesture(true);
        return;
      }
      pointers.delete(event.pointerId);
      if (multiTouchBlocked) {
        if (!pointers.size) multiTouchBlocked = false;
        return;
      }
      if (!drag || drag.pointerId !== event.pointerId) return;
      completed = outwardRect(
        { x: drag.startX, y: drag.startY },
        imagePoint(event),
      );
      if (pointers.size || !completed || !validRect(completed, input)) {
        cancelGesture();
        return;
      }
      draft = { ...completed };
      for (const [key] of GEOMETRY_LABELS) inputs[key].value = String(draft[key]);
      drag = null;
      render();
    };

    const pointerCancel = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId) && drag?.pointerId !== event.pointerId) return;
      pointers.delete(event.pointerId);
      if (multiTouchBlocked) {
        if (!pointers.size) multiTouchBlocked = false;
      } else if (drag?.pointerId === event.pointerId) cancelGesture(true);
    };
    document.addEventListener('pointerup', pointerUp, { capture: true, signal: listeners.signal });
    document.addEventListener('pointercancel', pointerCancel, { capture: true, signal: listeners.signal });

    drawing.addEventListener('lostpointercapture', event => {
      if (drag?.pointerId === event.pointerId) cancelGesture(true);
    }, { signal: listeners.signal });

    for (const control of Object.values(inputs)) control.addEventListener('input', () => {
      draft = currentDraft();
      if (validRect(draft, input)) completed = { ...draft };
      error.hidden = true;
      render();
    }, { signal: listeners.signal });

    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish({ kind: 'cancelled' });
    }, { capture: true, signal: listeners.signal });

    cancel.addEventListener('click', () => finish({ kind: 'cancelled' }), { signal: listeners.signal });
    remove.addEventListener('click', () => finish({ kind: 'removed' }), { signal: listeners.signal });
    apply.addEventListener('click', () => {
      const rect = currentDraft();
      if (applying || !validRect(rect, input)) return;
      applying = true;
      error.hidden = true;
      const attempt = ++operation;
      render();
      void maskJourneyPng(sourceDataUrl, rect).then(image => {
        if (alive && attempt === operation) finish({ kind: 'applied', image });
      }).catch(() => {
        if (!alive || attempt !== operation) return;
        applying = false;
        showError();
        render();
      });
    }, { signal: listeners.signal });

    const resizeObserver = new ResizeObserver(() => {
      if (stageSizeChanged()) cancelGesture(true);
    });
    resizeObserver.observe(stage);
    window.addEventListener('resize', () => cancelGesture(true), { signal: listeners.signal });
    render();
    heading.focus();
  });
}
