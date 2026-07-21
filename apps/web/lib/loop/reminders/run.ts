import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { captureServerEvent } from '~/lib/analytics/server-capture';
import { CHANNEL_SEND_QUEUE } from '~/lib/channel/config';
import { HOT_QUEUE_EXPIRE_SECONDS } from '~/lib/cron/drain';
import { appBaseUrl, unsubscribeUrl } from '~/lib/cron/email-compliance';
import { loopSendEnabled } from '~/lib/loop/send';
import type {
  ReminderChild,
  ReminderEventView,
  ReminderPayload,
} from '~/lib/loop/templates/reminder/payload';
import { getQueue } from '~/lib/queue';
import {
  type EventSnapshot,
  REMINDER_OFFSETS,
  type ReminderOffset,
  type ReminderStatus,
  type SuppressReason,
  batchReminders,
  classifyReminder,
  offsetUrgency,
  reminderFireAt,
} from './schedule';

/**
 * VIL-223 · D1 — the reminder scheduler's hourly run. Two phases over the pure core
 * (schedule.ts):
 *
 *  A. CONVERGE — materialize the event_reminders ledger from live placed events, so
 *     cancellation is explicit + auditable and same-evening reminders are enumerable
 *     (batchable). A move re-anchors fire_at in place via the unique-key upsert; a
 *     soft-deleted event's rows go 'cancelled'.
 *  B. FIRE — for every due row, re-read the LIVE event and classify at send time. This
 *     check-at-send is THE trust gate: a cancelled/moved/started event can never nag,
 *     regardless of whether the converge hook ran. Firing rows batch per parent (T-24h
 *     merges the evening, T-1h stays glanceable) and enqueue onto the A2 channel.send
 *     queue — which enforces prefs/quiet/cap/consent/ledger/audit + the mirror legs.
 *
 * Compose-not-send: the whole SEND stays dark behind LOOP_SEND_ENABLED (mirroring
 * send.ts). When off, the run still converges + classifies (exercising the pipeline)
 * but enqueues nothing and marks nothing 'sent' — the due rows stay 'scheduled'.
 *
 * Caps are A2's job (per-parent/category/channel), enforced at dispatch. recentInteraction
 * is the C3 reply↔event link, not yet wired — the default returns false; the classify
 * path already carries rule #3, the data link lands with C3.
 */

const REMINDER_TEMPLATE_KEY = 'reminder';
const REMINDER_EMAIL_TYPE = 'reminder';
// Materialize a week-plus ahead so the ledger is warm before either offset's slot.
const REMINDER_HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

/** An enrolled parent whose reminder category is on. */
export interface ReminderParent {
  familyId: string;
  userId: string;
  timezone: string;
}

/** A live family_events snapshot carrying the fields the reminder copy needs, on top
 * of the classify gate's EventSnapshot (id, startsAt, deletedAt). */
export interface LiveEvent extends EventSnapshot {
  title: string;
  childId: string | null;
  /** family_events.sensitive — the reminder templates genericize a sensitive event. */
  sensitive: boolean;
}

/** A materialized reminder that is due (status 'scheduled', fire_at ≤ now), joined to
 * its parent's timezone for the family-local classify. */
export interface DueReminder {
  id: string;
  familyId: string;
  eventRef: string;
  parentUserId: string;
  offset: ReminderOffset;
  fireAt: Date;
  timezone: string;
}

/** The channel.send job the A2 drain consumes (contract-validated by
 * `channelSendJobPayloadSchema`). Reminder-shaped: category 'reminder', urgency per offset. */
export interface ChannelSendJob {
  templateKey: string;
  familyId: string;
  parentUserId: string;
  category: 'reminder';
  urgency: 'normal' | 'time_sensitive';
  payload: Record<string, unknown>;
  dedupeKey: string;
}

