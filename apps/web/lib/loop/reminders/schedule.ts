import { dayKeyIn } from '~/lib/plan/spine';

/**
 * VIL-223 · D1 — the reminder engine's pure scheduling core. No DB, no LLM, no
 * `new Date()` of its own: `now` and the live event snapshot are passed in, so the
 * "don't-send matrix" (the trust test) is deterministic under an injected clock.
 *
 * The engine's whole point is everything it DOESN'T send. The classifier below is
 * that gate — given a scheduled reminder and the CURRENT live event, it decides
 * fire / cancel / stale / suppress, so a cancelled or moved event can never nag.
 * The engine materializes reminder rows for scheduling + audit, but the SEND is
 * always gated on a fresh classify against the live event — correctness holds even
 * if a recompute hook was missed.
 */

// The two default offsets (extensible — the column stores the ISO-8601 duration).
export type ReminderOffset = '-P1D' | '-PT1H';
export const REMINDER_OFFSETS: readonly ReminderOffset[] = ['-P1D', '-PT1H'];

export type ReminderStatus = 'scheduled' | 'sent' | 'suppressed' | 'cancelled' | 'stale';

/** T-1h is glanceable + time-sensitive (may cross quiet hours per the urgent toggle);
 * T-24h is the "evening before" heartbeat, a normal message that defers per A5. */
export function offsetUrgency(offset: ReminderOffset): 'normal' | 'time_sensitive' {
  return offset === '-PT1H' ? 'time_sensitive' : 'normal';
}

// The family-local evening slot the "evening before" (T-24h) reminder fires at. A
// fixed slot (not starts_at − 24h) is what lets every one of tomorrow's events share
// one fire_at and batch into a single message (rule #4). Product-tunable; a pref can
// override later.
export const REMINDER_EVENING_MINUTE = 18 * 60; // 18:00 local
const HOUR_MS = 60 * 60 * 1000;

// A reminder whose fire_at is more than this behind `now` missed its slot (a cron gap,
// a late placement) — it is suppressed, never fired stale-late (a 3 AM "reminder" for
// a slot that passed is exactly the annoyance this engine exists to avoid). One tick.
export const REMINDER_MISS_GRACE_MS = 90 * 60 * 1000;

/** The zone's UTC offset (ms) at `instant` — the machine's own zone cancels out of
 * the rendered-string difference. */
function tzOffsetMs(instant: Date, timeZone: string): number {
  const inZone = new Date(instant.toLocaleString('en-US', { timeZone }));
  const inUtc = new Date(instant.toLocaleString('en-US', { timeZone: 'UTC' }));
  return inUtc.getTime() - inZone.getTime();
}

/** The UTC instant of `dayKey` at `minuteOfDay` family-local. The offset is measured
 * at the target wall-time (not local midnight), so 18:00 lands correctly even on a
 * DST-transition day — the evening slot is well clear of the 02:00 gap. */
function zonedInstant(dayKey: string, minuteOfDay: number, timeZone: string): Date {
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
  const mm = String(minuteOfDay % 60).padStart(2, '0');
  const guess = new Date(`${dayKey}T${hh}:${mm}:00Z`);
  return new Date(guess.getTime() + tzOffsetMs(guess, timeZone));
}

