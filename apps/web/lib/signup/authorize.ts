import type { BusyInterval, SignupOffer, SignupSession, SignupStopReason } from './types';

const ENROLL_PHRASES = [
  'yes sign us up',
  'sign us up',
  'please sign us up',
  'yes please sign us up',
  'register us',
  'yes register us',
  'please register us',
  'enroll us',
  'enrol us',
  'yes enroll us',
  'yes enrol us',
] as const;

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

/** Closed vocabulary. A bare "yes" is not an authorization. */
export function isExplicitSignupUtterance(body: string): boolean {
  const normalized = normalizeUtterance(body);
  if ((ENROLL_PHRASES as readonly string[]).includes(normalized)) return true;
  return ENROLL_PHRASES.some((phrase) => normalized.startsWith(`${phrase} for `));
}

/**
 * The parent authorized this exact activity and one session, or they did not.
 *
 * A stated session wins. Otherwise exactly one open slot that fits the calendar
 * is the session. Two fits, a full slot, or a price they have not approved
 * stops the run before any browser opens.
 */
export function authorizeSignup(input: {
  utterance: string;
  offer: SignupOffer;
  busy: readonly BusyInterval[];
}): AuthorizationDecision {
  if (!isExplicitSignupUtterance(input.utterance)) {
    return { ok: false, reason: 'not_authorized' };
  }
  const stated = statedSession(input.utterance, input.offer.sessions);
  if (stated.kind === 'none') {
    return pickUnstated(input.offer, input.busy);
  }
  if (stated.kind === 'unknown') return { ok: false, reason: 'session_not_offered' };
  if (stated.kind === 'ambiguous') return { ok: false, reason: 'ambiguous_session' };
  return acceptSession(input.offer, stated.session);
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

function statedSession(
  utterance: string,
  sessions: readonly SignupSession[],
):
  | { kind: 'none' }
  | { kind: 'unknown' }
  | { kind: 'ambiguous' }
  | { kind: 'one'; session: SignupSession } {
  const normalized = normalizeUtterance(utterance);
  const phrase = ENROLL_PHRASES.find((candidate) => normalized.startsWith(`${candidate} for `));
  if (!phrase) return { kind: 'none' };
  const remainder = normalized.slice(`${phrase} for `.length).trim();
  if (!remainder) return { kind: 'unknown' };
  const matches = sessions.filter(
    (session) => normalizeUtterance(session.label) === remainder || session.id === remainder,
  );
  if (matches.length === 1) {
    const session = matches[0];
    return session ? { kind: 'one', session } : { kind: 'unknown' };
  }
  if (matches.length === 0) return { kind: 'unknown' };
  return { kind: 'ambiguous' };
}

export function normalizeUtterance(body: string): string {
  return body
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}
