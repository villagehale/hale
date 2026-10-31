import { type Database, schema } from '@hale/db';
import type {
  CalendarInviteReport,
  CalendarInviteRequest,
  CalendarInviteSender,
} from '@hale/worker/executor';
import { and, desc, eq, inArray, like, ne, notLike } from 'drizzle-orm';
import { householdTimezone } from '~/lib/channel/household-timezone';
import { type ReplyLanguage, acceptReplyLanguage } from '~/lib/channel/language';
import { acceptedStatus, dedupeActive } from '~/lib/channel/ledger';
import { type GroupAudienceVerdict, groupAudienceAllows } from '~/lib/channel/linq/group-audience';
import { readGroupMembership } from '~/lib/channel/linq/group-membership';
import { isUndefinedTable } from '~/lib/channel/linq/roster';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { type OptOutForm, withOptOut } from '~/lib/channel/opt-out';
import {
  PROACTIVE_CATEGORY,
  type ProactiveHoldReason,
  type ProactiveSendVerdict,
  assertProactiveSendAllowed,
  buildOutboundGatePorts,
} from '~/lib/channel/outbound-gate';
import { failedSendPatch, sendLinqChatMessage } from '~/lib/channel/outbound-transport';
import { type ContentClass, classifyFamilyEvent } from '~/lib/channel/role-scope';
import {
  icsSequence,
  loadInviteEventRow,
  mintEventInviteLink,
  toInviteEvent,
} from '~/lib/loop/ics-invite';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { recordGroupPlanHold } from './redrive';
import {
  type GroupPlanChange,
  type GroupPlanEvent,
  type GroupPlanMember,
  type GroupPlanReportInput,
  composeGroupPlanReport,
  groupPlanReportEnabled,
  groupPlanReportInput,
  planEndLabel,
  planWhenLabel,
} from './report';
import { groupPlanChatId } from './stamp';

/**
 * VIL-443 (T17) 2/2 — a group's plan, reported back to the group.
 *
 * A decorator on the executor's calendar-invite port. When
 * `GROUP_PLAN_CALENDAR_REPORT_ENABLED` is exactly `true` and the placed row belongs to a
 * plan a family-group turn drafted, the group gets an AI-written text (one message or a
 * few) carrying the add-to-calendar link, instead of each parent getting the same link
 * 1:1: a parent in the group would otherwise have it twice, and grandparents or a nanny
 * in the chat would not have it at all. Every other placement goes to the inner sender
 * untouched, and so does a group plan the group may not hear (its audience gate: a teen's
 * or health event, a roster not yet confirmed, someone in the chat whose role does not
 * cover it): its parents get their own invites, as they would without this flag.
 *
 * Moves and cancels find the plan through the row's placing action, so the same group
 * hears about every revision. One text per revision (and one per cancel): the dedupe key
 * carries the event's ICS sequence, and a re-driven placement never reaches this port.
 * The key rides on the last message, the one carrying the link (the composer refuses a
 * draft that puts it anywhere else), so it marks exactly whether the group has the whole
 * text; any other message is keyed off it.
 *
 * NOTHING CANNED. The model writes the text or nothing goes out; an unwritten text is an
 * audit row and an ops page, and its dedupe key stays unspent.
 *
 * A group text quiet hours hold waits for the morning re-drive (redrive.ts) and goes to
 * the group then: switching it to each parent's time-sensitive 1:1 invite would cross the
 * quiet hours that held it. One held for anything else (enrolment, an unread stop) or that
 * does not land goes to the parents' own invites instead, exactly as with this flag off:
 * a hold or a lost send is not the model failing. Every way this ends is a named outcome
 * in the execution detail (rule #11); nothing here throws into the executor.
 */

export const GROUP_PLAN_TEMPLATE_KEY = 'group_plan_calendar';

/** `send_failed`: a message did not land, so neither did the last, the one with the link. */
export type GroupLineSendOutcome = 'sent' | 'already_sent' | 'send_failed';

export type GroupPlanReportOutcome =
  | GroupLineSendOutcome
  | `held:${ProactiveHoldReason}`
  | 'no_link'
  | 'unwritten'
  | 'errored';

