import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { compileScript, parse } from '@vue/compiler-sfc';

const directory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(directory, 'dist');
const csp = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
const reactVersions = [
  { version: '18.3.1', react: 'react-18', dom: 'react-dom-18' },
  { version: '19.2.7', react: 'react-19-2', dom: 'react-dom-19-2' },
  { version: '19.3.0', react: 'react-19-3', dom: 'react-dom-19-3' },
];

const reactRoutes = reactVersions.flatMap(version => ['development', 'production', 'profiling'].map(mode => ({
  id: `react-${version.version}-${mode}`,
  framework: 'react',
  version: version.version,
  mode,
  path: `/react/${version.version}/${mode}`,
  asset: `/assets/react-${version.version}-${mode}.js`,
})));
const vueRoutes = ['development', 'production', 'production-devtools'].map(mode => ({
  id: `vue-3.5.43-${mode}`,
  framework: 'vue',
  version: '3.5.43',
  mode,
  path: `/vue/3.5.43/${mode}`,
  asset: `/assets/vue-3.5.43-${mode}.js`,
}));
const mixedRoutes = [
  { id: 'mixed-islands', framework: 'mixed', version: null, mode: 'islands', path: '/mixed/islands', asset: '/assets/mixed.js' },
  { id: 'mixed-dual-association', framework: 'mixed', version: null, mode: 'dual-association', path: '/mixed/dual-association', asset: '/assets/mixed.js' },
];
const angularRoutes = ['development', 'production'].map(mode => ({
  id: `angular-22.1.7-${mode}`,
  framework: 'angular',
  version: '22.1.7',
  mode,
  path: `/angular/22.1.7/${mode}`,
  asset: `/angular-assets/${mode}/main.js`,
}));

export const fixtureRouteManifest = Object.freeze([
  ...reactRoutes,
  ...vueRoutes,
  ...mixedRoutes,
  ...angularRoutes,
  { id: 'plain', framework: 'none', version: null, mode: 'plain', path: '/plain', asset: '/assets/plain.js' },
  { id: 'unsupported', framework: 'unknown', version: null, mode: 'unsupported', path: '/unsupported', asset: '/assets/unsupported.js' },
]);

function vueSfcPlugin() {
  return { name: 'compiled-vue-sfc', setup(context) {
    context.onLoad({ filter: /App\.vue$/ }, async args => {
      const source = await readFile(args.path, 'utf8');
      const { descriptor, errors } = parse(source, { filename: args.path });
      if (errors.length) throw new Error(`Vue SFC parse failed: ${errors.join(', ')}`);
      const compiled = compileScript(descriptor, {
        id: 'data-v-anmerko-component-context',
        inlineTemplate: true,
        templateOptions: { compilerOptions: { hoistStatic: true } },
      });
      return { contents: compiled.content, loader: 'js' };
    });
  } };
}

function aliasPlugin({ react, dom, profiling }) {
  const paths = new Map([
    ['react', resolve(directory, 'node_modules', react, 'index.js')],
    ['react/jsx-runtime', resolve(directory, 'node_modules', react, 'jsx-runtime.js')],
    ['react/jsx-dev-runtime', resolve(directory, 'node_modules', react, 'jsx-dev-runtime.js')],
    ['react-dom', resolve(directory, 'node_modules', dom, 'index.js')],
    ['react-dom/client', resolve(directory, 'node_modules', dom, 'client.js')],
    ['react-dom-entry', resolve(directory, 'node_modules', dom, profiling ? 'profiling.js' : 'client.js')],
  ]);
  return { name: 'exact-react-version', setup(context) {
    context.onResolve({ filter: /^(react(?:\/jsx-(?:dev-)?runtime)?|react-dom(?:\/client)?|react-dom-entry)$/ }, args => {
      const path = paths.get(args.path);
      if (!path) throw new Error(`Unmapped React import: ${args.path}`);
      return { path };
    });
  } };
}

