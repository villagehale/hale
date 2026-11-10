import type { AgentClient } from '@hale/agent';
import { type Database, type FamilyEventNotes, schema } from '@hale/db';
import { and, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { type RecordAgentRunInput, recordAgentRun } from '~/lib/agent-run';
import { captureServerEvent } from '~/lib/analytics/server-capture';
import { CHANNEL_SEND_QUEUE } from '~/lib/channel/config';
import { coparentSplitDutyActive } from '~/lib/channel/coparent/duty/flag';
import { loadLiveDutyFacts } from '~/lib/channel/coparent/duty/model';
import {
  confirmedParentDutyOwners,
  resolveSplitReminderOwner,
  splitReminderDecision,
} from '~/lib/channel/coparent/duty/split-target';
import { laneEnabled } from '~/lib/channel/lanes';
import type { ReplyLanguage } from '~/lib/channel/language';
import { proactiveFloorOpensAt, proactiveQuietNow } from '~/lib/channel/outbound-gate';
import { readParentLanguage } from '~/lib/channel/parent-language';
import {
  type FamilyRole,
  classifyFamilyEvent,
  isCaregiverRole,
  isParentRole,
  roleAllows,
} from '~/lib/channel/role-scope';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { HOT_QUEUE_EXPIRE_SECONDS } from '~/lib/cron/drain';
import { unsubscribeUrl } from '~/lib/cron/email-compliance';
import { type CaregiverSeat, selectCaregiverSeats } from '~/lib/loop/caregiver-audience';
import {
  type ChildNameLevel,
  type LoopPrefsView,
  deliverableNow,
  loadLoopPrefsView,
} from '~/lib/loop/prefs';
import { loopSendEnabled } from '~/lib/loop/send';
import { CAREGIVER_REMINDER_TEMPLATE_KEY } from '~/lib/loop/templates/caregiver/keys';
import type { CaregiverReminderPayload } from '~/lib/loop/templates/caregiver/payload';
import type {
  ReminderChild,
  ReminderEventView,
  ReminderPayload,
} from '~/lib/loop/templates/reminder/payload';
import { voiceClient } from '~/lib/loop/voice/compose';
import {
  type ProviderErrorShape,
  type ProviderFailureClass,
  type ProviderHealth,
  probeProviderHealth,
} from '~/lib/monitoring/provider-health';
import { scopeFamilies } from '~/lib/preview/family-scope';
import { getQueue } from '~/lib/queue';
import type { SourceChange } from './change';
import { changeFromColumns } from './change';
import { composeReminderTexts, reminderFacts } from './compose';
import {
  COMPOSE_HELD,
  type DropReason,
  type EventSnapshot,
  REMINDER_HORIZON_MS,
  REMINDER_OFFSETS,
  type ReminderOffset,
  type ReminderStatus,
  type SuppressReason,
  batchReminders,
  classifyReminder,
  isLateFire,
  nextComposeHold,
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
 *     merges the evening, T-1h stays glanceable). A batch that falls inside the proactive
 *     quiet floor or the recipient's own window is held here, before anything is written
 *     (VIL-562): the dispatch's own quiet check comes after the row is marked 'sent', so
 *     a hold there is a lost reminder. The rest enqueue onto the A2 channel.send queue,
 *     which enforces prefs/cap/consent/ledger/audit + the mirror legs.
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

/** A row mirrored from a parent's own calendar that no `kid` verdict covers (VIL-548). */
const mirrorUnjudged = (event: LiveEvent): boolean =>
  event.googleEventId !== null && event.kidVerdict !== 'kid';
const REMINDER_EMAIL_TYPE = 'reminder';

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
  /** family_events.ends_at — the end the reminder states, with its AM/PM. */
  endsAt?: Date | null;
  childId: string | null;
  /** family_events.sensitive — the reminder templates genericize a sensitive event, and
   * `classifyFamilyEvent` refuses it to a caregiver outright. */
  sensitive: boolean;
  /** Where to be. Unused by the parents' copy (they know), and half of what a caregiver's
   * `event_logistics` scope is FOR. */
  location: string | null;
  /** VIL-474 · a change recorded from source data only (reminders/change.ts). */
  change?: SourceChange | null;
  /** VIL-468. Parking / what-to-bring facts the source stated, or null. */
  notes?: FamilyEventNotes | null;
  /**
   * Set when this row mirrors one event on a connected Google Calendar (VIL-416).
   * Null for every Hale-authored event. A mirror is reminded to its owner only —
   * a co-parent and a caregiver do not hear a work block that lives on one
   * parent's calendar. The send itself still rides channel.send, so consent,
   * the frequency cap and quiet hours are the dispatch's.
   */
  googleEventId: string | null;
  /** Hale's write-back copy of this placement on a parent's Google Calendar. */
  placedGoogleEventId?: string | null;
  /** `family_events.duty_owner_user_id` — who is driving, when duty is recorded. */
  dutyOwnerUserId: string | null;
  /** `family_events.created_by`. For a mirror this is the parent who connected
   * that calendar. Null when the row has no acting user. */
  createdBy: string | null;
  /**
   * VIL-548 · the LIVE verdict behind `family_events.kid_verdict_id`, or null when the row
   * links none. A mirror is reminded about only while this is `kid`: the mirror writes the
   * link when the kid judge says so and clears it when a changed event is not yet judged.
   * Required, like `DueReminder.role`, so a fake that omits it is a compile error.
   */
  kidVerdict: 'kid' | 'adult' | 'unsure' | null;
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
  /**
   * The recipient's LIVE role in this family, or null when they no longer hold a seat.
   *
   * Carried on the row rather than inferred from the converge audience, for the reason
   * phase B re-reads its event: a scheduled row can outlive the reason it was written. A
   * caregiver who was seated a week ago may have left, and the audience they were selected
   * into no longer exists to be asked. It is required (not optional) so a fake that omits
   * it is a compile error rather than a leg that quietly stops being checked.
   */
  role: FamilyRole | null;
  /**
   * Whether this recipient holds a verified, non-revoked SMS channel RIGHT NOW — the
   * other half of "active seat", and what a caregiver's STOP takes away.
   *
   * On the row for the same reason the role is, and it was the one fact this gate used to
   * borrow from `selectReminderCaregivers`: a list assembled to fan CONVERGE out over
   * seats, which may legitimately be bounded, re-ordered or (for a run with no caregiver
   * work) empty. Read as a membership test it turns any of those into a permanent
   * `out_of_scope` on a live seat's due reminder — a refusal manufactured by a knob that
   * was never about this person. Only a caregiver leg consults it: a parent's reminder can
   * ride email, and their SMS state is the dispatch's to judge.
   */
  smsChannelActive: boolean;
  /** VIL-625 · how many times the writer has already failed this row (nextComposeHold). */
  composeAttempts: number;
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
  /** Pins a caregiver's leg to SMS — they have no address (see loop/send.ts). */
  channel?: 'sms';
}