/** A placement that is a group's plan, with everything its group text needs. */
export interface GroupPlan {
  familyId: string;
  familyEventId: string;
  /** The calendar_add that placed the row. */
  placedByActionId: string;
  chatId: string;
  /** The placed row's class, the one the group's audience gate is asked about. */
  contentClass: ContentClass;
  /** The parent whose proactive-send standing gates the group text: the primary parent. */
  gateUserId: string;
  change: GroupPlanChange;
  /** One per revision, and one per cancel. */
  dedupeKey: string;
  event: GroupPlanEvent;
  members: GroupPlanMember[];
  /** Members whose own calendar Hale wrote this placement to. */
  reachedUserIds: string[];
  language: ReplyLanguage;
}

export interface GroupPlanReportPorts {
  enabled(): boolean;
  now?(): Date;
  /** The group plan behind a placement, or null when it is not one. Writes nothing. */
  loadPlan(request: CalendarInviteRequest): Promise<GroupPlan | null>;
  /** Whether everyone in the chat may hear a line of this class. */
  audience(chatId: string, contentClass: ContentClass): Promise<GroupAudienceVerdict>;
  alreadySent(dedupeKey: string): Promise<boolean>;
  gate(familyId: string, parentUserId: string, now: Date): Promise<ProactiveSendVerdict>;
  /** The per-event add-to-calendar link, minted on the family. */
  mintLink(familyId: string, familyEventId: string): Promise<string>;
  /** The messages, in order, the link in the last; or null when none could be written. */
  compose(input: GroupPlanReportInput): Promise<string[] | null>;
  send(
    plan: GroupPlan,
    messages: readonly string[],
    optOut: OptOutForm,
  ): Promise<GroupLineSendOutcome>;
  /** Records and pages a text the model could not write. Nothing was sent. */
  unsent(plan: GroupPlan): Promise<void>;
  /** Records a text quiet hours held, for the morning re-drive. Nothing was sent. */
  hold(plan: GroupPlan): Promise<void>;
}

/** Exported for tests: one group plan's text, start to finish. Never throws. */
export async function reportGroupPlan(
  plan: GroupPlan,
  ports: GroupPlanReportPorts,
): Promise<GroupPlanReportOutcome> {
  try {
    if (await ports.alreadySent(plan.dedupeKey)) return 'already_sent';
    const verdict = await ports.gate(plan.familyId, plan.gateUserId, ports.now?.() ?? new Date());
    if (!verdict.allowed) return `held:${verdict.reason}`;
    const link =
      plan.change === 'cancelled' ? null : await ports.mintLink(plan.familyId, plan.familyEventId);
    const input = groupPlanReportInput({
      change: plan.change,
      event: plan.event,
      members: plan.members,
      reachedUserIds: plan.reachedUserIds,
      link,
      language: plan.language,
    });
    if (!input) return 'no_link';
    const messages = await ports.compose(input);
    if (!messages || messages.length === 0) {
      await ports.unsent(plan);
      return 'unwritten';
    }
    return await ports.send(plan, messages, verdict.optOut);
  } catch (err) {
    console.error(
      {
        familyId: plan.familyId,
        familyEventId: plan.familyEventId,
        err: err instanceof Error ? err.name : 'unknown',
      },
      'group plan report: threw - nothing sent, placement unaffected',
    );
    return 'errored';
  }
}

export function withGroupPlanReport(
  inner: CalendarInviteSender,
  ports: GroupPlanReportPorts,
): CalendarInviteSender {
  return {
    async send(request): Promise<CalendarInviteReport> {
      if (!ports.enabled()) return inner.send(request);
      let plan: GroupPlan | null;
      let audience: GroupAudienceVerdict | null = null;
      try {
        plan = await ports.loadPlan(request);
        if (plan) audience = await ports.audience(plan.chatId, plan.contentClass);
      } catch (err) {
        console.error(
          {
            familyId: request.familyId,
            familyEventId: request.familyEventId,
            err: err instanceof Error ? err.name : 'unknown',
          },
          'group plan report: could not read the placement - nothing sent',
        );
        return { status: 'errored', message: 'group_plan_unreadable' };
      }
      if (!plan) return inner.send(request);
      if (!audience?.allowed) {
        console.info(
          {
            familyId: request.familyId,
            familyEventId: request.familyEventId,
            contentClass: plan.contentClass,
            reason: audience?.reason,
          },
          'group plan report: not for this group - its parents get their own invites',
        );
        return toParents(inner, request, `audience:${audience?.reason ?? 'unread'}`);
      }
      const outcome = await reportGroupPlan(plan, ports);
      console.info(
        {
          familyId: request.familyId,
          familyEventId: request.familyEventId,
          change: plan.change,
          outcome,
        },
        'group plan report: done',
      );
      if (outcome === 'held:quiet_hours') {
        try {
          await ports.hold(plan);
        } catch (err) {
          console.error(
            {
              familyId: request.familyId,
              familyEventId: request.familyEventId,
              err: err instanceof Error ? err.name : 'unknown',
            },
            'group plan report: could not record the night hold - nothing sent',
          );
          return { status: 'errored', message: 'group_plan_hold_unrecorded' };
        }
        return { status: 'group_reported', outcome };
      }
      if (outcome === 'send_failed' || outcome.startsWith('held:')) {
        return toParents(inner, request, outcome);
      }
      return { status: 'group_reported', outcome };
    },
  };
}

