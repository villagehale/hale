#!/usr/bin/env bash
# Replays every apps/worker/evals/run-*.mjs from the committed cache. Shared by
# ci.yml (every PR, required) and eval-sweep.yml (weekly) so the two run the
# same loop. Cached-only means zero API calls: a cache miss fails the suite
# instead of spending. Runs every suite before failing, so one red suite does
# not hide another. A run-*.test.mjs is a vitest file, run by pnpm test.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

# Never spend. Unset (not empty): worker config Zod rejects ANTHROPIC_API_KEY="".
unset ANTHROPIC_API_KEY AI_GATEWAY_API_KEY VERCEL_KEY JEV_KEY OPENAI_API_KEY

cd "$REPO_ROOT/apps/worker"
table=""
fails=0
for f in evals/run-*.mjs; do
  case "$f" in *.test.mjs) continue ;; esac
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
