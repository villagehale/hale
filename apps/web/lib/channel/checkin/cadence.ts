import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';

/**
 * VIL-353 · THE CLOCK AND THE LADDER behind the evening check-in.
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

/** Consecutive unanswered asks before Hale says less, and then says nothing. */
export const SILENT_ASKS_BEFORE_STEP_DOWN = 3;

const WEEKLY_INTERVAL_MS = 7 * 24 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

export type CheckInCadence = schema.FamilyCheckInPrefs['cadence'];

/** The family's check-in state, as stored — or the default for a family never asked. */
export interface CheckInState {
  cadence: CheckInCadence;
  silentStreak: number;
  lastAskedAt: Date | null;
  lastAnsweredAt: Date | null;
}

export const DEFAULT_CHECK_IN_STATE: CheckInState = {
  cadence: 'daily',
  silentStreak: 0,
  lastAskedAt: null,
  lastAnsweredAt: null,
};

/** Why a family in the slot hears nothing tonight. Enum, never free text: it is counted
 * in the cron summary and logged, so it has to be safe to emit and stable to aggregate. */
export type CheckInSkipReason = 'cadence_off' | 'asked_today' | 'not_due';

export type CheckInDecision =
  | { kind: 'skip'; reason: CheckInSkipReason }
  /** Ask. `first` picks the copy that explains the keywords; `silentStreak` is what the
   * row carries forward once the question has gone out. */
  | { kind: 'ask'; first: boolean; silentStreak: number }
  /** Three lapsed asks on daily: say so, once, and move to weekly. */
  | { kind: 'step_down' }
  /** Three lapsed asks on weekly: stop, and say nothing about stopping. */
  | { kind: 'dormant'; silentStreak: number };

/** The family's local calendar day as 'YYYY-MM-DD'. */
export function localDateKey(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
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
 * WHAT HAPPENS IN THIS FAMILY'S EVENING SLOT — the whole ladder, as one pure function of
 * the stored row.
 *
 * THE LAPSE IS COUNTED AT THE NEXT ASK, never on a timer. The hourly cron reaches this
 * function several times a night and a weekly household skips it six evenings out of
 * seven, so a counter advanced whenever silence was OBSERVED would count one unanswered
 * evening once, or six times, depending on the cron — which is the same defect as no
 * counter at all. Deriving it from the two timestamps at the moment Hale is about to
 * speak again makes "consecutive unanswered asks" exactly what the name says.
 *
 * THE STEP-DOWN DOES NOT MOVE `lastAskedAt`, and that is what makes "three more" mean
 * three more. The weekly rhythm keeps measuring from the last real ASK, so the first
 * weekly question lands a week after the last daily one, and the silence Hale already
 * counted is not counted a second time by the notice that announced the change.
 */
export function decideCheckIn(
  state: CheckInState,
  now: Date,
  timeZone: string,
): CheckInDecision {
  if (state.cadence === 'off') return { kind: 'skip', reason: 'cadence_off' };

  const { lastAskedAt, lastAnsweredAt } = state;
  if (lastAskedAt !== null && localDateKey(lastAskedAt, timeZone) === localDateKey(now, timeZone)) {
    return { kind: 'skip', reason: 'asked_today' };
  }
  if (
    state.cadence === 'weekly' &&
    lastAskedAt !== null &&
    now.getTime() - lastAskedAt.getTime() < WEEKLY_INTERVAL_MS
  ) {
    return { kind: 'skip', reason: 'not_due' };
  }

  const lapsed =
    lastAskedAt !== null &&
    (lastAnsweredAt === null || lastAnsweredAt.getTime() < lastAskedAt.getTime());
  const silentStreak = lapsed ? state.silentStreak + 1 : 0;
  if (silentStreak >= SILENT_ASKS_BEFORE_STEP_DOWN) {
    return state.cadence === 'daily' ? { kind: 'step_down' } : { kind: 'dormant', silentStreak };
  }
  return { kind: 'ask', first: lastAskedAt === null, silentStreak };
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

/** The cadence moved, by Hale's own ladder or by the parent's word. */
export async function recordCheckInCadence(
  writer: CheckInWriter,
  input: { familyId: string; cadence: CheckInCadence; silentStreak: number; now: Date },
): Promise<void> {
  await writer
    .insert(schema.familyCheckInPrefs)
    .values({
      familyId: input.familyId,
      cadence: input.cadence,
      silentStreak: input.silentStreak,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: schema.familyCheckInPrefs.familyId,
      set: { cadence: input.cadence, silentStreak: input.silentStreak, updatedAt: input.now },
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
