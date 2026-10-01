/**
 * Parent-facing sentences for a partnership booking are Design's.
 *
 * TODO-Design: do not send these placeholders. They are not parent-facing
 * copy. The runner keeps the locked completed line and the locked
 * connector_failed line. Nothing here may be interpolated into a reply,
 * a handoff, or a co-parent group message.
 */
export const PARTNERSHIP_BOOKED_LINE_TODO =
  'TODO-Design: the sentence that says a partnership booking finished is unlocked and must not be sent.';

export const PARTNERSHIP_FAILED_LINE_TODO =
  'TODO-Design: the sentence that says a partnership booking did not finish is unlocked and must not be sent.';
