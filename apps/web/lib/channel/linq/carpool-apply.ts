import { dayKeyIn, zonedLocalInstant } from '~/lib/plan/spine';
import {
  type CarpoolIntent,
  type CarpoolPlanStatus,
  type CarpoolPlanView,
  type CarpoolReminderStatus,
  carpoolReminderFireAt,
} from './carpool-cadence';

/**
 * VIL-445 — fold one reading into a plan. Pure: no DB, no model, no send.
 * Hale never invents a driver. A later claim replaces the current one (a swap).
 * Cancel is terminal.
 */

export interface CarpoolReading {
  intent: CarpoolIntent;
  driverName: string | null;
  eventLabel: string | null;
  pickupAtIso: string | null;
  /**
   * VIL-520 — local calendar day and wall clock, copied from the family's
   * `now.nextDays`. Code turns these into the instant. An offset on
   * `pickupAtIso` is not the clock the parent said.
   */
  pickupDate?: string | null;
  pickupTime?: string | null;
  pickupPlace: string | null;
  kids: string | null;
  confidence: 'high' | 'low';
  /**
   * Devin #975 — the reader's call that the driver after this message is the
   * sender themself ("I'll take them", a tapback on Hale's ask). A name alone
   * is never enough: two people in a chat can share a first name.
   */
  driverIsSender?: boolean;
}

export interface CarpoolSender {
  userId: string | null;
  name: string | null;
  haleCustomer: boolean;
  timezone: string;
}

export interface CarpoolPlanState extends CarpoolPlanView {
  planKey: string;
  eventLabel: string | null;
  pickupPlace: string | null;
  kids: string | null;
  driverUserId: string | null;
  driverHaleCustomer: boolean;
  driverTimezone: string;
}

export function carpoolPlanKey(
  eventLabel: string | null,
  pickupAt: Date | null,
  timeZone: string,
): string {
  const day = pickupAt ? dayKeyIn(pickupAt, timeZone) : 'undated';
  const event = (eventLabel ?? 'plan').trim().toLowerCase().replace(/\s+/g, ' ');
  return `${day}:${event}`;
}

export function parsePickupAt(iso: string | null): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The pickup instant.
 *
 * A local date plus wall clock wins. Those are the family's calendar day and
 * the hour they said; the offset in force at that moment in `timeZone` is
 * applied here. Trusting a model instant instead is how Friday-night
 * "tomorrow Saturday 8am" became Sunday 7am: the UTC date rolled to Sunday,
 * and Friday's EDT offset (−04:00) was stuck on a Sunday that is already EST.
 * An absolute `pickupAtIso` is only the fallback for a stored instant.
 */
export function resolveCarpoolPickup(
  reading: Pick<CarpoolReading, 'pickupAtIso' | 'pickupDate' | 'pickupTime'>,
  timeZone: string,
): Date | null {
  const date = reading.pickupDate?.trim() ?? '';
  const time = reading.pickupTime?.trim() ?? '';
  if (DAY_KEY.test(date) && CLOCK.test(time)) {
    try {
      return zonedLocalInstant(date, time, timeZone);
    } catch {
      return null;
    }
  }
  return parsePickupAt(reading.pickupAtIso);
}

/** `HH:MM` of an instant on the wall clock of `timeZone`. */
function localClockIn(at: Date, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const hour = parts.find((part) => part.type === 'hour')?.value;
    const minute = parts.find((part) => part.type === 'minute')?.value;
    const clock = hour && minute ? `${hour}:${minute}` : '';
    return CLOCK.test(clock) ? clock : null;
  } catch {
    return null;
  }
}

/**
 * Devin #984 — a date-only move ("soccer pickup moved to Sunday") names a day and
 * no hour. It keeps the matched ride's own local hour on the new day; without this
 * the new date was dropped and the old instant kept. Which ride is matched (and the
 * refusal when several could be) stays with `pickCarpoolPlan`.
 */
export function withKnownClock<R extends Pick<CarpoolReading, 'pickupDate' | 'pickupTime'>>(
  reading: R,
  plan: Pick<CarpoolPlanState, 'pickupAt' | 'driverTimezone'> | null,
  timeZone: string,
): R {
  const date = reading.pickupDate?.trim() ?? '';
  const time = reading.pickupTime?.trim() ?? '';
  if (!DAY_KEY.test(date) || CLOCK.test(time) || !plan?.pickupAt) return reading;
  const clock = localClockIn(plan.pickupAt, plan.driverTimezone || timeZone);
  return clock ? { ...reading, pickupTime: clock } : reading;
}

function claimedDriverName(reading: CarpoolReading, sender: CarpoolSender): string | null {
  const named = reading.driverName?.trim() || null;
  if (named) return named;
  if (reading.intent === 'driver_claim' || reading.intent === 'driver_swap') {
    return sender.name?.trim() || null;
  }
  return null;
}

