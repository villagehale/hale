// Pure failure classifier for the self-healing CI workflow (ci-heal.yml).
//
// Input is the failed step name (from `gh run view --json jobs` — the
// `--log-failed` dump labels steps "UNKNOWN STEP", so step names must come
// from the jobs JSON) plus the raw `--log-failed` text. Output is one of four
// classes, evaluated strictly in order 1 → 2 → 3 → 4; the first match wins.
//
// Signatures are verbatim from real failed runs (see classify.test.mjs).

const SKILL_STEP = 'Skill lockfile check';
const SKILL_DRIFT_RE = /Skill prompt drift detected|No skills\/\.skills-lock\.json found/;
const CACHED_ONLY_STEP_RE = /\(cached-only\)$/;
const CACHE_MISS_RE = /cache miss in --cached-only mode/;
const CACHE_MISS_DETAIL_RE = /cache miss in --cached-only mode \(([^)]*)\)/;
const EVAL_NAME_RE = /pnpm --filter @hale\/worker (eval:[a-z][a-z0-9-]*)/;
const TIMEOUT_RE = /(Test|Hook) timed out in \d+ms/;
const PGLITE_FILE_RE = /(\.pglite\.test\.ts$|lib\/__journey__\/|lib\/testing\/pglite\.test\.ts$)/;
const ONE_FILE_SUMMARY_RE = /Test Files\s+1 failed \| \d+ passed/;
const FAIL_LINE_RE = /\bFAIL\b\s+(\S+)/;
const ERROR_LINE_RE = /\bFAIL\b\s|error TS\d+|\bError\b|##\[error\]/;

// Built via constructor so no control character sits in a regex literal
// (lint/suspicious/noControlCharactersInRegex is error-level here).
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

// `gh run view --log-failed` lines look like:
//   <job name>\t<step name>\t2026-08-26T14:03:11.5820000Z <text>
export function stripLogPrefix(line) {
  const parts = line.split('\t');
  const text = parts.length >= 3 ? parts.slice(2).join('\t') : line;
  return text.replace(ANSI_RE, '').replace(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z ?/, '');
}

export function extractFailFiles(logText) {
  const files = [];
  for (const raw of logText.split('\n')) {
    const match = stripLogPrefix(raw).match(FAIL_LINE_RE);
    if (match) files.push(match[1]);
  }
  return [...new Set(files)];
}

function firstErrorLines(text, limit = 5) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && ERROR_LINE_RE.test(l))
    .slice(0, limit);
}

export function classify(failedStepName, rawLog) {
  const step = failedStepName ?? '';
  const text = (rawLog ?? '').split('\n').map(stripLogPrefix).join('\n');

  // Class 1 — skills-lock drift: heal by reseeding the lockfile on the branch.
  if (step === SKILL_STEP && SKILL_DRIFT_RE.test(text)) {
    return { class: 'skills-lock-drift' };
  }

  // Class 2 — eval cache miss: needs live ANTHROPIC_API_KEY spend, never in CI.
  if (CACHED_ONLY_STEP_RE.test(step) && CACHE_MISS_RE.test(text)) {
    return {
      class: 'eval-cache-miss',
      missKey: text.match(CACHE_MISS_DETAIL_RE)?.[1] ?? null,
      evalName: text.match(EVAL_NAME_RE)?.[1] ?? null,
    };
  }

  // Class 3 — pglite timeout flake: rerun once. The file-confinement check is
  // what keeps a genuine timeout-shaped regression in a non-pglite file out
  // of the rerun path; an empty FAIL list (truncated log) also refuses.
  if (step === 'Test' && TIMEOUT_RE.test(text) && ONE_FILE_SUMMARY_RE.test(text)) {
    const failFiles = extractFailFiles(text);
    if (failFiles.length > 0 && failFiles.every((f) => PGLITE_FILE_RE.test(f))) {
      return { class: 'pglite-flake', failFiles };
    }
  }

  // Class 4 — everything else: escalate, never touch the branch.
  return {
    class: 'unknown',
    failedStep: step === '' ? null : step,
    firstErrorLines: firstErrorLines(text),
  };
}

// Derive the exact local re-record command for an eval cache miss from the
// worker package.json script entry: same runner, minus --cached-only, with
// --env-file so the live Anthropic key is loaded.
export function resolveEvalCommand(evalName, workerPkg) {
  const script = workerPkg?.scripts?.[evalName];
  if (!script) return null;
  return script.replace(/\s+--cached-only\b/, '').replace(/^node\s+/, 'node --env-file=.env ');
}