/**
 * The group could not be told, so each parent gets what they would get without this
 * flag. Nothing is retried here: a placement runs once, and a lost group text, or one
 * held for anything but the night, would otherwise leave nobody with the link. A text
 * the model could not write never comes here (no fallback for words).
 */
async function toParents(
  inner: CalendarInviteSender,
  request: CalendarInviteRequest,
  groupNotTold: string,
): Promise<CalendarInviteReport> {
  const report = await inner.send(request);
  return report.status === 'reported' ? { ...report, groupNotTold } : report;
}

const PARENT_ROLES = ['primary_parent', 'co_parent'] as const;

function spokenFirstName(name: string | null | undefined): string | null {
  const token = name?.trim().split(/\s+/)[0];
  return token && token.length > 0 ? token : null;
}

/**
 * Who is in the group: everyone seated in it. Before anyone is seated (member seating
 * off), the household's parents are the group Hale knows.
 */
async function groupMembers(
  database: Database,
  familyId: string,
  chatId: string,
  parentIds: readonly string[],
): Promise<GroupPlanMember[]> {
  const membership = await readGroupMembership(database, chatId);
  const seated =
    membership && membership.familyId === familyId
      ? membership.members.map((member) => member.userId)
      : [];
  const ids = [...new Set(seated.length > 0 ? seated : parentIds)];
  if (ids.length === 0) return [];
  const rows = await database
    .select({ id: schema.users.id, name: schema.users.name })
    .from(schema.users)
    .where(inArray(schema.users.id, ids));
  return ids.map((userId) => ({
    userId,
    firstName: spokenFirstName(rows.find((row) => row.id === userId)?.name),
  }));
}

const CALENDAR_MOVED = 'action.calendar_moved';
const GOOGLE_WRITTEN = 'integration.google_calendar_written';
const GOOGLE_FAILED = 'integration.google_calendar_failed';

async function wasMoved(database: Database, familyId: string, familyEventId: string) {
  const [moved] = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.targetTable, 'family_events'),
        eq(schema.auditLog.targetId, familyEventId),
        eq(schema.auditLog.actionTaken, CALENDAR_MOVED),
      ),
    )
    .limit(1);
  return moved !== undefined;
}

/**
 * Whose own calendar holds this version of the plan: the owner of the Google calendar
 * Hale created it on, and only when Hale's latest write there landed after the plan's
 * latest move. A move whose update failed, or was never tried (no token, flag off),
 * left the old time on that calendar, so its owner is "not yet" again.
 */
async function reachedOwners(
  database: Database,
  familyId: string,
  familyEventId: string,
  placed: { googleEventId: string | null; integrationId: string | null },
): Promise<string[]> {
  if (!placed.googleEventId || !placed.integrationId) return [];
  const rows = await database
    .select({ actionTaken: schema.auditLog.actionTaken, occurredAt: schema.auditLog.occurredAt })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.targetTable, 'family_events'),
        eq(schema.auditLog.targetId, familyEventId),
        inArray(schema.auditLog.actionTaken, [CALENDAR_MOVED, GOOGLE_WRITTEN, GOOGLE_FAILED]),
      ),
    )
    .orderBy(desc(schema.auditLog.occurredAt));
  const latest = (action: string) =>
    rows.find((row) => row.actionTaken === action)?.occurredAt.getTime();
  const written = latest(GOOGLE_WRITTEN);
  if (written === undefined) return [];
  const failed = latest(GOOGLE_FAILED);
  const moved = latest(CALENDAR_MOVED);
  if ((failed !== undefined && failed >= written) || (moved !== undefined && moved > written)) {
    return [];
  }
  const [owner] = await database
    .select({ userId: schema.integrations.userId })
    .from(schema.integrations)
    .where(eq(schema.integrations.id, placed.integrationId));
  return owner?.userId ? [owner.userId] : [];
}

