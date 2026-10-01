import type { SameActivityKind } from './match';
import {
  SAME_ACTIVITY_ASK_NEXT,
  SAME_ACTIVITY_ASK_TODO,
  SAME_ACTIVITY_DECLINE_NEXT,
  SAME_ACTIVITY_DECLINE_TODO,
  SAME_ACTIVITY_MUTUAL_JOIN_TODO,
  SAME_ACTIVITY_MUTUAL_MEET_TODO,
  SAME_ACTIVITY_MUTUAL_NEXT,
  SAME_ACTIVITY_WAITING_NEXT,
  SAME_ACTIVITY_WAITING_TODO,
} from './placeholders';

const BANNED_SEND = /reply stop|stop to opt out|\bunsubscribe\b/i;

/**
 * A line Hale may put on the wire. Nothing in this feature is locked, so this
 * is false for every string, including a sentence that merely looks finished.
 */
export function sameActivityCopyMayLeave(text: string): boolean {
  if (text.includes('TODO-Design')) return false;
  if (BANNED_SEND.test(text)) return false;
  if (text.includes('\n')) return false;
  return false;
}

export interface SameActivityReply {
  text: string;
  mayLeave: false;
  nextStep: string;
}

function sealed(text: string, nextStep: string): SameActivityReply {
  if (!text.startsWith('TODO-Design:')) {
    throw new Error('same-activity copy is design-owned');
  }
  if (!text.endsWith(nextStep)) {
    throw new Error('same-activity copy must end on its next step');
  }
  return { text, mayLeave: false, nextStep };
}

/**
 * The parent-facing sentence for one state.
 *
 * No family id, name, activity key, or place is a parameter. A match can
 * exist in the caller and still cannot be interpolated here.
 */
export function renderSameActivityReply(
  status: 'not_opted_in' | 'unread' | 'waiting' | 'mutual' | 'declined',
  kind: SameActivityKind | null,
): SameActivityReply {
  if (status === 'declined') return sealed(SAME_ACTIVITY_DECLINE_TODO, SAME_ACTIVITY_DECLINE_NEXT);
  if (status === 'waiting') return sealed(SAME_ACTIVITY_WAITING_TODO, SAME_ACTIVITY_WAITING_NEXT);
  if (status === 'mutual' && kind === 'join_group') {
    return sealed(SAME_ACTIVITY_MUTUAL_JOIN_TODO, SAME_ACTIVITY_MUTUAL_NEXT);
  }
  if (status === 'mutual' && kind === 'meet') {
    return sealed(SAME_ACTIVITY_MUTUAL_MEET_TODO, SAME_ACTIVITY_MUTUAL_NEXT);
  }
  return sealed(SAME_ACTIVITY_ASK_TODO, SAME_ACTIVITY_ASK_NEXT);
}

/**
 * Nothing leaves. Copy is still a placeholder, and there is no transport to
 * withhold — the skip is the whole result (rule #11).
 */
export function deliverSameActivityReply(_text: string): {
  sent: false;
  skipped: 'placeholder';
} {
  return { sent: false, skipped: 'placeholder' };
}
