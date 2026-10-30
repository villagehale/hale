import { dayKeyIn } from '~/lib/plan/spine';
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
  pickupPlace: string | null;
  kids: string | null;
  confidence: 'high' | 'low';
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

function claimedDriverName(reading: CarpoolReading, sender: CarpoolSender): string | null {
  const named = reading.driverName?.trim() || null;
  if (named) return named;
  if (reading.intent === 'driver_claim' || reading.intent === 'driver_swap') {
    return sender.name?.trim() || null;
  }
  return null;
}

function sameFirstName(a: string | null, b: string | null): boolean {
  const first = (value: string | null) =>
    (value ?? '').trim().split(/\s+/)[0]?.toLocaleLowerCase() ?? '';
  const left = first(a);
  return left.length > 0 && left === first(b);
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
  const pickupAt = parsePickupAt(reading.pickupAtIso) ?? previousPickupAt;
  const eventLabel = reading.eventLabel?.trim() || plan?.eventLabel || null;
  const pickupPlace = reading.pickupPlace?.trim() || plan?.pickupPlace || null;
  const kids = reading.kids?.trim() || plan?.kids || null;
  const timeZone = sender.timezone || plan?.driverTimezone || 'America/Toronto';
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
  // Devin #936 — "Priya is driving" from Maya is Priya, not Maya. Only the
  // speaker naming themself carries their account; anyone else stays null
  // until they are a verified member.
  const speakerIsDriver = sameFirstName(driverName, sender.name);
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
