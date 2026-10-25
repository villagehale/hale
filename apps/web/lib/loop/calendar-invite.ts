import { type Database, schema } from '@hale/db';
import type {
  CalendarInviteMethod,
  CalendarInviteOutcome,
  CalendarInviteParentOutcome,
  CalendarInviteReport,
  CalendarInviteRequest,
  CalendarInviteSender,
} from '@hale/worker/executor';
import { and, asc, eq, gt, gte, inArray, isNotNull, like, sql } from 'drizzle-orm';
import { type DispatchPorts, type LegResult, dispatchLoopMessage } from '~/lib/channel/dispatch';
import type { Channel, ChannelKind, LoopMessage, TemplateRenderer } from '~/lib/channel/types';
import { buildDispatchPorts } from '~/lib/channel/wiring';
import { composeEventCancel, composeEventLink } from '~/lib/loop/ics-invite';
import {
  CALENDAR_CANCEL_SMS_TEMPLATE_KEY,
  type CalendarCancelSmsPayload,
} from '~/lib/loop/templates/calendar-cancel/sms';
import {
  CALENDAR_INVITE_SMS_TEMPLATE_KEY,
  type CalendarInviteSmsPayload,
  inviteWhenLabel,
} from '~/lib/loop/templates/calendar-invite/sms';
import type { CalendarCancelVoice } from '~/lib/loop/voice/calendar-cancel-voice';

/**
 * VIL-249 · M13 — the production fan-out: a placement, delivered as a tap-to-add link.
 *
 * This is the executor's `sendCalendarInvites` port bound to real families. Every
 * send goes through the A2 dispatch, which is the only path to a provider: consent,
 * the per-category enables, quiet hours, the channel_messages ledger and the audit row
 * all happen there, exactly once, for this message like every other.
 *
 * ONE FORM: a text carrying one line and a per-event ICS URL the parent's phone opens
 * in Calendar. The emailed iTIP invite (and the one-time ask for an address to send it
 * to) is retired with the email channel; a parent with a connected Google Calendar
 * gets the placement written there directly, and everyone else gets iMessage
 * reminders. A CANCEL texts each parent who was sent that link that the event is
 * cancelled, in words a model writes (calendar-cancel-voice.ts); a parent who never got
 * the link is named `never_linked` and texted nothing.
 *
 * ITS STANDING IS A LOOP SEND, not the "Approved" reply's — that reply is an answer to
 * an inbound turn and leaves through the transport with no policy gate, while this
 * leaves through the dispatch. So a parent who has turned `urgent_bypass_quiet_hours`
 * OFF and says yes at 22:30 gets the acknowledgment and, that night, no link: the leg
 * reports `suppressed`, and since the executor runs once per approval nothing re-drives
 * it in the morning. Named rather than hidden (rule #11).
 *
 * Every outcome is NAMED back to the executor (rule #11). "Reachable on no channel" is
 * a first-class result of a successful placement, not a silence inside one.
 */

/** Roles that receive a family's calendar invites. Caregivers never do (rule #1). */
const INVITED_ROLES = ['primary_parent', 'co_parent'] as const;

export interface CalendarInviteDeps {
  /** The seam's real adapters, shared with the drain so both send through one SMS
   * channel. Non-nullable (rule #11): a missing adapter is the dispatch's own
   * 'channel_unavailable', not an absent dependency here. */
  channels: Partial<Record<ChannelKind, Channel>>;
  renderer: TemplateRenderer;
  /** The cancellation's words. REQUIRED (rule #11); its deferral is named
   * (`compose_deferred`) and nothing is sent. */
  cancelVoice: CalendarCancelVoice;
  now?: () => Date;
}

interface InvitedParent {
  userId: string;
  timezone: string;
  role: string;
}

