import { type Database, schema } from '@hale/db';
import { eq, inArray } from 'drizzle-orm';
import { captureServerEvent } from '~/lib/analytics/server-capture';
import { CHANNEL_SEND_QUEUE } from '~/lib/channel/config';
import { scopeWeekItemsForRole } from '~/lib/channel/role-scope';
import { HOT_QUEUE_EXPIRE_SECONDS } from '~/lib/cron/drain';
import { appBaseUrl, unsubscribeUrl } from '~/lib/cron/email-compliance';
import { type CaregiverSeat, selectCaregiverSeats } from '~/lib/loop/caregiver-audience';
import {
  type LoopPrefsView,
  loadLoopPrefsView,
  localParts,
  weeklyPlanWeekday,
} from '~/lib/loop/prefs';
import { readWeekPlan } from '~/lib/loop/queries';
import { CAREGIVER_WEEKLY_PLAN_TEMPLATE_KEY } from '~/lib/loop/templates/caregiver/keys';
import type { CaregiverPlanPayload } from '~/lib/loop/templates/caregiver/payload';
import type { PlanChild, WeeklyPlanPayload } from '~/lib/loop/templates/weekly-plan/payload';
import { weekWindow } from '~/lib/plan/spine';
import { getQueue } from '~/lib/queue';

/**
 * F11 · The Sunday Loop (VIL-218 · B2) — the Sunday send job. HOURLY: for every
 * enrolled parent whose LOCAL weekly_plan_send_time is now, it reads B1's persisted
 * week_plans artifact + the family's children and enqueues the weekly_plan message
 * onto the A2 channel.send queue. The A2 dispatch (via the drain) enforces
 * prefs/quiet/cap/consent/ledger/audit + the mirror legs and renders through the
 * weekly_plan template — this job only selects, assembles, and enqueues.
 *
 * Compose-not-send: the whole SEND stays dark behind LOOP_SEND_ENABLED (default
 * OFF). When off, the job still selects +
 * assembles (so the pipeline is exercised) but enqueues nothing — the founder flips
 * the flag when the loop is ready to reach real families.
 */

/** The founder's send kill-switch: the loop composes but never sends until this is
 * explicitly 'true'. */
export function loopSendEnabled(): boolean {
  return process.env.LOOP_SEND_ENABLED === 'true';
}

const WEEKLY_PLAN_TEMPLATE_KEY = 'weekly_plan';
export const MAX_SEND_PARENTS_PER_RUN = 200;
const SEND_SLOT_MINUTES = 60;
const MINUTES_PER_WEEK = 7 * 24 * 60;

function sendTimeMinutes(hms: string): number {
  const [h, m] = hms.split(':');
  return Number(h) * 60 + Number(m);
}

/**
 * Whether `now` is inside this parent's weekly-plan SEND slot: their local send
 * weekday (VIL-216 `weeklyPlanWeekday` — identity; product default Sunday) at their
 * `weekly_plan_send_time`, within a one-hour slot for the hourly cron. DST-safe via
 * `localParts`, so two parents in different zones each match at their own instant.
 * (A5's `isWeeklyPlanMoment` is exact-minute; an HOURLY cron needs the slot — this
 * is the send-weekday analog of the composer's `isComposeMoment`, without the
 * day-of-slack offset.)
 */
export function isSendMoment(
  view: LoopPrefsView,
  now: Date,
  timeZone: string,
  weekStartDay: number,
): boolean {
  const { weekday, minutes } = localParts(now, timeZone);
  const sendWeekday = weeklyPlanWeekday(weekStartDay);
  const nowMinOfWeek = weekday * 1440 + minutes;
  const targetMinOfWeek = sendWeekday * 1440 + sendTimeMinutes(view.weeklyPlanSendTime);
  const delta = (nowMinOfWeek - targetMinOfWeek + MINUTES_PER_WEEK) % MINUTES_PER_WEEK;
  return delta < SEND_SLOT_MINUTES;
}

