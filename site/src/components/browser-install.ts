const root = document.querySelector<HTMLElement>('.install-area')!;
const groups = [...root.querySelectorAll<HTMLElement>('[data-browser-platform]')];
const switchButton = root.querySelector<HTMLButtonElement>('.platform-switch')!;
const switchChoice = root.querySelector<HTMLElement>('.platform-choice')!;
const ua = navigator.userAgent;
// Chromium browsers share Chrome's token; identify their more specific hints first.
function detectBrowser() {
  if (/Edg(?:e|A|iOS)?\//i.test(ua)) return 'edge';
  if (/Firefox\/|FxiOS\//i.test(ua)) return 'firefox';
  return 'chrome';
}
const browserHint = detectBrowser();

for (const group of groups) {
  const tabs = [...group.querySelectorAll<HTMLButtonElement>('.browser-tab')];
  const panels = [...group.querySelectorAll<HTMLElement>('.browser-panel')];

  function selectTab(index: number) {
    tabs.forEach((tab, tabIndex) => {
      const selected = tabIndex === index;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      panels[tabIndex].hidden = !selected;
    });
  }

  function selectDetectedBrowser(browser: string) {
    const index = tabs.findIndex(tab => tab.id === `tab-${group.dataset.browserPlatform}-${browser}`);
    // Keep the platform's default when that browser is not an available choice.
    if (index !== -1) selectTab(index);
  }
  const initialBrowser = group.dataset.browserPlatform === 'mobile' && /iPhone/i.test(ua)
    ? 'orion'
    : browserHint;
  selectDetectedBrowser(initialBrowser);

  tabs.forEach((tab, index) => {
    function chooseTab() {
      selectTab(index);
    }
    tab.addEventListener('click', chooseTab);
    tab.addEventListener('focus', chooseTab);
    tab.addEventListener('keydown', event => {
      let next: number;
      switch (event.key) {
        case 'ArrowRight': next = (index + 1) % tabs.length; break;
        case 'ArrowLeft': next = (index + tabs.length - 1) % tabs.length; break;
        case 'Home': next = 0; break;
        case 'End': next = tabs.length - 1; break;
        default: return;
      }
      event.preventDefault();
      tabs[next].focus();
    });
  });
}

// Device hints choose only the initial view. The visitor can always switch sets.
// iPadOS can identify as a Mac; touch support alone must not classify Windows laptops as mobile.
const mobileDevice = /Android|iPhone|iPad|iPod/i.test(ua)
  || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
let platform = mobileDevice ? 'mobile' : 'desktop';

function showPlatform() {
  for (const group of groups) group.hidden = group.dataset.browserPlatform !== platform;
  switchButton.textContent = `Install for ${platform === 'mobile' ? 'desktop' : 'mobile'} browsers`;
}

showPlatform();
switchChoice.hidden = false;
switchButton.addEventListener('click', () => {
  platform = platform === 'mobile' ? 'desktop' : 'mobile';
  showPlatform();
  // Announce the newly shown choices and make their keyboard navigation immediately reachable.
  root.querySelector<HTMLButtonElement>('[data-browser-platform]:not([hidden]) [aria-selected="true"]')?.focus();
});
