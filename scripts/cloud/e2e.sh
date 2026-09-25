#!/usr/bin/env bash
# Run anmerko's end-to-end browser matrix in a Claude Code cloud session, in
# CI's order: static checks, stable Chrome and Edge with the production
# manifest under Xvfb, the Playwright Chromium suite (desktop, touch and Edge
# Android emulation), Firefox stable and 142.0, and the Firefox for Android
# package lint. Evidence is written under artifacts/.
#
# Usage: scripts/cloud/e2e.sh [static] [chrome] [edge] [chromium] [firefox] [android]
# With no arguments every suite runs. Exits non-zero if any step fails.
set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
export PATH="/opt/node24/bin:$PATH" SE_AVOID_STATS=true
cd "$root" || exit 1

suites=("$@")
[[ ${#suites[@]} -gt 0 ]] || suites=(static chrome edge chromium firefox android)
wants() { [[ " ${suites[*]} " == *" $1 "* ]]; }

echo '== Provisioning (waits for the SessionStart background run)'
if ! bash scripts/cloud/setup.sh; then
  echo 'Provisioning failed; see /tmp/anmerko-cloud-setup.log for the background run.' >&2
  exit 1
fi

results=()
failed=0
step() {
  local name=$1 limit=$2 start=$SECONDS
  shift 2
  echo
  echo "== $name"
  if timeout --kill-after=30s "$limit" "$@"; then
    results+=("PASS  $name ($((SECONDS - start))s)")
  else
    results+=("FAIL  $name ($((SECONDS - start))s)")
    failed=1
  fi
}

if wants static; then
  step 'Lint' 5m npm run lint
  step 'Typecheck' 5m npm run typecheck
fi
if wants chrome || wants edge || wants chromium; then
  step 'Build Chromium extension' 5m npm run build
fi
if wants chrome; then
  step 'Chrome stable (production manifest, Xvfb)' 10m xvfb-run -a npm run test:desktop -- --browser chrome
fi
if wants edge; then
  step 'Edge stable (production manifest, Xvfb)' 10m xvfb-run -a npm run test:desktop -- --browser edge
fi
if wants chromium; then
  step 'Package Chromium ZIP' 5m npm run package
  step 'Installer tests' 10m npm run test:installer
  step 'Playwright Chromium (desktop, touch, Edge Android UA)' 30m npm test
fi
if wants firefox; then
  step 'Build Firefox extension' 5m npm run build:firefox
  step 'Firefox stable' 20m env FIREFOX_VERSION=stable npm run test:firefox
  step 'Firefox 142.0' 20m env FIREFOX_VERSION=142.0 npm run test:firefox
fi
if wants android; then
  # Firefox for Android installs this same package; Mozilla's linter checks
  # its gecko_android manifest. Touch and Edge Android flows run above.
  step 'Firefox for Android package (Mozilla lint)' 10m npm run package:firefox
  results+=('SKIP  Android emulator: no /dev/kvm here; CI runs npm run test:android (Firefox Android emulator)')
fi

echo
echo '== Summary'
printf '%s\n' "${results[@]}"
exit "$failed"
