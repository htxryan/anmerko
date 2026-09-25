#!/usr/bin/env bash
# SessionStart hook: in Claude Code cloud sessions only, put the pinned Node on
# PATH and start (or refresh) provisioning in the background so the session
# opens immediately. scripts/cloud/e2e.sh waits for it to finish.
[[ "${CLAUDE_CODE_REMOTE:-}" == true ]] || exit 0
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
log=/tmp/anmerko-cloud-setup.log
if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
  # Literal $PATH: the env file is sourced before each later Bash command.
  # shellcheck disable=SC2016
  echo 'export PATH="/opt/node24/bin:$PATH"' >> "$CLAUDE_ENV_FILE"
fi
setsid nohup bash "$root/scripts/cloud/setup.sh" >>"$log" 2>&1 </dev/null &
echo "anmerko cloud provisioning is running in the background (log: $log)."
echo 'Run scripts/cloud/e2e.sh for the full browser matrix; it waits for provisioning.'
