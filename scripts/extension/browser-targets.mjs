import { parseArgs } from 'node:util';

const targets = {
  chromium: { name: 'chromium', label: 'Chrome', outdir: 'dist', syntax: 'chrome142', format: 'esm', archiveSuffix: '' },
  firefox: { name: 'firefox', label: 'Firefox / Android', outdir: 'dist-firefox', syntax: 'firefox142', format: 'iife', archiveSuffix: '-firefox-unsigned' },
  orion: { name: 'orion', label: 'Orion for iOS', outdir: 'dist-orion', syntax: 'safari16.4', format: 'iife', archiveSuffix: '-orion' },
};

export function browserTarget(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: { target: { type: 'string' }, firefox: { type: 'boolean' } } });
  if (values.firefox && values.target) throw new Error('Use either --firefox or --target, not both.');
  const requested = values.target ?? (values.firefox ? 'firefox' : 'chromium');
  const name = requested === 'chrome' ? 'chromium' : requested;
  if (!Object.hasOwn(targets, name)) throw new Error(`Unsupported target: ${requested}. Choose chromium, firefox, or orion.`);
  return targets[name];
}

// Journeys are opt-in and unavailable on Orion. Only journey builds request
// their navigation and timer APIs, so release builds keep the shipped warnings.
const journeyPermissions = ['alarms', 'webNavigation'];

export function journeyBuild(target, env = process.env) {
  return env.ANMERKO_JOURNEYS === '1' && target.name !== 'orion';
}

export function browserManifest(source, version, target, journeys = false) {
  const manifest = structuredClone(source);
  manifest.version = version;
  if (journeys) manifest.permissions.push(...journeyPermissions);
  if (target.name === 'orion') {
    delete manifest.minimum_chrome_version;
    delete manifest.side_panel;
    manifest.permissions = manifest.permissions.filter(permission => permission !== 'sidePanel');
    manifest.action.default_popup = 'popup.html';
    manifest.background = { scripts: ['background.js'] };
  }
  if (target.name === 'firefox') {
    delete manifest.minimum_chrome_version;
    delete manifest.side_panel;
    manifest.permissions = manifest.permissions.filter(permission => permission !== 'sidePanel');
    // Android's Extensions menu activates the picker directly in one tap.
    delete manifest.action.default_popup;
    manifest.sidebar_action = { default_panel: 'sidebar.html', default_title: 'anmerko', default_icon: 'icons/48.png', open_at_install: false };
    manifest.background = { scripts: ['background.js'] };
    manifest.browser_specific_settings = {
      gecko: { id: 'briefmark@briefmark.app', strict_min_version: '142.0', data_collection_permissions: { required: ['none'] } },
      gecko_android: { strict_min_version: '142.0' },
    };
  }
  return manifest;
}
