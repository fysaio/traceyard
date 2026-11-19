#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 6 ]]; then
  echo 'Usage: browser-check.sh <config directory> <base SHA> <head SHA> <base build> <head build> <evidence>' >&2
  exit 2
fi
shopt -s nullglob
journeys=("$1"/browser/*.json)
if [[ -f "$1/browser-journey.json" ]]; then
  journeys+=("$1/browser-journey.json")
fi
if [[ ${#journeys[@]} -lt 1 || ${#journeys[@]} -gt 20 ]]; then
  echo 'Provide between one and twenty reviewed browser journeys.' >&2
  exit 2
fi
mkdir -p "$6"
: > "$6/summary.md"
status=0
for journey in "${journeys[@]}"; do
  label=$(basename "$journey" .json)
  if [[ ! $label =~ ^[a-zA-Z0-9_-]+$ ]]; then
    echo 'Use letters, digits, dashes, and underscores in journey filenames.' >&2
    exit 2
  fi
  kind=journeys
  if [[ "$journey" == "$1/browser-journey.json" ]]; then kind=default; fi
  output="$6/$kind/$label"
  mkdir -p "$output"
  touch "$output/summary.md"
  result=0
  bash "$(dirname "$0")/browser-replay.sh" "$journey" "$2" "$3" "$4" "$5" "$output" \
    > "$output/result.json" || result=$?
  printf '\n**Journey %s**\n' "$label" >> "$6/summary.md"
  cat "$output/summary.md" >> "$6/summary.md"
  cat "$output/result.json"
  if [[ $result -gt $status ]]; then status=$result; fi
done
exit "$status"