/**
 * Read-only: the group plan behind a placed row, or null when the row was not placed by
 * a calendar_add drafted in the family's group chat, that chat is no longer the family's
 * group, or a REQUEST arrives for a row that is already gone. The event is rendered at
 * the same privacy floor as the file
 * behind the link (generic: a teen's or sensitive event loses its title and place), since
 * the group can include people who are not parents.
 */
export async function loadGroupPlan(
  database: Database,
  request: CalendarInviteRequest,
  now: Date,
): Promise<GroupPlan | null> {
  const row = await loadInviteEventRow(database, request.familyEventId);
  if (!row || row.familyId !== request.familyId) return null;
  if (request.method === 'REQUEST' && row.deletedAt !== null) return null;

  const [placement] = await database
    .select({
      placedByActionId: schema.familyEvents.placedByActionId,
      placedGoogleEventId: schema.familyEvents.placedGoogleEventId,
      placedGoogleIntegrationId: schema.familyEvents.placedGoogleIntegrationId,
    })
    .from(schema.familyEvents)
    .where(eq(schema.familyEvents.id, row.id));
  const placedByActionId = placement?.placedByActionId;
  if (!placement || !placedByActionId) return null;

  const draftedIn = await groupPlanChatId(database, row.familyId, placedByActionId);
  if (!draftedIn) return null;

  const [family] = await database
    .select({
      chatId: schema.families.linqGroupChatId,
      primaryLanguage: schema.families.primaryLanguage,
    })
    .from(schema.families)
    .where(eq(schema.families.id, row.familyId));
  if (!family?.chatId || family.chatId !== draftedIn) return null;
  const chatId = family.chatId;

  const parents = await database
    .select({ userId: schema.familyMembers.userId, role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, row.familyId),
        inArray(schema.familyMembers.role, [...PARENT_ROLES]),
      ),
    );
  const gateUserId = (parents.find((p) => p.role === 'primary_parent') ?? parents[0])?.userId;
  if (!gateUserId) return null;

  const change: GroupPlanChange =
    request.method === 'CANCEL'
      ? 'cancelled'
      : (await wasMoved(database, row.familyId, row.id))
        ? 'moved'
        : 'added';
  const revision =
    change === 'cancelled'
      ? 'cancelled'
      : String(await icsSequence(database, row.familyId, row.id, 'REQUEST'));
  const reachedUserIds =
    change === 'cancelled'
      ? []
      : await reachedOwners(database, row.familyId, row.id, {
          googleEventId: placement.placedGoogleEventId,
          integrationId: placement.placedGoogleIntegrationId,
        });
  const language = acceptReplyLanguage(family.primaryLanguage) ?? 'en';
  const timeZone = await householdTimezone(database, row.familyId);
  const invite = toInviteEvent(row, { level: 'generic', note: null, sequence: 0 }, now);

  const children =
    row.childId && row.childDob ? [{ id: row.childId, dateOfBirth: row.childDob }] : [];

  return {
    familyId: row.familyId,
    familyEventId: row.id,
    placedByActionId,
    chatId,
    contentClass: classifyFamilyEvent(row, children, now),
    gateUserId,
    change,
    dedupeKey: `${GROUP_PLAN_TEMPLATE_KEY}:${row.id}:${revision}`,
    event: {
      title: invite.summary,
      starts: planWhenLabel(row.startsAt, timeZone, language),
      ends: planEndLabel(row.startsAt, row.endsAt, timeZone, language),
      where: invite.location,
    },
    members: await groupMembers(
      database,
      row.familyId,
      chatId,
      parents.map((p) => p.userId),
    ),
    reachedUserIds,
    language,
  };
}

const GONE: schema.LinqRosterMemberStatus[] = ['left', 'removed'];

/**
 * Who Hale can place in the chat as its text goes: a live seat there, a live roster row
 * naming someone Hale knows (group onboarding v2 seats a known parent only on their own
 * reply, and a co-parent the backfill confirmed not at all), or the parent whose message
 * there drafted the plan, unless a closed seat or a roster row says they have left since.
 * Written on the report, so a cancel the group cannot hear goes to who had the link and
 * nobody else (`hadGroupPlanLink`).
 */
