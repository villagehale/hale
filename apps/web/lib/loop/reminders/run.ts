import type { AgentClient } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { captureServerEvent } from '~/lib/analytics/server-capture';
import { CHANNEL_SEND_QUEUE } from '~/lib/channel/config';
import {
  type FamilyRole,
  classifyFamilyEvent,
  isCaregiverRole,
  isParentRole,
  roleAllows,
} from '~/lib/channel/role-scope';
import { HOT_QUEUE_EXPIRE_SECONDS } from '~/lib/cron/drain';
import { appBaseUrl, unsubscribeUrl } from '~/lib/cron/email-compliance';
import { type CaregiverSeat, selectCaregiverSeats } from '~/lib/loop/caregiver-audience';
import { type ChildNameLevel, loadLoopPrefsView } from '~/lib/loop/prefs';
import { loopSendEnabled } from '~/lib/loop/send';
import { CAREGIVER_REMINDER_TEMPLATE_KEY } from '~/lib/loop/templates/caregiver/keys';
import type { CaregiverReminderPayload } from '~/lib/loop/templates/caregiver/payload';
import type {
  ReminderChild,
  ReminderEventView,
  ReminderPayload,
} from '~/lib/loop/templates/reminder/payload';
import { voiceClient } from '~/lib/loop/voice/compose';
import { composeReminderVoice } from '~/lib/loop/voice/reminder-voice';
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
  /** family_events.sensitive — the reminder templates genericize a sensitive event, and
   * `classifyFamilyEvent` refuses it to a caregiver outright. */
  sensitive: boolean;
  /** Where to be. Unused by the parents' copy (they know), and half of what a caregiver's
   * `event_logistics` scope is FOR. */
  location: string | null;
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
  /** VIL-229 · the agent client for the per-batch voice stage, or null to run WITHOUT
   * it (the deterministic time + event descriptor still render + send — rule #8). */
  client: AgentClient | null;
  /** VIL-229 · the parent's resolved child-name-level dial, for the SAME redacted view
   * (rule #1) the voice stage hands the model and the template later renders. */
  loadNameLevel: (db: Database, userId: string) => Promise<ChildNameLevel>;
}

function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
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
          deletedAt: schema.familyEvents.deletedAt,
          title: schema.familyEvents.title,
          childId: schema.familyEvents.childId,
          sensitive: schema.familyEvents.sensitive,
          location: schema.familyEvents.location,
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
          role: schema.familyMembers.role,
          channelId: schema.parentChannels.id,
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
          ),
        );
      return rows.map(({ channelId, ...r }) => ({
        ...r,
        offset: r.offset as ReminderOffset,
        role: (r.role as FamilyRole | null) ?? null,
        smsChannelActive: channelId !== null,
      }));
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
          location: schema.familyEvents.location,
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
    client: voiceClient(),
    loadNameLevel: async (db, userId) => (await loadLoopPrefsView(userId, db)).childNameLevel,
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
  location: string | null;
  /** Proven non-null by the fire gate: a row whose recipient holds no seat never gets
   * here. Non-parent roles other than the three caregiver ones are suppressed too, so
   * this is either a parent role or a caregiver one. */
  role: FamilyRole;
}

interface ParentFiring {
  familyId: string;
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
  // The family's children, read at most once per run per family — the deterministic teen
  // age gate needs them, and both phases ask.
  const childCache = new Map<string, ReminderChild[]>();
  const childrenFor = async (familyId: string): Promise<ReminderChild[]> => {
    const hit = childCache.get(familyId);
    if (hit) return hit;
    const loaded = await deps.loadChildren(db, familyId);
    childCache.set(familyId, loaded);
    return loaded;
  };

  // ── Phase A: converge the ledger from live placed events ─────────────────────
  const parents = await deps.selectReminderParents(db);
  const caregiverSeats = await deps.selectReminderCaregivers(db);

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
      for (const event of events) await materialize(parent.userId, parent.timezone, event);
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
          if (!roleAllows(seat.role, classifyFamilyEvent(event, children, now))) continue;
          await materialize(seat.userId, seat.timezone, event);
        }
      }
    }

    // Belt-and-suspenders: the check-at-send below is the real guard, but a scheduled
    // row for a soft-deleted event is cancelled here so the ledger reads true.
    await deps.cancelDeletedEventReminders(db, familyId);
  }

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
          if (!(await recipientMaySee(row, event))) {
            await deps.markStatus(db, row.id, 'suppressed', 'out_of_scope');
            suppressed += 1;
            break;
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
            childId: event.childId,
            sensitive: event.sensitive,
            location: event.location,
            // Non-null past the gate above: role null never survives it.
            role: row.role as FamilyRole,
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
    else
      byParent.set(r.parentUserId, {
        familyId: r.familyId,
        timezone: r.timezone,
        role: r.role,
        rows: [r],
      });
  }

  const sendEnabled = loopSendEnabled();
  let fired = 0;

  for (const [parentUserId, group] of byParent) {
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
    const nameLevel =
      !caregiver && sendEnabled && deps.client
        ? await deps.loadNameLevel(db, parentUserId)
        : null;

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

      // VIL-229 · the per-batch voice stage, over the SAME redacted view (eventDescriptor
      // at the resolved name level) the template renders (rule #1). Fail-open (rule
      // #8): a null client/level, or any compose degrade, leaves voice null and the
      // deterministic time + descriptor still render + send.
      const voice =
        deps.client && nameLevel
          ? (
              await composeReminderVoice(
                events,
                children,
                nameLevel,
                group.timezone,
                batch.offset,
                group.familyId,
                db,
                deps.client,
                now,
              )
            ).voice
          : null;

      // Rule #6: no deep link on the glanceable T-1h; /plan on the evening-before T-24h.
      // Never for a caregiver on either offset — /plan is behind an account they do not
      // have, so the link would be a door with no key.
      const deepLink = !caregiver && batch.offset === '-P1D' ? `${appBaseUrl()}/plan` : null;
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
        deepLink,
        unsubscribeUrl: unsubscribeUrl({ userId: parentUserId, emailType: REMINDER_EMAIL_TYPE }),
        voice,
      };
      // Batch key: the single event for T-1h, the evening for a merged T-24h.
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
        audience: caregiver ? 'caregiver' : 'parent',
      });
    }
  }

  return { converged, due: due.length, fired, suppressed, cancelled, sendEnabled };
}
