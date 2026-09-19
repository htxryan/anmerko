// Share keyboard and dismissal behavior between the footer's split buttons.
export function splitMenu(group: HTMLElement, toggle: HTMLButtonElement, menu: HTMLElement, signal: AbortSignal) {
  const items = () => [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].filter(item => !item.disabled);
  function setOpen(open: boolean, restoreFocus = false, last = false) {
    open = open && !toggle.disabled;
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) (last ? items().at(-1) : items()[0])?.focus();
    else if (restoreFocus) toggle.focus();
  }
  toggle.addEventListener('click', () => setOpen(!!menu.hidden), { signal });
  group.addEventListener('keydown', event => {
    if (event.target !== toggle && !menu.contains(event.target as Node)) return;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (menu.hidden) { setOpen(true, false, event.key === 'ArrowUp' || event.key === 'End'); return; }
      const enabled = items();
      const current = enabled.indexOf(event.target as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
        : (current + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length;
      enabled[next]?.focus();
    } else if (!menu.hidden && ['Escape', 'Tab'].includes(event.key)) {
      if (event.key === 'Escape') event.preventDefault();
      setOpen(false, true);
    }
  }, { signal });
  const dismiss = (event: Event) => {
    if (!event.composedPath().includes(menu) && !event.composedPath().includes(toggle)) setOpen(false);
  };
  document.addEventListener('pointerdown', dismiss, { capture: true, signal });
  document.addEventListener('focusin', dismiss, { capture: true, signal });
  return setOpen;
}