export interface SendParentRow {
  familyId: string;
  userId: string;
  timezone: string;
  weekStartDay: number;
  view: LoopPrefsView;
}

/**
 * Every enrolled parent (primary_parent AND co_parent) at their local send moment
 * with the weekly plan enabled. Co-parents send independently — each in their own
 * timezone + send time, their own copy. Cheap weekday pre-check before the per-parent
 * prefs read, then the in-window + `catWeeklyPlan` filter, then the cap.
 *
 * A parent on the email channel with no address is dropped HERE rather than sent and
 * failed: a family provisioned from a text has `users.email = null` (M2's provision),
 * and letting them through mints a `failed` channel_messages row every Sunday that is
 * indistinguishable from a provider outage. The SMS channel needs no equivalent check —
 * the dispatch's live-consent gate already suppresses a parent with no active verified
 * channel, and an enrolled one always has a resolvable number.
 */
export async function selectParentsToSend(db: Database, now: Date): Promise<SendParentRow[]> {
  const rows = await db
    .select({
      familyId: schema.familyMembers.familyId,
      userId: schema.users.id,
      email: schema.users.email,
      timezone: schema.users.timezone,
      weekStartDay: schema.users.weekStartDay,
    })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(inArray(schema.familyMembers.role, ['primary_parent', 'co_parent']));

  const out: SendParentRow[] = [];
  for (const row of rows) {
    if (out.length >= MAX_SEND_PARENTS_PER_RUN) break;
    if (localParts(now, row.timezone).weekday !== weeklyPlanWeekday(row.weekStartDay)) continue;
    const view = await loadLoopPrefsView(row.userId, db);
    if (!view.catWeeklyPlan) continue;
    if (view.loopChannel === 'email' && row.email === null) continue;
    if (isSendMoment(view, now, row.timezone, row.weekStartDay)) {
      out.push({ familyId: row.familyId, userId: row.userId, timezone: row.timezone, weekStartDay: row.weekStartDay, view });
    }
  }
  return out;
}

/**
 * Every ACTIVE caregiver seat at its own local send moment — the audience the M6 welcome
 * ("I'll text you the week's schedule and pickup reminders") promised and that no sender
 * has ever selected.
 *
 * The seat predicate itself lives in caregiver-audience.ts; what happens here is the same
 * filtering the parents get, applied to the caregiver's OWN row: their timezone, their
 * week_start_day, their loop prefs. A caregiver has no loop_prefs row, so
 * `DEFAULT_LOOP_PREFS` applies — Sunday 08:00 local, weekly plan on — which is the
 * documented absent-row state and not a default invented here.
 *
 * No email-with-no-address drop, and its absence is the point rather than an oversight:
 * a caregiver ALWAYS has `users.email = null` (their account is minted from a phone
 * number), so the parents' guard would silently drop every seat there is. The leg is
 * pinned to SMS at enqueue instead.
 */
export async function selectCaregiversToSend(
  db: Database,
  now: Date,
): Promise<SendCaregiverRow[]> {
  const seats = await selectCaregiverSeats(db);
  const out: SendCaregiverRow[] = [];
  for (const seat of seats) {
    if (localParts(now, seat.timezone).weekday !== weeklyPlanWeekday(seat.weekStartDay)) continue;
    const view = await loadLoopPrefsView(seat.userId, db);
    if (!view.catWeeklyPlan) continue;
    if (isSendMoment(view, now, seat.timezone, seat.weekStartDay)) out.push({ ...seat, view });
  }
  return out;
}

/** The channel.send job the A2 drain consumes (LoopMessage-shaped, contract-validated
 * by `channelSendJobPayloadSchema`). */
export interface ChannelSendJob {
  templateKey: string;
  familyId: string;
  parentUserId: string;
  category: 'weekly_plan';
  urgency: 'normal';
  payload: Record<string, unknown>;
  dedupeKey: string;
  /** Pins the leg (contracts `channelSendJobPayloadSchema.channel`). The parents' plan
   * leaves it unset and rides their loop_channel; a caregiver has no address other than
   * their phone, so their leg is pinned rather than defaulted. */
  channel?: 'sms';
}

