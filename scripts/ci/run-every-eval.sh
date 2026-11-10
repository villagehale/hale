#!/usr/bin/env bash
# Replays every apps/worker/evals/run-*.mjs from the committed cache. Shared by
# ci.yml (every PR) and eval-sweep.yml (weekly) so the two run the same loop.
# Cached-only means zero API calls: a cache miss fails instead of spending.
# Runs every suite before failing, so one red suite does not hide another.
set -uo pipefail

cd "$(dirname "$0")/../../apps/worker"
table=""
fails=0
for f in evals/run-*.mjs; do
  name=$(basename "$f" .mjs)
  echo "::group::$name"
  if node "$f" --cached-only; then
    table="${table}PASS  ${name}"$'\n'
  else
    table="${table}FAIL  ${name}"$'\n'
    fails=$((fails + 1))
  fi
  echo "::endgroup::"
done
printf '%s\n' "==== eval sweep ===="
printf '%s' "$table"
printf 'failing suites: %s\n' "$fails"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '### Eval sweep\n\n```\n'
    printf '%s' "$table"
    printf '```\n\nfailing suites: %s\n' "$fails"
  } >> "$GITHUB_STEP_SUMMARY"
fi
test "$fails" -eq 0