async function inChatUserIds(database: Database, plan: GroupPlan): Promise<string[]> {
  const seats = await database
    .select({
      userId: schema.linqGroupMembers.userId,
      removedAt: schema.linqGroupMembers.removedAt,
    })
    .from(schema.linqGroupMembers)
    .where(
      and(
        eq(schema.linqGroupMembers.chatId, plan.chatId),
        eq(schema.linqGroupMembers.familyId, plan.familyId),
      ),
    );
  let listed: Array<{
    userId: string | null;
    knownUserId: string | null;
    status: schema.LinqRosterMemberStatus;
  }> = [];
  try {
    listed = await database
      .select({
        userId: schema.linqGroupRosterMembers.userId,
        knownUserId: schema.linqGroupRosterMembers.knownUserId,
        status: schema.linqGroupRosterMembers.status,
      })
      .from(schema.linqGroupRosterMembers)
      .innerJoin(
        schema.linqGroupRosters,
        eq(schema.linqGroupRosters.id, schema.linqGroupRosterMembers.rosterId),
      )
      .where(
        and(
          eq(schema.linqGroupRosters.chatId, plan.chatId),
          eq(schema.linqGroupRosters.familyId, plan.familyId),
        ),
      );
  } catch (err) {
    if (!isUndefinedTable(err)) throw err;
  }
  const drafted = await database
    .select({ userId: schema.auditLog.actor })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, plan.familyId),
        eq(schema.auditLog.targetTable, 'actions'),
        eq(schema.auditLog.targetId, plan.placedByActionId),
        eq(schema.auditLog.actionTaken, 'group_plan.drafted'),
      ),
    );

  const inChat = new Set<string>();
  const left = new Set<string>();
  for (const seat of seats) (seat.removedAt === null ? inChat : left).add(seat.userId);
  for (const member of listed) {
    const gone = GONE.includes(member.status);
    for (const id of [member.userId, member.knownUserId]) {
      if (id) (gone ? left : inChat).add(id);
    }
  }
  for (const { userId } of drafted) if (!left.has(userId)) inChat.add(userId);
  return [...inChat];
}

