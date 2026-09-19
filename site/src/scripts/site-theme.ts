import { icon } from '../../../src/icons';

const button = document.querySelector<HTMLButtonElement>('#site-theme-toggle')!;
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
// Use the documentation site's existing preference and early theme provider.
const storageKey = 'starlight-theme';
let preference: string | null = null;
try { preference = localStorage.getItem(storageKey); } catch { /* Theme still works without storage. */ }

function renderTheme() {
  const dark = preference === 'dark' || (preference !== 'light' && systemTheme.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  button.replaceChildren(icon(dark ? 'sun' : 'moon'));
  button.title = button.ariaLabel = `Switch to ${dark ? 'light' : 'dark'} theme`;
  button.hidden = false;
}

button.addEventListener('click', () => {
  preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(storageKey, preference); } catch { /* Keep the current page usable. */ }
  renderTheme();
});
systemTheme.addEventListener('change', renderTheme);
window.addEventListener('storage', event => {
  if (event.key === storageKey || event.key === null) {
    preference = event.newValue;
    renderTheme();
  }
});
renderTheme();
