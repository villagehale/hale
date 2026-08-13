import { type Database, schema } from '@hale/db';
import type {
  CalendarInviteAskOutcome,
  CalendarInviteMethod,
  CalendarInviteOutcome,
  CalendarInviteParentOutcome,
  CalendarInviteReport,
  CalendarInviteRequest,
  CalendarInviteSender,
} from '@hale/worker/executor';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  type DispatchPorts,
  type LedgerWrite,
  type LegResult,
  dispatchLoopMessage,
} from '~/lib/channel/dispatch';
import { CALENDAR_EMAIL_ASK } from '~/lib/channel/router/copy';
import type { Channel, ChannelKind, LoopMessage, TemplateRenderer } from '~/lib/channel/types';
import { buildDispatchPorts } from '~/lib/channel/wiring';
import { unsubscribeUrl } from '~/lib/cron/email-compliance';
import { composeEventInvite, inviteAttachment } from '~/lib/loop/ics-invite';
import {
  CALENDAR_EMAIL_ASK_TEMPLATE_KEY,
  CALENDAR_INVITE_TEMPLATE_KEY,
  type CalendarInvitePayload,
} from '~/lib/loop/templates/calendar-invite';

/**
 * VIL-249 · M13 — the production fan-out: a placement's iTIP object, delivered.
 *
 * This is the executor's `sendCalendarInvites` port bound to real families. Every
 * send goes through the A2 dispatch, which is the only path to a provider: consent,
 * the per-category enables, quiet hours, the cap, the channel_messages ledger, the
 * email_sends CASL row and the audit row all happen there, exactly once, for this
 * message like every other. Nothing here talks to Resend.
 *
 * TWO HALVES, because a family that never gave Hale an address cannot be sent to:
 *
 *   1. EVERY parent with an address gets the invite, pinned to the email leg (the
 *      attachment has no SMS or push form) and marked time_sensitive — the parent
 *      approved this seconds ago, so the receipt of their own decision must not be
 *      dropped by a quiet-hours window that exists to stop unsolicited pings. Their
 *      own `urgent_bypass_quiet_hours` pref still governs; the dispatch decides.
 *
 *   2. A family where NO parent has one is ASKED, once ever. The claim is the INSERT
 *      of the ledger row carrying the ask's dedupe key (#413's pattern): the partial
 *      unique index means exactly one concurrent placement wins it, and the dispatch
 *      then settles that same row rather than writing a second. A SUPPRESSED ask
 *      releases the key — a message the parent never received is not an ask, and the
 *      next placement may try again, which is the dispatch's own rule for its own
 *      keys.
 *
 * Every outcome is NAMED back to the executor (rule #11). "No address on file" is a
 * first-class result of a successful placement, not a silence inside one.
 */

/** Roles that receive a family's calendar invites. Caregivers never do (rule #1). */
const INVITED_ROLES = ['primary_parent', 'co_parent'] as const;

/** The email stream an invite rides, for the CASL opt-out and the unsubscribe link.
 * 'approval' is the loop category a placement's receipt belongs to. */
const INVITE_EMAIL_TYPE = 'approval' as const;

export interface CalendarInviteDeps {
  /** The seam's real adapters, shared with the drain so both send through one email
   * channel. Non-nullable (rule #11): a missing adapter is the dispatch's own
   * 'channel_unavailable', not an absent dependency here. */
  channels: Partial<Record<ChannelKind, Channel>>;
  renderer: TemplateRenderer;
  now?: () => Date;
}

interface InvitedParent {
  userId: string;
  email: string | null;
  timezone: string;
  role: string;
}

/** The parents an invite is addressed to, primary first (the ask targets the head of
 * this list). */
export async function loadInvitedParents(
  database: Database,
  familyId: string,
): Promise<InvitedParent[]> {
  const rows = await database
    .select({
      userId: schema.users.id,
      email: schema.users.email,
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
  return rows.sort((a, b) => Number(b.role === 'primary_parent') - Number(a.role === 'primary_parent'));
}

/** The most recent placement still standing — what a parent who has just handed over
 * their address is owed an invite for. */
export async function latestPlacedEventId(
  database: Database,
  familyId: string,
): Promise<string | null> {
  const [row] = await database
    .select({ id: schema.familyEvents.id })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        eq(schema.familyEvents.source, 'placement'),
        isNull(schema.familyEvents.deletedAt),
      ),
    )
    // Most recently placed; among rows written in the same instant (a batch), the
    // later event, so the answer is never arbitrary.
    .orderBy(desc(schema.familyEvents.createdAt), desc(schema.familyEvents.startsAt))
    .limit(1);
  return row?.id ?? null;
}