export interface ReminderRunDeps {
  /**
   * Preview family scope applied to the audience and due rows. Defaults to the
   * PREVIEW_FAMILY_ALLOWLIST filter (a no-op off preview). The VIL-466 Preview trigger
   * replaces it, since it already narrows the run to one verified fake family.
   */
  scopeFamilies?: <T extends { familyId: string }>(rows: readonly T[]) => T[];
  selectReminderParents: (db: Database) => Promise<ReminderParent[]>;
  /**
   * The family's ACTIVE caregiver seats (caregiver-audience.ts) — the second audience,
   * added by VIL-241 · M6.
   *
   * No per-category pre-filter, unlike the parents' selector, and that is a fact about
   * the data rather than a gap: nothing writes a `loop_prefs` row for a caregiver (there
   * is no settings surface they can reach), so every seat sits on the documented default
   * and there is nothing to filter on. The dispatch's `categoryEnabled` remains the
   * enforcement if one ever appears.
   */
  selectReminderCaregivers: (db: Database) => Promise<CaregiverSeat[]>;
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
  /** Never writes the COMPOSE_HELD mark: only `holdForCompose` does, so no hold can be
   * written without the try count and the next-try time that bound it (VIL-625). */
  markStatus: (
    db: Database,
    reminderId: string,
    status: ReminderStatus,
    reason: DropReason | null,
  ) => Promise<void>;
  /** VIL-625 · leaves the row 'scheduled' under the COMPOSE_HELD mark, not to be asked
   * again before `nextTryAt`. */
  holdForCompose: (
    db: Database,
    reminderId: string,
    hold: { attempts: number; nextTryAt: Date },
  ) => Promise<void>;
  /** The audit row for a due reminder the fire path dropped (rule #6). */
  auditSuppressed: (
    db: Database,
    row: { familyId: string; reminderId: string; offset: ReminderOffset; reason: SuppressReason },
  ) => Promise<void>;
  reanchor: (db: Database, reminderId: string, fireAt: Date) => Promise<void>;
  loadChildren: (db: Database, familyId: string) => Promise<ReminderChild[]>;
  enqueue: (job: ChannelSendJob) => Promise<void>;
  capture: typeof captureServerEvent;
  /** The agent client that writes a parent's reminder. Null means no parent reminder
   * can be written, so none is sent (there is no fallback copy). */
  client: AgentClient | null;
  /** The recipient's one proactive language (VIL-572), for the model-written reminder. */
  loadLanguage: (db: Database, familyId: string, parentUserId: string) => Promise<ReplyLanguage>;
  /** Writes the whole reminder from facts, or names why it could not (VIL-563). */
  composeText: typeof composeReminderTexts;
  /** VIL-563 · one agent_runs row per writer attempt, so a reminder outage is visible to
   * the failed-run backstop. */
  recordAgentRun: (db: Database, input: RecordAgentRunInput) => Promise<void>;
  /** VIL-229 · the parent's resolved child-name-level dial, for the SAME redacted view
   * (rule #1) the voice stage hands the model and the template later renders. */
  loadNameLevel: (db: Database, userId: string) => Promise<ChildNameLevel>;
  /** VIL-562 · the recipient's own quiet window and urgent-bypass toggle. */
  loadPrefs: (db: Database, userId: string) => Promise<LoopPrefsView>;
  /** VIL-562 · the recipient's sendable number, read only while proactive cadence is
   * armed (the Florida and Oklahoma 20:00 start), exactly as the outbound gate reads it. */
  parentPhone: (db: Database, userId: string) => Promise<string | null>;
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

/** The due ledger rows (status 'scheduled', fire_at ≤ now), each with what the fire gate
 * needs to know about its recipient. `held` narrows them to the rows carrying that hold
 * mark. */
async function selectDueReminders(
  db: Database,
  now: Date,
  held: typeof COMPOSE_HELD | null,
): Promise<DueReminder[]> {
  const rows = await db
    .select({
      id: schema.eventReminders.id,
      familyId: schema.eventReminders.familyId,
      eventRef: schema.eventReminders.eventRef,
      parentUserId: schema.eventReminders.parentUserId,
      offset: schema.eventReminders.offset,
      fireAt: schema.eventReminders.fireAt,
      timezone: schema.users.timezone,
      role: schema.familyMembers.role,
      channelId: schema.parentChannels.id,
      composeAttempts: schema.eventReminders.composeAttempts,
    })
    .from(schema.eventReminders)
    .innerJoin(schema.users, eq(schema.eventReminders.parentUserId, schema.users.id))
    // LEFT, so a row whose recipient has left the family still arrives — with a null
    // role, which the fire path reads as "prove nothing" and suppresses.
    .leftJoin(
      schema.familyMembers,
      and(
        eq(schema.familyMembers.familyId, schema.eventReminders.familyId),
        eq(schema.familyMembers.userId, schema.eventReminders.parentUserId),
      ),
    )
    // The SAME three columns caregiver-audience.ts joins on, asked per row. At most one
    // row can match (`parent_channels_user_kind_active_idx` is unique on (user, kind)
    // among the non-revoked), so this widens the result set by nothing.
    .leftJoin(
      schema.parentChannels,
      and(
        eq(schema.parentChannels.userId, schema.eventReminders.parentUserId),
        eq(schema.parentChannels.kind, 'sms'),
        isNotNull(schema.parentChannels.verifiedAt),
        isNull(schema.parentChannels.revokedAt),
      ),
    )
    .where(
      and(
        eq(schema.eventReminders.status, 'scheduled'),
        lte(schema.eventReminders.fireAt, now),
        or(
          isNull(schema.eventReminders.composeNextTryAt),
          lte(schema.eventReminders.composeNextTryAt, now),
        ),
        held ? eq(schema.eventReminders.suppressReason, held) : undefined,
      ),
    );
  return rows.map(({ channelId, ...r }) => ({
    ...r,
    offset: r.offset as ReminderOffset,
    role: (r.role as FamilyRole | null) ?? null,
    smsChannelActive: channelId !== null,
  }));
}

export function defaultReminderRunDeps(): ReminderRunDeps {
  return {
    selectReminderCaregivers: selectCaregiverSeats,
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
          endsAt: schema.familyEvents.endsAt,
          deletedAt: schema.familyEvents.deletedAt,
          title: schema.familyEvents.title,
          childId: schema.familyEvents.childId,
          sensitive: schema.familyEvents.sensitive,
          location: schema.familyEvents.location,
          notes: schema.familyEvents.notes,
          googleEventId: schema.familyEvents.googleEventId,
          placedGoogleEventId: schema.familyEvents.placedGoogleEventId,
          createdBy: schema.familyEvents.createdBy,
          dutyOwnerUserId: schema.familyEvents.dutyOwnerUserId,
          kidVerdict: schema.kidRelevanceVerdicts.verdict,
        })
        .from(schema.familyEvents)
        .leftJoin(
          schema.kidRelevanceVerdicts,
          eq(schema.kidRelevanceVerdicts.id, schema.familyEvents.kidVerdictId),
        )
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
    loadDueReminders: (db, now) => selectDueReminders(db, now, null),
    loadEvent: async (db, eventRef) => {
      // No deleted_at filter: the live snapshot must carry deletedAt so classify can
      // return 'cancel' for a soft-deleted event (the trust gate).
      const rows = await db
        .select({
          id: schema.familyEvents.id,
          startsAt: schema.familyEvents.startsAt,
          endsAt: schema.familyEvents.endsAt,
          deletedAt: schema.familyEvents.deletedAt,
          title: schema.familyEvents.title,
          childId: schema.familyEvents.childId,
          sensitive: schema.familyEvents.sensitive,
          location: schema.familyEvents.location,
          notes: schema.familyEvents.notes,
          googleEventId: schema.familyEvents.googleEventId,
          placedGoogleEventId: schema.familyEvents.placedGoogleEventId,
          createdBy: schema.familyEvents.createdBy,
          dutyOwnerUserId: schema.familyEvents.dutyOwnerUserId,
          kidVerdict: schema.kidRelevanceVerdicts.verdict,
          sourceChangedField: schema.familyEvents.sourceChangedField,
          sourceChangedFromStartsAt: schema.familyEvents.sourceChangedFromStartsAt,
          sourceChangedFromLocation: schema.familyEvents.sourceChangedFromLocation,
          sourceChangedAt: schema.familyEvents.sourceChangedAt,
        })
        .from(schema.familyEvents)
        .leftJoin(
          schema.kidRelevanceVerdicts,
          eq(schema.kidRelevanceVerdicts.id, schema.familyEvents.kidVerdictId),
        )
        .where(eq(schema.familyEvents.id, eventRef))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      const {
        sourceChangedField,
        sourceChangedFromStartsAt,
        sourceChangedFromLocation,
        sourceChangedAt,
        ...event
      } = row;
      return {
        ...event,
        change: changeFromColumns(
          {
            sourceChangedField,
            sourceChangedFromStartsAt,
            sourceChangedFromLocation,
            sourceChangedAt,
          },
          new Date(),
        ),
      };
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
    holdForCompose: async (db, reminderId, hold) => {
      await db
        .update(schema.eventReminders)
        .set({
          status: 'scheduled',
          suppressReason: COMPOSE_HELD,
          composeAttempts: hold.attempts,
          composeNextTryAt: hold.nextTryAt,
          updatedAt: new Date(),
        })
        .where(eq(schema.eventReminders.id, reminderId));
    },
    auditSuppressed: async (db, row) => {
      await db.insert(schema.auditLog).values({
        familyId: row.familyId,
        actor: 'system',
        actionTaken: 'reminder_suppressed',
        targetTable: 'event_reminders',
        targetId: row.reminderId,
        after: { reason: row.reason, offset: row.offset },
      });
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
    client: voiceClient(),
    loadLanguage: (db, familyId, parentUserId) =>
      readParentLanguage(db, { familyId, parentUserId }),
    composeText: composeReminderTexts,
    recordAgentRun: async (db, input) => {
      await recordAgentRun(db, input);
    },
    loadNameLevel: async (db, userId) => (await loadLoopPrefsView(userId, db)).childNameLevel,
    loadPrefs: (db, userId) => loadLoopPrefsView(userId, db),
    parentPhone: resolveSendablePhone,
  };
}

export interface ReminderRunResult {
  converged: number;
  due: number;
  fired: number;
  /** Of `fired`, the reminders sent more than one cron tick after their slot (see
   * `isLateFire`): held while a lane was off, or caught up after a cron gap. */
  firedLate: number;
  suppressed: number;
  cancelled: number;
  /** Due reminders on a mirrored Google event left 'scheduled' because the
   * parent_calendar_mirror lane is off. They are classified again once it is on: one whose
   * event has not started is sent late, one whose event has started is suppressed as
   * 'started', each with its reason logged. */
  heldLaneOff: number;
  /** Reminder rows not created for a mirrored Google event because the
   * parent_calendar_mirror lane is off. They are created on the first run after it is on. */
  notScheduledLaneOff: number;
  /** VIL-548 · due reminders on a mirrored Google event left 'scheduled' because the event
   * does not link to a `kid` verdict. Held, not suppressed (that is terminal): once the
   * mirror judges it kid it is sent, late if its slot passed; judged otherwise, the mirror
   * drops the event and the reminder is cancelled; started first, it is suppressed. */
  heldNoKidVerdict: number;
  /** VIL-548 · reminder rows not created for a mirrored Google event that does not link to
   * a `kid` verdict. They are created on the first run after the mirror judges it kid. */
  notScheduledNoKidVerdict: number;
  /** VIL-562 · due reminders left 'scheduled' because the proactive floor or the
   * recipient's own window is closed and the floor opens before the event starts. Checked
   * again at the next slot: sent late if the event has not started, suppressed 'started'
   * if it has. One whose event starts before the floor opens is suppressed 'quiet_hours'
   * instead, and counted in `suppressed`. */
  heldQuietHours: number;
  /** VIL-563 · due reminders left 'scheduled' because the writer could not be reached (a
   * provider fault that can clear, or a skill that did not load), marked COMPOSE_HELD.
   * Checked again at the next slot, and a T-1h by the drain before that (VIL-586). A refused draft is dropped ('unwritten'), and so is a
   * request the provider rejected or our own bug ('compose_rejected'). Each hold backs off
   * (nextComposeHold); the last try drops it as 'compose_retries_exhausted' (VIL-625). */
  heldComposeUnavailable: number;
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
  endsAt: Date | null;
  childId: string | null;
  sensitive: boolean;
  location: string | null;
  change: SourceChange | null;
  notes: FamilyEventNotes | null;
  composeAttempts: number;
  /** Proven non-null by the fire gate: a row whose recipient holds no seat never gets
   * here. Non-parent roles other than the three caregiver ones are suppressed too, so
   * this is either a parent role or a caregiver one. */
  role: FamilyRole;
}

/**
 * The rows that become ONE household's message to ONE recipient.
 *
 * Keyed on (family, recipient) rather than the recipient alone, because neither of the
 * two facts hanging off this group — the familyId every ledger and audit row is written
 * under, and the role that chooses the template — is a property of the person. A sitter
 * works for two families; a parent of one household is the nanny of another. Grouped by
 * recipient, the first row's family and role decided the whole batch: a second
 * household's evening merged into the first one's text (no ledger row, no audit row of
 * its own), and a recipient's two roles collapsed to whichever row the ledger happened
 * to return first — the parents' template for a household that only seated them as a
 * nanny, or the caregiver's for their own teenager's appointment, teen gate and all.
 *
 * (family, recipient) is also the EXACT grain: `family_members` is keyed
 * (family_id, user_id), so role — and the timezone read beside it — is single-valued
 * here and at no coarser key.
 */
interface RecipientFiring {
  familyId: string;
  parentUserId: string;
  timezone: string;
  role: FamilyRole;
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
  const childrenFor = childLoader(db, deps);
  const scope = deps.scopeFamilies ?? ((rows) => scopeFamilies(rows));