export interface ReminderRunDeps {
  selectReminderParents: (db: Database) => Promise<ReminderParent[]>;
  loadHorizonEvents: (db: Database, familyId: string, now: Date) => Promise<LiveEvent[]>;
  upsertReminder: (
    db: Database,
    row: {
      familyId: string;
      eventRef: string;
      parentUserId: string;
      offset: ReminderOffset;
      fireAt: Date;
    },
  ) => Promise<void>;
  cancelDeletedEventReminders: (db: Database, familyId: string) => Promise<void>;
  loadDueReminders: (db: Database, now: Date) => Promise<DueReminder[]>;
  loadEvent: (db: Database, eventRef: string) => Promise<LiveEvent | null>;
  recentInteraction: (
    db: Database,
    args: { parentUserId: string; eventRef: string; offset: ReminderOffset; now: Date },
  ) => Promise<boolean>;
  markStatus: (
    db: Database,
    reminderId: string,
    status: ReminderStatus,
    reason: SuppressReason | null,
  ) => Promise<void>;
  reanchor: (db: Database, reminderId: string, fireAt: Date) => Promise<void>;
  loadChildren: (db: Database, familyId: string) => Promise<ReminderChild[]>;
  enqueue: (job: ChannelSendJob) => Promise<void>;
  capture: typeof captureServerEvent;
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

export function defaultReminderRunDeps(): ReminderRunDeps {
  return {
    selectReminderParents: async (db) => {
      // Left-join loop_prefs: a parent with no row keeps the column default (cat_reminder
      // on), so `!== false` reads "no row OR explicitly on" — never a magic default here.
      const rows = await db
        .select({
          familyId: schema.familyMembers.familyId,
          userId: schema.users.id,
          timezone: schema.users.timezone,
          catReminder: schema.loopPrefs.catReminder,
        })
        .from(schema.familyMembers)
        .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
        .leftJoin(schema.loopPrefs, eq(schema.loopPrefs.userId, schema.users.id))
        .where(inArray(schema.familyMembers.role, ['primary_parent', 'co_parent']));
      return rows
        .filter((r) => r.catReminder !== false)
        .map((r) => ({ familyId: r.familyId, userId: r.userId, timezone: r.timezone }));
    },
    loadHorizonEvents: async (db, familyId, now) => {
      const horizonEnd = new Date(now.getTime() + REMINDER_HORIZON_MS);
      return db
        .select({
          id: schema.familyEvents.id,
          startsAt: schema.familyEvents.startsAt,
          deletedAt: schema.familyEvents.deletedAt,
          title: schema.familyEvents.title,
          childId: schema.familyEvents.childId,
          sensitive: schema.familyEvents.sensitive,
        })
        .from(schema.familyEvents)
        .where(
          and(
            eq(schema.familyEvents.familyId, familyId),
            inArray(schema.familyEvents.source, ['placement', 'parent']),
            gte(schema.familyEvents.startsAt, now),
            lte(schema.familyEvents.startsAt, horizonEnd),
            // Live only; a soft-deleted event never materializes a reminder.
            sql`${schema.familyEvents.deletedAt} is null`,
          ),
        );
    },
    upsertReminder: async (db, row) => {
      await db
        .insert(schema.eventReminders)
        .values({
          familyId: row.familyId,
          eventRef: row.eventRef,
          parentUserId: row.parentUserId,
          offset: row.offset,
          fireAt: row.fireAt,
          status: 'scheduled',
        })
        .onConflictDoUpdate({
          target: [
            schema.eventReminders.eventRef,
            schema.eventReminders.offset,
            schema.eventReminders.parentUserId,
          ],
          set: { fireAt: sqlExcluded('fire_at'), updatedAt: new Date() },
          // A move re-anchors a still-scheduled row in place; a fired/cancelled/
          // suppressed row is terminal and left untouched.
          setWhere: eq(schema.eventReminders.status, 'scheduled'),
        });
    },
    cancelDeletedEventReminders: async (db, familyId) => {
      const deletedEvents = db
        .select({ id: schema.familyEvents.id })
        .from(schema.familyEvents)
        .where(
          and(eq(schema.familyEvents.familyId, familyId), isNotNull(schema.familyEvents.deletedAt)),
        );
      await db
        .update(schema.eventReminders)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(
          and(
            eq(schema.eventReminders.familyId, familyId),
            eq(schema.eventReminders.status, 'scheduled'),
            inArray(schema.eventReminders.eventRef, deletedEvents),
          ),
        );
    },
    loadDueReminders: async (db, now) => {
      const rows = await db
        .select({
          id: schema.eventReminders.id,
          familyId: schema.eventReminders.familyId,
          eventRef: schema.eventReminders.eventRef,
          parentUserId: schema.eventReminders.parentUserId,
          offset: schema.eventReminders.offset,
          fireAt: schema.eventReminders.fireAt,
          timezone: schema.users.timezone,
        })
        .from(schema.eventReminders)
        .innerJoin(schema.users, eq(schema.eventReminders.parentUserId, schema.users.id))
        .where(
          and(
            eq(schema.eventReminders.status, 'scheduled'),
            lte(schema.eventReminders.fireAt, now),
          ),
        );
      return rows.map((r) => ({ ...r, offset: r.offset as ReminderOffset }));
    },
    loadEvent: async (db, eventRef) => {
      // No deleted_at filter: the live snapshot must carry deletedAt so classify can
      // return 'cancel' for a soft-deleted event (the trust gate).
      const rows = await db
        .select({
          id: schema.familyEvents.id,
          startsAt: schema.familyEvents.startsAt,
          deletedAt: schema.familyEvents.deletedAt,
          title: schema.familyEvents.title,
          childId: schema.familyEvents.childId,
          sensitive: schema.familyEvents.sensitive,
        })
        .from(schema.familyEvents)
        .where(eq(schema.familyEvents.id, eventRef))
        .limit(1);
      return rows[0] ?? null;
    },
    // C3 (reply↔event link) isn't wired yet: the classify path carries rule #3, the
    // data link lands with C3. Until then no reminder is suppressed as 'interacted'.
    recentInteraction: async () => false,
    markStatus: async (db, reminderId, status, reason) => {
      await db
        .update(schema.eventReminders)
        .set({ status, suppressReason: reason, updatedAt: new Date() })
        .where(eq(schema.eventReminders.id, reminderId));
    },
    reanchor: async (db, reminderId, fireAt) => {
      await db
        .update(schema.eventReminders)
        .set({ fireAt, updatedAt: new Date() })
        .where(eq(schema.eventReminders.id, reminderId));
    },
    loadChildren: async (db, familyId) =>
      db
        .select({
          id: schema.children.id,
          name: schema.children.name,
          dateOfBirth: schema.children.dateOfBirth,
          gender: schema.children.gender,
        })
        .from(schema.children)
        .where(eq(schema.children.familyId, familyId)),
    enqueue: async (job) => {
      const queue = await getQueue();
      await queue.send(CHANNEL_SEND_QUEUE, job, { expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS });
    },
    capture: captureServerEvent,
  };
}

export interface ReminderRunResult {
  converged: number;
  due: number;
  fired: number;
  suppressed: number;
  cancelled: number;
  sendEnabled: boolean;
}

/** A classified fire, carrying the row identity + the live event fields the payload needs. */
interface FiringRow {
  reminderId: string;
  familyId: string;
  eventRef: string;
  parentUserId: string;
  offset: ReminderOffset;
  fireAt: Date;
  timezone: string;
  title: string;
  startsAt: Date;
  childId: string | null;
  sensitive: boolean;
}

interface ParentFiring {
  familyId: string;
  timezone: string;
  rows: FiringRow[];
}

/**
 * One hourly run: converge the ledger, then fire the due reminders that survive a
 * fresh classify against the live event. The founder's LOOP_SEND_ENABLED gates the
 * enqueue; when off, the run composes but sends nothing and leaves rows 'scheduled'.
 */
export async function runReminderCron(
  db: Database,
  deps: ReminderRunDeps = defaultReminderRunDeps(),
  now: Date = new Date(),
): Promise<ReminderRunResult> {
  // ── Phase A: converge the ledger from live placed events ─────────────────────
  const parents = await deps.selectReminderParents(db);
  const familyParents = new Map<string, ReminderParent[]>();
  for (const p of parents) {
    const existing = familyParents.get(p.familyId);
    if (existing) existing.push(p);
    else familyParents.set(p.familyId, [p]);
  }

  let converged = 0;
  for (const [familyId, famParents] of familyParents) {
    const events = await deps.loadHorizonEvents(db, familyId, now);
    for (const parent of famParents) {
      for (const event of events) {
        for (const offset of REMINDER_OFFSETS) {
          const fireAt = reminderFireAt(event.startsAt, offset, parent.timezone);
          await deps.upsertReminder(db, {
            familyId,
            eventRef: event.id,
            parentUserId: parent.userId,
            offset,
            fireAt,
          });
          converged += 1;
        }
      }
    }
    // Belt-and-suspenders: the check-at-send below is the real guard, but a scheduled
    // row for a soft-deleted event is cancelled here so the ledger reads true.
    await deps.cancelDeletedEventReminders(db, familyId);
  }

  // ── Phase B: fire — classify each due row against the LIVE event ──────────────
  const due = await deps.loadDueReminders(db, now);
  const firing: FiringRow[] = [];
  let suppressed = 0;
  let cancelled = 0;

  for (const row of due) {
    const event = await deps.loadEvent(db, row.eventRef);
    const interacted = await deps.recentInteraction(db, {
      parentUserId: row.parentUserId,
      eventRef: row.eventRef,
      offset: row.offset,
      now,
    });
    const decision = classifyReminder(
      { eventRef: row.eventRef, offset: row.offset, fireAt: row.fireAt },
      event,
      now,
      row.timezone,
      { recentInteraction: interacted },
    );

    switch (decision.action) {
      case 'cancel':
        // The trust invariant: a gone/soft-deleted event is cancelled, NEVER enqueued.
        await deps.markStatus(db, row.id, 'cancelled', null);
        cancelled += 1;
        break;
      case 'suppress':
        await deps.markStatus(db, row.id, 'suppressed', decision.reason);
        suppressed += 1;
        break;
      case 'stale':
        // event is non-null for every non-cancel decision; the guard narrows the type.
        if (event)
          await deps.reanchor(db, row.id, reminderFireAt(event.startsAt, row.offset, row.timezone));
        break;
      case 'fire':
        if (event) {
          firing.push({
            reminderId: row.id,
            familyId: row.familyId,
            eventRef: row.eventRef,
            parentUserId: row.parentUserId,
            offset: row.offset,
            fireAt: row.fireAt,
            timezone: row.timezone,
            title: event.title,
            startsAt: event.startsAt,
            childId: event.childId,
            sensitive: event.sensitive,
          });
        }
        break;
      case 'wait':
        break;
    }
  }

  // Group firing rows by parent (one parent → one timezone) for batching.
  const byParent = new Map<string, ParentFiring>();
  for (const r of firing) {
    const existing = byParent.get(r.parentUserId);
    if (existing) existing.rows.push(r);
    else byParent.set(r.parentUserId, { familyId: r.familyId, timezone: r.timezone, rows: [r] });
  }

  const sendEnabled = loopSendEnabled();
  let fired = 0;

  for (const [parentUserId, group] of byParent) {
    const batches = batchReminders(group.rows, group.timezone);
    const children = await deps.loadChildren(db, group.familyId);
    const rowByRef = new Map(group.rows.map((r) => [r.eventRef, r] as const));

    for (const batch of batches) {
      const [firstRef] = batch.eventRefs;
      if (!firstRef) continue; // a batch always has ≥1 event

      const events: ReminderEventView[] = [];
      for (const ref of batch.eventRefs) {
        const r = rowByRef.get(ref);
        if (r) {
          events.push({
            eventRef: r.eventRef,
            title: r.title,
            startsAt: r.startsAt.toISOString(),
            childId: r.childId,
            sensitive: r.sensitive,
          });
        }
      }

      // Rule #6: no deep link on the glanceable T-1h; /plan on the evening-before T-24h.
      const deepLink = batch.offset === '-P1D' ? `${appBaseUrl()}/plan` : null;
      const payload: ReminderPayload = {
        offset: batch.offset,
        timeZone: group.timezone,
        events,
        children,
        deepLink,
        unsubscribeUrl: unsubscribeUrl({ userId: parentUserId, emailType: REMINDER_EMAIL_TYPE }),
      };
      // Batch key: the single event for T-1h, the evening for a merged T-24h.
      const batchKey = batch.offset === '-P1D' ? batch.eveningKey : firstRef;
      const job: ChannelSendJob = {
        templateKey: REMINDER_TEMPLATE_KEY,
        familyId: group.familyId,
        parentUserId,
        category: 'reminder',
        urgency: offsetUrgency(batch.offset),
        payload: payload as unknown as Record<string, unknown>,
        dedupeKey: `reminder:${batch.offset}:${parentUserId}:${batchKey}`,
      };

      // Compose-not-send: only reach real families once the founder flips the flag.
      if (!sendEnabled) continue;

      await deps.enqueue(job);
      for (const ref of batch.eventRefs) {
        const r = rowByRef.get(ref);
        if (r) await deps.markStatus(db, r.reminderId, 'sent', null);
      }
      fired += batch.eventRefs.length;
      // Coarse telemetry (buildEvent drops any PII key): counts + enum only.
      await deps.capture('reminder_sent', parentUserId, {
        offset: batch.offset,
        events: batch.eventRefs.length,
      });
    }
  }

  return { converged, due: due.length, fired, suppressed, cancelled, sendEnabled };
}
