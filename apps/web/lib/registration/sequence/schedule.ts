import { addDaysToKey, dayKeyIn } from '~/lib/plan/spine';

/**
 * VIL-242 · M7 — the registration sequence's pure scheduling core. No DB, no LLM, no
 * `new Date()` of its own: `now` and a live state snapshot are passed in, so every
 * timing rule is deterministic under an injected clock.
 *
 * THE ONE PRIMITIVE: a leg is an INTERVAL, not an instant. D1's reminder engine fires
 * on an instant plus a fixed miss-grace, which is right for an event reminder — it has
 * a materialized ledger to converge and a batch to merge. This ladder has neither, and
 * an interval buys three properties a grace cannot:
 *
 *   1. SELF-HEALING. A dropped cron tick, or a family matched three days before the
 *      open rather than ten, still gets the heads-up: the interval has not closed.
 *   2. QUIET-HOURS DEFERRAL FOR FREE. A leg held at 04:00 is simply retried at the next
 *      tick and lands at 08:00. With a grace it would expire unsent, which for a
 *      waitlist guard means a family loses a spot because Hale was being polite.
 *   3. AN HONEST CEILING. `until` is where the message stops being TRUE. The go leg's
 *      is the open instant itself — "your link, it opens at 6:30" sent at 6:31 is a
 *      lie, and no grace period should be able to produce one.
 *
 * The intervals are contiguous and disjoint by construction (each leg's `until` IS the
 * next leg's `from`), so at most one leg is ever due and there is no priority order to
 * get wrong. Idempotency is NOT this file's job: the caller dedupes on
 * (family, window, leg) at the ledger, exactly as M4 does.
 */

export type SequenceLeg =
  | 'heads_up'
  | 'battle_plan'
  | 'go'
  | 'check_in'
  | 'waitlist_half'
  | 'waitlist_final';

/** How far ahead the heads-up leg opens. Matches M4's registration horizon: a date a
 * week out arrives while it still matters and does not need repeating. */
export const HEADS_UP_LEAD_DAYS = 7;

/** The family-local hour the heads-up may first land in. The same mid-morning slot
 * M4's nudge uses (NUDGE_SEND_HOUR_LOCAL) — Hale's unprompted messages should not
 * arrive at three different times of day depending on which surface produced them. */
export const HEADS_UP_MINUTE_LOCAL = 10 * 60;

/** The family-local evening the battle plan may first land in. The evening before is
 * when a parent can actually act on it — bookmark the link, set an alarm, agree who
 * is on the laptop. D1 puts its evening-before reminder in the same slot. */
export const BATTLE_PLAN_MINUTE_LOCAL = 19 * 60;

/** How close to the open the go leg fires. */
export const GO_LEAD_MINUTES = 15;

/** How long after the open Hale asks how it went. Long enough that the queue has
 * cleared and the parent knows the answer; short enough to still be the same morning. */
export const CHECK_IN_LEAD_HOURS = 4;

/** How long the check-in question stays open — both for asking and for hearing an
 * answer. Past this the conversation has moved on and an unprompted "so did you get
 * in?" is Hale nagging about something the family has already lived through. */
export const CHECK_IN_REPLY_WINDOW_HOURS = 72;

/** How long before a waitlist offer expires the last guard fires. Two hours is enough
 * to answer an email and not so early that it is the same message as the half-life. */
export const WAITLIST_FINAL_LEAD_HOURS = 2;

export interface LegWindow {
  /** The first instant this leg may fire. */
  from: Date;
  /** The first instant it may NOT — where the message stops being true. */
  until: Date;
}

export type OpenLegWindows = Record<'heads_up' | 'battle_plan' | 'go' | 'check_in', LegWindow>;
export type WaitlistLegWindows = {
  /** Null when the response window is too short for two distinct guards. */
  waitlist_half: LegWindow | null;
  waitlist_final: LegWindow;
};

