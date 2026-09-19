import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requiredOperatingSystems } from './ci-policy.mjs';

export const firefoxScenarios = [
  "Firefox captures regions from the native sidebar and touch input, and downloads local Markdown and PNG files",
  "Firefox toolbar activation, parent selection, persistence, prompt export, editing and deletion",
  "Firefox touch selection and narrow editor preserve drafts without activating the page link",
  "Firefox captures shadow elements, excludes form values, and retains comments after SPA navigation",
  "Firefox shows a helpful explanation when activation targets a protected page",
  "Firefox native sidebar resizes the page and retains a draft when floated and minimized",
  "Firefox default process isolation opens a native sidebar with the unchanged package"
];

export function assertDesktopPayloads(reports, sourceSha, firefoxVersions = [], chromiumBrowsers = ['chrome'], scope = 'full') {
  for (const os of requiredOperatingSystems(scope)) {
    assert.ok(reports.some(report => report.os === os), `Missing desktop evidence for ${os}`);
    for (const version of firefoxVersions) {
      for (const scenario of firefoxScenarios) {
        assert.equal(reports.filter(report => report.os === os && report.requestedVersion === version && report.scenario === scenario).length, 1,
          `Missing or duplicate Firefox evidence for ${os} / ${version} / ${scenario}`);
      }
    }
    if (firefoxVersions.length === 0) {
      for (const browser of chromiumBrowsers) {
        for (const scenario of ['activation', 'workflow']) {
          assert.equal(reports.filter(report => report.os === os && report.browser === browser && report.scenario === scenario).length, 1,
            `Missing ${browser} evidence for ${os} / ${scenario}`);
        }
      }
    }
  }
  const expected = reports.find(report => report.os === 'linux').payload;
  assert.ok(Object.keys(expected).length > 0, 'Payload hashes must not be empty');
  for (const report of reports) {
    assert.ok(requiredOperatingSystems(scope).includes(report.os), 'Unexpected OS evidence');
    if (firefoxVersions.length > 0) {
      assert.equal(report.browser, 'firefox', `Unexpected browser for ${report.os}`);
      assert.ok(firefoxVersions.includes(report.requestedVersion), `Unexpected Firefox version request on ${report.os}`);
      if (/^\d/.test(report.requestedVersion)) {
        assert.equal(report.engine, report.requestedVersion, `Firefox version differs on ${report.os}`);
      }
      assert.equal(report.result, 'passed', `Failed Firefox scenario on ${report.os}: ${report.scenario}`);
      assert.equal(report.teardown, 'passed', `Firefox teardown failed on ${report.os}: ${report.scenario}`);
    } else {
      assert.ok(chromiumBrowsers.includes(report.browser), `Unexpected browser for ${report.os}: ${report.browser}`);
      const product = { chrome: /^Chrome\/\d+\./, edge: /^Edg\/\d+\./ }[report.browser];
      assert.ok(product && product.test(report.engine?.product), `Unexpected ${report.browser} product on ${report.os}`);
      assert.equal(report.result, 'passed', `Failed ${report.browser} scenario on ${report.os}: ${report.scenario}`);
      assert.equal(report.teardown, 'passed', `${report.browser} teardown failed on ${report.os}: ${report.scenario}`);
    }
    assert.equal(report.sourceSha, sourceSha, `Unexpected source commit for ${report.os}`);
    assert.equal(report.dirty, false, `Dirty source tree for ${report.os}`);
    assert.deepEqual(report.payload, expected, `Packaged web payload differs on ${report.os}`);
  }
}

if (import.meta.main) {
  const directory = process.argv[2] || 'artifacts/desktop-ci';
  const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter(file => file.isFile() && file.name === 'evidence.json');
  const reports = await Promise.all(files.map(async file => JSON.parse(await readFile(join(file.parentPath, file.name), 'utf8'))));
  assertDesktopPayloads(reports, process.env.SOURCE_SHA || process.env.GITHUB_SHA, process.argv.includes('--firefox') ? ['stable', '142.0'] : [],
    process.argv.includes('--edge') ? ['chrome', 'edge'] : ['chrome'], process.env.VALIDATION_SCOPE || 'full');
  console.log(`Identical packaged web payloads in ${reports.length} reports in the required validation scope.`);
}
