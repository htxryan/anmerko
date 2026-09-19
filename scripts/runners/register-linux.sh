#!/bin/bash
set -euo pipefail
umask 077
repository=${1:?Usage: register-linux.sh OWNER/REPO [RUNNER_NAME]}
runner_name=${2:-macbook-${repository//\//-}-linux-1}
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
[[ "$runner_name" =~ ^[A-Za-z0-9_.-]+$ ]]
[[ "$(gh api "repos/$repository" --jq .private)" == true ]] || {
  echo 'Only private repositories are supported by this personal Mac setup.' >&2
  exit 1
}
docker_context=${ANMERKO_DOCKER_CONTEXT:-colima-github-actions}
runner_image=${ANMERKO_RUNNER_IMAGE:-anmerko-actions-runner:2.337.0}
docker_cli() { docker --context "$docker_context" "$@"; }
if ! docker_cli container inspect "$runner_name" >/dev/null 2>&1; then
  # Named volumes only: no Mac filesystem, Docker socket or credentials mounted.
  docker_cli run --detach --init --restart unless-stopped --name "$runner_name" \
    --cpus 2 --memory 4g --shm-size 1g --log-opt max-size=10m --log-opt max-file=3 \
    --label anmerko.runner-group=linux --label "anmerko.repository=$repository" \
    --mount "type=volume,source=$runner_name,target=/home/runner" "$runner_image"
else
  docker_cli start "$runner_name"
fi
if docker_cli exec "$runner_name" test -f /home/runner/.configured; then
  echo "Already registered: $runner_name"
  exit 0
fi
# Expansion below belongs to the container's shell, not the host shell.
# shellcheck disable=SC2016
gh api --method POST "repos/$repository/actions/runners/registration-token" --jq .token |
  docker_cli exec -i "$runner_name" bash -c '
    set -euo pipefail
    read -r registration_token
    ./config.sh --unattended --url "$1" --token "$registration_token" \
      --name "$2" --labels macbook,macbook-linux --work _work
    unset registration_token
    touch .configured
  ' -- "https://github.com/$repository" "$runner_name"
echo "Registered Linux container: $runner_name"
