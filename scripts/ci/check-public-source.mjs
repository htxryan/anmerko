import { execFileSync } from 'node:child_process';
import { lstat, readFile, readlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const allowedEmails = new Set([
  'support@briefmark.app',
  'briefmark@briefmark.app',
]);
const exampleEmailDomains = new Set(['example.com', 'example.net', 'example.org', 'invalid', 'test']);
const lines = text => text.split(/\r?\n/u);
const decode = line => {
  try {
    return decodeURIComponent(line);
  } catch {
    return line;
  }
};

export function scanPublicText(text, file = '<text>') {
  const findings = [];
  const add = (line, rule) => {
    if (!findings.some(finding => finding.line === line && finding.rule === rule)) findings.push({ file, line, rule });
  };

  for (const [index, line] of lines(text).entries()) {
    const lineNumber = index + 1;
    for (const match of line.matchAll(/(?<![\w.+-])([\w.+-]+)@([a-z0-9.-]+\.[a-z]{2,}|invalid|test)(?![\w.-])/giu)) {
      const email = match[0].toLowerCase();
      const domain = match[2].toLowerCase();
      const reservedDomain = exampleEmailDomains.has(domain) || [...exampleEmailDomains].some(suffix => domain.endsWith(`.${suffix}`));
      if (!allowedEmails.has(email) && !reservedDomain) add(lineNumber, 'personal-email');
    }

    const variants = new Set([line, decode(line), line.replaceAll('\\\\', '\\')]);
    for (const variant of variants) {
      for (const match of variant.matchAll(/\/(?:Users|home)\/([^/\s`"']+)/gu)) {
        const user = match[1];
        if (user !== 'runner' && !/[<$>{}]/u.test(user)) add(lineNumber, 'machine-user-path');
      }
      if (/[A-Za-z]:\\Users\\[^\\\s`"']+/u.test(variant) || /\/var\/folders\/[^\s`"']+/u.test(variant)) {
        add(lineNumber, 'machine-user-path');
      }
      if (/file:(?:\/\/|%2f%2f)/iu.test(variant)) add(lineNumber, 'machine-file-url');
    }

    for (const variant of variants) {
      for (const match of variant.matchAll(/https?:\/\/[^\s)\]}>"']+/giu)) {
        try {
          const url = new URL(match[0].replace(/[.,;:]$/u, ''));
          const privateAddonPage = url.hostname === 'addons.mozilla.org' && url.pathname.startsWith('/developers/');
          const chromeDashboard = ['chrome.google.com', 'chromewebstore.google.com'].includes(url.hostname)
            && /\/(?:webstore\/)?devconsole(?:\/|$)/u.test(url.pathname);
          const partnerDashboard = url.hostname === 'partner.microsoft.com' && url.pathname.startsWith('/dashboard');
          if (url.hostname === 'dash.cloudflare.com' || privateAddonPage || chromeDashboard || partnerDashboard) {
            add(lineNumber, 'private-dashboard-url');
          }
        } catch {
          // Malformed URLs are handled by their owning format checks.
        }
      }
    }

    if (/(?:^|["'\s_-])account(?:_|-)?id["'\s]*[:=]["'\s]*[0-9a-f]{24,64}/iu.test(line)) {
      add(lineNumber, 'provider-account-id');
    }
  }

  for (const match of text.matchAll(/["']account["']\s*:\s*\{[\s\S]{0,1000}?["']id["']\s*:\s*["'][0-9a-f]{24,64}["']/giu)) {
    const lineNumber = text.slice(0, match.index).split(/\r?\n/u).length;
    if (!findings.some(finding => finding.line === lineNumber && finding.rule === 'provider-account-id')) {
      add(lineNumber, 'provider-account-id');
    }
  }
  return findings;
}

const trackedFiles = () => execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);

export async function checkPublicSource(files = trackedFiles()) {
  const findings = [];
  for (const file of files) {
    let contents;
    try {
      const metadata = await lstat(file);
      contents = metadata.isSymbolicLink() ? await readlink(file, 'utf8') : await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (contents.includes('\0')) continue;
    findings.push(...scanPublicText(contents, file));
  }
  return findings;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const findings = await checkPublicSource();
  if (findings.length) {
    for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.rule}`);
    console.error(`Public-source privacy check failed with ${findings.length} finding(s).`);
    process.exitCode = 1;
  } else {
    console.log('Public-source privacy check passed.');
  }
}
