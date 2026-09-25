#!/usr/bin/env bash
# Provision a Claude Code cloud VM (Ubuntu 24.04, x86_64, root) for anmerko's
# browser matrix: Node 24, npm and component-fixture dependencies, Playwright
# Chromium, stable Chrome and Edge, and Firefox stable and 142.0 with
# geckodriver through Selenium Manager.
#
# Idempotent and safe to repeat: use it as the cloud environment's setup script
# (the filesystem snapshot then caches everything), and the SessionStart hook
# runs it in the background to refresh a new checkout. Concurrent runs
# serialize on a lock, so scripts/cloud/e2e.sh calls it to wait.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
state=${ANMERKO_CLOUD_STATE:-/opt/anmerko-cloud}
node_version=${ANMERKO_NODE_VERSION:-24.15.0}
node_home=/opt/node24
export DEBIAN_FRONTEND=noninteractive PATH="$node_home/bin:$PATH" SE_AVOID_STATS=true
mkdir -p "$state"
exec 9>"$state/setup.lock"
flock 9

log() { printf '[anmerko-cloud %(%H:%M:%S)T] %s\n' -1 "$*"; }
# Stamps live beside what they describe; npm ci removes a stale one.
current() { [[ -f "$1" && "$(cat "$1")" == "$2" ]]; }

if [[ $(id -u) -ne 0 || $(uname -m) != x86_64 ]]; then
  echo 'Run as root on x86_64 Linux: branded Chrome and Edge ship only for x86_64.' >&2
  exit 1
fi

install_node() {
  [[ "$("$node_home/bin/node" -v 2>/dev/null)" == "v$node_version" ]] && return
  log "Installing Node $node_version"
  # Unpack beside the target and rename, so commands started while this runs
  # never execute a half-written binary ("Text file busy").
  rm -rf "$node_home.partial" && mkdir -p "$node_home.partial"
  curl -fsSL "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz" \
    | tar -xJ -C "$node_home.partial" --strip-components=1
  rm -rf "$node_home" && mv "$node_home.partial" "$node_home"
}

install_packages() {
  local packages=(xvfb xauth zip unzip)
  dpkg -s "${packages[@]}" >/dev/null 2>&1 && return
  log 'Installing Xvfb and archive tools'
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends "${packages[@]}" >/dev/null
}

install_fixtures() {
  local key
  # Tracked blobs plus uncommitted edits, so fixture source changes rebuild.
  key=$(cd "$root" && { git ls-files -s tests/fixtures/component-context; git diff HEAD -- tests/fixtures/component-context; } \
    | sha256sum | cut -c1-16)
  local stamp="$root/tests/fixtures/component-context/node_modules/.anmerko-cloud"
  current "$stamp" "$key" && return
  log 'Installing and building component-context fixtures'
  (cd "$root" && npm run test:context-fixtures:setup >/dev/null)
  echo "$key" >"$stamp"
}

install_browsers() {
  local key
  key=$(cd "$root" && node -p "require('@playwright/test/package.json').version")
  if ! current "$state/browsers" "$key"; then
    # Stable Chrome and Edge install through apt. CI also forces them because
    # runner-bundled channels can hang during extension startup.
    log "Installing Playwright $key Chromium, stable Chrome and stable Edge"
    (cd "$root" && npx playwright install --with-deps chromium && npx playwright install --force chrome msedge \
      && npx playwright install-deps firefox) >/dev/null
    echo "$key" >"$state/browsers"
  fi
  for version in stable 142.0; do
    log "Caching Firefox $version and geckodriver"
    (cd "$root" && node -e "const { binaryPaths } = require('selenium-webdriver/common/seleniumManager');
      console.log(JSON.stringify(binaryPaths(['--browser', 'firefox', '--browser-version', process.argv[1], '--output', 'json'])));" \
      "$version") >"$state/firefox-$version.json"
  done
}

install_packages & apt_job=$!
install_node
wait "$apt_job"
key=$({ echo "$node_version"; cat "$root/package-lock.json"; } | sha256sum | cut -c1-16)
if ! current "$root/node_modules/.anmerko-cloud" "$key"; then
  log 'Installing npm dependencies'
  (cd "$root" && npm ci --no-audit --no-fund >/dev/null)
  echo "$key" >"$root/node_modules/.anmerko-cloud"
fi
install_fixtures & fixtures_job=$!
install_browsers
wait "$fixtures_job"
log "Ready: Node $(node -v), $(google-chrome --version), $(microsoft-edge --version)"
