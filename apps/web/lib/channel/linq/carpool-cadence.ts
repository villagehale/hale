import { NIGHT_BEFORE_START_MIN, inNightBeforeWindow } from '~/lib/channel/coparent/duty/cadence';
import { reminderFireAt } from '~/lib/loop/reminders/schedule';

/**
 * VIL-445 (T16) — when a carpool line may leave, and when it must not.
 *
 * Code owns this gate. The model reads who is driving and writes the words.
 * There is no rota: a missing driver is an ask, never an assignment.
 * The night-before window is the duty one (17:00 to quiet start, driver's zone).
 * A cancelled plan, a quiet-hours hold, and a closed window are first-class
 * outcomes — never a silent send.
 */

export type CarpoolIntent =
  | 'driver_claim'
  | 'driver_swap'
  | 'plan_needs_driver'
  | 'cancel'
  | 'chatter'
  | 'unclear';

export type CarpoolReminderStatus =
  | 'unscheduled'
  | 'pending'
  | 'sent'
  | 'held_quiet'
  | 'skipped_cancelled'
  | 'skipped_no_driver'
  | 'suppressed';

export type CarpoolPlanStatus = 'open' | 'assigned' | 'cancelled';

export interface CarpoolPlanView {
  status: CarpoolPlanStatus;
  driverName: string | null;
  pickupAt: Date | null;
  askedForDriverAt: Date | null;
  reminderStatus: CarpoolReminderStatus;
  reminderFireAt: Date | null;
}

export type CarpoolTurnDecision =
  | { speak: 'silent'; reason: 'chatter' | 'already_asked' | 'unclear' | 'has_driver' | 'flag_off' }
  | { speak: 'ask_driver' }
  | { speak: 'addressed_status' };

export type CarpoolReminderDecision =
  | { action: 'fire' }
  | { action: 'wait' }
  | { action: 'hold'; reason: 'quiet_hours' }
  | {
      action: 'skip';
      reason: 'cancelled' | 'no_driver' | 'window_closed' | 'already_sent' | 'unscheduled';
    };

export interface CarpoolTurnInput {
  intent: CarpoolIntent;
  confidence: 'high' | 'low';
  plan: CarpoolPlanView | null;
  addressed: boolean;
}

export interface CarpoolReminderInput {
  plan: CarpoolPlanView;
  now: Date;
  localMinutes: number;
  quiet: boolean;
  quietStartMin: number;
  timeZone: string;
}

/** Minutes since local midnight in `timeZone`. */
export function localMinutesIn(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

export function carpoolReminderFireAt(pickupAt: Date, timeZone: string): Date {
  return reminderFireAt(pickupAt, '-P1D', timeZone);
}

/**
 * Inbound: Hale speaks only when the group needs a driver and has not been
 * asked, or when someone addressed Hale about this plan. Banter stays quiet.
 * A claim or a swap updates state in the caller; this function does not assign
 * a driver.
 */
export function decideCarpoolTurn(input: CarpoolTurnInput): CarpoolTurnDecision {
  if (input.confidence === 'low' && input.intent !== 'cancel') {
    return { speak: 'silent', reason: 'unclear' };
  }
  if (input.plan?.status === 'cancelled') {
    return { speak: 'silent', reason: 'chatter' };
  }
  if (
    input.intent === 'cancel' ||
    input.intent === 'driver_claim' ||
    input.intent === 'driver_swap'
  ) {
    return { speak: 'silent', reason: input.plan?.driverName ? 'has_driver' : 'chatter' };
  }
  if (input.intent === 'chatter' || input.intent === 'unclear') {
    if (input.addressed && input.plan) return { speak: 'addressed_status' };
    return { speak: 'silent', reason: input.intent === 'unclear' ? 'unclear' : 'chatter' };
  }
  if (input.intent === 'plan_needs_driver') {
    if (input.plan?.driverName) return { speak: 'silent', reason: 'has_driver' };
    if (input.plan?.askedForDriverAt) return { speak: 'silent', reason: 'already_asked' };
    return { speak: 'ask_driver' };
  }
  return { speak: 'silent', reason: 'chatter' };
}

/**
 * Cron: the night-before reminder. Re-reads the live plan. Quiet hours hold
 * inside the window; after the window closes the send is dropped.
 */
export function decideCarpoolReminder(input: CarpoolReminderInput): CarpoolReminderDecision {
  const { plan } = input;
  if (plan.status === 'cancelled' || plan.reminderStatus === 'skipped_cancelled') {
    return { action: 'skip', reason: 'cancelled' };
  }
  if (plan.reminderStatus === 'sent') return { action: 'skip', reason: 'already_sent' };
  if (plan.reminderStatus === 'suppressed') return { action: 'skip', reason: 'window_closed' };
  if (!plan.driverName) return { action: 'skip', reason: 'no_driver' };
  if (!plan.pickupAt || !plan.reminderFireAt || plan.reminderStatus === 'unscheduled') {
    return { action: 'skip', reason: 'unscheduled' };
  }
  if (plan.pickupAt.getTime() <= input.now.getTime()) {
    return { action: 'skip', reason: 'window_closed' };
  }
  if (input.now.getTime() < plan.reminderFireAt.getTime()) return { action: 'wait' };
  const inWindow = inNightBeforeWindow(input.localMinutes, input.quietStartMin);
  if (input.quiet && inWindow) return { action: 'hold', reason: 'quiet_hours' };
  if (input.quiet || !inWindow) {
    const afterWindow = input.localMinutes >= input.quietStartMin;
    const pastFireDay = input.now.getTime() - plan.reminderFireAt.getTime() > 6 * 60 * 60 * 1000;
    if (afterWindow || pastFireDay) return { action: 'skip', reason: 'window_closed' };
    return { action: 'wait' };
  }
  return { action: 'fire' };
}

export { NIGHT_BEFORE_START_MIN };
