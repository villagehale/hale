/**
 * VIL-631 — three subject draws on judge-graded coach suites, with the 2-of-3 /
 * any-fail-safety bar in n-of-m.mjs.
 *
 * Off unless COACH_EVAL_N_OF_M_ENABLED is exactly `true`. A trailing newline from
 * `vercel env add` stays off. Unset stays off. Dark, every suite keeps its historical
 * one-subject-draw recordings so `--cached-only` CI does not miss.
 */

export const COACH_EVAL_N_OF_M_ENABLED_ENV = 'COACH_EVAL_N_OF_M_ENABLED';

export function coachEvalNOfMEnabled(env = process.env) {
  return env[COACH_EVAL_N_OF_M_ENABLED_ENV] === 'true';
}
