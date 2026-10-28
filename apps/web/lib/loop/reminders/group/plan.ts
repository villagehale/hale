import { localDateFact } from '~/lib/loop/reminders/compose';
import { zonedLocalInstant } from '~/lib/plan/spine';
import {
  type AskerStanding,
  type QuietShift,
  type QuietWindow,
  type ReminderDelivery,
  type ReminderFor,
  askedInstant,
  cleanWhat,
  deliveryFor,
  quietSafeAt,
  sameFirstName,
} from './policy';
import type { GroupReminderReading } from './read';

/**
 * VIL-448 (T26) — what one reminder turn does, from the model's reading. Pure: every
 * rule about time, quiet hours and where a reminder goes runs here, so the door, the
 * tests and the eval all check the same code.
 */

export const MAX_SET_PER_TURN = 5;

export interface PlannedReminder {
  forKind: ReminderFor;
  forUserId: string | null;
  forPhoneHash: string | null;
  forName: string | null;
  what: string;
  askedFor: Date;
  deliverAt: Date;
  moved: QuietShift;
  delivery: ReminderDelivery;
  privateAsked: boolean;
}

/** A reminder with no usable time: the confirmation asks when, and nothing is set. */
export interface NeedsTime {
  forKind: ReminderFor;
  forName: string | null;
  what: string;
  day: string | null;
}

export interface TurnPlan {
  set: PlannedReminder[];
  needsTime: NeedsTime[];
  cancelIds: string[];
}

export interface PlanSeat {
  userId: string;
  phoneHash: string;
  firstName: string | null;
}

export interface PlanInput {
  reading: GroupReminderReading;
  now: Date;
  /** The asker's zone: the one their times are read in. */
  timeZone: string;
  asker: PlanSeat & AskerStanding;
  seats: readonly PlanSeat[];
  groupQuiet: { timeZone: string; windows: QuietWindow[] };
  /** Null when no 1:1 text can reach the asker. */
  directQuiet: { timeZone: string; windows: QuietWindow[] } | null;
  /** The reader's refs for the open reminders it was shown. */
  openRefs: ReadonlyMap<string, string>;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function askedDay(date: string | null, timeZone: string): string | null {
  if (date === null || !DAY_KEY.test(date)) return null;
  try {
    return localDateFact(zonedLocalInstant(date, '12:00', timeZone), timeZone);
  } catch {
    return null;
  }
}

export function planReminderTurn(input: PlanInput): TurnPlan {
  const set: PlannedReminder[] = [];
  const needsTime: NeedsTime[] = [];
  const seen = new Set<string>();
  for (const ask of input.reading.set.slice(0, MAX_SET_PER_TURN)) {
    const what = cleanWhat(ask.what);
    if (!what) continue;
    let forUserId: string | null = null;
    let forPhoneHash: string | null = null;
    let forName: string | null = null;
    if (ask.for === 'sender') {
      forUserId = input.asker.userId;
      forPhoneHash = input.asker.phoneHash;
      forName = input.asker.firstName;
    } else if (ask.for === 'person') {
      const named = ask.name?.trim();
      if (!named) continue;
      const matches = input.seats.filter(
        (seat) => seat.firstName !== null && sameFirstName(named, seat.firstName),
      );
      const match = matches.length === 1 ? matches[0] : undefined;
      forUserId = match?.userId ?? null;
      forPhoneHash = match?.phoneHash ?? null;
      forName = match?.firstName ?? named;
    }
    const asked = askedInstant(ask, input.now, input.timeZone);
    let delivery = deliveryFor(ask, input.asker);
    if (delivery === 'direct' && !input.directQuiet) delivery = 'group';
    const quiet = delivery === 'direct' && input.directQuiet ? input.directQuiet : input.groupQuiet;
    const safe = asked ? quietSafeAt(asked, input.now, quiet.timeZone, quiet.windows) : null;
    if (!asked || !safe) {
      needsTime.push({ forKind: ask.for, forName, what, day: askedDay(ask.date, input.timeZone) });
      continue;
    }
    const key = `${ask.for}|${forUserId ?? forName ?? ''}|${what}|${safe.at.toISOString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    set.push({
      forKind: ask.for,
      forUserId,
      forPhoneHash,
      forName,
      what,
      askedFor: asked,
      deliverAt: safe.at,
      moved: safe.moved,
      delivery,
      privateAsked: ask.for === 'sender' && ask.where === 'private',
    });
  }
  const cancelIds = [
    ...new Set(
      input.reading.cancel
        .map((ref) => input.openRefs.get(ref))
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];
  return { set, needsTime, cancelIds };
}
