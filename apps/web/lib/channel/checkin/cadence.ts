import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';

/**
 * VIL-353 · THE CLOCK behind the evening check-in.
 *
 * Everything in this file is either a pure function of the family's stored state or a
 * single-row read/write of it. The sweep that sends and the handler that reads a reply
 * both need it, and neither should have to import the other's transport to get it.
 */

/**
 * The local hour the question may land in, and the whole of the US-state clamp.
 *
 * The founder's word is "9pm". The floor under every unprompted message is 21:00 local
 * (PROACTIVE_QUIET_HOURS, outbound-gate.ts), and Florida and Oklahoma end the lawful
 * texting day at 20:00 with a $500-per-message private right of action — so 21:00 is the
 * one hour "9pm" cannot mean. The 20:00 hour is the closest honest slot, and THIS
 * CONSTANT IS THE CLAMP: nothing else in the product stops a send at 20:00, so removing
 * the slot filter would not merely retime the question, it would make it unlawful in two
 * states.
 *
 * It matches the whole HOUR, like the nudge's own slot, because the cron fires hourly —
 * an exact-minute match would silently drop every family whose tick landed a minute late.
 * The nudge cron runs at :17, so in practice the question lands about 20:17 local.
 */
export const EVENING_CHECK_IN_HOUR_LOCAL = 20;

/**
 * When an unanswered question stops standing: 08:00 the next local morning.
 *
 * The same hour the quiet window ends, deliberately. A parent who wakes up and texts
 * Hale is starting a new conversation, not finishing last night's, and reading their
 * first sentence of the day as a note about yesterday is the one way this feature could
 * put words in their mouth.
 */
export const CHECK_IN_LAPSE_HOUR_LOCAL = 8;

const DAY_MS = 24 * 3_600_000;

export type CheckInCadence = schema.FamilyCheckInPrefs['cadence'];

/** The family's check-in state, as stored — or the default for a family never asked. */
export interface CheckInState {
  cadence: CheckInCadence;
  silentStreak: number;
  lastAskedAt: Date | null;
  lastAnsweredAt: Date | null;
  /**
   * Left on the row for households the old silence ladder already stamped. Nothing in
   * this file writes it anymore. Old audit rows still parse; this column is not a clock.
   */
  silentStreakSince: Date | null;
}

export const DEFAULT_CHECK_IN_STATE: CheckInState = {
  cadence: 'daily',
  silentStreak: 0,
  lastAskedAt: null,
  lastAnsweredAt: null,
  silentStreakSince: null,
};

/** Why a family in the slot is not offered to the decider tonight. Enum, never free
 * text: it is counted in the cron summary and logged, so it has to be safe to emit
 * and stable to aggregate. */
export type CheckInSkipReason = 'cadence_off' | 'asked_today';

export type CheckInDecision =
  | { kind: 'skip'; reason: CheckInSkipReason }
  /** Offer an evening check-in to the proactive decider. The model chooses whether
   * and when, and writes the text. Silence does not change the cadence. */
  | { kind: 'ask' };

