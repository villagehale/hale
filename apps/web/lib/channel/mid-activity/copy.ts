/**
 * Parent-facing strings for the mid-activity ask (VIL-393).
 *
 * Design owns these. The lines below are placeholders and must not be sent.
 * `midActivityCopyMayLeave` rejects the marker, any unsubscribe or STOP wording,
 * and a body that does not end in exactly one next step.
 */

export const MID_ACTIVITY_ASK_TODO =
  'TODO-Design: how is this activity going? Next: one line is enough.';

export const MID_ACTIVITY_REPLY_TODO =
  'TODO-Design: I have that. Next: I will weigh it the next time I look.';

const OPT_OUT = /\bSTOP\b|unsubscribe|opt[- ]out/i;

/** The last sentence is the single next step, and it is the only one. */
export function replyEndsWithOneNextStep(text: string): boolean {
  const parts = text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length < 2) return false;
  const nextSteps = parts.filter((part) => part.startsWith('Next:'));
  const last = parts[parts.length - 1];
  return nextSteps.length === 1 && last !== undefined && last.startsWith('Next:');
}

/** True only for a locked line that can actually be sent. Placeholders stay. */
export function midActivityCopyMayLeave(text: string): boolean {
  if (text.includes('TODO-Design')) return false;
  if (OPT_OUT.test(text)) return false;
  return replyEndsWithOneNextStep(text);
}
