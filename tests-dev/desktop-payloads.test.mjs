import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertDesktopPayloads, firefoxScenarios } from '../scripts/check-desktop-payloads.mjs';

import { requiredOperatingSystems, windowsChecksEnabled, windowsHoldReason } from '../scripts/ci-policy.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const reports = () => requiredOperatingSystems('full').map(os => ({
  os, sourceSha: 'candidate-commit', dirty: false, payload: { 'sidebar.html': hash('<html>\n</html>\n') },
})).flatMap(report => ['activation', 'workflow'].map(scenario => ({
  ...report, browser: 'chrome', engine: { product: 'Chrome/153.0.8010.36' },
  scenario, result: 'passed', teardown: 'passed',
})));

test('the desktop gate accepts identical payloads and rejects Windows checkout line-ending changes', { skip: windowsChecksEnabled ? false : windowsHoldReason }, () => {
  const evidence = reports();
  assert.doesNotThrow(() => assertDesktopPayloads(evidence, 'candidate-commit'));
  evidence[4].payload['sidebar.html'] = hash('<html>\r\n</html>\r\n');
  assert.throws(() => assertDesktopPayloads(evidence, 'candidate-commit'), /payload differs on win32/);
});

test('the desktop gate rejects missing OS evidence and stale or dirty source', () => {
  assert.throws(() => assertDesktopPayloads(reports().slice(0, 2), 'candidate-commit'), /Missing.*linux/);
  assert.throws(() => assertDesktopPayloads(reports(), 'another-commit'), /Unexpected source commit/);
  const evidence = reports(); evidence[0].dirty = true;
  assert.throws(() => assertDesktopPayloads(evidence, 'candidate-commit'), /Dirty source tree/);
});

test('the Chromium gate requires real Chrome and Edge scenarios on every OS', () => {
  const browsers = ['chrome', 'edge'];
  const chromiumReports = () => reports().flatMap(report => [report, {
    ...report, browser: 'edge', engine: { product: 'Edg/153.0.4234.32' },
  }]);
  const check = evidence => assertDesktopPayloads(evidence, 'candidate-commit', [], browsers);
  assert.doesNotThrow(() => check(chromiumReports()));
  assert.throws(() => check(reports()), /Missing.*edge/);
  assert.throws(() => check(chromiumReports().slice(0, -1)), /Missing.*edge.*linux.*workflow/);
  const mislabeled = chromiumReports(); mislabeled[1].engine.product = 'Chrome/153.0.8010.36';
  assert.throws(() => check(mislabeled), /Unexpected.*edge.*product/);
  const failed = chromiumReports(); failed[1].result = 'incomplete';
  assert.throws(() => check(failed), /Failed.*edge.*scenario/);
  const teardown = chromiumReports(); teardown[1].teardown = 'failed';
  assert.throws(() => check(teardown), /edge.*teardown/);
  const different = chromiumReports(); different[1].payload = { 'sidebar.html': hash('Edge-only payload') };
  assert.throws(() => check(different), /payload differs/);
});

test('the Firefox gate requires passing stable and exact minimum-version evidence on every OS', () => {
  const versions = ['stable', '142.0'];
  const firefoxReports = () => reports().filter(report => report.scenario === 'activation').flatMap(report => versions.flatMap(requestedVersion => firefoxScenarios.map(scenario => ({
    ...report, scenario, browser: 'firefox', requestedVersion, engine: requestedVersion === 'stable' ? '155.0.1' : '142.0',
    result: 'passed', teardown: 'passed',
  }))));
  assert.doesNotThrow(() => assertDesktopPayloads(firefoxReports(), 'candidate-commit', versions));
  assert.throws(() => assertDesktopPayloads(firefoxReports().slice(0, -1), 'candidate-commit', versions), /Missing.*linux.*142.0/);
  const wrongBrowser = firefoxReports(); wrongBrowser[firefoxScenarios.length].engine = '155.0.1';
  assert.throws(() => assertDesktopPayloads(wrongBrowser, 'candidate-commit', versions), /Firefox version/);
  const failed = firefoxReports(); failed[0].result = 'failed';
  assert.throws(() => assertDesktopPayloads(failed, 'candidate-commit', versions), /Failed Firefox scenario/);
  const teardown = firefoxReports(); teardown[0].teardown = 'failed';
  assert.throws(() => assertDesktopPayloads(teardown, 'candidate-commit', versions), /Firefox teardown/);
});

test('active desktop platforms still reject differing packaged bytes', () => {
  const evidence = reports();
  assert.doesNotThrow(() => assertDesktopPayloads(evidence, 'candidate-commit'));
  evidence[0].payload = { 'sidebar.html': hash('different bytes') };
  assert.throws(() => assertDesktopPayloads(evidence, 'candidate-commit'), /payload differs on darwin/);
});