/** The calendar day before `dayKey` (YYYY-MM-DD), read at UTC (the key is bare). */
function previousDayKey(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * When a reminder for an event starting at `startsAt` fires, family-local:
 * - T-1h: exactly one hour before the start instant (time-sensitive, precise).
 * - T-24h: the fixed evening slot (18:00 local) on the day BEFORE the event's local
 *   day — so all of a day's events share one fire_at and batch into one message.
 */
export function reminderFireAt(startsAt: Date, offset: ReminderOffset, timeZone: string): Date {
  if (offset === '-PT1H') return new Date(startsAt.getTime() - HOUR_MS);
  const eveBefore = previousDayKey(dayKeyIn(startsAt, timeZone));
  return zonedInstant(eveBefore, REMINDER_EVENING_MINUTE, timeZone);
}

export interface EventSnapshot {
  id: string;
  startsAt: Date;
  /** B3 soft-delete stamp — non-null means cancelled/UNDO-removed; never remind. */
  deletedAt: Date | null;
}

export interface ScheduledReminder {
  eventRef: string;
  offset: ReminderOffset;
  fireAt: Date;
}

export type SuppressReason = 'started' | 'missed' | 'interacted';

export type ReminderDecision =
  | { action: 'fire' }
  | { action: 'cancel' } // event erased or soft-deleted — the trust test
  | { action: 'stale' } // event moved — this row is for the old fire time
  | { action: 'suppress'; reason: SuppressReason }
  | { action: 'wait' }; // fire_at still in the future

export interface ClassifyOptions {
  /** The parent already engaged this event in-channel within the offset window (e.g.
   * rescheduled it an hour ago) — suppress the now-redundant reminder (rule #3). */
  recentInteraction?: boolean;
}

/**
 * The don't-send gate. Ordered so the strongest "never send" wins: a gone/cancelled
 * event beats everything; a moved event is stale; an event that already started (or a
 * slot missed by more than the grace) is suppressed; a fresh in-channel interaction
 * suppresses; a future fire waits; otherwise fire. `event` is the CURRENT live row
 * (null when it no longer exists), re-read at send time — so this holds regardless of
 * whether any recompute hook ran.
 */
export function classifyReminder(
  reminder: ScheduledReminder,
  event: EventSnapshot | null,
  now: Date,
  timeZone: string,
  opts: ClassifyOptions = {},
): ReminderDecision {
  if (event === null || event.deletedAt !== null) return { action: 'cancel' };

  const expected = reminderFireAt(event.startsAt, reminder.offset, timeZone);
  if (expected.getTime() !== reminder.fireAt.getTime()) return { action: 'stale' };

  if (event.startsAt.getTime() <= now.getTime()) return { action: 'suppress', reason: 'started' };
  if (reminder.fireAt.getTime() > now.getTime()) return { action: 'wait' };
  if (now.getTime() - reminder.fireAt.getTime() > REMINDER_MISS_GRACE_MS) {
    return { action: 'suppress', reason: 'missed' };
  }
  if (opts.recentInteraction) return { action: 'suppress', reason: 'interacted' };
  return { action: 'fire' };
}

/**
 * The reminder rows a live event SHOULD have — one per offset, each with its computed
 * fire_at. The scheduler converges the materialized ledger to this set (upsert fire_at,
 * so a move re-anchors), and never materializes for a deleted event. Pure.
 */
export function expectedReminders(event: EventSnapshot, timeZone: string): ScheduledReminder[] {
  if (event.deletedAt !== null) return [];
  return REMINDER_OFFSETS.map((offset) => ({
    eventRef: event.id,
    offset,
    fireAt: reminderFireAt(event.startsAt, offset, timeZone),
  }));
}

export interface FiringReminder {
  eventRef: string;
  parentUserId: string;
  offset: ReminderOffset;
  fireAt: Date;
}

export interface ReminderBatch {
  parentUserId: string;
  offset: ReminderOffset;
  /** The family-local evening key the batch fires on (`YYYY-MM-DD`). */
  eveningKey: string;
  eventRefs: string[];
}

/**
 * Merge same-evening T-24h reminders for one parent into ONE message (rule #4:
 * "Tomorrow: checkup 10:00 + swim 4:30"). T-1h reminders are glanceable and never
 * batched — each fires on its own. Grouping key is (parent, offset, family-local
 * evening of fire_at); event order within a batch is the input order.
 */
export function batchReminders(firing: readonly FiringReminder[], timeZone: string): ReminderBatch[] {
  const batches = new Map<string, ReminderBatch>();
  for (const r of firing) {
    const eveningKey = dayKeyIn(r.fireAt, timeZone);
    // T-1h never merges: a unique key per event keeps each its own batch of one.
    const mergeKey =
      r.offset === '-P1D'
        ? `${r.parentUserId}|${r.offset}|${eveningKey}`
        : `${r.parentUserId}|${r.offset}|${eveningKey}|${r.eventRef}`;
    const existing = batches.get(mergeKey);
    if (existing) existing.eventRefs.push(r.eventRef);
    else
      batches.set(mergeKey, {
        parentUserId: r.parentUserId,
        offset: r.offset,
        eveningKey,
        eventRefs: [r.eventRef],
      });
  }
  return [...batches.values()];
}
