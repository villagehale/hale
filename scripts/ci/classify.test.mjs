import { describe, expect, it } from 'vitest';
import { classify, extractFailFiles, resolveEvalCommand, stripLogPrefix } from './classify.mjs';

// Real signatures quoted from failed CI runs the week of 2026-08-24 (run ids in comments).
const GH = 'Lint, typecheck, test, build\tUNKNOWN STEP\t2026-08-26T14:03:11.5820000Z ';
const prefixed = (lines) => lines.map((l) => `${GH}${l}`).join('\n');

// Run 33231040640 — packages/agent/scripts/check-skills.mjs check()
const SKILLS_DRIFT_LOG = prefixed([
  '##[group]Run pnpm --filter @hale/agent skills:check',
  'Skill prompt drift detected (edit deliberately, then `pnpm --filter @hale/agent skills:seed` and commit the lockfile):',
  '  - intake-answer.md: sha256 01414c38b832… != lockfile 8f1202fff7a1…',
  '##[error]Process completed with exit code 1.',
]);

const SKILLS_LOCK_MISSING_LOG = prefixed([
  '##[group]Run pnpm --filter @hale/agent skills:check',
  'No skills/.skills-lock.json found. Run `pnpm skills:seed` to create it from disk.',
  '##[error]Process completed with exit code 1.',
]);

// Run 33226992535 — apps/worker/evals/run-memory-writeback-eval.mjs:120
const CACHE_MISS_KEY_ONLY_LOG = prefixed([
  '##[group]Run pnpm --filter @hale/worker eval:memory-writeback',
  'cache miss in --cached-only mode (key f2766b0d1c38e815…). Request written to /home/runner/work/hale/hale/apps/worker/evals/cache/MISS.json. Re-run live (node --env-file=.env ...) to populate, then commit the cache.',
  '##[error]Process completed with exit code 1.',
]);

// Run 33232269412 — apps/worker/evals/lib/harness.mjs:173
const CACHE_MISS_FIXTURE_LOG = prefixed([
  '##[group]Run pnpm --filter @hale/worker eval:intake-answer',
  'cache miss in --cached-only mode (intake-answer:eye-exam, key 9904e32a117c9f5f…). Re-run live (with --env-file) to populate, then commit the cache.',
  '##[error]Process completed with exit code 1.',
]);

// Runs 33004370815 / 33002295101 — pglite journey beforeEach hook timeout
const PGLITE_HOOK_TIMEOUT_LOG = prefixed([
  'FAIL  lib/__journey__/deep-answer-at-question-time.test.ts > deep answer at question time > answers from stored facts',
  'Error: Hook timed out in 10000ms.',
  'If this is a long-running hook, pass a timeout value as the last argument or configure it globally with "hookTimeout".',
  ' ❯ lib/__journey__/deep-answer-at-question-time.test.ts:94:3',
  'Test Files  1 failed | 552 passed (553)',
]);

const PGLITE_TEST_TIMEOUT_LOG = prefixed([
  'FAIL  lib/testing/pglite.test.ts > pglite snapshot > clones per worker',
  'Error: Test timed out in 5000ms.',
  'Test Files  1 failed | 610 passed (611)',
]);

// Run 33404801929 shape — timeout wording present but the failure is a real
// regression in a non-pglite file; must NOT be rerun.
const REAL_FAILURE_WITH_TIMEOUT_LOG = prefixed([
  'FAIL  lib/coach/guarded-tools.test.ts > guarded tools > rejects an unknown tool',
  'Error: Test timed out in 5000ms.',
  'Test Files  1 failed | 552 passed (553)',
]);

// Runs 33097574544 / 33041930922 / 33041796847 — typecheck failures
const TYPECHECK_LOG = prefixed([
  '##[group]Run pnpm typecheck',
  "apps/web/lib/coach/guarded-tools.ts(42,7): error TS2345: Argument of type 'string' is not assignable.",
  '##[error]Process completed with exit code 1.',
]);

describe('classify — skills-lock drift (class 1)', () => {
  it('classifies the drift message on the Skill lockfile check step', () => {
    expect(classify('Skill lockfile check', SKILLS_DRIFT_LOG).class).toBe('skills-lock-drift');
  });

  it('classifies the missing-lockfile variant', () => {
    expect(classify('Skill lockfile check', SKILLS_LOCK_MISSING_LOG).class).toBe('skills-lock-drift');
  });

  it('requires the Skill lockfile check step name, not just the message', () => {
    expect(classify('Test', SKILLS_DRIFT_LOG).class).toBe('unknown');
  });
});

