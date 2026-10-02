/**
 * TODO-Design — not locked. These must not leave. `sameActivityCopyMayLeave`
 * rejects the marker, and `deliverSameActivityReply` has no transport.
 *
 * No other household, no child, no place, no count, no STOP wording. Each
 * line ends with one next step the parent can take.
 */
export const SAME_ACTIVITY_ASK_NEXT = 'Say meet, join, or no.';
export const SAME_ACTIVITY_WAITING_NEXT = 'Say no here if you change your mind.';
export const SAME_ACTIVITY_MUTUAL_NEXT = 'Say what you want to do next.';
export const SAME_ACTIVITY_DECLINE_NEXT = 'Say so here if you want that changed.';

export const SAME_ACTIVITY_ASK_TODO =
  'TODO-Design: the sentence that offers a meet or a group is unlocked and must not be sent. Say meet, join, or no.';
export const SAME_ACTIVITY_WAITING_TODO =
  'TODO-Design: noted, and nothing about another household is shared yet. Say no here if you change your mind.';
export const SAME_ACTIVITY_MUTUAL_MEET_TODO =
  'TODO-Design: both households opted in and the meet line is unlocked and must not be sent. Say what you want to do next.';
export const SAME_ACTIVITY_MUTUAL_JOIN_TODO =
  'TODO-Design: both households opted in and the group line is unlocked and must not be sent. Say what you want to do next.';
export const SAME_ACTIVITY_DECLINE_TODO =
  'TODO-Design: done for this activity. Say so here if you want that changed.';

export const SAME_ACTIVITY_PLACEHOLDER_COPY = [
  SAME_ACTIVITY_ASK_TODO,
  SAME_ACTIVITY_WAITING_TODO,
  SAME_ACTIVITY_MUTUAL_MEET_TODO,
  SAME_ACTIVITY_MUTUAL_JOIN_TODO,
  SAME_ACTIVITY_DECLINE_TODO,
] as const;
