import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const names = { chrome: 'Google Chrome', edge: 'Microsoft Edge', brave: 'Brave' };

export function resolveBrowser(browser, { platform = process.platform, exists = existsSync, executable } = {}) {
  if (!Object.hasOwn(names, browser)) throw new Error(`Unsupported browser: ${browser}. Choose chrome, edge, or brave.`);
  if (executable) {
    const path = resolve(executable);
    if (!exists(path)) throw new Error(`Browser executable not found: ${path}`);
    return path;
  }
  const windowsPath = { chrome: 'Google/Chrome/Application/chrome.exe', edge: 'Microsoft/Edge/Application/msedge.exe', brave: 'BraveSoftware/Brave-Browser/Application/brave.exe' };
  const macPath = { chrome: 'Google Chrome.app/Contents/MacOS/Google Chrome', edge: 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge', brave: 'Brave Browser.app/Contents/MacOS/Brave Browser' };
  const linuxPath = { chrome: ['google-chrome', 'google-chrome-stable'], edge: ['microsoft-edge', 'microsoft-edge-stable'], brave: ['brave-browser', 'brave-browser-stable'] };
  const paths = {
    win32: [process.env.PROGRAMFILES || 'C:/Program Files', process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', process.env.LOCALAPPDATA].filter(Boolean).map(base => join(base, windowsPath[browser])),
    darwin: [join('/Applications', macPath[browser])],
    linux: linuxPath[browser].map(name => join('/usr/bin', name)),
  }[platform];
  if (!paths) throw new Error(`Unsupported OS: ${platform}`);
  const found = paths.find(exists);
  if (!found) throw new Error(`${names[browser]} not found. Install it or pass --executable PATH. No Chromium fallback is used.`);
  return found;
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: {
      browser: { type: 'string', default: 'chrome' }, executable: { type: 'string' },
      manual: { type: 'boolean' },
    } });
    const executable = resolveBrowser(values.browser, { executable: values.executable });
    process.chdir(root);
    process.env.ANMERKO_DESKTOP_BROWSER = values.browser;
    process.env.ANMERKO_DESKTOP_EXECUTABLE = executable;
    if (values.manual) {
      const { createDesktopSession } = await import('../tests-shared/desktop-session.mjs');
      const session = await createDesktopSession();
      console.log(JSON.stringify(session.evidence, null, 2));
      console.log('Disposable profile ready. Click anmerko in the Extensions menu. Ctrl+C saves evidence and closes this profile.');
      await new Promise(done => { process.once('SIGINT', done); process.once('SIGTERM', done); session.context.once('close', done); });
      await session.close();
    } else {
      const child = spawn(process.execPath, ['--test', 'tests-desktop/extension.test.mjs'], { cwd: root, env: process.env, stdio: 'inherit' });
      child.on('error', error => { console.error(error.message); process.exitCode = 1; });
      child.on('exit', code => { process.exitCode = code ?? 1; });
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