  // ── Phase A: converge the ledger from live placed events ─────────────────────
  // On Preview, only allowlisted test families (no-op elsewhere).
  const parents = scope(await deps.selectReminderParents(db));
  const caregiverSeats = scope(await deps.selectReminderCaregivers(db));

  const familyParents = new Map<string, ReminderParent[]>();
  for (const p of parents) {
    const existing = familyParents.get(p.familyId);
    if (existing) existing.push(p);
    else familyParents.set(p.familyId, [p]);
  }
  const familyCaregivers = new Map<string, CaregiverSeat[]>();
  for (const seat of caregiverSeats) {
    const existing = familyCaregivers.get(seat.familyId);
    if (existing) existing.push(seat);
    else familyCaregivers.set(seat.familyId, [seat]);
  }

  let converged = 0;
  let notScheduledLaneOff = 0;
  let notScheduledNoKidVerdict = 0;
  const mirrorLaneOn = laneEnabled('parent_calendar_mirror');
  for (const familyId of new Set([...familyParents.keys(), ...familyCaregivers.keys()])) {
    const events = await deps.loadHorizonEvents(db, familyId, now);
    const materialize = async (userId: string, timezone: string, event: LiveEvent) => {
      for (const offset of REMINDER_OFFSETS) {
        await deps.upsertReminder(db, {
          familyId,
          eventRef: event.id,
          parentUserId: userId,
          offset,
          fireAt: reminderFireAt(event.startsAt, offset, timezone),
        });
        converged += 1;
      }
    };

    for (const parent of familyParents.get(familyId) ?? []) {
      for (const event of events) {
        // A Google mirror is that parent's own calendar. The other parent already
        // has a reminder when Hale itself placed the event (googleEventId null).
        if (event.googleEventId && event.createdBy !== parent.userId) continue;
        if (event.googleEventId && !mirrorLaneOn) {
          notScheduledLaneOff += REMINDER_OFFSETS.length;
          continue;
        }
        if (mirrorUnjudged(event)) {
          notScheduledNoKidVerdict += REMINDER_OFFSETS.length;
          continue;
        }
        await materialize(parent.userId, parent.timezone, event);
      }
    }

    // The caregiver seats, scoped. Materializing only what the role may see is what keeps
    // the fan-out honest AND small — a household whose week is mostly a teenager's writes
    // no rows for a grandparent instead of writing them and suppressing them at fire.
    // The gate is re-applied at fire regardless: a child has a birthday.
    const seats = familyCaregivers.get(familyId) ?? [];
    if (seats.length > 0) {
      const children = await childrenFor(familyId);
      for (const seat of seats) {
        for (const event of events) {
          // A raw calendar mirror is not a household occasion a caregiver was
          // told about. Hale-authored rows (no google id) keep the role gate.
          if (event.googleEventId) continue;
          if (!roleAllows(seat.role, classifyFamilyEvent(event, children, now))) continue;
          await materialize(seat.userId, seat.timezone, event);
        }
      }
    }

    // Belt-and-suspenders: the check-at-send below is the real guard, but a scheduled
    // row for a soft-deleted event is cancelled here so the ledger reads true.
    await deps.cancelDeletedEventReminders(db, familyId);
  }

