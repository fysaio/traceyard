#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 6 ]]; then
  echo 'Usage: browser-replay.sh <journey> <base SHA> <head SHA> <base build> <head build> <evidence>' >&2
  exit 2
fi
docker run --rm --init --network none --read-only --tmpfs /tmp:exec,mode=1777,size=512m \
  --shm-size=256m --cap-drop ALL --security-opt=no-new-privileges \
  --memory=1g --pids-limit=256 --user="$(id -u):$(id -g)" \
  --env HOME=/tmp --env GITHUB_ACTIONS=true --env GITHUB_STEP_SUMMARY=/output/summary.md \
  --mount "type=bind,source=$1,target=/journey.json,readonly" \
  --mount "type=bind,source=$4,target=/baseline,readonly" \
  --mount "type=bind,source=$5,target=/candidate,readonly" \
  --mount "type=bind,source=$6,target=/output" \
  traceyard-browser /journey.json "$2" "$3" \
  --baseline-build /baseline --candidate-build /candidate --evidence /output