/** One caregiver seat at its own send moment, with the prefs the dispatch will re-read. */
export interface SendCaregiverRow extends CaregiverSeat {
  view: LoopPrefsView;
}

export interface SundaySendDeps {
  selectParents: (db: Database, now: Date) => Promise<SendParentRow[]>;
  selectCaregivers: (db: Database, now: Date) => Promise<SendCaregiverRow[]>;
  readPlan: (db: Database, familyId: string, weekStart: string) => Promise<schema.WeekPlan | null>;
  loadChildren: (db: Database, familyId: string) => Promise<PlanChild[]>;
  enqueue: (job: ChannelSendJob) => Promise<void>;
  capture: typeof captureServerEvent;
}

export function defaultSundaySendDeps(): SundaySendDeps {
  return {
    selectParents: selectParentsToSend,
    selectCaregivers: selectCaregiversToSend,
    readPlan: readWeekPlan,
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

export interface SundaySendResult {
  matched: number;
  enqueued: number;
  skippedNoPlan: number;
  sendEnabled: boolean;
  /** Caregiver seats at their own send moment this run. */
  caregiversMatched: number;
  caregiverEnqueued: number;
  /**
   * Seats whose family HAS a composed week but whose scoped view of it is empty — every
   * item was health, a teenager's, or a suggestion (rule #11: the absence is an outcome
   * with a name, not a zero that could equally mean the leg never ran).
   *
   * They are sent NOTHING, which is where this leg deliberately parts company with the
   * parents' one. The parents' renderer fills an empty week with "A quiet week - nothing
   * scheduled yet. Want ideas for Saturday? Reply IDEAS." Said to a caregiver that is two
   * untruths: the household may be having anything but a quiet week, and IDEAS is a
   * conversation they were promised they would not be drawn into.
   */
  caregiversNothingInScope: number;
}

/**
 * One hourly run: enqueue a weekly_plan message for each parent at their send moment
 * whose family has a composed plan for this week. The week key is ALWAYS Monday
 * (`weekWindow(now, tz, 1, 0)`) — the composer keys every artifact on Monday, so a
 * Sunday-start family would miss its row under its own weekStartDay. The dedupe key
 * is `family:weekStart:parent`; A2 suffixes it per channel, so a re-run double-sends
 * no leg.
 */
export async function runSundaySendCron(
  db: Database,
  deps: SundaySendDeps = defaultSundaySendDeps(),
  now: Date = new Date(),
): Promise<SundaySendResult> {
  const parents = await deps.selectParents(db, now);
  const sendEnabled = loopSendEnabled();
  let enqueued = 0;
  let skippedNoPlan = 0;

  for (const parent of parents) {
    // The brief fires the MORNING the week starts (2026-08-11 retime), and the
    // artifact is ALWAYS keyed on a Monday. For a Monday-start parent the send
    // morning IS that Monday (offset 0). For a Sunday-start parent the send
    // morning is Sunday — still the OUTGOING week in the Monday frame — so their
    // week's Monday key is tomorrow (offset 1). Both must land on the composer's
    // key (cron.ts weekWindow(now, tz, 1, 1), run the day before); the first
    // full-loop prod probe caught the mismatched-week variant of this.
    const weekStart = weekWindow(
      now,
      parent.timezone,
      1,
      parent.weekStartDay === 0 ? 1 : 0,
    ).startKey;
    const plan = await deps.readPlan(db, parent.familyId, weekStart);
    if (!plan) {
      skippedNoPlan += 1;
      continue;
    }

    const children = await deps.loadChildren(db, parent.familyId);
    const payload: WeeklyPlanPayload = {
      weekStart: plan.weekStart,
      summary: plan.summary,
      voice: plan.voice,
      items: plan.items,
      children,
      deepLink: `${appBaseUrl()}/plan`,
      unsubscribeUrl: unsubscribeUrl({ userId: parent.userId, emailType: WEEKLY_PLAN_TEMPLATE_KEY }),
    };
    const job: ChannelSendJob = {
      templateKey: WEEKLY_PLAN_TEMPLATE_KEY,
      familyId: parent.familyId,
      parentUserId: parent.userId,
      category: 'weekly_plan',
      urgency: 'normal',
      payload: payload as unknown as Record<string, unknown>,
      dedupeKey: `${parent.familyId}:${weekStart}:${parent.userId}`,
    };

    // Compose-not-send: only reach real families once the founder flips the flag.
    if (!sendEnabled) continue;

    await deps.enqueue(job);
    enqueued += 1;
    // Coarse telemetry for X1 (buildEvent drops any PII key): counts + enum only.
    await deps.capture('loop_plan_sent', parent.userId, {
      category: 'weekly_plan',
      items: plan.items.length,
      pending: plan.items.filter((item) => item.needs !== 'none').length,
    });
  }

  const caregivers = await deps.selectCaregivers(db, now);
  let caregiverEnqueued = 0;
  let caregiversNothingInScope = 0;

  for (const seat of caregivers) {
    // Same key as the parents', for the same reason: the composer writes every artifact
    // on a Monday, and a Sunday-start recipient's week is tomorrow's key.
    const weekStart = weekWindow(now, seat.timezone, 1, seat.weekStartDay === 0 ? 1 : 0).startKey;
    const plan = await deps.readPlan(db, seat.familyId, weekStart);
    if (!plan) {
      skippedNoPlan += 1;
      continue;
    }

    const children = await deps.loadChildren(db, seat.familyId);
    // BOTH GATES, in the order role-scope.ts requires: the role scope decides which
    // classes of the household this seat may see, and the deterministic teen age gate
    // (composed inside the same call, from date of birth) removes a 13+ child's items
    // outright — not genericized, absent. `children` is the whole family's, deliberately:
    // the filter needs every child an item could reference to be able to age them, and an
    // item naming a child it was not given fails closed.
    const scoped = scopeWeekItemsForRole({ role: seat.role, items: plan.items, children, now });
    if (scoped.length === 0) {
      caregiversNothingInScope += 1;
      continue;
    }

    // Only the children the SURVIVING items reference reach the payload — a teenager
    // whose every item the gate removed must not ride the queue as a name and a DOB.
    const referenced = new Set(scoped.flatMap((item) => item.childIds));
    const payload: CaregiverPlanPayload = {
      weekStart: plan.weekStart,
      items: scoped,
      children: children
        .filter((child) => referenced.has(child.id))
        .map((child) => ({ id: child.id, name: child.name })),
    };
    const job: ChannelSendJob = {
      templateKey: CAREGIVER_WEEKLY_PLAN_TEMPLATE_KEY,
      familyId: seat.familyId,
      parentUserId: seat.userId,
      category: 'weekly_plan',
      urgency: 'normal',
      // The pin. Without it the dispatch takes `DEFAULT_LOOP_PREFS.loopChannel` ('email')
      // for a recipient who has no email, and the week becomes a `no_address` row.
      channel: 'sms',
      payload: payload as unknown as Record<string, unknown>,
      // Same shape as the parents' key — the recipient id is what separates them, and the
      // dispatch suffixes the channel, so a re-drain can re-send no leg.
      dedupeKey: `${seat.familyId}:${weekStart}:${seat.userId}`,
    };

    if (!sendEnabled) continue;

    await deps.enqueue(job);
    caregiverEnqueued += 1;
    await deps.capture('loop_plan_sent', seat.userId, {
      category: 'weekly_plan',
      items: scoped.length,
      pending: 0,
    });
  }

  return {
    matched: parents.length,
    enqueued,
    skippedNoPlan,
    sendEnabled,
    caregiversMatched: caregivers.length,
    caregiverEnqueued,
    caregiversNothingInScope,
  };
}