/** Whether the parent approved the shortlist Hale drafted for this window. Derived
 * LIVE from the actions row every tick (see run.ts) rather than mirrored onto the
 * sequence, so the approval spine stays the single source of truth for consent. */
export type SequenceOptIn = 'pending' | 'opted_in' | 'declined' | 'missing';

export type RegistrationOutcome = 'registered' | 'waitlisted' | 'missed';

export interface SequenceState {
  /** When THIS family can first register (the resident date where they have one). */
  openAt: Date;
  timeZone: string;
  optIn: SequenceOptIn;
  outcome: RegistrationOutcome | null;
  /** When the parent TOLD us they were waitlisted — not when the municipality made
   * the offer, which Hale has no way to know. The clock is honest about its own
   * starting point, and the copy says so. */
  waitlistStartedAt: Date | null;
  /** The municipality's published response window (Toronto 36h, Markham 48h), or
   * null where none is published and no clock may be claimed. */
  waitlistResponseHours: number | null;
}

/** The zone's UTC offset (ms) at `instant` — the machine's own zone cancels out of the
 * rendered-string difference. Mirrors D1's helper (lib/loop/reminders/schedule.ts):
 * a tiny pure calculation, duplicated rather than reached across domains for. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const inZone = new Date(instant.toLocaleString('en-US', { timeZone }));
  const inUtc = new Date(instant.toLocaleString('en-US', { timeZone: 'UTC' }));
  return inUtc.getTime() - inZone.getTime();
}

/** The UTC instant of `dayKey` at `minuteOfDay` family-local. The offset is measured at
 * the target WALL time rather than at local midnight, so a slot on a DST-transition day
 * lands on the correct side of the change — both of these slots are well clear of the
 * 02:00 gap itself. */
function zonedInstant(dayKey: string, minuteOfDay: number, timeZone: string): Date {
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');
  const guess = new Date(`${dayKey}T${hh}:${mm}:00Z`);
  return new Date(guess.getTime() + tzOffsetMs(guess, timeZone));
}

/**
 * The four pre- and post-open legs, as contiguous intervals in the family's own zone.
 *
 * The slots are anchored on the open's LOCAL DAY, never on `openAt` minus a fixed
 * number of milliseconds: seven days before a 6:30 a.m. open is 6:30 a.m., which is
 * inside quiet hours and would be held until the interval had almost run out — and one
 * day before is 6:30 a.m. too, which is nobody's idea of when to read a battle plan.
 */
export function openLegWindows(openAt: Date, timeZone: string): OpenLegWindows {
  const openDay = dayKeyIn(openAt, timeZone);
  const headsUpFrom = zonedInstant(
    addDaysToKey(openDay, -HEADS_UP_LEAD_DAYS),
    HEADS_UP_MINUTE_LOCAL,
    timeZone,
  );
  const battlePlanFrom = zonedInstant(
    addDaysToKey(openDay, -1),
    BATTLE_PLAN_MINUTE_LOCAL,
    timeZone,
  );
  const goFrom = new Date(openAt.getTime() - GO_LEAD_MINUTES * 60_000);
  const checkInFrom = new Date(openAt.getTime() + CHECK_IN_LEAD_HOURS * 3_600_000);
  return {
    heads_up: { from: headsUpFrom, until: battlePlanFrom },
    battle_plan: { from: battlePlanFrom, until: goFrom },
    go: { from: goFrom, until: openAt },
    check_in: {
      from: checkInFrom,
      until: new Date(checkInFrom.getTime() + CHECK_IN_REPLY_WINDOW_HOURS * 3_600_000),
    },
  };
}

/** When a waitlist offer reported at `startedAt` runs out, or null where the
 * municipality publishes no response window and Hale may not invent one. */
export function waitlistDeadline(startedAt: Date, responseHours: number | null): Date | null {
  if (responseHours === null) return null;
  return new Date(startedAt.getTime() + responseHours * 3_600_000);
}