export async function buildFixtures() {
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  for (const version of reactVersions) for (const mode of ['development', 'production', 'profiling']) {
    const development = mode === 'development';
    await build({
      entryPoints: [resolve(directory, 'app.tsx')],
      outfile: resolve(outputDirectory, `react-${version.version}-${mode}.js`),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['chrome142', 'firefox142'],
      jsx: 'automatic',
      jsxDev: development,
      minify: !development,
      define: {
        'process.env.NODE_ENV': JSON.stringify(development ? 'development' : 'production'),
        __FIXTURE_VERSION__: JSON.stringify(version.version),
        __FIXTURE_MODE__: JSON.stringify(mode),
        __FIXTURE_RENDERER__: JSON.stringify(mode === 'profiling' ? 'react-dom/profiling' : 'react-dom/client'),
      },
      plugins: [aliasPlugin({ react: version.react, dom: version.dom, profiling: mode === 'profiling' })],
    });
  }
  for (const mode of ['development', 'production', 'production-devtools']) {
    const development = mode === 'development';
    const productionDevtools = mode === 'production-devtools';
    await build({
      stdin: {
        sourcefile: 'vue-entry.js',
        resolveDir: directory,
        contents: `
          import { createApp, createSSRApp, defineComponent, h, nextTick, version } from 'vue';
          import App from './App.vue';
          const HydrationTree = defineComponent({ name: 'HydrationTree', setup() { return () => h('section', { id: 'vue-hydration-owner' }, [h('p', { id: 'vue-hydrated-first' }, 'Hydrated first'), h('span', { id: 'vue-hydrated-later' }, 'Hydrated later')]); } });
          createApp(App).mount('#vue-root');
          createSSRApp(HydrationTree).mount('#vue-hydration');
          const manual = document.createElement('button');
          manual.id = 'vue-manual-button'; manual.type = 'button'; manual.textContent = 'Manually inserted button';
          document.querySelector('#vue-manual-host').append(manual);
          const targets = Object.freeze({
            options: { id: 'vue-options-button', expectedPath: ['App', 'OptionsCard'], kind: 'options-api' },
            functional: { id: 'vue-functional-button', expectedPath: ['App', 'FunctionalLeaf'], kind: 'functional-display-name' },
            anonymous: { id: 'vue-anonymous-button', expectedPath: [], kind: 'anonymous-fallback' },
            slot: { id: 'vue-slotted-button', expectedPath: ['App', 'SlotOwner'], kind: 'slot-content' },
            teleport: { id: 'vue-teleport-button', expectedPath: ['App'], kind: 'teleport' },
            fragmentFirst: { id: 'vue-fragment-first', expectedPath: ['App', 'FragmentLeaf'], kind: 'fragment-first' },
            fragmentLater: { id: 'vue-fragment-later', expectedPath: ['App', 'FragmentLeaf'], kind: 'fragment-later' },
            kept: { id: 'vue-kept-button', expectedPath: ['App', 'KeptLeaf'], kind: 'keep-alive' },
            sensitive: { id: 'vue-sensitive-button', expectedPath: ['App', 'SensitiveLeaf'], kind: 'privacy-sentinel' },
            staticFirst: { id: 'vue-static-first', expectedPath: ['App'], kind: 'static-first' },
            staticLater: { id: 'vue-static-later', expectedPath: ['App'], kind: 'static-later' },
            hydratedFirst: { id: 'vue-hydrated-first', expectedPath: ['HydrationTree'], kind: 'hydrated-first' },
            hydratedLater: { id: 'vue-hydrated-later', expectedPath: ['HydrationTree'], kind: 'hydrated-later' },
            manual: { id: 'vue-manual-button', expectedPath: [], kind: 'manually-inserted-missing-marker' },
          });
          nextTick(() => requestAnimationFrame(() => Object.defineProperty(globalThis, '__ANMERKO_FIXTURE__', { value: Object.freeze({ ready: true, framework: 'vue', version: ${JSON.stringify('3.5.43')}, mode: ${JSON.stringify(mode)}, runtimeVersion: version, flags: Object.freeze({ development: ${development}, productionDevtools: ${productionDevtools} }), targets, privacyReads: globalThis.__VUE_PRIVACY_READS__ }) })));
        `,
      },
      outfile: resolve(outputDirectory, `vue-3.5.43-${mode}.js`),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: ['chrome142', 'firefox142'],
      minify: !development,
      define: {
        'process.env.NODE_ENV': JSON.stringify(development ? 'development' : 'production'),
        __VUE_OPTIONS_API__: 'true',
        __VUE_PROD_DEVTOOLS__: JSON.stringify(productionDevtools),
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
      },
      plugins: [vueSfcPlugin()],
    });
  }
  await build({
    entryPoints: [resolve(directory, 'mixed.ts')],
    outfile: resolve(outputDirectory, 'mixed.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome142', 'firefox142'],
    define: {
      'process.env.NODE_ENV': JSON.stringify('development'),
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
    plugins: [aliasPlugin({ react: 'react-19-3', dom: 'react-dom-19-3', profiling: false })],
  });
  await writeFile(resolve(outputDirectory, 'plain.js'), `Object.defineProperty(globalThis,'__ANMERKO_FIXTURE__',{value:Object.freeze({ready:true,framework:'none',version:null,mode:'plain',targets:Object.freeze({plain:{id:'plain-target',expectedPath:[],kind:'plain'}}),privacyReads:{}})});\n`);
  await writeFile(resolve(outputDirectory, 'unsupported.js'), `const reads={value:0};const target=document.querySelector('#unsupported-target');Object.defineProperty(target,'__reactFiber$unsupported',{get(){reads.value+=1;throw new Error('forbidden unknown shape')}});Object.defineProperty(globalThis,'__ANMERKO_FIXTURE__',{value:Object.freeze({ready:true,framework:'unknown',version:null,mode:'unsupported',targets:Object.freeze({unknown:{id:'unsupported-target',expectedPath:[],kind:'unknown-shape'}}),privacyReads:reads})});\n`);
}

function fixtureHtml(route) {
  const vue = route.framework === 'vue';
  const mixed = route.framework === 'mixed';
  const angular = route.framework === 'angular';
  const target = route.id === 'plain' ? '<button id="plain-target">Plain target</button>'
    : route.id === 'unsupported' ? '<button id="unsupported-target">Unsupported marker shape</button>'
      : route.mode === 'islands' ? '<div id="mixed-react-root"></div><div id="mixed-vue-root"></div>'
        : route.mode === 'dual-association' ? '<div id="mixed-dual-root"></div>'
          : angular ? ''
      : vue ? '<div id="vue-root"></div><div id="vue-teleport"></div><div id="vue-hydration"><section id="vue-hydration-owner"><p id="vue-hydrated-first">Hydrated first</p><span id="vue-hydrated-later">Hydrated later</span></section></div>'
      : '<div id="react-root"></div><div id="react-portal"></div><div id="react-shadow-host"></div>';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${route.id}</title><style>body{font:16px system-ui;margin:24px}button{min-height:36px;margin:6px}</style><body data-framework="${route.framework}" data-mode="${route.mode}"${mixed ? ` data-fixture-case="${route.mode}"` : ''}><h1>${route.id}</h1>${target}<script${angular ? ' type="module"' : ''} src="${route.asset}"></script></body></html>`;
}

function assetFile(route) {
  if (route.framework === 'angular') {
    return resolve(directory, 'angular', 'dist', route.mode, 'browser', 'main.js');
  }
  return resolve(outputDirectory, route.asset.slice('/assets/'.length));
}

async function assertBuiltAssets() {
  for (const route of fixtureRouteManifest) {
    try { await stat(assetFile(route)); }
    catch { throw new Error(`Missing built asset for ${route.id}. Run the locked component fixture setup before starting the server.`); }
  }
}

export async function startFixtureServer({ host = '127.0.0.1', port = 0, build: shouldBuild = false } = {}) {
  if (shouldBuild) await buildFixtures();
  await assertBuiltAssets();
  const byPath = new Map(fixtureRouteManifest.map(route => [route.path, route]));
  const assets = new Map(fixtureRouteManifest.map(route => [route.asset, assetFile(route)]));
  const server = createServer(async (request, response) => {
    try {
      response.setHeader('Content-Security-Policy', csp);
      if (request.url === '/healthz') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ service: 'anmerko-component-context-fixtures', version: 1, ready: true, routeCount: fixtureRouteManifest.length }));
        return;
      }
      if (request.url === '/routes.json') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(fixtureRouteManifest));
        return;
      }
      const route = byPath.get(request.url);
      if (route) {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(fixtureHtml(route));
        return;
      }
      const asset = assets.get(request.url);
      if (asset) {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        response.end(await readFile(asset));
        return;
      }
      response.statusCode = 404;
      response.end('Not found');
    } catch {
      response.statusCode = 500;
      response.end('Fixture server error');
    }
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolveListen);
  });
  const address = server.address();
  const origin = `http://${host}:${address.port}`;
  return {
    origin,
    routes: fixtureRouteManifest,
    close: () => new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
  };
}

async function checkFixtures() {
  await buildFixtures();
  const fixture = await startFixtureServer();
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    const health = await (await fetch(`${fixture.origin}/healthz`)).json();
    assert.deepEqual(health, { service: 'anmerko-component-context-fixtures', version: 1, ready: true, routeCount: fixtureRouteManifest.length });
    assert.deepEqual(await (await fetch(`${fixture.origin}/routes.json`)).json(), fixtureRouteManifest);
    const page = await browser.newPage();
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    for (const route of fixtureRouteManifest) {
      await page.goto(`${fixture.origin}${route.path}`);
      if (route.framework === 'angular') {
        await page.waitForFunction(() => globalThis.__BRIEFMARK_ANGULAR_FIXTURE__?.ready === true
          || !!globalThis.__BRIEFMARK_ANGULAR_FIXTURE__?.error);
        const angular = await page.evaluate(() => {
          const record = globalThis.__BRIEFMARK_ANGULAR_FIXTURE__;
          const host = document.querySelector(`[data-fixture-id="${record.selectedTargets.host.id}"]`);
          const leaf = host?.shadowRoot?.querySelector(`[data-fixture-id="${record.selectedTargets.leaf.id}"]`);
          return {
            record,
            hostFound: !!host,
            leafFound: !!leaf,
            ngFunctions: ['getComponent', 'getOwningComponent', 'getHostElement'].map(name => typeof globalThis.ng?.[name]),
          };
        });
        assert.equal(angular.record.error, undefined);
        assert.equal(angular.record.framework, 'angular');
        assert.equal(angular.record.runtime.angularVersion, route.version);
        assert.equal(angular.record.runtime.buildMode, route.mode);
        assert.equal(angular.record.runtime.aot, true);
        assert.equal(angular.record.runtime.optimized, route.mode === 'production');
        assert.equal(angular.hostFound, true);
        assert.equal(angular.leafFound, true);
        assert.deepEqual(angular.record.sentinels.reads, { props: 0, state: 0, source: 0 });
        assert.deepEqual(angular.ngFunctions, route.mode === 'development'
          ? ['function', 'function', 'function'] : ['undefined', 'undefined', 'undefined']);
        continue;
      }
      await page.waitForFunction(() => globalThis.__ANMERKO_FIXTURE__?.ready === true);
      const result = await page.evaluate(() => {
        const record = globalThis.__ANMERKO_FIXTURE__;
        const elementFor = id => document.getElementById(id)
          || document.querySelector('#react-shadow-host')?.shadowRoot?.getElementById(id);
        const markerFor = id => {
          const target = elementFor(id);
          return target ? Object.getOwnPropertyNames(target).find(name => name.startsWith('__reactFiber$')) || null : 'missing';
        };
        const reactPathFor = id => {
          const target = elementFor(id);
          const key = target && Object.getOwnPropertyNames(target).find(name => name.startsWith('__reactFiber$'));
          const names = [];
          for (let fiber = key ? target[key] : null; fiber; fiber = fiber.return) {
            const type = fiber.elementType ?? fiber.type;
            const name = typeof type === 'function' ? type.displayName || type.name
              : type && typeof type === 'object' ? type.displayName || type.type?.displayName || type.type?.name || type.render?.displayName || type.render?.name
                : null;
            if (name) names.push(name);
          }
          return names.reverse();
        };
        const vueMarkerFor = id => {
          const target = document.getElementById(id);
          return target ? Object.hasOwn(target, '__vueParentComponent') : 'missing';
        };
        const vueInfoFor = id => {
          const target = document.getElementById(id);
          const direct = target?.__vueParentComponent;
          const directType = direct?.type;
          const directName = typeof directType === 'function' ? directType.displayName || directType.name : directType?.name || directType?.__name;
          const names = [];
          for (let instance = direct; instance; instance = instance.parent) {
            const type = instance.type;
            const name = typeof type === 'function' ? type.displayName || type.name : type?.name || type?.__name;
            if (name) names.push(name);
          }
          return { directNamed: !!directName, path: names.reverse() };
        };
        return {
          record,
          markers: Object.fromEntries(Object.values(record.targets).map(target => [target.id, markerFor(target.id)])),
          reactPaths: record.framework === 'react'
            ? Object.fromEntries(Object.values(record.targets).map(target => [target.id, reactPathFor(target.id)])) : {},
          vueMarkers: Object.fromEntries(Object.values(record.targets).map(target => [target.id, vueMarkerFor(target.id)])),
          vueInfo: Object.fromEntries(Object.values(record.targets).map(target => [target.id, vueInfoFor(target.id)])),
        };
      });
      assert.equal(result.record.framework, route.framework);
      assert.equal(result.record.mode, route.mode);
      if (route.framework === 'react') {
        assert.equal(result.record.runtimeVersion, route.version);
        assert.equal(result.record.rendererEntry, route.mode === 'profiling' ? 'react-dom/profiling' : 'react-dom/client');
        assert.deepEqual(result.record.privacyReads, { props: 0, state: 0, source: 0, stack: 0 });
        assert.ok(Object.values(result.markers).every(marker => typeof marker === 'string' && marker.startsWith('__reactFiber$')));
        if (route.mode === 'development') for (const target of Object.values(result.record.targets)) {
          assert.deepEqual(result.reactPaths[target.id], target.expectedPath);
        }
      }
      if (route.framework === 'vue') {
        assert.equal(result.record.runtimeVersion, route.version);
        assert.deepEqual(result.record.privacyReads, { props: 0, state: 0, source: 0, file: 0 });
        const expectedMarker = route.mode !== 'production';
        for (const [id, marker] of Object.entries(result.vueMarkers)) {
          assert.notEqual(marker, 'missing', `${route.id} target ${id} must render`);
          assert.equal(marker, id === 'vue-manual-button' ? false : expectedMarker, `${route.id} target ${id} marker`);
        }
        if (expectedMarker) for (const target of Object.values(result.record.targets)) {
          if (target.id === 'vue-manual-button') continue;
          if (target.id === 'vue-anonymous-button') {
            assert.equal(result.vueInfo[target.id].directNamed, false);
            continue;
          }
          const path = result.vueInfo[target.id].path.filter(name => name !== 'KeepAlive');
          assert.deepEqual(path, target.expectedPath, `${route.id} target ${target.id} path`);
        }
      }
      if (route.framework === 'mixed') {
        const associations = await page.evaluate(() => Object.fromEntries(Object.values(globalThis.__ANMERKO_FIXTURE__.targets).map(target => {
          const element = document.getElementById(target.id);
          return [target.id, {
            react: !!Object.getOwnPropertyNames(element).find(name => name.startsWith('__reactFiber$')),
            vue: Object.hasOwn(element, '__vueParentComponent'),
          }];
        })));
        if (route.mode === 'islands') assert.deepEqual(associations, {
          'mixed-react-button': { react: true, vue: false },
          'mixed-vue-button': { react: false, vue: true },
        });
        else assert.deepEqual(associations, { 'mixed-dual-button': { react: true, vue: true } });
      }
    }
    assert.deepEqual(failures, []);
  } finally {
    await browser.close();
    await fixture.close();
  }
  console.log(`PASS ${fixtureRouteManifest.length} component-context fixture routes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = new Set(process.argv.slice(2));
  if (args.has('--build')) await buildFixtures();
  else if (args.has('--check')) await checkFixtures();
  else {
    const values = process.argv.slice(2);
    const portIndex = values.indexOf('--port');
    const port = portIndex === -1 ? 4177 : Number(values[portIndex + 1]);
    const fixture = await startFixtureServer({ port, build: true });
    console.log(`component-context fixtures listening at ${fixture.origin}`);
  }
}