  const fire = await fireDueReminders(
    db,
    deps,
    now,
    scope(await deps.loadDueReminders(db, now)),
    childrenFor,
  );

  if (fire.heldNoKidVerdict > 0 || notScheduledNoKidVerdict > 0) {
    console.info(
      { heldNoKidVerdict: fire.heldNoKidVerdict, notScheduledNoKidVerdict },
      'reminder: mirror rows without a kid verdict, not sent',
    );
  }

  return { converged, notScheduledLaneOff, notScheduledNoKidVerdict, ...fire };
}

/** The family's children, read at most once per run per family: the deterministic teen
 * age gate needs them, and both phases ask. */
function childLoader(
  db: Database,
  deps: Pick<ReminderRunDeps, 'loadChildren'>,
): (familyId: string) => Promise<ReminderChild[]> {
  const cache = new Map<string, ReminderChild[]>();
  return async (familyId) => {
    const hit = cache.get(familyId);
    if (hit) return hit;
    const loaded = await deps.loadChildren(db, familyId);
    cache.set(familyId, loaded);
    return loaded;
  };
}

/** What the fire phase did with the due rows it was handed. */
type ReminderFireResult = Omit<
  ReminderRunResult,
  'converged' | 'notScheduledLaneOff' | 'notScheduledNoKidVerdict'
>;

/** Phase B: classify each due row against the LIVE event, then hold, drop or send it. */
async function fireDueReminders(
  db: Database,
  deps: ReminderRunDeps,
  now: Date,
  due: DueReminder[],
  childrenFor: (familyId: string) => Promise<ReminderChild[]>,
): Promise<ReminderFireResult> {
  const mirrorLaneOn = laneEnabled('parent_calendar_mirror');

  /**
   * MAY THIS RECIPIENT BE TOLD ABOUT THIS EVENT, right now — the role half of the trust
   * gate, asked of the LIVE row the way the classify above asks about the live event.
   *
   * A parent's answer is unchanged and unconditional. Everyone else has to prove it: a
   * caregiver must still hold an active seat (an accepted membership AND a verified,
   * non-revoked channel — their STOP lands here), and the event must fall inside the
   * three classes their role allows. Anything else — a departed member, one of the two
   * legacy vague roles, a row whose seat is simply gone — fails closed.
   *
   * EVERY FACT COMES FROM THE ROW, none from the run's audience list. A gate that reads a
   * fan-out list refuses whatever that list happened not to contain.
   */
  const recipientMaySee = async (row: DueReminder, event: LiveEvent): Promise<boolean> => {
    const role = row.role;
    if (role !== null && isParentRole(role)) return true;
    if (role === null || !isCaregiverRole(role)) return false;
    if (!row.smsChannelActive) return false;
    return roleAllows(role, classifyFamilyEvent(event, await childrenFor(row.familyId), now));
  };

  const firing: FiringRow[] = [];
  const dutyOwnersByFamily = new Map<string, Map<string, string>>();
  const dutyOwnersFor = async (familyId: string): Promise<Map<string, string>> => {
    const cached = dutyOwnersByFamily.get(familyId);
    if (cached) return cached;
    const owners = confirmedParentDutyOwners(await loadLiveDutyFacts(db, familyId));
    dutyOwnersByFamily.set(familyId, owners);
    return owners;
  };
  let suppressed = 0;
  let cancelled = 0;
  let heldLaneOff = 0;
  let heldNoKidVerdict = 0;

  const drop = async (
    row: Pick<DueReminder, 'id' | 'familyId' | 'offset'>,
    reason: DropReason,
  ): Promise<void> => {
    await deps.markStatus(db, row.id, 'suppressed', reason);
    const dropped = { familyId: row.familyId, reminderId: row.id, offset: row.offset, reason };
    console.info(dropped, 'reminder: dropped, not sent');
    await deps.auditSuppressed(db, dropped);
    suppressed += 1;
  };

  for (const row of due) {
    const event = await deps.loadEvent(db, row.eventRef);
    if (event?.googleEventId && !mirrorLaneOn) {
      heldLaneOff += 1;
      continue;
    }
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
        await drop(row, decision.reason);
        break;
      case 'stale':
        // event is non-null for every non-cancel decision; the guard narrows the type.
        if (event)
          await deps.reanchor(db, row.id, reminderFireAt(event.startsAt, row.offset, row.timezone));
        break;
      case 'fire':
        if (event) {
          // Left 'scheduled', like the lane-off hold: a suppression is terminal and would
          // lose a kid reminder the mirror has not judged yet.
          if (mirrorUnjudged(event)) {
            heldNoKidVerdict += 1;
            break;
          }
          if (!(await recipientMaySee(row, event))) {
            await drop(row, 'out_of_scope');
            break;
          }
          if (
            coparentSplitDutyActive(row.familyId) &&
            row.role !== null &&
            isParentRole(row.role)
          ) {
            const owners = await dutyOwnersFor(row.familyId);
            const familyEvents = await deps.loadHorizonEvents(db, row.familyId, now);
            const decision = splitReminderDecision({
              event: {
                eventKey: event.id,
                childId: event.childId,
                startsAt: event.startsAt,
                endsAt: event.endsAt ?? null,
                ownerUserId: resolveSplitReminderOwner(event, owners),
              },
              siblings: familyEvents
                .filter((other) => other.id !== event.id && other.deletedAt === null)
                .map((other) => ({
                  eventKey: other.id,
                  childId: other.childId,
                  startsAt: other.startsAt,
                  endsAt: other.endsAt ?? null,
                  ownerUserId: resolveSplitReminderOwner(other, owners),
                })),
              parentUserId: row.parentUserId,
            });
            if (decision.action === 'suppress') {
              await drop(row, decision.reason);
              break;
            }
          }
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
            endsAt: event.endsAt ?? null,
            childId: event.childId,
            sensitive: event.sensitive,
            location: event.location,
            change: event.change ?? null,
            notes: event.notes ?? null,
            composeAttempts: row.composeAttempts,
            // Non-null past the gate above: role null never survives it.
            role: row.role as FamilyRole,
          });
        }
        break;
      case 'wait':
        break;
    }
  }

  // Group firing rows per (family, recipient) — see RecipientFiring. batchReminders then
  // merges the evening WITHIN one household, which is the only scope a merge is true in.
  const byRecipient = new Map<string, RecipientFiring>();
  for (const r of firing) {
    const key = `${r.familyId}|${r.parentUserId}`;
    const existing = byRecipient.get(key);
    if (existing) existing.rows.push(r);
    else
      byRecipient.set(key, {
        familyId: r.familyId,
        parentUserId: r.parentUserId,
        timezone: r.timezone,
        role: r.role,
        rows: [r],
      });
  }

  const sendEnabled = loopSendEnabled();
  let fired = 0;
  let firedLate = 0;
  let heldQuietHours = 0;
  let heldComposeUnavailable = 0;

  for (const group of byRecipient.values()) {
    const parentUserId = group.parentUserId;
    const caregiver = isCaregiverRole(group.role);
    const batches = batchReminders(group.rows, group.timezone);
    const children = caregiver ? [] : await deps.loadChildren(db, group.familyId);
    const rowByRef = new Map(group.rows.map((r) => [r.eventRef, r] as const));
    // VIL-229 · resolve the parent's name-level dial ONCE per parent (not per batch) —
    // only when voice can actually run, so a disabled or compose-not-send run skips
    // the read entirely (rule #8, cost discipline).
    //
    // NEITHER for a caregiver, and both omissions are deliberate. The children ride the
    // parents' payload so the renderer can apply that PARENT's name dial; a caregiver's
    // payload carries no child roster at all (templates/caregiver/payload.ts), so loading
    // one would put a teenager's name and date of birth on a queue for nothing. And the
    // voice stage is a real model call composed in the recipient's own register — a
    // caregiver's reminder is deterministic logistics, and paying for a sentence in
    // somebody else's voice is the wrong spend twice over (rule #8).
    // The parent's name dial and language, read ONCE per recipient and only when a
    // reminder can actually be written and sent. Neither for a caregiver: their payload
    // carries no child roster and their reminder is a separate template.
    const nameLevel =
      !caregiver && sendEnabled && deps.client ? await deps.loadNameLevel(db, parentUserId) : null;
    const language =
      !caregiver && sendEnabled && deps.client
        ? await deps.loadLanguage(db, group.familyId, parentUserId)
        : null;
    // VIL-562 · read once per recipient, and only once a batch could be sent.
    let prefs: LoopPrefsView | undefined;
    let floorClosed: boolean | undefined;

    for (const batch of batches) {
      const [firstRef] = batch.eventRefs;
      if (!firstRef) continue; // a batch always has ≥1 event

      const events: ReminderEventView[] = [];
      const factEvents: Parameters<typeof reminderFacts>[0]['events'][number][] = [];
      for (const ref of batch.eventRefs) {
        const r = rowByRef.get(ref);
        if (r) {
          const view: ReminderEventView = {
            eventRef: r.eventRef,
            title: r.title,
            startsAt: r.startsAt.toISOString(),
            childId: r.childId,
            sensitive: r.sensitive,
          };
          events.push(view);
          factEvents.push({
            ...view,
            endsAt: r.endsAt ? r.endsAt.toISOString() : null,
            location: r.location,
            change: r.change,
            notes: r.notes,
          });
        }
      }

      // Compose-not-send: only reach real families once the founder flips the flag, and
      // never pay for a text that will not be sent.
      if (!sendEnabled) continue;

      // VIL-562 · the SAME floor every unprompted text meets; no reminder class may claim
      // urgency past it. Their own window can only narrow it: their urgent-bypass toggle
      // lets a T-1h cross that window, never the floor.
      prefs ??= await deps.loadPrefs(db, parentUserId);
      floorClosed ??= await proactiveQuietNow({
        now,
        timeZone: group.timezone,
        phone: () => deps.parentPhone(db, parentUserId),
      });
      const timeSensitive = offsetUrgency(batch.offset) === 'time_sensitive';
      if (floorClosed || !deliverableNow(prefs, now, group.timezone, timeSensitive)) {
        const floorOpensAt = floorClosed ? proactiveFloorOpensAt(now, group.timezone) : null;
        for (const ref of batch.eventRefs) {
          const r = rowByRef.get(ref);
          if (!r) continue;
          if (floorOpensAt && floorOpensAt.getTime() >= r.startsAt.getTime()) {
            await drop({ id: r.reminderId, familyId: r.familyId, offset: r.offset }, 'quiet_hours');
          } else {
            heldQuietHours += 1;
          }
        }
        continue;
      }

      // The parent's reminder is written whole by the model from facts. No client, or a
      // draft the model could not write usably, is NOTHING SENT and a logged, audited drop.
      // A writer that could not be reached is not the reminder's fault: it stays scheduled.
      let texts: string[] | null = null;
      let bold: string | null = null;
      if (!caregiver) {
        const composed =
          deps.client && nameLevel && language
            ? await deps.composeText(
                deps.client,
                reminderFacts({
                  events: factEvents,
                  children,
                  level: nameLevel,
                  timeZone: group.timezone,
                  offset: batch.offset,
                  now,
                  planLink: null,
                  language,
                }),
                group.familyId,
                (run) => deps.recordAgentRun(db, run),
              )
            : null;
        if (composed?.status === 'unavailable') {
          console.error(
            {
              familyId: group.familyId,
              offset: batch.offset,
              events: batch.eventRefs.length,
              cause: composed.cause,
              httpStatus: composed.httpStatus,
              errorType: composed.errorType,
            },
            'reminder: compose unavailable, held for the next slot',
          );
          // The mark is what lets the drain ask again before a T-1h's event starts.
          for (const ref of batch.eventRefs) {
            const r = rowByRef.get(ref);
            if (!r) continue;
            const step = nextComposeHold(r.composeAttempts, now);
            if (step.action === 'exhausted') {
              await drop(
                { id: r.reminderId, familyId: r.familyId, offset: r.offset },
                'compose_retries_exhausted',
              );
              continue;
            }
            await deps.holdForCompose(db, r.reminderId, step);
            heldComposeUnavailable += 1;
          }
          continue;
        }
        if (composed?.status === 'rejected') {
          console.error(
            {
              familyId: group.familyId,
              offset: batch.offset,
              events: batch.eventRefs.length,
              cause: composed.cause,
              httpStatus: composed.httpStatus,
              errorType: composed.errorType,
            },
            'reminder: compose rejected, dropped',
          );
          for (const ref of batch.eventRefs) {
            const r = rowByRef.get(ref);
            if (!r) continue;
            await drop(
              { id: r.reminderId, familyId: r.familyId, offset: r.offset },
              'compose_rejected',
            );
          }
          continue;
        }
        if (composed?.status !== 'written') {
          console.error(
            { familyId: group.familyId, offset: batch.offset, events: batch.eventRefs.length },
            'reminder: no text written, nothing sent',
          );
          for (const ref of batch.eventRefs) {
            const r = rowByRef.get(ref);
            if (!r) continue;
            await drop({ id: r.reminderId, familyId: r.familyId, offset: r.offset }, 'unwritten');
          }
          continue;
        }
        texts = composed.draft.texts;
        bold = composed.draft.bold;
      }

      const caregiverPayload: CaregiverReminderPayload = {
        offset: batch.offset,
        timeZone: group.timezone,
        events: batch.eventRefs.flatMap((ref) => {
          const r = rowByRef.get(ref);
          return r
            ? [
                {
                  eventRef: r.eventRef,
                  title: r.title,
                  startsAt: r.startsAt.toISOString(),
                  location: r.location,
                },
              ]
            : [];
        }),
      };
      const parentPayload: ReminderPayload = {
        offset: batch.offset,
        timeZone: group.timezone,
        events,
        children,
        deepLink: null,
        unsubscribeUrl: unsubscribeUrl({ userId: parentUserId, emailType: REMINDER_EMAIL_TYPE }),
        texts: texts ?? [],
        ...(bold ? { bold } : {}),
      };
      // Batch key: the single event for T-1h, the evening for a merged T-24h. The family
      // is part of it because `dedupeActive` matches on the key alone, family-blind — and
      // an evening key is a DATE, so two households texting the same sitter tomorrow
      // would otherwise share one key and the second one's text would be dropped as an
      // already-attempted send.
      const batchKey = batch.offset === '-P1D' ? batch.eveningKey : firstRef;
      const job: ChannelSendJob = {
        templateKey: caregiver ? CAREGIVER_REMINDER_TEMPLATE_KEY : REMINDER_TEMPLATE_KEY,
        familyId: group.familyId,
        parentUserId,
        category: 'reminder',
        urgency: offsetUrgency(batch.offset),
        payload: (caregiver ? caregiverPayload : parentPayload) as unknown as Record<
          string,
          unknown
        >,
        // The pin: a caregiver has no address, so their leg cannot be left to the
        // recipient's loop_channel default (see loop/send.ts).
        ...(caregiver ? { channel: 'sms' as const } : {}),
        dedupeKey: `reminder:${batch.offset}:${group.familyId}:${parentUserId}:${batchKey}`,
      };

      await deps.enqueue(job);
      for (const ref of batch.eventRefs) {
        const r = rowByRef.get(ref);
        if (!r) continue;
        await deps.markStatus(db, r.reminderId, 'sent', null);
        if (isLateFire(r.fireAt, now)) firedLate += 1;
      }
      fired += batch.eventRefs.length;
      // Coarse telemetry (buildEvent drops any PII key): counts + enum only.
      await deps.capture('reminder_sent', parentUserId, {
        offset: batch.offset,
        events: batch.eventRefs.length,
        audience: caregiver ? 'caregiver' : 'parent',
      });
    }
  }

  if (heldQuietHours > 0) {
    console.info({ heldQuietHours }, 'reminder: held for quiet hours, checked again next slot');
  }

  return {
    due: due.length,
    fired,
    firedLate,
    suppressed,
    cancelled,
    heldLaneOff,
    heldNoKidVerdict,
    heldQuietHours,
    heldComposeUnavailable,
    sendEnabled,
  };
}