describe('classify — eval cache miss (class 2)', () => {
  it('classifies the key-only variant and extracts key + eval name', () => {
    const result = classify('Memory writeback eval (cached-only)', CACHE_MISS_KEY_ONLY_LOG);
    expect(result.class).toBe('eval-cache-miss');
    expect(result.missKey).toBe('key f2766b0d1c38e815…');
    expect(result.evalName).toBe('eval:memory-writeback');
  });

  it('classifies the fixture-prefixed variant and extracts key + eval name', () => {
    const result = classify('Mid-signup answer composer eval (cached-only)', CACHE_MISS_FIXTURE_LOG);
    expect(result.class).toBe('eval-cache-miss');
    expect(result.missKey).toBe('intake-answer:eye-exam, key 9904e32a117c9f5f…');
    expect(result.evalName).toBe('eval:intake-answer');
  });

  it('requires a (cached-only) step name, not just the message', () => {
    expect(classify('Test', CACHE_MISS_KEY_ONLY_LOG).class).toBe('unknown');
  });
});

describe('classify — pglite timeout flake (class 3)', () => {
  it('classifies a hook timeout confined to a journey test file', () => {
    const result = classify('Test', PGLITE_HOOK_TIMEOUT_LOG);
    expect(result.class).toBe('pglite-flake');
    expect(result.failFiles).toEqual(['lib/__journey__/deep-answer-at-question-time.test.ts']);
  });

  it('classifies a test timeout confined to a .pglite.test.ts file', () => {
    expect(classify('Test', PGLITE_TEST_TIMEOUT_LOG).class).toBe('pglite-flake');
  });

  it('refuses when the failing file is outside the pglite confinement set', () => {
    expect(classify('Test', REAL_FAILURE_WITH_TIMEOUT_LOG).class).toBe('unknown');
  });

  it('refuses when more than one test file failed', () => {
    const log = prefixed([
      'FAIL  lib/__journey__/deep-answer-at-question-time.test.ts > journey',
      'FAIL  lib/testing/pglite.test.ts > snapshot',
      'Error: Hook timed out in 10000ms.',
      'Test Files  2 failed | 550 passed (552)',
    ]);
    expect(classify('Test', log).class).toBe('unknown');
  });

  it('refuses when no FAIL file lines are present (truncated log)', () => {
    const log = prefixed(['Error: Hook timed out in 10000ms.', 'Test Files  1 failed | 552 passed (553)']);
    expect(classify('Test', log).class).toBe('unknown');
  });
});

describe('classify — unknown (class 4)', () => {
  it('classifies a typecheck failure with the failing step and first error line', () => {
    const result = classify('Typecheck', TYPECHECK_LOG);
    expect(result.class).toBe('unknown');
    expect(result.failedStep).toBe('Typecheck');
    expect(result.firstErrorLines[0]).toContain('error TS2345');
  });

  it('returns unknown for an empty log and null step', () => {
    const result = classify(null, '');
    expect(result.class).toBe('unknown');
    expect(result.failedStep).toBeNull();
  });
});

describe('classify — multi-match precedence (1 → 2 → 3 → 4)', () => {
  it('prefers skills-lock drift over cache miss when both messages appear', () => {
    const log = `${SKILLS_DRIFT_LOG}\n${CACHE_MISS_KEY_ONLY_LOG}`;
    expect(classify('Skill lockfile check', log).class).toBe('skills-lock-drift');
  });

  it('prefers cache miss over pglite flake when both signatures appear', () => {
    const log = `${CACHE_MISS_KEY_ONLY_LOG}\n${PGLITE_HOOK_TIMEOUT_LOG}`;
    expect(classify('Memory writeback eval (cached-only)', log).class).toBe('eval-cache-miss');
  });
});

describe('stripLogPrefix', () => {
  it('strips the gh job/step/timestamp prefix', () => {
    expect(stripLogPrefix(`${GH}Error: Hook timed out in 10000ms.`)).toBe('Error: Hook timed out in 10000ms.');
  });

  it('leaves unprefixed lines alone', () => {
    expect(stripLogPrefix('plain line')).toBe('plain line');
  });
});

describe('extractFailFiles', () => {
  it('extracts the file path token after each FAIL marker', () => {
    expect(extractFailFiles(PGLITE_HOOK_TIMEOUT_LOG)).toEqual(['lib/__journey__/deep-answer-at-question-time.test.ts']);
  });

  it('ignores lowercase failed-summary lines', () => {
    expect(extractFailFiles(prefixed(['Test Files  1 failed | 552 passed (553)']))).toEqual([]);
  });
});

describe('resolveEvalCommand', () => {
  const workerPkg = {
    scripts: {
      'eval:memory-writeback': 'node evals/run-memory-writeback-eval.mjs --cached-only',
      'eval:week-summary': 'node evals/run-agent-eval.mjs --cached-only --suite=week-summary',
    },
  };

  it('rewrites a cached-only runner into the live re-record command', () => {
    expect(resolveEvalCommand('eval:memory-writeback', workerPkg)).toBe(
      'node --env-file=.env evals/run-memory-writeback-eval.mjs',
    );
  });

  it('keeps extra flags like --suite while dropping --cached-only', () => {
    expect(resolveEvalCommand('eval:week-summary', workerPkg)).toBe(
      'node --env-file=.env evals/run-agent-eval.mjs --suite=week-summary',
    );
  });

  it('returns null for an eval name with no script entry', () => {
    expect(resolveEvalCommand('eval:nonexistent', workerPkg)).toBeNull();
  });
});
