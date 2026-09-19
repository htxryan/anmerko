# Local GitHub Actions runners

The source controls use `ANMERKO_*` environment names. The currently installed infrastructure retains a few exact prelaunch identifiers while release and CI work is active: Tart VM `briefmark-ci`, Docker image `briefmark-actions-runner:2.337.0`, container labels `briefmark.runner-group=linux` and `briefmark.repository`, and LaunchAgent labels `local.github-actions.macos-vm` and `local.github-actions.colima`. These names do not change the repository registration or product output. Retire them together during the next planned runner drain and reprovision, after active jobs finish and the replacement routes successfully.

- **macOS:** one Tart VM (`briefmark-ci`), 6 CPUs / 12 GiB RAM. Its desktop,
  clipboard and audio stay separate from the host; no Mac folders are shared.
- **Linux:** four Ubuntu ARM64 Docker runners, each limited to 2 CPUs / 4 GiB RAM.
  Their dedicated Colima VM has 8 CPUs / 20 GiB RAM and no host-folder, SSH-agent
  or Docker-socket mounts in the runners. Combined VM memory is 32 GiB on this
  64 GiB Mac. Runner workspaces and caches persist between jobs.

## Controls

Run from the repository root:

| Task | Effect |
| --- | --- |
| `task runners:start` | Start both groups |
| `task runners:stop` | Stop both groups |
| `task runners:mac:start` / `task runners:mac:stop` | Control macOS |
| `task runners:linux:start` / `task runners:linux:stop` | Control Linux |

Stop commands can interrupt active jobs and disable login startup until started
again. Start commands restore login startup. Keep the Mac awake, plugged in,
logged in and online; lid sleep still interrupts CI.

## Routing

Trusted private macOS jobs require `[self-hosted, macOS, ARM64,
macbook-macos-vm]`; they have **no automatic hosted fallback or variable
override**. When the VM is off, those jobs queue. Public and fork macOS jobs use
hosted macOS runners and are not scheduled on the personal runner.
Windows remains paused; its retained native build does not require runner
provisioning.

Compatible Linux jobs across Check, Release, Deploy and Publish prefer local
runners. `LINUX_RUNNER_MODE=hosted` selects `ubuntu-latest`; the Linux start/stop
tasks set this variable to `local`/`hosted`. Linux Chrome/Edge desktop jobs stay
hosted because the branded browsers require x64. Fork/public Linux jobs also use
hosted runners.

GitHub does not offer automatic runner priority/fallback. Unexpected outages or
an already queued local job still require recovery or cancellation and rerun.
The Linux controls need host GitHub CLI access to update repository routing.
To choose hosted Linux while leaving the local group running:

```sh
gh variable set LINUX_RUNNER_MODE --body hosted
```

## Provisioning and maintenance

Personal GitHub accounts require per-repository registrations. Use these scripts
from a host with GitHub CLI authenticated as repository administrator:

```sh
scripts/runners/register-macos.sh OWNER/REPO
scripts/runners/register-linux.sh OWNER/REPO RUNNER_NAME
```

Each registration gets its own directory/volume. Trusted macOS desktop jobs in
this repository share a FIFO VM queue, retaining up to 100 pending jobs rather
than canceling them. This queue is repository-scoped: other repositories sharing
the VM need an organization runner pool, one active worker, or separate VMs.
Only trusted private code belongs on these persistent runners.

Tart 2.37.0 is installed at `~/.local/bin/tart`. The VM uses
`ghcr.io/cirruslabs/macos-tahoe-base@sha256:1b093499716409d29e8b5336844528e1cae375db97d2ad8e5aeff78cf0da201e`,
with Chrome/Edge installed and network SSH/screen sharing disabled.
`install-macos-vm-service.sh` installs its host LaunchAgent. The Linux image is
built with `docker --context colima-github-actions build -t briefmark-actions-runner:2.337.0 scripts/runners`.
It includes DejaVu fonts for consistent layout tests. Containers carry the
`briefmark.runner-group=linux` label used by the controls.

Optional source-control overrides use `ANMERKO_MACOS_VM`, `ANMERKO_TART_BIN`,
`ANMERKO_DOCKER_CONTEXT`, `ANMERKO_RUNNER_IMAGE`, and `ANMERKO_REPOSITORY`.
Their defaults deliberately address the installed values above. No legacy
environment-variable fallback is provided; update local shell configuration to
the new names before using an override.

Host service plists are `~/Library/LaunchAgents/local.github-actions.{macos-vm,colima}.plist`;
logs are in `~/Library/Logs/github-actions-{macos-vm,colima}/`. Both services hold
an AC-only sleep assertion. Runner registration uses short-lived tokens; host
GitHub CLI credentials are not copied into either VM. GitHub's runner updates
itself. npm caches stay local, and Selenium uses fresh per-job browser downloads
to keep Firefox 142 from silently updating in place.
