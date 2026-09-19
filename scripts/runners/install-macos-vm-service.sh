#!/bin/bash
# Start an existing Tart VM at login without showing or sharing its desktop.
set -euo pipefail
vm_name=${1:-briefmark-ci}
tart_bin=${ANMERKO_TART_BIN:-$HOME/.local/bin/tart}
label=local.github-actions.macos-vm
[[ "$vm_name" =~ ^[A-Za-z0-9_.-]+$ ]]
"$tart_bin" get "$vm_name" >/dev/null
if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
  echo "Already loaded: $label. Stop the service before changing its configuration."
  exit 0
fi
python3 - "$vm_name" "$tart_bin" "$label" <<'PY'
import pathlib, plistlib, sys
vm, binary, label = sys.argv[1:]
home = pathlib.Path.home()
logs = home / 'Library/Logs/github-actions-macos-vm'
logs.mkdir(parents=True, exist_ok=True)
path = home / 'Library/LaunchAgents' / (label + '.plist')
path.parent.mkdir(parents=True, exist_ok=True)
service = {
    'Label': label,
    'ProgramArguments': ['/usr/bin/caffeinate', '-s', str(pathlib.Path(binary).resolve()),
                         'run', '--no-graphics', '--no-audio', '--no-clipboard', vm],
    'EnvironmentVariables': {'PATH': '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'},
    'RunAtLoad': True, 'KeepAlive': True, 'ThrottleInterval': 30,
    'StandardOutPath': str(logs / 'stdout.log'),
    'StandardErrorPath': str(logs / 'stderr.log'),
}
with path.open('wb') as file:
    plistlib.dump(service, file)
PY
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist"
echo "VM service installed: $label"
