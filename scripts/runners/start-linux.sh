#!/bin/bash
set -euo pipefail
cd /home/runner
# Registration happens once via docker exec, with its token supplied on stdin.
until [[ -f .configured ]]; do sleep 1; done
exec ./run.sh