/**
 * The two waitlist guards. The final one is anchored to the DEADLINE (two hours before
 * it) rather than to the start, because what matters is how long the family has left,
 * not how long they have had. The half-life guard is dropped where it would land after
 * the final one — a response window short enough for that is short enough for one
 * message.
 */
export function waitlistLegWindows(
  startedAt: Date,
  responseHours: number | null,
): WaitlistLegWindows | null {
  const deadline = waitlistDeadline(startedAt, responseHours);
  if (deadline === null) return null;
  const finalFrom = new Date(deadline.getTime() - WAITLIST_FINAL_LEAD_HOURS * 3_600_000);
  const halfFrom = new Date(startedAt.getTime() + (deadline.getTime() - startedAt.getTime()) / 2);
  return {
    waitlist_half:
      halfFrom.getTime() < finalFrom.getTime()
        ? { from: halfFrom, until: finalFrom }
        : null,
    waitlist_final: { from: finalFrom, until: deadline },
  };
}

function inWindow(window: LegWindow, now: Date): boolean {
  return now.getTime() >= window.from.getTime() && now.getTime() < window.until.getTime();
}

function dueWaitlistLeg(state: SequenceState, now: Date): SequenceLeg | null {
  if (state.waitlistStartedAt === null) return null;
  const windows = waitlistLegWindows(state.waitlistStartedAt, state.waitlistResponseHours);
  if (!windows) return null;
  if (windows.waitlist_half && inWindow(windows.waitlist_half, now)) return 'waitlist_half';
  if (inWindow(windows.waitlist_final, now)) return 'waitlist_final';
  return null;
}

/**
 * The ONE leg due for this sequence right now, or nothing.
 *
 * Opt-in is a gate, not a filter, and it splits the ladder in a deliberate place. The
 * heads-up carries exactly the news M4's registration nudge would have carried, and the
 * sequence took that job over the moment it claimed the window — so withholding it from
 * a parent who has not yet opened their approvals queue would mean the claim SILENCED
 * the family rather than serving them. Everything after it presumes a yes: a battle
 * plan for a window nobody wants is noise, and the quiet-hours exemption those legs
 * carry is only defensible because the parent asked for them.
 */
export function dueLeg(state: SequenceState, now: Date): SequenceLeg | null {
  if (state.outcome === 'waitlisted') return dueWaitlistLeg(state, now);
  // Registered or missed: the window is finished and there is nothing left to say.
  if (state.outcome !== null) return null;
  if (state.optIn === 'declined' || state.optIn === 'missing') return null;

  const windows = openLegWindows(state.openAt, state.timeZone);
  for (const leg of ['heads_up', 'battle_plan', 'go', 'check_in'] as const) {
    if (!inWindow(windows[leg], now)) continue;
    if (leg === 'heads_up') return leg;
    return state.optIn === 'opted_in' ? leg : null;
  }
  return null;
}

/**
 * Whether a leg may cross the outbound gate's quiet hours.
 *
 * Only the two legs a parent explicitly signed up for, and only because they are
 * WORTHLESS late: a battle plan that waits until 08:00 arrives after a 06:30 open, and
 * a go leg that waits at all never fires. The check-in and both waitlist guards have
 * hours of slack, so they defer politely like everything else.
 */
export function legIsUrgent(leg: SequenceLeg): boolean {
  return leg === 'battle_plan' || leg === 'go';
}

/**
 * Whether an inbound message from this family should be read as an answer to the
 * check-in. Derived from the open instant rather than from a stored "we asked at…"
 * stamp: a parent who got in at 6:31 says so at 6:31, and a Hale that would not hear
 * that until it had asked its own question four hours later is not listening.
 */
export function awaitingOutcome(state: SequenceState, now: Date): boolean {
  if (state.outcome !== null || state.optIn !== 'opted_in') return false;
  const { check_in } = openLegWindows(state.openAt, state.timeZone);
  return now.getTime() >= state.openAt.getTime() && now.getTime() < check_in.until.getTime();
}
