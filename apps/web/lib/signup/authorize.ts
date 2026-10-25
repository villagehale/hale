import type { SignupConsentReading } from './consent-reader';
import type { BusyInterval, SignupOffer, SignupSession, SignupStopReason } from './types';

export interface AuthorizationOk {
  ok: true;
  activityKey: string;
  sessionId: string;
}

export interface AuthorizationStop {
  ok: false;
  reason: SignupStopReason;
}

export type AuthorizationDecision = AuthorizationOk | AuthorizationStop;

/**
 * The parent authorized this exact activity and one session, or they did not.
 *
 * The parent's consent comes from the model read, never a word list. A stated session wins. Otherwise exactly one open slot that fits the calendar
 * is the session. Two fits, a full slot, or a price they have not approved
 * stops the run before any browser opens.
 */
export function authorizeSignup(input: {
  /** The consent read (`consent-reader.ts`). Anything but `consent` is not an authorization. */
  reading: SignupConsentReading | null;
  offer: SignupOffer;
  busy: readonly BusyInterval[];
}): AuthorizationDecision {
  if (input.reading?.verdict !== 'consent') return { ok: false, reason: 'not_authorized' };
  const statedId = input.reading.sessionId;
  if (statedId === null) return pickUnstated(input.offer, input.busy);
  const stated = input.offer.sessions.find((session) => session.id === statedId);
  if (!stated) return { ok: false, reason: 'session_not_offered' };
  return acceptSession(input.offer, stated);
}

function pickUnstated(offer: SignupOffer, busy: readonly BusyInterval[]): AuthorizationDecision {
  const open = offer.sessions.filter((session) => !session.full);
  if (open.length === 0) return { ok: false, reason: 'session_full' };
  const fitting = open.filter((session) => fitsCalendar(session, busy));
  if (fitting.length !== 1) return { ok: false, reason: 'ambiguous_session' };
  const chosen = fitting[0];
  if (!chosen) return { ok: false, reason: 'ambiguous_session' };
  return acceptSession(offer, chosen);
}

function acceptSession(offer: SignupOffer, session: SignupSession): AuthorizationDecision {
  if (session.full) return { ok: false, reason: 'session_full' };
  if (!priceApproved(offer.approvedPriceCents, session.priceCents)) {
    return { ok: false, reason: 'price_not_approved' };
  }
  return { ok: true, activityKey: offer.activityKey, sessionId: session.id };
}

function priceApproved(approved: number | null, asked: number | null): boolean {
  if (asked === null || asked === 0) return true;
  return approved === asked;
}

function fitsCalendar(session: SignupSession, busy: readonly BusyInterval[]): boolean {
  const start = Date.parse(session.startsAt);
  const end = Date.parse(session.endsAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return false;
  return busy.every((block) => {
    const blockStart = Date.parse(block.startsAt);
    const blockEnd = Date.parse(block.endsAt);
    if (Number.isNaN(blockStart) || Number.isNaN(blockEnd)) return true;
    return start >= blockEnd || end <= blockStart;
  });
}
