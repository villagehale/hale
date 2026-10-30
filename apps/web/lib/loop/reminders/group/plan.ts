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

/**
 * A reminder for someone else that no one seat in the chat answers to: nobody in it has
 * that name, or more than one person does. Nothing is set, and the confirmation says so.
 */
export interface NotSet {
  forName: string;
  what: string;
  why: 'not_in_chat' | 'name_shared';
}

export interface TurnPlan {
  set: PlannedReminder[];
  needsTime: NeedsTime[];
  notSet: NotSet[];
  cancelIds: string[];
}

export interface PlanSeat {
  userId: string;
  phoneHash: string;
  firstName: string | null;
  /** Their whole name, when Hale has one: what settles two seats sharing a first name. */
  fullName?: string | null;
}

/** The one seat in `matches` whose whole name is the name asked for, else undefined. */
function byFullName(named: string, matches: readonly PlanSeat[]): PlanSeat | undefined {
  const fold = (s: string) =>
    s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase().split(/\s+/).join(' ');
  const want = fold(named);
  if (!want.includes(' ')) return undefined;
  const bare = (s: string) => fold(s).replace(/\./g, '');
  const whole = matches.filter(
    (seat) =>
      (seat.fullName && fold(seat.fullName) === want) ||
      (seat.firstName !== null && bare(seat.firstName) === bare(named)),
  );
  return whole.length === 1 ? whole[0] : undefined;
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

/**
 * A reminder for someone else is tied to the one seat that has their first name, so it
 * goes to someone who is in the chat and is dropped if they leave it. One no seat answers
 * to is not set: posting it would tell the chat a person was reminded who never saw it.
 */
export function planReminderTurn(input: PlanInput): TurnPlan {
  const set: PlannedReminder[] = [];
  const needsTime: NeedsTime[] = [];
  const notSet: NotSet[] = [];
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
      const match = matches.length === 1 ? matches[0] : byFullName(named, matches);
      if (!match) {
        notSet.push({
          forName: named,
          what,
          why: matches.length === 0 ? 'not_in_chat' : 'name_shared',
        });
        continue;
      }
      forUserId = match.userId;
      forPhoneHash = match.phoneHash;
      forName = match.firstName;
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
  return { set, needsTime, notSet, cancelIds };
}