/** The dedupe key for ONE parent's copy of ONE revision of one event. The revision is
 * in the key, so a move (which raises the sequence) sends a fresh invite while a
 * re-drive of the same placement is deduped by the dispatch. */
function inviteDedupeKey(
  familyEventId: string,
  method: CalendarInviteMethod,
  sequence: number,
  parentUserId: string,
): string {
  return `${CALENDAR_INVITE_TEMPLATE_KEY}:${familyEventId}:${method}:${sequence}:${parentUserId}`;
}

/** One ask per family, forever — the key the claim row holds. */
export function emailAskDedupeKey(familyId: string): string {
  return `${CALENDAR_EMAIL_ASK_TEMPLATE_KEY}:${familyId}`;
}

/** The dispatch statuses that mean "not now" rather than "no". They release the ask's
 * claim, exactly as the dispatch declines to spend a dedupe key on a suppression. */
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

/** One invite to compose and send: the placed row, and which way it goes. */
interface InviteJob {
  familyId: string;
  familyEventId: string;
  method: CalendarInviteMethod;
}

/** Compose one parent's copy and hand it to the dispatch. */
async function inviteOneParent(
  database: Database,
  ports: DispatchPorts,
  job: InviteJob,
  parent: InvitedParent & { email: string },
  now: Date,
): Promise<CalendarInviteParentOutcome> {
  const composed = await composeEventInvite(
    {
      familyId: job.familyId,
      familyEventId: job.familyEventId,
      parentUserId: parent.userId,
      to: parent.email,
      method: job.method,
    },
    { database, now },
  );
  if (composed.status === 'not_found') {
    return { parentUserId: parent.userId, channel: 'email', outcome: 'event_not_found' };
  }

  // CASL: no working unsubscribe, no commercial send. Named rather than thrown, so a
  // missing secret reads as "nothing is wired here" instead of a failed placement.
  const unsubscribe = unsubscribeUrl({ userId: parent.userId, emailType: INVITE_EMAIL_TYPE });
  if (!unsubscribe) {
    return {
      parentUserId: parent.userId,
      channel: 'email',
      outcome: 'not_configured',
      reason: 'unsubscribe_unavailable',
    };
  }

  const payload: CalendarInvitePayload = {
    summary: composed.summary,
    startsAt: composed.startsAt.toISOString(),
    timeZone: parent.timezone,
    method: composed.method,
    unsubscribeUrl: unsubscribe,
    attachment: inviteAttachment(composed),
  };
  const message: LoopMessage = {
    templateKey: CALENDAR_INVITE_TEMPLATE_KEY,
    familyId: job.familyId,
    parentUserId: parent.userId,
    category: 'approval',
    urgency: 'time_sensitive',
    channel: 'email',
    dedupeKey: inviteDedupeKey(
      job.familyEventId,
      composed.method,
      composed.sequence,
      parent.userId,
    ),
    payload: payload as unknown as Record<string, unknown>,
  };

  const { legs } = await dispatchLoopMessage(message, ports);
  return { parentUserId: parent.userId, channel: 'email', ...outcomeFromLeg(legs[0]) };
}

/**
 * Claim the family's one ask. The INSERT is the claim (#413): the partial unique index
 * on `dedupe_key` lets exactly one caller win, so two placements landing together
 * cannot both text the same family. Returns the claimed row's id, or null when the
 * family has already been asked.
 */
async function claimEmailAsk(
  database: Database,
  familyId: string,
  parentUserId: string,
): Promise<string | null> {
  const [row] = await database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'approval',
      templateKey: CALENDAR_EMAIL_ASK_TEMPLATE_KEY,
      dedupeKey: emailAskDedupeKey(familyId),
      status: 'queued',
    })
    .onConflictDoNothing()
    .returning({ id: schema.channelMessages.id });
  return row?.id ?? null;
}

