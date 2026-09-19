// Shared release checklist. A candidate smoke run must not imply store readiness.
export const desktopScenarios = {
  P1: 'Toolbar activation, protected pages and denied/regranted site access',
  P2: 'Select/add/edit/delete, page scope, drafts, scroll and navigation',
  P3: 'Real capture, crop/move/resize/cancel, zoom/HiDPI and tab/window races',
  P4: 'Comments/settings through page, browser, worker and store updates',
  P5: 'Identical prompt, clipboard success/denial and valid Markdown/PNG ZIP',
  P6: 'Native dock/floating fallback, keyboard/focus, minimize and draft retention',
  P7: 'Local-only behavior, shipped permissions and shared sender/tab/frame checks',
  P8: 'Published store install and store-managed upgrade on every required OS',
};