/** The family's local calendar day as 'YYYY-MM-DD'. */
export function localDateKey(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Whole local days from one instant to another, off the CALENDAR rather than the clock.
 *
 * A weekly rhythm measured in milliseconds is a rhythm that drifts: the hourly cron fires
 * at :17 give or take a few seconds, so an interval of exactly 7 × 24h lands a fraction
 * short about half the time and the question slips to the eighth day — and a spring
 * forward makes it certain. Days are what the promise was made in.
 */
export function localDaysBetween(from: Date, to: Date, timeZone: string): number {
  const start = Date.parse(`${localDateKey(from, timeZone)}T00:00:00Z`);
  const end = Date.parse(`${localDateKey(to, timeZone)}T00:00:00Z`);
  return Math.round((end - start) / DAY_MS);
}

/** The family's local hour (0-23). */
export function localHour(now: Date, timeZone: string): number {
  const hour = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(now);
  // en-CA with hour12:false renders local midnight as '24' — normalize to 0.
  return Number(hour) % 24;
}

/** Whether `now` sits in this family's evening slot. */
export function isEveningCheckInSlot(now: Date, timeZone: string): boolean {
  return localHour(now, timeZone) === EVENING_CHECK_IN_HOUR_LOCAL;
}

/**
 * Is the ask sent at `askedAt` still standing at `now`?
 *
 * Read off the local CALENDAR rather than by adding hours, so a spring-forward night
 * cannot shorten the window or an autumn one extend it: the question stands for the rest
 * of the local day it was asked on, plus the hours of the next local morning before
 * {@link CHECK_IN_LAPSE_HOUR_LOCAL}. The 24-hour bound is the backstop that keeps a
 * week-old ask from standing again on some later pre-dawn morning.
 */
export function askStillStanding(askedAt: Date, now: Date, timeZone: string): boolean {
  if (now.getTime() < askedAt.getTime()) return false;
  if (now.getTime() - askedAt.getTime() >= DAY_MS) return false;
  if (localDateKey(now, timeZone) === localDateKey(askedAt, timeZone)) return true;
  return localHour(now, timeZone) < CHECK_IN_LAPSE_HOUR_LOCAL;
}

/**
 * WHAT HAPPENS IN THIS FAMILY'S EVENING SLOT.
 *
 * A stored `off` is a stop this household already asked for, and it is the one cadence
 * the clock still honours: the decider is not offered a check-in to a household that
 * asked for none. Anything else — daily, weekly, a long silence — is an offer. Whether
 * it goes out, and when, is the proactive decider's call. There is no silence ladder
 * and no fixed interval.
 */
export function decideCheckIn(state: CheckInState, now: Date, timeZone: string): CheckInDecision {
  if (state.cadence === 'off') return { kind: 'skip', reason: 'cadence_off' };
  const { lastAskedAt } = state;
  if (lastAskedAt !== null && localDateKey(lastAskedAt, timeZone) === localDateKey(now, timeZone)) {
    return { kind: 'skip', reason: 'asked_today' };
  }
  return { kind: 'ask' };
}

// ── the stored row ───────────────────────────────────────────────────────────

/** This family's check-in state, or the default for one that has never been asked. */
export async function readCheckInState(
  database: Database,
  familyId: string,
): Promise<CheckInState> {
  const [row] = await database
    .select({
      cadence: schema.familyCheckInPrefs.cadence,
      silentStreak: schema.familyCheckInPrefs.silentStreak,
      lastAskedAt: schema.familyCheckInPrefs.lastAskedAt,
      lastAnsweredAt: schema.familyCheckInPrefs.lastAnsweredAt,
      silentStreakSince: schema.familyCheckInPrefs.silentStreakSince,
    })
    .from(schema.familyCheckInPrefs)
    .where(eq(schema.familyCheckInPrefs.familyId, familyId))
    .limit(1);
  return row ?? DEFAULT_CHECK_IN_STATE;
}

/** The query surface a state write needs — satisfied by both `Database` and a tx. */
export type CheckInWriter = Pick<Database, 'insert'>;

/** The question went out: stamp the ask and carry the counted silence forward. */
export async function recordCheckInAsk(
  writer: CheckInWriter,
  input: { familyId: string; silentStreak: number; now: Date },
): Promise<void> {
  await writer
    .insert(schema.familyCheckInPrefs)
    .values({
      familyId: input.familyId,
      silentStreak: input.silentStreak,
      lastAskedAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: schema.familyCheckInPrefs.familyId,
      set: { silentStreak: input.silentStreak, lastAskedAt: input.now, updatedAt: input.now },
    });
}

/** The cadence moved. The silence ladder no longer calls this; a stored stop still can. */
export async function recordCheckInCadence(
  writer: CheckInWriter,
  input: {
    familyId: string;
    cadence: CheckInCadence;
    silentStreak: number;
    /** Set by a rung of the LADDER, so the silence it just acted on is not counted twice
     * by the rung after it. A parent moving their own cadence leaves it alone. */
    silentStreakSince?: Date;
    now: Date;
  },
): Promise<void> {
  const baseline =
    input.silentStreakSince === undefined ? {} : { silentStreakSince: input.silentStreakSince };
  await writer
    .insert(schema.familyCheckInPrefs)
    .values({
      familyId: input.familyId,
      cadence: input.cadence,
      silentStreak: input.silentStreak,
      ...baseline,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: schema.familyCheckInPrefs.familyId,
      set: {
        cadence: input.cadence,
        silentStreak: input.silentStreak,
        ...baseline,
        updatedAt: input.now,
      },
    });
}

/** The parent said something back — whatever they said, the streak is over. */
export async function recordCheckInAnswer(
  writer: CheckInWriter,
  input: { familyId: string; cadence: CheckInCadence | null; now: Date },
): Promise<void> {
  const moved = input.cadence === null ? {} : { cadence: input.cadence };
  await writer
    .insert(schema.familyCheckInPrefs)
    .values({
      familyId: input.familyId,
      ...moved,
      silentStreak: 0,
      lastAnsweredAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: schema.familyCheckInPrefs.familyId,
      set: { ...moved, silentStreak: 0, lastAnsweredAt: input.now, updatedAt: input.now },
    });
}
