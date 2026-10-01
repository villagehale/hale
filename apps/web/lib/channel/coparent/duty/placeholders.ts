/**
 * TODO-Design — not locked. These must not leave. `dutyCopyMayLeave` rejects
 * the marker, and no sender is wired while it remains. Listed for Design in
 * the VIL-383 PR. No counts, no event titles, no STOP wording.
 *
 * Kept out of copy.ts so the locked templates stay the only parent-facing
 * sentences in that file.
 */
export const DUTY_UNDO_TEXT_TODO = 'TODO-Design: Done. Say so here if that is wrong.';
export const DUTY_BURDEN_ANSWER_TODO =
  'TODO-Design: I can answer that in words once this line is locked. Want me to keep the counts internal?';
export const DUTY_DEFAULT_OWNER_TODO =
  'TODO-Design: Want this as the usual plan? Say yes or no.';
export const DUTY_LOPSIDED_CONSENT_TODO =
  'TODO-Design: Want me to keep an eye on keeping things balanced? Say yes or no.';
export const DUTY_LOPSIDED_NUDGE_TODO = 'TODO-Design: Want the open one? Say yes or no.';

export const DUTY_PLACEHOLDER_COPY = [
  DUTY_UNDO_TEXT_TODO,
  DUTY_BURDEN_ANSWER_TODO,
  DUTY_DEFAULT_OWNER_TODO,
  DUTY_LOPSIDED_CONSENT_TODO,
  DUTY_LOPSIDED_NUDGE_TODO,
] as const;