/** The parents an invite is addressed to, primary first. */
async function loadInvitedParents(database: Database, familyId: string): Promise<InvitedParent[]> {
  const rows = await database
    .select({
      userId: schema.users.id,
      timezone: schema.users.timezone,
      role: schema.familyMembers.role,
    })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        inArray(schema.familyMembers.role, [...INVITED_ROLES]),
      ),
    );
  return rows.sort(
    (a, b) => Number(b.role === 'primary_parent') - Number(a.role === 'primary_parent'),
  );
}

/** The dispatch statuses that mean "not now" rather than "no". */
function isSuppression(status: string): boolean {
  return status.startsWith('suppressed_');
}

/** A 'failed' leg whose reason is a channel with no way to send at all — unwired
 * infrastructure, not a refused address. `channel_unavailable` is the dispatch's own
 * word for "no adapter for this leg"; the other three are the adapters' skips. */
const UNCONFIGURED_REASONS: ReadonlySet<string> = new Set([
  'channel_unavailable',
  'not_configured',
  'no_address',
  'disabled',
]);

function outcomeFromLeg(leg: LegResult | undefined): {
  outcome: CalendarInviteOutcome;
  reason?: string;
} {
  if (!leg) return { outcome: 'send_failed', reason: 'no_leg' };
  if (leg.outcome === 'sent') return { outcome: 'sent' };
  if (leg.outcome === 'deduped') return { outcome: 'already_sent' };
  if (isSuppression(leg.outcome)) return { outcome: 'suppressed', reason: leg.outcome };
  // A 'failed' leg is either the channel saying it has no way to send or a provider
  // refusal. They are different problems: one is unwired infrastructure, the other is
  // a bad address, and folding them together would hide whichever is real.
  if (leg.reason && UNCONFIGURED_REASONS.has(leg.reason)) {
    return { outcome: 'not_configured', reason: leg.reason };
  }
  return { outcome: 'send_failed', reason: leg.reason };
}

/** The dedupe key for ONE parent's copy of ONE revision of the tap-to-add text. The
 * method is not in it because only a REQUEST is ever texted. */
function linkDedupeKey(familyEventId: string, sequence: number, parentUserId: string): string {
  return `${CALENDAR_INVITE_SMS_TEMPLATE_KEY}:${familyEventId}:${sequence}:${parentUserId}`;
}

/** One invite to compose and send: the placed row, and which way it goes. */
interface InviteJob {
  familyId: string;
  familyEventId: string;
  method: CalendarInviteMethod;
}

/**
 * Text one parent the placement as a tap-to-add link.
 *
 * NO COMPOSER. This is a receipt plus a URL, locked and segment-tested at the
 * authoring site like every other deterministic line Hale texts
 * (templates/calendar-invite/sms.ts).
 */
async function textOneParent(
  database: Database,
  ports: DispatchPorts,
  job: InviteJob,
  parent: InvitedParent,
  now: Date,
): Promise<CalendarInviteParentOutcome> {
  const composed = await composeEventLink(
    {
      familyId: job.familyId,
      familyEventId: job.familyEventId,
      parentUserId: parent.userId,
    },
    { database, now },
  );
  if (composed.status === 'not_found') {
    return { parentUserId: parent.userId, channel: 'sms', outcome: 'event_not_found' };
  }

  const payload: CalendarInviteSmsPayload = {
    summary: composed.summary,
    when: inviteWhenLabel(composed.startsAt, parent.timezone),
    url: composed.url,
  };
  const message: LoopMessage = {
    templateKey: CALENDAR_INVITE_SMS_TEMPLATE_KEY,
    familyId: job.familyId,
    parentUserId: parent.userId,
    category: 'approval',
    urgency: 'time_sensitive',
    channel: 'sms',
    dedupeKey: linkDedupeKey(job.familyEventId, composed.sequence, parent.userId),
    payload: payload as unknown as Record<string, unknown>,
  };

  const { legs } = await dispatchLoopMessage(message, ports);
  const leg = legs[0];
  const result = outcomeFromLeg(leg);
  // The dispatch's SMS consent gate is the live-state read (an active verified
  // parent_channels row), and SMS is the only channel Hale sends on, so a consent
  // suppression here is not a preference — it is a parent Hale has no way to reach. Naming it that
  // way is the difference between "policy said no" and "there is nobody to send to",
  // and folding the two would hide whichever is real (rule #11).
  if (leg?.outcome === 'suppressed_consent') {
    return { parentUserId: parent.userId, channel: 'sms', outcome: 'no_channel' };
  }
  return { parentUserId: parent.userId, channel: 'sms', ...result };
}

