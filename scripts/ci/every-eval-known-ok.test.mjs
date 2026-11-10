import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  KNOWN_OK_PATH,
  classifySuite,
  jobFails,
  loadKnownOk,
  parseKnownOk,
} from './every-eval-known-ok.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVAL_RUNNERS = readdirSync(join(REPO_ROOT, 'apps', 'worker', 'evals')).filter((name) =>
  /^run-.*\.mjs$/.test(name),
);

describe('every-eval known-ok list', () => {
  const known = loadKnownOk();

  it('names committed run-*.mjs files only', () => {
    const runners = new Set(EVAL_RUNNERS.map((name) => name.replace(/\.mjs$/, '')));
    expect([...known].every((name) => runners.has(name))).toBe(true);
  });

  it('ignores comments and blanks', () => {
    expect(parseKnownOk('# skip\n\nrun-signup-outcome-reply-eval\n')).toEqual([
      'run-signup-outcome-reply-eval',
    ]);
  });

  it('loads the committed list from disk', () => {
    expect(KNOWN_OK_PATH.endsWith('every-eval-known-ok.txt')).toBe(true);
    expect(known.has('run-signup-outcome-reply-eval')).toBe(true);
    expect(known.has('run-registration-note-eval')).toBe(true);
  });
});

describe('classifySuite', () => {
  const known = new Set(['run-signup-outcome-reply-eval']);

  it('passes an unlisted suite that passed', () => {
    expect(classifySuite({ name: 'run-eval', passed: true, allowKnown: true, known })).toBe('pass');
  });

  it('fails an unlisted suite that failed, even when known-ok is on', () => {
    expect(classifySuite({ name: 'run-eval', passed: false, allowKnown: true, known })).toBe(
      'fail',
    );
  });

  it('marks a listed failure as known only when known-ok is on', () => {
    expect(
      classifySuite({
        name: 'run-signup-outcome-reply-eval',
        passed: false,
        allowKnown: true,
        known,
      }),
    ).toBe('known');
    expect(
      classifySuite({
        name: 'run-signup-outcome-reply-eval',
        passed: false,
        allowKnown: false,
        known,
      }),
    ).toBe('fail');
  });

  it('flags a listed suite that now passes so the allowlist can shrink', () => {
    expect(
      classifySuite({
        name: 'run-signup-outcome-reply-eval',
        passed: true,
        allowKnown: true,
        known,
      }),
    ).toBe('pass-stale');
  });

  it('fails the job only on unexpected fails', () => {
    expect(jobFails(['pass', 'known', 'pass-stale'])).toBe(false);
    expect(jobFails(['pass', 'fail'])).toBe(true);
  });
});

describe('run-every-eval.sh', () => {
  const script = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'run-every-eval.sh'),
    'utf8',
  );

  it('replays cached-only and unsets live credentials before any suite', () => {
    expect(script).toMatch(
      /unset ANTHROPIC_API_KEY AI_GATEWAY_API_KEY VERCEL_KEY JEV_KEY OPENAI_API_KEY/,
    );
    expect(script).toMatch(/node "\$f" --cached-only/);
    expect(script).not.toMatch(/--live/);
  });
});
