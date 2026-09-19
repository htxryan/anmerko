type Shape = { tag: 'path' | 'circle' | 'rect'; attributes: Record<string, string> };

const shapes = {
  select: [{tag: 'circle', attributes: {cx: '12', cy: '12', r: '7'}}, {tag: 'path', attributes: {d: 'M12 2v5m0 10v5M2 12h5m10 0h5'}}],
  camera: [{tag: 'path', attributes: {d: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z'}}, {tag: 'circle', attributes: {cx: '12', cy: '13', r: '4'}}],
  pin: [{tag: 'path', attributes: {d: 'M9 3h6l-1 7 4 4v2H6v-2l4-4-1-7Zm3 13v6'}}],
  unpin: [{tag: 'path', attributes: {d: 'm2 2 20 20M9 3h6l-1 7 4 4v2M10 10l-4 4v2h10m-4 0v6'}}],
  settings: [{tag: 'path', attributes: {d: 'm9 3-1 3-3 1-2 3 2 2-1 3 2 3h3l2 3h3l1-3 3-1 2-3-2-2 1-3-2-3h-3l-2-3H9Z'}}, {tag: 'circle', attributes: {cx: '12', cy: '12', r: '3'}}],
  minus: [{tag: 'path', attributes: {d: 'M5 12h14'}}],
  close: [{tag: 'path', attributes: {d: 'm6 6 12 12M6 18 18 6'}}],
  back: [{tag: 'path', attributes: {d: 'm10 5-7 7 7 7M3 12h18'}}],
  sun: [{tag: 'circle', attributes: {cx: '12', cy: '12', r: '4'}}, {tag: 'path', attributes: {d: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5'}}],
  moon: [{tag: 'path', attributes: {d: 'M21 13a9 9 0 0 1-10-10 9 9 0 1 0 10 10Z'}}],
  save: [{tag: 'path', attributes: {d: 'M5 3h12l4 4v14H3V3h2Zm2 0v6h10V3M7 21v-8h10v8'}}],
  restore: [{tag: 'path', attributes: {d: 'M3 4v6h6M3 10a9 9 0 1 1 1 8'}}],
  copy: [{tag: 'rect', attributes: {x: '8', y: '8', width: '13', height: '13', rx: '2'}}, {tag: 'path', attributes: {d: 'M16 8V3H3v13h5'}}],
  download: [{tag: 'path', attributes: {d: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5'}}],
  comment: [{tag: 'path', attributes: {d: 'M21 14a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8Z'}}],
  'comment-add': [{tag: 'path', attributes: {d: 'M21 14a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8ZM12 6v8m-4-4h8'}}],
  edit: [{tag: 'path', attributes: {d: 'm15 5 4 4M4 16 16 4a2.8 2.8 0 0 1 4 4L8 20l-5 1 1-5Z'}}],
  trash: [{tag: 'path', attributes: {d: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7'}}],
  parent: [{tag: 'path', attributes: {d: 'm6 9 6-6 6 6M12 3v14a4 4 0 0 0 4 4h4'}}],
  check: [{tag: 'path', attributes: {d: 'm4 12 5 5L20 6'}}],
  connect: [{tag: 'path', attributes: {d: 'M7 17 17 7M7 7h10v10'}}],
  maximize: [{tag: 'path', attributes: {d: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5'}}],
  field: [{tag: 'rect', attributes: {x: '3', y: '5', width: '18', height: '14', rx: '2'}}, {tag: 'path', attributes: {d: 'M7 9v6m9 0h2m-5 0h1'}}],
  expand: [{tag: 'path', attributes: {d: 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7'}}],
  collapse: [{tag: 'path', attributes: {d: 'M20 4l-7 7m0-6v6h6M4 20l7-7m-6 0h6v6'}}],
  chevron: [{tag: 'path', attributes: {d: 'm6 9 6 6 6-6'}}],
} as const satisfies Record<string, readonly Shape[]>;
type IconName = keyof typeof shapes;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [attribute, value] of Object.entries({ class: 'button-icon', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' })) svg.setAttribute(attribute, value);
  const iconShapes: readonly Shape[] = shapes[name];
  for (const shape of iconShapes) {
    const child = document.createElementNS(svg.namespaceURI, shape.tag);
    for (const [attribute, value] of Object.entries(shape.attributes)) child.setAttribute(attribute, value);
    svg.append(child);
  }
  return svg;
}

export function renderIcons(root: ParentNode): void {
  for (const placeholder of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = placeholder.dataset.icon;
    if (name && Object.hasOwn(shapes, name)) placeholder.replaceChildren(icon(name as IconName));
  }
}
