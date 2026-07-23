import { type Database, schema } from '@hale/db';
import { eq, inArray } from 'drizzle-orm';
import { captureServerEvent } from '~/lib/analytics/server-capture';
import { CHANNEL_SEND_QUEUE } from '~/lib/channel/config';
import { HOT_QUEUE_EXPIRE_SECONDS } from '~/lib/cron/drain';
import { appBaseUrl, unsubscribeUrl } from '~/lib/cron/email-compliance';
import {
  type LoopPrefsView,
  loadLoopPrefsView,
  localParts,
  weeklyPlanWeekday,
} from '~/lib/loop/prefs';
import { readWeekPlan } from '~/lib/loop/queries';
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
 * OFF, mirroring digest's DIGEST_SEND_ENABLED). When off, the job still selects +
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
 * weekday (VIL-216 `weeklyPlanWeekday` — Sunday for a Monday-start week) at their
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
 */
export async function selectParentsToSend(db: Database, now: Date): Promise<SendParentRow[]> {
  const rows = await db
    .select({
      familyId: schema.familyMembers.familyId,
      userId: schema.users.id,
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
    if (isSendMoment(view, now, row.timezone, row.weekStartDay)) {
      out.push({ familyId: row.familyId, userId: row.userId, timezone: row.timezone, weekStartDay: row.weekStartDay, view });
    }
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
}

export interface SundaySendDeps {
  selectParents: (db: Database, now: Date) => Promise<SendParentRow[]>;
  readPlan: (db: Database, familyId: string, weekStart: string) => Promise<schema.WeekPlan | null>;
  loadChildren: (db: Database, familyId: string) => Promise<PlanChild[]>;
  enqueue: (job: ChannelSendJob) => Promise<void>;
  capture: typeof captureServerEvent;
}

export function defaultSundaySendDeps(): SundaySendDeps {
  return {
    selectParents: selectParentsToSend,
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
    // Offset 1 = the UPCOMING Monday — symmetric with the composer (cron.ts
    // weekWindow(now, tz, 1, 1)). The send fires the evening BEFORE the week
    // starts, so offset 0 would key the OUTGOING week and never find the
    // artifact (caught by the first full-loop prod probe).
    const weekStart = weekWindow(now, parent.timezone, 1, 1).startKey;
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

  return { matched: parents.length, enqueued, skippedNoPlan, sendEnabled };
}