/** Production ports. The only door is the family's claimed Linq group chat. */
export function productionGroupPlanReportPorts(
  database: Database,
  options: { fetch?: typeof fetch; now?: () => Date } = {},
): GroupPlanReportPorts {
  const clock = options.now ?? (() => new Date());
  return {
    enabled: () => groupPlanReportEnabled(),
    now: clock,
    loadPlan: (request) => loadGroupPlan(database, request, clock()),
    audience: (chatId, contentClass) => groupAudienceAllows(database, chatId, contentClass),
    alreadySent: (dedupeKey) => dedupeActive(dedupeKey, database),
    gate: (familyId, parentUserId, now) =>
      assertProactiveSendAllowed(
        { familyId, parentUserId, kind: 'calendar_alert', now },
        // A parent said yes to this plan: the standing of the 1:1 approval link it
        // replaces, which never asks for the household's watch consent. Enrolment, an
        // unread stop and quiet hours still hold it.
        { ...buildOutboundGatePorts(database), watchConsentGranted: async () => true },
      ),
    mintLink: (familyId, familyEventId) => mintEventInviteLink(database, familyId, familyEventId),
    compose: (input) => composeGroupPlanReport(budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS), input),
    /**
     * Every message is claimed before anything goes, in one transaction: the revision on
     * the last message's row, each other message keyed off it. A setup that fails claims
     * nothing, so the revision stays unspent and a text quiet hours held keeps its place
     * for the morning. Then in order, one at a time; the first that does not land stops
     * the rest, and it and every message after it, the link included, are failed with
     * its reason: the group gets the link only once everything before it has landed.
     */
    async send(plan, messages, optOut) {
      const inChat = await inChatUserIds(database, plan);
      const last = messages.length - 1;
      const claimed = await database.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        const claim = async (dedupeKey: string) => {
          const [row] = await tx
            .insert(schema.channelMessages)
            .values({
              familyId: plan.familyId,
              parentUserId: plan.gateUserId,
              channel: 'imessage',
              direction: 'out',
              category: PROACTIVE_CATEGORY.calendar_alert,
              templateKey: GROUP_PLAN_TEMPLATE_KEY,
              dedupeKey,
              providerChatId: plan.chatId,
              status: acceptedStatus('imessage'),
              sentAt: clock(),
            })
            .onConflictDoNothing()
            .returning({ id: schema.channelMessages.id });
          return row?.id ?? null;
        };
        const keyed = await claim(plan.dedupeKey);
        if (!keyed) return null;
        const rows: Array<{ id: string; text: string }> = [];
        for (const [index, text] of messages.entries()) {
          const id = index === last ? keyed : await claim(`${plan.dedupeKey}#${index}`);
          if (!id) {
            throw new Error('group plan report: a message of this revision is already claimed');
          }
          rows.push({ id, text });
        }
        return { keyed, rows };
      });
      if (!claimed) return 'already_sent';
      for (const [index, row] of claimed.rows.entries()) {
        try {
          const { providerMessageId } = await sendLinqChatMessage({
            chatId: plan.chatId,
            text: withOptOut(row.text, optOut),
            fetch: options.fetch,
          });
          await database
            .update(schema.channelMessages)
            .set({ providerMessageId, sentAt: clock() })
            .where(eq(schema.channelMessages.id, row.id));
        } catch (err) {
          const code = err instanceof LinqSendError ? err.code : 'unknown';
          await database
            .update(schema.channelMessages)
            .set(failedSendPatch(code))
            .where(
              inArray(
                schema.channelMessages.id,
                claimed.rows.slice(index).map((unsent) => unsent.id),
              ),
            );
          console.warn(
            { familyId: plan.familyId, code, message: index + 1, of: messages.length },
            'group plan report: a group message did not land - nothing after it is sent, the link included',
          );
          return 'send_failed';
        }
      }
      await database.insert(schema.auditLog).values({
        familyId: plan.familyId,
        actor: 'system',
        actionTaken: 'group_plan.calendar_reported',
        targetTable: 'channel_messages',
        targetId: claimed.keyed,
        after: {
          familyEventId: plan.familyEventId,
          change: plan.change,
          messages: messages.length,
          inChat,
        },
      });
      return 'sent';
    },
    async unsent(plan) {
      await database.insert(schema.auditLog).values({
        familyId: plan.familyId,
        actor: 'system',
        actionTaken: 'group_plan.line_unsent',
        targetTable: 'actions',
        targetId: plan.placedByActionId,
        after: { familyEventId: plan.familyEventId, change: plan.change },
      });
      console.error(
        {
          urgent: true,
          familyId: plan.familyId,
          familyEventId: plan.familyEventId,
          change: plan.change,
        },
        'URGENT: group plan text unwritten after a smaller model - page #ops now',
      );
      const page = await postOpsSlack(
        `Hale group plan: the ${plan.change} text for a family group could not be written, so nothing was sent to the group.`,
      );
      console.warn({ page }, 'group plan report: ops paged');
    },
    hold: (plan) => recordGroupPlanHold(database, plan, clock()),
  };
}

/**
 * Whether this person had the group's add-to-calendar link for this event: a revision's
 * keyed message landed in the family group while its report names them as in the chat.
 * The `#n` messages and the group's own cancel never carried the link, and a parent
 * outside the chat never saw it.
 */
export async function hadGroupPlanLink(
  database: Database,
  familyId: string,
  familyEventId: string,
  userId: string,
): Promise<boolean> {
  const m = schema.channelMessages;
  const links = await database
    .select({ id: m.id })
    .from(m)
    .where(
      and(
        eq(m.familyId, familyId),
        eq(m.templateKey, GROUP_PLAN_TEMPLATE_KEY),
        like(m.dedupeKey, `${GROUP_PLAN_TEMPLATE_KEY}:${familyEventId}:%`),
        notLike(m.dedupeKey, '%#%'),
        ne(m.dedupeKey, `${GROUP_PLAN_TEMPLATE_KEY}:${familyEventId}:cancelled`),
        inArray(m.status, ['queued', 'sent', 'delivered']),
      ),
    );
  if (links.length === 0) return false;
  const reports = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'group_plan.calendar_reported'),
        eq(schema.auditLog.targetTable, 'channel_messages'),
        inArray(
          schema.auditLog.targetId,
          links.map((link) => link.id),
        ),
      ),
    );
  return reports.some((report) => {
    const inChat = (report.after as { inChat?: unknown } | null)?.inChat;
    return Array.isArray(inChat) && inChat.includes(userId);
  });
}
