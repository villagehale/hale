/**
 * VIL-220 · C1 — every line the router itself can send. Deterministic copy only: what
 * the coach says is C2's, what intake says is M2's, what a caregiver hears is M6's.
 *
 * Written to the F14 voice rules — three sentences at most, one idea, never a dead end,
 * and never a rendered piece of household detail. Every label below comes from
 * `actionTypeLabel`, which is derived from the action TYPE and never from its payload,
 * so a numbered list can name a teenager's drafted action without disclosing what it
 * says (rule #1).
 */

/**
 * VIL-504 · absolute-zero fixed parent copy. The router's failure line, spine-refusal
 * lines, approval/undo receipts, nothing-pending / out-of-range lines, the which-one
 * skeleton, the health-done ack and the name-capture ack were all deleted. Each of
 * those paths now sends nothing; anything a parent hears is written by the model per
 * send (or the turn is silent). OTP is the only fixed exception and lives elsewhere.
 */

/**
 * The graceful capability reply, verbatim from the F14 Conversation Design (§3,
 * "Unknown/out-of-scope"). It is what the coach STUB says for every turn until C2
 * (VIL-221) lands — an honest boundary rather than an invented answer.
 */
/** VIL-504 · Stub coach used to send this fixed out-of-scope line. Absolute-zero:
 * the stub now returns null (send nothing). Kept only so tests can assert the
 * stub no longer ships fixed copy. */
export function capabilityReply(): string {
  // VIL-504 · Must not be sent. Stub returns '' via capabilityStubRuntime.
  return '';
}