/** The legs the dispatch can leave in, as the executor's outcomes. Shared by both texts. */
function parentOutcome(
  parentUserId: string,
  leg: LegResult | undefined,
): CalendarInviteParentOutcome {
  // The dispatch's SMS consent gate is the live-state read (an active verified
  // parent_channels row), and SMS is the only channel Hale sends on, so a consent
  // suppression here is not a preference — it is a parent Hale has no way to reach.
  if (leg?.outcome === 'suppressed_consent') {
    return { parentUserId, channel: 'sms', outcome: 'no_channel' };
  }
  return { parentUserId, channel: 'sms', ...outcomeFromLeg(leg) };
}

/** Whether this parent was texted the tap-to-add link for this event — any revision. */
async function wasTextedTheLink(
  database: Database,
  job: InviteJob,
  parentUserId: string,
): Promise<boolean> {
  const m = schema.channelMessages;
  const rows = await database
    .select({ id: m.id })
    .from(m)
    .where(
      and(
        eq(m.familyId, job.familyId),
        eq(m.parentUserId, parentUserId),
        eq(m.templateKey, CALENDAR_INVITE_SMS_TEMPLATE_KEY),
        like(m.dedupeKey, `${CALENDAR_INVITE_SMS_TEMPLATE_KEY}:${job.familyEventId}:%`),
        inArray(m.status, ['queued', 'sent', 'delivered']),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/** Whether this parent already has the cancellation text for this event. Checked
 * BEFORE the model is asked, so a re-driven cancel costs nothing once it has landed. */
async function wasTextedTheCancel(
  database: Database,
  job: InviteJob,
  parentUserId: string,
): Promise<boolean> {
  const m = schema.channelMessages;
  const rows = await database
    .select({ id: m.id })
    .from(m)
    .where(
      and(
        eq(m.familyId, job.familyId),
        eq(m.parentUserId, parentUserId),
        like(
          m.dedupeKey,
          `${CALENDAR_CANCEL_SMS_TEMPLATE_KEY}:${job.familyEventId}:${parentUserId}%`,
        ),
        inArray(m.status, ['queued', 'sent', 'delivered']),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Text one parent that an event they were sent a tap-to-add link for is cancelled.
 *
 * Only a parent who got the link: anyone else has nothing on their phone to take back,
 * and a cancellation for an event they never heard about is noise (`never_linked`).
 */
async function cancelOneParent(
  database: Database,
  ports: DispatchPorts,
  voice: CalendarCancelVoice,
  job: InviteJob,
  parent: InvitedParent,
  now: Date,
): Promise<CalendarInviteParentOutcome> {
  if (!(await wasTextedTheLink(database, job, parent.userId))) {
    return { parentUserId: parent.userId, channel: 'sms', outcome: 'never_linked' };
  }
  if (await wasTextedTheCancel(database, job, parent.userId)) {
    return { parentUserId: parent.userId, channel: 'sms', outcome: 'already_sent' };
  }
  const event = await composeEventCancel(
    { familyId: job.familyId, familyEventId: job.familyEventId, parentUserId: parent.userId },
    { database, now },
  );
  if (event.status === 'not_found') {
    return { parentUserId: parent.userId, channel: 'sms', outcome: 'event_not_found' };
  }

  const when = inviteWhenLabel(event.startsAt, parent.timezone);
  const voiced = await voice.compose({ summary: event.summary, when });
  // No fixed fallback: a deferred compose sends nothing and is named back, so the
  // cancellation is never a canned line (Barton: the model writes it, or nothing goes).
  if (voiced.status !== 'composed') {
    return {
      parentUserId: parent.userId,
      channel: 'sms',
      outcome: 'compose_deferred',
      reason: voiced.reason,
    };
  }
  const payload: CalendarCancelSmsPayload = { summary: event.summary, when, line: voiced.body };
  const message: LoopMessage = {
    templateKey: CALENDAR_CANCEL_SMS_TEMPLATE_KEY,
    familyId: job.familyId,
    parentUserId: parent.userId,
    category: 'approval',
    urgency: 'time_sensitive',
    channel: 'sms',
    dedupeKey: `${CALENDAR_CANCEL_SMS_TEMPLATE_KEY}:${job.familyEventId}:${parent.userId}`,
    payload: payload as unknown as Record<string, unknown>,
  };
  const { legs } = await dispatchLoopMessage(message, ports);
  return parentOutcome(parent.userId, legs[0]);
}

/**
 * The port the executor calls after a placement lands. Never throws for a family
 * reason: everything that can go wrong is a named outcome the execution detail
 * carries.
 */
export function createCalendarInviteSender(
  database: Database,
  deps: CalendarInviteDeps,
): CalendarInviteSender {
  const clock = deps.now ?? (() => new Date());
  return {
    async send(request: CalendarInviteRequest): Promise<CalendarInviteReport> {
      const ports = buildDispatchPorts(database, {
        channels: deps.channels,
        renderer: deps.renderer,
        now: clock,
      });
      const now = clock();
      const parents = await loadInvitedParents(database, request.familyId);
      if (parents.length === 0) {
        return { status: 'reported', parents: [] };
      }

      const job: InviteJob = {
        familyId: request.familyId,
        familyEventId: request.familyEventId,
        method: request.method,
      };
      const outcomes: CalendarInviteParentOutcome[] = [];
      for (const parent of parents) {
        if (request.method === 'REQUEST') {
          outcomes.push(await textOneParent(database, ports, job, parent, now));
        } else {
          outcomes.push(await cancelOneParent(database, ports, deps.cancelVoice, job, parent, now));
        }
      }

      return { status: 'reported', parents: outcomes };
    },
  };
}

/** How far back a cancellation is still re-driven. The event must also not have started. */
export const CANCEL_RETRY_LOOKBACK_DAYS = 7;
/** Bounded per tick, like every other sweep. */
export const CANCEL_RETRY_MAX_EVENTS = 50;
/** Retries per cancelled event before the sweep gives up on it. */
export const CANCEL_RETRY_MAX_ATTEMPTS = 5;
/** Wait after the Nth retry: base × 2^(N-1) (1h, 2h, 4h, 8h). */
export const CANCEL_RETRY_BACKOFF_BASE_MS = 3_600_000;

/**
 * The audit actions that mark a GENUINE cancellation: the approved calendar_cancel
 * executor and a parent's undo. Any other soft delete (untrack, backfill, mirror
 * cleanup) never texts a parent a cancel.
 */
export const GENUINE_CANCEL_ACTIONS = [
  'action.calendar_cancelled',
  'action.calendar_placement_reverted',
] as const;
export const CANCEL_RETRY_ATTEMPT_ACTION = 'calendar_cancel.retry_attempt';

export interface CancelRetrySummary {
  events: number;
  sent: number;
  deferred: number;
  failed: number;
}

/**
 * VIL-449 · re-drive cancellation texts that never landed (`compose_deferred`, or held
 * by quiet hours). Only an event with a genuine cancel audit row is eligible, soonest
 * start first, capped at CANCEL_RETRY_MAX_EVENTS. Each event gets at most
 * CANCEL_RETRY_MAX_ATTEMPTS retries with exponential backoff between them, recorded as
 * audit rows. Retries go through the same sender, so dispatch consent, quiet hours and
 * same-item dedupe all apply, and the model writes the words or nothing goes. Gives up
 * once the event has started or the cancel is older than the lookback.
 */
export async function retryDeferredCalendarCancels(
  database: Database,
  sender: CalendarInviteSender,
  now: Date = new Date(),
): Promise<CancelRetrySummary> {
  const e = schema.familyEvents;
  const a = schema.auditLog;
  const since = new Date(now.getTime() - CANCEL_RETRY_LOOKBACK_DAYS * 86_400_000);
  const cancelled = database
    .selectDistinct({ eventId: a.targetId })
    .from(a)
    .where(
      and(
        eq(a.targetTable, 'family_events'),
        inArray(a.actionTaken, [...GENUINE_CANCEL_ACTIONS]),
        gte(a.occurredAt, since),
      ),
    );
  const candidates = await database
    .select({ id: e.id, familyId: e.familyId, startsAt: e.startsAt })
    .from(e)
    .where(
      and(
        isNotNull(e.deletedAt),
        gte(e.deletedAt, since),
        gt(e.startsAt, now),
        inArray(sql`${e.id}::text`, cancelled),
      ),
    )
    .orderBy(asc(e.startsAt), asc(e.id));
  const attempts = await retryAttempts(
    database,
    candidates.map((row) => row.id),
  );
  const due = candidates
    .filter((row) => retryIsDue(attempts.get(row.id), now))
    .slice(0, CANCEL_RETRY_MAX_EVENTS);
  const summary: CancelRetrySummary = { events: due.length, sent: 0, deferred: 0, failed: 0 };
  for (const row of due) {
    await database.insert(a).values({
      familyId: row.familyId,
      actor: 'system',
      actionTaken: CANCEL_RETRY_ATTEMPT_ACTION,
      targetTable: 'family_events',
      targetId: row.id,
      occurredAt: now,
    });
    try {
      const report = await sender.send({
        familyId: row.familyId,
        familyEventId: row.id,
        method: 'CANCEL',
      });
      if (report.status !== 'reported') continue;
      for (const parent of report.parents) {
        if (parent.outcome === 'sent') summary.sent += 1;
        else if (parent.outcome === 'compose_deferred') summary.deferred += 1;
      }
    } catch (err) {
      summary.failed += 1;
      console.error(
        { err: err instanceof Error ? err.name : 'unknown', familyEventId: row.id },
        'calendar cancel retry: event failed',
      );
    }
  }
  return summary;
}

interface AttemptHistory {
  count: number;
  last: Date;
}

async function retryAttempts(
  database: Database,
  eventIds: readonly string[],
): Promise<Map<string, AttemptHistory>> {
  if (eventIds.length === 0) return new Map();
  const a = schema.auditLog;
  const rows = await database
    .select({
      eventId: a.targetId,
      count: sql<number>`count(*)::int`,
      last: sql<Date>`max(${a.occurredAt})`,
    })
    .from(a)
    .where(
      and(
        eq(a.actionTaken, CANCEL_RETRY_ATTEMPT_ACTION),
        eq(a.targetTable, 'family_events'),
        inArray(a.targetId, [...eventIds]),
      ),
    )
    .groupBy(a.targetId);
  return new Map(
    rows.flatMap((row) =>
      row.eventId ? [[row.eventId, { count: row.count, last: new Date(row.last) }]] : [],
    ),
  );
}

/** Exported for the backoff test. No history → due now. */
export function retryIsDue(history: AttemptHistory | undefined, now: Date): boolean {
  if (!history) return true;
  if (history.count >= CANCEL_RETRY_MAX_ATTEMPTS) return false;
  const wait = CANCEL_RETRY_BACKOFF_BASE_MS * 2 ** (history.count - 1);
  return now.getTime() - history.last.getTime() >= wait;
}