function withReminder(
  plan: CarpoolPlanState,
  pickupAt: Date | null,
  timeZone: string,
  previousPickupAt: Date | null = plan.pickupAt,
): CarpoolPlanState {
  if (plan.status === 'cancelled') {
    return { ...plan, reminderStatus: 'skipped_cancelled', reminderFireAt: null };
  }
  if (!plan.driverName || !pickupAt) {
    return {
      ...plan,
      reminderFireAt: null,
      reminderStatus: plan.driverName ? 'unscheduled' : 'skipped_no_driver',
    };
  }
  if (plan.reminderStatus === 'sent') {
    // Devin #936 — a ride moved to another day after its reminder went out
    // gets a fresh night-before reminder for the new day.
    const movedDay =
      previousPickupAt !== null &&
      dayKeyIn(previousPickupAt, timeZone) !== dayKeyIn(pickupAt, timeZone);
    if (!movedDay) return plan;
  }
  return {
    ...plan,
    reminderFireAt: carpoolReminderFireAt(pickupAt, timeZone),
    reminderStatus: 'pending',
  };
}

/**
 * Apply a high-confidence reading. Low confidence leaves the plan untouched
 * except `cancel`, which is always stored when the model named it.
 */
export function applyCarpoolReading(
  plan: CarpoolPlanState | null,
  reading: CarpoolReading,
  sender: CarpoolSender,
  _now: Date,
): CarpoolPlanState | null {
  if (reading.confidence === 'low' && reading.intent !== 'cancel') return plan;
  if (reading.intent === 'chatter' || reading.intent === 'unclear') return plan;

  const previousPickupAt = plan?.pickupAt ?? null;
  const timeZone = sender.timezone || plan?.driverTimezone || 'America/Toronto';
  const pickupAt =
    resolveCarpoolPickup(withKnownClock(reading, plan, timeZone), timeZone) ?? previousPickupAt;
  const eventLabel = reading.eventLabel?.trim() || plan?.eventLabel || null;
  const pickupPlace = reading.pickupPlace?.trim() || plan?.pickupPlace || null;
  const kids = reading.kids?.trim() || plan?.kids || null;
  const movedDay = Boolean(
    plan?.pickupAt &&
      pickupAt &&
      dayKeyIn(plan.pickupAt, timeZone) !== dayKeyIn(pickupAt, timeZone),
  );
  const planKey = plan && !movedDay ? plan.planKey : carpoolPlanKey(eventLabel, pickupAt, timeZone);

  if (reading.intent === 'cancel') {
    const base: CarpoolPlanState = plan ?? {
      planKey,
      eventLabel,
      pickupAt,
      pickupPlace,
      kids,
      driverName: null,
      driverUserId: null,
      driverHaleCustomer: false,
      driverTimezone: timeZone,
      status: 'cancelled',
      askedForDriverAt: null,
      reminderStatus: 'skipped_cancelled',
      reminderFireAt: null,
    };
    return {
      ...base,
      status: 'cancelled',
      reminderStatus: 'skipped_cancelled',
      reminderFireAt: null,
    };
  }

  if (plan?.status === 'cancelled') return plan;

  const next: CarpoolPlanState = plan ?? {
    planKey,
    eventLabel,
    pickupAt,
    pickupPlace,
    kids,
    driverName: null,
    driverUserId: null,
    driverHaleCustomer: false,
    driverTimezone: timeZone,
    status: 'open',
    askedForDriverAt: null,
    reminderStatus: 'unscheduled',
    reminderFireAt: null,
  };

  const merged: CarpoolPlanState = {
    ...next,
    planKey,
    eventLabel,
    pickupAt,
    pickupPlace,
    kids,
    driverTimezone: timeZone,
  };

  if (reading.intent === 'plan_needs_driver') {
    return withReminder(merged, pickupAt, timeZone, previousPickupAt);
  }

  const driverName = claimedDriverName(reading, sender);
  if (!driverName) return withReminder(merged, pickupAt, timeZone, previousPickupAt);

  const swapped = Boolean(merged.driverName && merged.driverName !== driverName);
  // Devin #936/#975 — "Priya is driving" from Maya is Priya, not Maya, and
  // "Priya is driving" from a different Priya is not the sender either. Only a
  // clear self-claim carries the sender's account (and their private reminder):
  // the reader said the sender is the driver, or named no one so the claim
  // fell back to the sender. A matching first name alone never routes it.
  const speakerIsDriver =
    sender.userId !== null &&
    (reading.driverIsSender === true || !(reading.driverName?.trim() || null));
  const assigned: CarpoolPlanState = {
    ...merged,
    driverName,
    driverUserId: speakerIsDriver ? sender.userId : null,
    driverHaleCustomer: speakerIsDriver ? sender.haleCustomer : false,
    driverTimezone: timeZone,
    status: 'assigned',
    reminderStatus: swapped && merged.reminderStatus === 'sent' ? 'pending' : merged.reminderStatus,
  };
  return withReminder(assigned, pickupAt, timeZone, previousPickupAt);
}

export function markAsked(plan: CarpoolPlanState, at: Date): CarpoolPlanState {
  return { ...plan, askedForDriverAt: at };
}

export function markReminder(
  plan: CarpoolPlanState,
  status: CarpoolReminderStatus,
): CarpoolPlanState {
  return { ...plan, reminderStatus: status };
}

export function statusOf(plan: CarpoolPlanState): CarpoolPlanStatus {
  return plan.status;
}
