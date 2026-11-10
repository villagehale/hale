#!/usr/bin/env bash
# Replays every apps/worker/evals/run-*.mjs from the committed cache. Shared by
# ci.yml (every PR) and eval-sweep.yml (weekly) so the two run the same loop.
# Cached-only means zero API calls: a cache miss fails the suite instead of
# spending. Runs every suite before failing, so one red suite does not hide
# another.
#
# HALE_EVERY_EVAL_KNOWN_OK=1 (CI every-eval job only): suites listed in
# every-eval-known-ok.txt may fail without failing this script, so known reds
# on main from in-flight PRs do not turn main red. The weekly sweep does not
# set the flag.
set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

# Never spend. Unset (not empty): worker config Zod rejects ANTHROPIC_API_KEY="".
unset ANTHROPIC_API_KEY AI_GATEWAY_API_KEY VERCEL_KEY JEV_KEY OPENAI_API_KEY

allow_known=0
if [ "${HALE_EVERY_EVAL_KNOWN_OK:-}" = '1' ]; then
  allow_known=1
fi
known_list=$(node "$SCRIPT_DIR/every-eval-known-ok.mjs" list)

is_known() {
  printf '%s\n' "$known_list" | grep -qxF "$1"
}

cd "$REPO_ROOT/apps/worker"
table=""
fails=0
knowns=0
stale=0
for f in evals/run-*.mjs; do
  name=$(basename "$f" .mjs)
  echo "::group::$name"
  if node "$f" --cached-only; then
    if is_known "$name"; then
      table="${table}PASS  ${name}  (stale known-ok; remove from every-eval-known-ok.txt)"$'\n'
      stale=$((stale + 1))
    else
      table="${table}PASS  ${name}"$'\n'
    fi
  else
    if [ "$allow_known" -eq 1 ] && is_known "$name"; then
      table="${table}KNOWN ${name}"$'\n'
      knowns=$((knowns + 1))
    else
      table="${table}FAIL  ${name}"$'\n'
      fails=$((fails + 1))
    fi
  fi
  echo "::endgroup::"
done
printf '%s\n' "==== eval sweep ===="
printf '%s' "$table"
printf 'failing suites: %s\n' "$fails"
printf 'known-ok suites: %s\n' "$knowns"
printf 'stale known-ok: %s\n' "$stale"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    printf '### Eval sweep\n\n```\n'
    printf '%s' "$table"
    printf '```\n\nfailing suites: %s\nknown-ok suites: %s\nstale known-ok: %s\n' "$fails" "$knowns" "$stale"
  } >> "$GITHUB_STEP_SUMMARY"
fi
test "$fails" -eq 0