export interface HeldReminderRecheckDeps extends ReminderRunDeps {
  /** Due rows the run held because the writer could not be reached ({@link COMPOSE_HELD}). */
  loadHeldReminders: (db: Database, now: Date) => Promise<DueReminder[]>;
  /** One call that carries no family fact: is the provider answering again? */
  probe: (client: AgentClient) => Promise<ProviderHealth>;
}

export function defaultHeldReminderRecheckDeps(): HeldReminderRecheckDeps {
  return {
    ...defaultReminderRunDeps(),
    loadHeldReminders: (db, now) => selectDueReminders(db, now, COMPOSE_HELD),
    probe: probeProviderHealth,
  };
}

export type HeldReminderRecheck =
  | { held: 0 }
  | { held: number; skipped: 'send_disabled' | 'no_client' }
  | ({ held: number; skipped: 'provider_down'; failure: ProviderFailureClass } & ProviderErrorShape)
  | ({ held: number } & ReminderFireResult);

/**
 * VIL-586 · the drain's ask-again for a time-sensitive reminder the hourly run held
 * because the writer could not be reached. A T-1h's next hourly slot comes after its
 * event has started, so without this the hold could only end as 'started'.
 *
 * The family's facts go to the writer again only once a probe that carries none of them
 * says the provider answers. The rows then take the same fire path as the hourly run's,
 * so every gate (live event, scope, quiet hours, teen redaction) is asked again.
 */
export async function recheckHeldReminders(
  db: Database,
  deps: HeldReminderRecheckDeps = defaultHeldReminderRecheckDeps(),
  now: Date = new Date(),
): Promise<HeldReminderRecheck> {
  const scope = deps.scopeFamilies ?? ((rows) => scopeFamilies(rows));
  const held = scope(await deps.loadHeldReminders(db, now)).filter(
    (row) => offsetUrgency(row.offset) === 'time_sensitive',
  );
  if (held.length === 0) return { held: 0 };
  if (!loopSendEnabled()) return { held: held.length, skipped: 'send_disabled' };
  if (!deps.client) {
    console.error({ held: held.length, skipped: 'no_client' }, 'reminder: held, no writer');
    return { held: held.length, skipped: 'no_client' };
  }

  const health = await deps.probe(deps.client);
  if (!health.ok) {
    return {
      held: held.length,
      skipped: 'provider_down',
      failure: health.failure,
      httpStatus: health.httpStatus,
      errorType: health.errorType,
    };
  }
  return {
    held: held.length,
    ...(await fireDueReminders(db, deps, now, held, childLoader(db, deps))),
  };
}
