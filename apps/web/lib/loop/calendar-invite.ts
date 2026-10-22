import { type Database, schema } from '@hale/db';
import type {
  CalendarInviteMethod,
  CalendarInviteOutcome,
  CalendarInviteParentOutcome,
  CalendarInviteReport,
  CalendarInviteRequest,
  CalendarInviteSender,
} from '@hale/worker/executor';
import { and, eq, inArray } from 'drizzle-orm';
import { type DispatchPorts, type LegResult, dispatchLoopMessage } from '~/lib/channel/dispatch';
import type { Channel, ChannelKind, LoopMessage, TemplateRenderer } from '~/lib/channel/types';
import { buildDispatchPorts } from '~/lib/channel/wiring';
import { composeEventLink } from '~/lib/loop/ics-invite';
import {
  CALENDAR_INVITE_SMS_TEMPLATE_KEY,
  type CalendarInviteSmsPayload,
  inviteWhenLabel,
} from '~/lib/loop/templates/calendar-invite/sms';

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
 * reminders. REQUEST only: a CANCEL has nothing to link to, and says so by name.
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
          // A CANCEL has no link form, so nothing is withdrawn by text — said rather
          // than swallowed.
          outcomes.push({
            parentUserId: parent.userId,
            channel: 'sms',
            outcome: 'no_withdraw_form',
          });
        }
      }

      return { status: 'reported', parents: outcomes };
    },
  };
}