/**
 * Settle the claimed row with what the dispatch decided, IN PLACE — this is the
 * dispatch's `record` port for the ask, so one ask is one ledger row rather than a
 * claim plus a duplicate. A suppression gives the key back (see the module note).
 */
async function settleEmailAskClaim(
  database: Database,
  claimId: string,
  familyId: string,
  write: LedgerWrite,
): Promise<string> {
  await database
    .update(schema.channelMessages)
    .set({
      status: write.status,
      providerMessageId: write.providerMessageId ?? null,
      errorCode: write.errorCode ?? null,
      sentAt: write.sentAt ?? null,
      dedupeKey: isSuppression(write.status) ? null : emailAskDedupeKey(familyId),
    })
    .where(eq(schema.channelMessages.id, claimId));
  return claimId;
}

/**
 * Ask the family for an address, at most once ever. The target is the primary parent
 * (the head of the invited list) — whether they can actually be texted is the
 * dispatch's question, not a second consent reader's.
 */
async function askForEmail(
  database: Database,
  ports: DispatchPorts,
  familyId: string,
  parents: InvitedParent[],
): Promise<CalendarInviteAskOutcome> {
  const target = parents[0];
  if (!target) return 'no_parent_to_ask';

  const claimId = await claimEmailAsk(database, familyId, target.userId);
  if (!claimId) return 'already_asked';

  const message: LoopMessage = {
    templateKey: CALENDAR_EMAIL_ASK_TEMPLATE_KEY,
    familyId,
    parentUserId: target.userId,
    category: 'approval',
    urgency: 'normal',
    channel: 'sms',
    payload: { text: CALENDAR_EMAIL_ASK },
  };
  const { legs } = await dispatchLoopMessage(message, {
    ...ports,
    record: (write) => settleEmailAskClaim(database, claimId, familyId, write),
  });

  const leg = legs[0];
  if (!leg) return 'send_failed';
  if (leg.outcome === 'sent') return 'sent';
  if (isSuppression(leg.outcome)) return 'suppressed';
  if (leg.reason && UNCONFIGURED_REASONS.has(leg.reason)) return 'not_configured';
  return 'send_failed';
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
        return { status: 'reported', parents: [], ask: 'no_parent_to_ask' };
      }

      const outcomes: CalendarInviteParentOutcome[] = [];
      for (const parent of parents) {
        outcomes.push(
          parent.email
            ? await inviteOneParent(
                database,
                ports,
                {
                  familyId: request.familyId,
                  familyEventId: request.familyEventId,
                  method: request.method,
                },
                { ...parent, email: parent.email },
                now,
              )
            : { parentUserId: parent.userId, channel: 'email', outcome: 'no_email_on_file' },
        );
      }

      // The ask follows an event the family can still put on a calendar. After a
      // CANCEL there is nothing to add, and "want this in your real calendar?" about
      // a cancellation is a question with no good answer.
      const needsAsk = request.method === 'REQUEST' && parents.every((parent) => !parent.email);
      const ask = needsAsk ? await askForEmail(database, ports, request.familyId, parents) : 'not_needed';

      return { status: 'reported', parents: outcomes, ask };
    },
  };
}

/**
 * The invite a newly-captured address is owed: the family's most recent standing
 * placement, sent to that one parent. Same dispatch, same dedupe key, so a parent who
 * was already sent this revision is not sent it twice.
 */
export async function sendPendingInvite(
  database: Database,
  input: { familyId: string; parentUserId: string },
  deps: CalendarInviteDeps,
): Promise<CalendarInviteParentOutcome | { outcome: 'nothing_pending' }> {
  const familyEventId = await latestPlacedEventId(database, input.familyId);
  if (!familyEventId) return { outcome: 'nothing_pending' };

  const parents = await loadInvitedParents(database, input.familyId);
  const parent = parents.find((row) => row.userId === input.parentUserId);
  if (!parent?.email) {
    return { parentUserId: input.parentUserId, channel: 'email', outcome: 'no_email_on_file' };
  }

  const clock = deps.now ?? (() => new Date());
  const ports = buildDispatchPorts(database, {
    channels: deps.channels,
    renderer: deps.renderer,
    now: clock,
  });
  return inviteOneParent(
    database,
    ports,
    { familyId: input.familyId, familyEventId, method: 'REQUEST' },
    { ...parent, email: parent.email },
    clock(),
  );
}
