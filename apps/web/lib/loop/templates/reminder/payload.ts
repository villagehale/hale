/**
 * VIL-223 · D1 — the reminder message contract carried on the A2 LoopMessage payload.
 *
 * A reminder is one offset's worth of a parent's due events: a single event for T-1h,
 * or the batched "tomorrow" set for T-24h (rule #4). The events carry only the fields
 * the copy needs; children ride alongside (id + DOB + gender) so the renderer can apply
 * the deterministic teen age gate + the child_name_level dial at render — the reminder
 * never leaks a name above the family's level, and a teen's event is always generic.
 */

export interface ReminderChild {
  id: string;
  name: string;
  dateOfBirth: string;
  gender: string | null;
}

export interface ReminderEventView {
  /** family_events id — the dedupe/ledger anchor, never rendered. */
  eventRef: string;
  title: string;
  /** Event start INSTANT (ISO); the family-local time label is derived with `timeZone`. */
  startsAt: string;
  childId: string | null;
  /** Health/sensitivity signal, when one exists. family_events carries none today, so
   * this defaults false and the teen age gate is the enforced privacy floor; the field
   * lets the copy genericize the moment a signal is wired (E3/executor). */
  sensitive?: boolean;
}

export interface ReminderPayload {
  offset: '-P1D' | '-PT1H';
  /** The family IANA timezone — the event time labels ("10:00") are family-local. */
  timeZone: string;
  events: ReminderEventView[];
  children: ReminderChild[];
  /** The /plan deep link for T-24h; NULL for T-1h (rule #6 — no links, glanceable). */
  deepLink: string | null;
  /** CASL unsubscribe for the email leg; null only when email is not a target. */
  unsubscribeUrl: string | null;
  /**
   * VIL-229 voice slot — ONE LLM-composed human line for the message, composed at the
   * evening converge tick from the SAME redacted view the template renders (teen-gated,
   * sensitive-genericized, name-leveled), so the email shell renders it verbatim without
   * a second privacy gate. The email uses it as the serif signature line (single) or a
   * serif lead above the list (batch); facts (the time) stay slot-injected, never in the
   * voice string. Absent/null → the deterministic line is the fail-open fallback (rule
   * #8). Email-only; SMS/push keep their terse deterministic copy.
   */
  voice?: string | null;
}

function isReminderEventView(value: unknown): value is ReminderEventView {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.eventRef === 'string' &&
    typeof v.title === 'string' &&
    typeof v.startsAt === 'string' &&
    (v.childId === null || typeof v.childId === 'string')
  );
}

/** Narrow the A2 LoopMessage payload to a ReminderPayload, throwing on a malformed one
 * (a wiring bug — fail loud rather than render a broken reminder). */
export function asReminderPayload(payload: Record<string, unknown>): ReminderPayload {
  const offset = payload.offset;
  if (offset !== '-P1D' && offset !== '-PT1H') {
    throw new Error(`reminder payload: bad offset ${String(offset)}`);
  }
  if (typeof payload.timeZone !== 'string') throw new Error('reminder payload: missing timeZone');
  if (!Array.isArray(payload.events) || !payload.events.every(isReminderEventView)) {
    throw new Error('reminder payload: malformed events');
  }
  if (!Array.isArray(payload.children)) throw new Error('reminder payload: missing children');
  return payload as unknown as ReminderPayload;
}
