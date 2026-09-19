#!/bin/bash
# Run on the host: only a short-lived registration token crosses into the VM.
set -euo pipefail
umask 077
repository=${1:?Usage: register-macos.sh OWNER/REPO [RUNNER_NAME]}
runner_name=${2:-macbook-${repository//\//-}-macos-vm-1}
vm_name=${ANMERKO_MACOS_VM:-anmerko-ci}
tart_bin=${ANMERKO_TART_BIN:-$HOME/.local/bin/tart}
[[ "$repository" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]
[[ "$runner_name" =~ ^[A-Za-z0-9_.-]+$ ]]
[[ "$(gh api "repos/$repository" --jq .private)" == true ]] || {
  echo 'Only private repositories are supported by this personal Mac setup.' >&2
  exit 1
}

read -r archive_url checksum < <(gh api "repos/$repository/actions/runners/downloads" \
  --jq '.[] | select(.os == "osx" and .architecture == "arm64") | [.download_url, .sha256_checksum] | @tsv')
[[ "$archive_url" == https://github.com/actions/runner/releases/download/* ]]
[[ "$checksum" =~ ^[a-f0-9]{64}$ ]]

# Expansion belongs to the guest shell. Never pass the host's GitHub token.
# shellcheck disable=SC2016
gh api --method POST "repos/$repository/actions/runners/registration-token" --jq .token |
  "$tart_bin" exec -i "$vm_name" /bin/bash -c '
    set -euo pipefail
    umask 077
    read -r registration_token
    repository=$1; runner_name=$2; archive_url=$3; checksum=$4
    runner_base="$HOME/.local/share/github-actions-runners"
    runner_dir="$runner_base/${repository//\//-}/$runner_name"
    mkdir -p "$runner_dir" "$runner_base/downloads"
    cd "$runner_dir"
    if [[ -f .runner ]]; then
      echo "Already registered: $runner_dir (use ./svc.sh status there)."
      exit 0
    fi
    archive="$runner_base/downloads/${archive_url##*/}"
    if [[ ! -f "$archive" ]]; then
      curl --fail --location --silent --show-error "$archive_url" -o "$archive"
    fi
    printf "%s  %s\n" "$checksum" "$archive" | shasum -a 256 --check
    tar -xzf "$archive"
    ./config.sh --unattended --url "https://github.com/$repository" \
      --token "$registration_token" --name "$runner_name" \
      --labels macbook,macbook-macos,macbook-macos-vm --work _work
    unset registration_token
    printf "%s\n" /opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin > .path
    printf "\nNPM_CONFIG_CACHE=%s/cache/npm\n" "$runner_dir" >> .env
    ./svc.sh install
    ./svc.sh start
    printf "Runner installed inside the VM at %s\n" "$runner_dir"
  ' -- "$repository" "$runner_name" "$archive_url" "$checksum"
