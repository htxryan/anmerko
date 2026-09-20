import { extensionApi } from './platform';
import { icon } from './icons';
import { activateTab } from './activate';
const api = extensionApi();
const button = document.querySelector<HTMLButtonElement>('#open')!;
button.prepend(icon('select'));
const status = document.querySelector<HTMLElement>('#status')!;
button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = '';
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/.test(tab.url)) {
      throw new Error('Open a regular http or https website to start annotating.');
    }
    await activateTab(tab.id);
    window.close();
  } catch (error) {
    status.textContent = error instanceof Error && error.message.startsWith('Open a regular')
      ? error.message
      : 'This browser cannot annotate this page. Try a regular website; browser settings and extension stores are restricted.';
    button.disabled = false;
  }
});
