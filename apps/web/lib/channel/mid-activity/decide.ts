/**
 * VIL-393 — when a household may be asked, once, how an activity is going.
 *
 * The post-activity "how did it go?" ask already exists (VIL-366). This gate is
 * the mid-series node: not every text, and not a one-off the day after. Fewer
 * asks wins every tie. A missing parent preference is the stricter gate, not
 * the evening check-in's daily default.
 */

export type ActivityCadence = 'once' | 'weekly' | 'often';

/** How often this household wants Hale to ask. `fewer` is the unset default. */
export type AskPreference = 'off' | 'fewer' | 'regular';

export type CheckInCadence = 'daily' | 'weekly' | 'off';

export type MidActivitySkipReason =
  | 'already_asked'
  | 'preference_off'
  | 'too_rare'
  | 'too_soon'
  | 'past_window';

export type MidActivityDecision =
  | { ask: true; atSession: number }
  | { ask: false; reason: MidActivitySkipReason };

const DAY_MS = 24 * 3_600_000;
/** Gaps shorter than this are one day with several slots, not a series with a middle. */
const SAME_DAY_MS = 20 * 3_600_000;

/**
 * No stored check-in row means the parent has not asked to hear from Hale more
 * often. That is `fewer`, on purpose: the evening check-in treats a missing row
 * as daily, and copying that default would ask more households, not fewer.
 */
export function preferenceFromCheckIn(row: { cadence: CheckInCadence } | null): AskPreference {
  if (row === null) return 'fewer';
  if (row.cadence === 'off') return 'off';
  if (row.cadence === 'weekly') return 'fewer';
  return 'regular';
}

/** Median gap between session starts. One start, a same-day cluster, or a rare gap is `once`. */
export function cadenceFromSessionStarts(starts: readonly Date[]): ActivityCadence {
  if (starts.length < 2) return 'once';
  const sorted = [...starts].sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (prev === undefined || next === undefined) continue;
    gaps.push(next.getTime() - prev.getTime());
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)] ?? DAY_MS;
  if (median < SAME_DAY_MS) return 'once';
  if (median < 5 * DAY_MS) return 'often';
  if (median <= 10 * DAY_MS) return 'weekly';
  return 'once';
}

export function sessionsElapsed(starts: readonly Date[], now: Date): number {
  return starts.filter((start) => start.getTime() <= now.getTime()).length;
}

/**
 * The one session count at which this activity may be asked about.
 * Null means the series is too short or too rare to have a middle worth interrupting for.
 *
 * A planned series asks on the session just past halfway, and one later when the
 * parent prefers fewer — still before the last session. An open-ended series
 * (no end on the row) has one fixed node, later for `fewer`.
 */
export function midpointSession(input: {
  cadence: ActivityCadence;
  preference: AskPreference;
  sessionsPlanned: number | null;
}): number | null {
  if (input.preference === 'off' || input.cadence === 'once') return null;

  if (input.sessionsPlanned !== null) {
    const minimum = input.preference === 'fewer' ? 6 : 4;
    if (input.sessionsPlanned < minimum) return null;
    const halfway = Math.ceil(input.sessionsPlanned / 2);
    if (input.preference === 'fewer') {
      return Math.min(halfway + 1, input.sessionsPlanned - 1);
    }
    return halfway;
  }

  if (input.cadence === 'weekly') return input.preference === 'fewer' ? 4 : 3;
  return input.preference === 'fewer' ? 6 : 4;
}

/**
 * Ask on exactly one session count. The next session is `past_window` — a missed
 * node is not caught up later. That is the fewer-asks rule, and it is also what
 * stops an hourly tick from asking on every later text.
 */
export function decideMidActivityAsk(input: {
  cadence: ActivityCadence;
  preference: AskPreference;
  sessionsElapsed: number;
  sessionsPlanned: number | null;
  alreadyAsked: boolean;
}): MidActivityDecision {
  if (input.alreadyAsked) return { ask: false, reason: 'already_asked' };
  if (input.preference === 'off') return { ask: false, reason: 'preference_off' };
  const atSession = midpointSession(input);
  if (atSession === null) return { ask: false, reason: 'too_rare' };
  if (input.sessionsElapsed < atSession) return { ask: false, reason: 'too_soon' };
  if (input.sessionsElapsed > atSession) return { ask: false, reason: 'past_window' };
  return { ask: true, atSession };
}
