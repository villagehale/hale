import type { ShareLinkKind } from './api-types';

/**
 * Framework-free display logic for the Settings "Privacy & data" section, so the
 * confirm state machine, the shared-link row label, and the deletion-date copy are
 * unit-tested without a native runtime. No RN imports — the screen renders the
 * strings this module returns.
 */

/** The delete-account confirm states, mirroring the web DeleteAccountButton: an
 * idle link, a revealed confirm step, the in-flight post, the scheduled success,
 * and a retryable error. A deletion is only ever scheduled from an explicit
 * confirm — never a single tap (rule #4: no autonomous destructive action). */
export type DeleteState = 'idle' | 'confirming' | 'pending' | 'scheduled' | 'error';

/**
 * The next delete state for an event. Encodes the two-step gate: 'idle' only ever
 * advances to 'confirming' (the first tap reveals the real scope, it never posts);
 * only an explicit 'confirm' from 'confirming' starts the post. 'cancel' from any
 * pre-success state returns to idle. From a terminal 'scheduled' nothing moves.
 */
export function nextDeleteState(
  state: DeleteState,
  event: 'start' | 'confirm' | 'cancel' | 'success' | 'failure',
): DeleteState {
  if (state === 'scheduled') return 'scheduled';
  switch (event) {
    case 'start':
      return state === 'idle' ? 'confirming' : state;
    case 'confirm':
      return state === 'confirming' || state === 'error' ? 'pending' : state;
    case 'cancel':
      return 'idle';
    case 'success':
      return state === 'pending' ? 'scheduled' : state;
    case 'failure':
      return state === 'pending' ? 'error' : state;
  }
}

const SHARE_KIND_LABEL: Record<ShareLinkKind, string> = {
  week_plan: 'This week with Hale',
  activity: 'A local pick',
};

/** The eyebrow label for a shared-link row — the human name for the link's kind
 * (never the raw table/enum). Matches the web SharedLinks KIND_LABEL. */
export function shareLinkLabel(kind: ShareLinkKind): string {
  return SHARE_KIND_LABEL[kind];
}

/**
 * The one-line success copy after a deletion is scheduled: the effective date in
 * long form, plus the honest "you can still cancel" note. Falls back to a
 * date-less line when the instant is missing/unparseable, so the parent is never
 * shown "Invalid Date". Mirrors the web DeleteAccountButton scheduled copy.
 */
export function scheduledDeletionCopy(scheduledDeletionAt: string | null): string {
  const suffix = 'Contact us before then to cancel.';
  if (!scheduledDeletionAt) {
    return 'Deletion scheduled. Contact us before it completes to cancel.';
  }
  const when = new Date(scheduledDeletionAt);
  if (Number.isNaN(when.getTime())) {
    return 'Deletion scheduled. Contact us before it completes to cancel.';
  }
  const formatted = when.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  return `Deletion scheduled for ${formatted}. ${suffix}`;
}
