#!/bin/bash
# Control the installed runner VMs. Linux routing changes precede shutdown.
set -euo pipefail
group=${1:?Usage: control.sh mac|linux|all start|stop}
action=${2:?Usage: control.sh mac|linux|all start|stop}
[[ "$action" == start || "$action" == stop ]]
if [[ "$group" == all ]]; then
  result=0
  for target in linux mac; do
    "$0" "$target" "$action" || result=1
  done
  exit "$result"
fi
domain="gui/$(id -u)"
tart_bin=${ANMERKO_TART_BIN:-$HOME/.local/bin/tart}
vm_name=${ANMERKO_MACOS_VM:-briefmark-ci}
docker_context=${ANMERKO_DOCKER_CONTEXT:-colima-github-actions}
docker_cli() { docker --context "$docker_context" "$@"; }
start_service() {
  local label=$1
  launchctl enable "$domain/$label"
  if ! launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootstrap "$domain" "$HOME/Library/LaunchAgents/$label.plist"
  fi
}
stop_service() {
  local label=$1
  launchctl disable "$domain/$label"
  if launchctl print "$domain/$label" >/dev/null 2>&1; then
    launchctl bootout "$domain/$label"
  fi
}
linux_mode() {
  local repository=${ANMERKO_REPOSITORY:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}
  gh variable set LINUX_RUNNER_MODE --repo "$repository" --body "$1"
}
linux_containers() {
  containers=()
  while IFS= read -r container; do
    [[ -z "$container" ]] || containers+=("$container")
  done < <(docker_cli ps -aq --filter label=briefmark.runner-group=linux)
}
case "$group:$action" in
  mac:start)
    start_service local.github-actions.macos-vm
    echo 'macOS VM starting; its runner starts at guest login.'
    ;;
  mac:stop)
    # Release the GitHub session cleanly when the guest is reachable.
    if "$tart_bin" get "$vm_name" | grep -q running; then
      # Expansion below belongs to the guest, not the host.
      # shellcheck disable=SC2016
      "$tart_bin" exec "$vm_name" /bin/bash -c '
        for service in "$HOME"/.local/share/github-actions-runners/*/*/.service; do
          [ -f "$service" ] || continue
          (cd "${service%/*}" && ./svc.sh stop)
        done' || true
    fi
    stop_service local.github-actions.macos-vm
    if "$tart_bin" get "$vm_name" | grep -q running; then
      "$tart_bin" stop "$vm_name"
    fi
    echo 'macOS runners stopped; macOS jobs will queue.'
    ;;
  linux:start)
    start_service local.github-actions.colima
    for ((attempt=0; attempt<60; attempt++)); do
      if docker_cli info >/dev/null 2>&1; then break; fi
      sleep 2
    done
    docker_cli info >/dev/null
    linux_containers
    if [[ ${#containers[@]} == 0 ]]; then
      echo 'No Linux runner containers registered. Run register-linux.sh first.' >&2
      exit 1
    fi
    docker_cli start "${containers[@]}"
    linux_mode local
    echo 'Linux runners started; future workflows prefer local Linux.'
    ;;
  linux:stop)
    routing_status=0
    linux_mode hosted || routing_status=$?
    if docker_cli info >/dev/null 2>&1; then
      linux_containers
      if [[ ${#containers[@]} != 0 ]]; then docker_cli stop --timeout 45 "${containers[@]}"; fi
    fi
    stop_service local.github-actions.colima
    colima stop github-actions
    if [[ "$routing_status" != 0 ]]; then
      echo 'Linux stopped, but GitHub routing could not be updated.' >&2
      exit "$routing_status"
    fi
    echo 'Linux runners stopped; future workflows use hosted Linux.'
    ;;
  *) echo "Unknown runner group: $group" >&2; exit 1 ;;
esac
