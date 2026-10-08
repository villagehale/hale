/**
 * A held draft described as already done.
 *
 * "Moved" / "cancelled" / "done" / "that one went through" tell a parent the
 * calendar changed. It has not: they still have to confirm. "I went through the
 * week" is reading the schedule, not claiming the draft landed, so that shape
 * stays legal.
 */

const ALREADY_DONE =
  /\b(?:i (?:have )?(?:moved|cancelled|canceled)|all set|done|(?:that|it|this)(?: one)? went through)\b/i;

export function claimsDraftAlreadyHappened(reply) {
  return ALREADY_DONE.test(String(reply));
}
