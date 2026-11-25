import type { ReplyLanguage } from '~/lib/channel/language';
import { inviteWhenLabel } from '~/lib/loop/templates/calendar-invite/sms';
import type { OpsPager } from '~/lib/monitoring/failure-page';
import type { LinqTapback } from '../transport';
import {
  type CalendarAskFacts,
  type CalendarConsentReader,
  type CalendarConsentReading,
  type CalendarPrivateKind,
  type CalendarPrivateSender,
  GROUP_PLAN_RSVP_CALENDAR_MOVED_SKILL,
  type GroupPlanCalendarWriter,
  type GroupPlanHouseholdResolver,
  type HouseholdResolution,
  calendarAskTapback,
  groupPlanCalendarLineInput,
  sharedCalendarConsentReader,
} from './calendar';
import type { CalendarConsentRow, GroupPlanRecord, GroupPlanRsvpStore } from './store';
import type { PlanRsvpResponse } from './tally';
import {
  type GroupPlanRsvpComposer,
  type GroupPlanRsvpVoiceSkip,
  composeGroupPlanRsvpLine,
  productionGroupPlanRsvpComposer,
} from './voice';

/**
 * VIL-503 — the calendar half of a group-plan turn.
 *
 * A yes opens one model-written ask, sent 1:1 to that household's parent.
 * The group hears the RSVP only. A later message is an OK, a no, or a reopen
 * only when the consent reader says so. The write and the removal use the
 * consent row's family id. A removal soft-deletes the copy Hale placed and
 * leaves a row the parent added themselves.
 */

export type CalendarSkipReason =
  | 'no_household'
  | 'ambiguous_household'
  | 'no_start'
  | 'not_configured'
  | 'voice_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unusable'
  | 'not_sent'
  | 'no_parent'
  | 'no_thread'
  | 'thread_unread'
  | 'not_a_parent'
  | 'withdrawn'
  | 'write_failed'
  | 'remove_failed';

export type CalendarEffect =
  | { status: 'asked' }
  | { status: 'written'; familyId: string; familyEventId: string }
  | { status: 'declined' }
  | { status: 'removed'; familyId: string; familyEventId: string }
  | { status: 'moved'; familyId: string; familyEventId: string }
  | { status: 'skipped'; reason: CalendarSkipReason };

export interface CalendarTurnPorts {
  store: GroupPlanRsvpStore;
  households?: GroupPlanHouseholdResolver;
  calendar?: GroupPlanCalendarWriter;
  consentReader?: CalendarConsentReader;
  composer?: GroupPlanRsvpComposer;
  /** 1:1 to the household parent. This port has no group chat id. */
  privateSend?: CalendarPrivateSender;
}

export type PendingCalendarAnswer =
  | { consumed: false }
  | {
      consumed: true;
      kind: 'written' | 'declined' | 'unwritten' | 'asked';
      effect: CalendarEffect;
      notice?: 'sent' | { skipped: GroupPlanRsvpVoiceSkip | 'not_sent' };
    };

async function householdStillComing(
  ports: CalendarTurnPorts,
  chatId: string,
  planId: string,
  familyId: string,
): Promise<boolean> {
  if (!ports.households) return false;
  const yeses = await ports.store.listYesRsvps(planId);
  for (const yes of yeses) {
    if (!yes.userId) continue;
    const home = await ports.households.resolve({ chatId, userId: yes.userId });
    if (home.status === 'one' && home.familyId === familyId) return true;
  }
  return false;
}

function skipFor(resolution: HouseholdResolution): CalendarEffect | null {
  if (resolution.status === 'one') return null;
  if (resolution.status === 'ambiguous') {
    return { status: 'skipped', reason: 'ambiguous_household' };
  }
  return { status: 'skipped', reason: 'no_household' };
}

function askFacts(
  plan: GroupPlanRecord,
  displayName: string,
  householdLabel: string | null,
): CalendarAskFacts {
  return {
    title: plan.title,
    startsAt: plan.startsAt?.toISOString() ?? null,
    location: plan.location,
    displayName,
    householdLabel,
  };
}

/**
 * The start as this household reads it on their own clock. The writer never
 * converts an instant itself; with no known zone it gets no clock time at all.
 */
function householdWhen(startsAt: Date | null, timeZone: string | null): string | null {
  if (!startsAt || !timeZone) return null;
  try {
    return inviteWhenLabel(startsAt, timeZone);
  } catch (err) {
    if (err instanceof RangeError) return null;
    throw err;
  }
}

type HouseholdLookup = HouseholdResolution | { status: 'skipped'; reason: 'not_configured' };

async function resolveHousehold(
  ports: CalendarTurnPorts,
  chatId: string,
  userId: string | null,
): Promise<HouseholdLookup> {
  if (!ports.households) {
    console.warn({ outcome: 'not_configured' }, 'group plan calendar: no household resolver');
    return { status: 'skipped', reason: 'not_configured' };
  }
  return ports.households.resolve({ chatId, userId });
}

async function deliverPrivate(
  ports: CalendarTurnPorts,
  input: {
    plan: GroupPlanRecord;
    familyId: string;
    userId: string | null;
    displayName: string;
    householdLabel: string | null;
    language: ReplyLanguage | null;
    /** The parent's own message, or null when this turn has no words. */
    parentWords: string | null;
    kind: Exclude<CalendarPrivateKind, 'calendar_moved'>;
    sendKey?: string;
  },
): Promise<{ status: 'sent' } | { status: 'skipped'; reason: CalendarSkipReason }> {
  const timeZone = await ports.store.householdTimeZone(input.familyId);
  const spoken = await composeGroupPlanRsvpLine(
    groupPlanCalendarLineInput({
      kind: input.kind,
      language: input.language,
      parentWords: input.parentWords,
      facts: {
        ...askFacts(input.plan, input.displayName, input.householdLabel),
        startsAt: householdWhen(input.plan.startsAt, timeZone),
      },
    }),
    ports.composer ?? productionGroupPlanRsvpComposer(),
  );
  if (spoken.status === 'skipped') return { status: 'skipped', reason: spoken.reason };
  if (!ports.privateSend) {
    console.warn({ outcome: 'not_configured' }, 'group plan calendar: no private sender');
    return { status: 'skipped', reason: 'not_configured' };
  }
  const sent = await ports.privateSend.send({
    planId: input.plan.id,
    familyId: input.familyId,
    userId: input.userId,
    text: spoken.line,
    kind: input.kind,
    ...(input.sendKey ? { sendKey: input.sendKey } : {}),
  });
  if (sent.status === 'skipped') return { status: 'skipped', reason: sent.reason };
  if (input.kind === 'calendar_ask' && sent.providerMessageId) {
    await ports.store.setCalendarAskMessage(input.plan.id, input.familyId, sent.providerMessageId);
  }
  return { status: 'sent' };
}

function privateNotice(reason: CalendarSkipReason): {
  skipped: GroupPlanRsvpVoiceSkip | 'not_sent';
} {
  if (
    reason === 'voice_unavailable' ||
    reason === 'skill_unavailable' ||
    reason === 'model_failed' ||
    reason === 'unusable'
  ) {
    return { skipped: reason };
  }
  return { skipped: 'not_sent' };
}

/**
 * When this sender's household has an open ask, or a decline they might
 * reopen, the reader decides the message. Anything else leaves the RSVP door
 * the turn.
 */
export async function answerPendingCalendarAsk(
  input: {
    chatId: string;
    plan: GroupPlanRecord;
    userId: string | null;
    senderName: string | null;
    text: string;
    tapback: LinqTapback | null;
    /** The message the tapback landed on. A reaction on anything else is not this ask. */
    tapbackMessageId?: string | null;
    language: ReplyLanguage | null;
    now: Date;
    /** A reading already taken while choosing among several asks. */
    decided?: CalendarConsentReading;
  },
  ports: CalendarTurnPorts,
): Promise<PendingCalendarAnswer> {
  const resolved = await resolveHousehold(ports, input.chatId, input.userId);
  if (!('status' in resolved) || resolved.status !== 'one') return { consumed: false };
  const familyId = resolved.familyId;
  const row = await ports.store.loadCalendarConsent(input.plan.id, familyId);
  if (!row || (row.status !== 'asked' && row.status !== 'declined')) return { consumed: false };

  const tapback =
    input.tapback &&
    input.tapbackMessageId &&
    row.askProviderMessageId &&
    input.tapbackMessageId === row.askProviderMessageId
      ? input.tapback
      : null;
  const reader = ports.consentReader ?? sharedCalendarConsentReader();
  // A bare tapback is protocol. Only heart, thumbs-up, and thumbs-down on this
  // ask decide it. Laugh, emphasize, question, and any other message do not,
  // and the model is not asked to overrule that.
  const tapbackDecision =
    !input.text.trim() && tapback && row.status === 'asked' ? calendarAskTapback(tapback) : null;
  if (!input.decided && !input.text.trim() && !tapbackDecision) return { consumed: false };

  const reading = input.decided
    ? input.decided
    : tapbackDecision
      ? { decision: tapbackDecision, confidence: 'high' as const }
      : await reader.read({
          text: input.text,
          tapback,
          senderName: input.senderName,
          consent: row.status,
          ask: askFacts(input.plan, row.displayName, row.householdLabel),
        });
  if (!reading || reading.confidence !== 'high' || reading.decision === 'not_this') {
    return { consumed: false };
  }

  if (row.status === 'declined') {
    if (reading.decision !== 'reopen') return { consumed: false };
    return reopenCalendarAsk(
      { ...input, parentWords: input.text.trim() || null },
      ports,
      familyId,
      row,
    );
  }

  if (reading.decision === 'reopen') return { consumed: false };
  if (reading.decision === 'decline') {
    await ports.store.markCalendarDeclined({
      planId: input.plan.id,
      familyId,
      actorUserId: input.userId,
      now: input.now,
    });
    return { consumed: true, kind: 'declined', effect: { status: 'declined' } };
  }

  if (!input.plan.startsAt) {
    return {
      consumed: true,
      kind: 'unwritten',
      effect: { status: 'skipped', reason: 'no_start' },
    };
  }

  const written = await ports.store.commitCalendarWrite({
    consentId: row.id,
    planId: input.plan.id,
    chatId: input.chatId,
    familyId,
    actorUserId: input.userId,
    now: input.now,
  });
  if (written.status !== 'written') {
    const reason =
      written.status === 'withdrawn'
        ? 'withdrawn'
        : written.status === 'no_start'
          ? 'no_start'
          : 'write_failed';
    console.warn(
      { outcome: 'group_plan_calendar_unwritten', reason },
      'group plan calendar: no write',
    );
    return { consumed: true, kind: 'unwritten', effect: { status: 'skipped', reason } };
  }

  const notice = await deliverPrivate(ports, {
    plan: input.plan,
    familyId,
    userId: input.userId,
    displayName: row.displayName,
    householdLabel: row.householdLabel,
    language: input.language,
    parentWords: input.text.trim() || null,
    kind: 'calendar_written',
  });
  if (notice.status === 'skipped') {
    console.warn(
      { outcome: 'group_plan_calendar_notice_unsent', reason: notice.reason },
      'group plan calendar: confirmation not sent',
    );
    return {
      consumed: true,
      kind: 'written',
      effect: { status: 'written', familyId, familyEventId: written.familyEventId },
      notice: privateNotice(notice.reason),
    };
  }
  return {
    consumed: true,
    kind: 'written',
    effect: { status: 'written', familyId, familyEventId: written.familyEventId },
    notice: 'sent',
  };
}

async function reopenCalendarAsk(
  input: {
    plan: GroupPlanRecord;
    userId: string | null;
    language: ReplyLanguage | null;
    parentWords: string | null;
    now: Date;
  },
  ports: CalendarTurnPorts,
  familyId: string,
  row: CalendarConsentRow,
): Promise<PendingCalendarAnswer> {
  const cleared = await ports.store.deleteCalendarConsent(input.plan.id, familyId, 'declined');
  if (!cleared) return { consumed: false };
  const claimed = await ports.store.claimCalendarAsk({
    planId: input.plan.id,
    familyId,
    memberKey: row.memberKey,
    displayName: row.displayName,
    householdLabel: row.householdLabel,
    now: input.now,
  });
  if (!claimed) return { consumed: false };
  const sent = await deliverPrivate(ports, {
    plan: input.plan,
    familyId,
    userId: input.userId,
    displayName: row.displayName,
    householdLabel: row.householdLabel,
    language: input.language,
    parentWords: input.parentWords,
    kind: 'calendar_ask',
  });
  if (sent.status === 'skipped') {
    await ports.store.releaseCalendarAsk(input.plan.id, familyId, input.userId, 'send_failed');
    await ports.store.recordCalendarDecline({
      planId: input.plan.id,
      familyId,
      memberKey: row.memberKey,
      displayName: row.displayName,
      householdLabel: row.householdLabel,
      actorUserId: input.userId,
      now: input.now,
    });
    console.warn(
      { outcome: 'group_plan_calendar_reopen_unsent', reason: sent.reason },
      'group plan calendar: reopen ask not sent',
    );
    return {
      consumed: true,
      kind: 'unwritten',
      effect: { status: 'skipped', reason: sent.reason },
    };
  }
  await ports.store.noteCalendarAsked({
    planId: input.plan.id,
    familyId,
    actorUserId: input.userId,
  });
  return { consumed: true, kind: 'asked', effect: { status: 'asked' } };
}

/**
 * After a yes is recorded, ask once, 1:1. A no or a maybe withdraws an open
 * ask. A no or a maybe after a write removes only Hale's copy and confirms
 * in private when the model can write that line.
 */
export async function settleCalendarAfterAnswer(
  input: {
    chatId: string;
    plan: GroupPlanRecord;
    userId: string | null;
    memberKey: string;
    displayName: string;
    householdLabel: string | null;
    response: PlanRsvpResponse;
    language: ReplyLanguage | null;
    parentWords: string | null;
    now: Date;
  },
  ports: CalendarTurnPorts,
): Promise<CalendarEffect | undefined> {
  const resolved = await resolveHousehold(ports, input.chatId, input.userId);
  if (resolved.status !== 'one') {
    if (input.response !== 'yes') return undefined;
    if (resolved.status === 'skipped') return resolved;
    return skipFor(resolved) ?? undefined;
  }
  const familyId = resolved.familyId;

  if (input.response !== 'yes') {
    const row = await ports.store.loadCalendarConsent(input.plan.id, familyId);
    if (row && (await householdStillComing(ports, input.chatId, input.plan.id, familyId))) {
      return undefined;
    }
    if (row?.status === 'asked') {
      await ports.store.releaseCalendarAsk(
        input.plan.id,
        familyId,
        input.userId,
        input.response === 'maybe' ? 'household_said_maybe' : 'household_said_no',
      );
    }
    if (row?.status === 'written') {
      return removeWrittenCopy(input, ports, familyId, row);
    }
    return undefined;
  }

  if (!input.plan.startsAt) return { status: 'skipped', reason: 'no_start' };
  if (!ports.calendar) {
    console.warn({ outcome: 'not_configured' }, 'group plan calendar: no writer');
    return { status: 'skipped', reason: 'not_configured' };
  }

  const existing = await ports.store.loadCalendarConsent(input.plan.id, familyId);
  if (existing) return undefined;

  const claimed = await ports.store.claimCalendarAsk({
    planId: input.plan.id,
    familyId,
    memberKey: input.memberKey,
    displayName: input.displayName,
    householdLabel: input.householdLabel,
    now: input.now,
  });
  if (!claimed) return undefined;

  const sent = await deliverPrivate(ports, {
    plan: input.plan,
    familyId,
    userId: input.userId,
    displayName: input.displayName,
    householdLabel: input.householdLabel,
    language: input.language,
    parentWords: input.parentWords,
    kind: 'calendar_ask',
  });
  if (sent.status === 'skipped') {
    await ports.store.releaseCalendarAsk(
      input.plan.id,
      familyId,
      input.userId,
      sent.reason === 'no_thread' ? 'no_thread' : 'send_failed',
    );
    console.warn(
      { outcome: 'group_plan_calendar_ask_unsent', reason: sent.reason },
      'group plan calendar: ask not sent',
    );
    return { status: 'skipped', reason: sent.reason };
  }
  await ports.store.noteCalendarAsked({
    planId: input.plan.id,
    familyId,
    actorUserId: input.userId,
  });
  return { status: 'asked' };
}

async function removeWrittenCopy(
  input: {
    plan: GroupPlanRecord;
    userId: string | null;
    language: ReplyLanguage | null;
    parentWords: string | null;
  },
  ports: CalendarTurnPorts,
  familyId: string,
  row: CalendarConsentRow,
): Promise<CalendarEffect> {
  if (!ports.calendar) {
    console.warn({ outcome: 'not_configured' }, 'group plan calendar: no writer');
    return { status: 'skipped', reason: 'not_configured' };
  }
  const removed = await ports.calendar.remove({ planId: input.plan.id, familyId });
  if (removed.status === 'failed') return { status: 'skipped', reason: 'remove_failed' };
  if (removed.status === 'none') {
    await ports.store.deleteCalendarConsent(input.plan.id, familyId, 'written');
    return { status: 'skipped', reason: 'remove_failed' };
  }
  await ports.store.noteCalendarRemoved({
    planId: input.plan.id,
    familyId,
    familyEventId: removed.familyEventId,
    actorUserId: input.userId,
  });
  await ports.store.deleteCalendarConsent(input.plan.id, familyId, 'written');
  const notice = await deliverPrivate(ports, {
    plan: input.plan,
    familyId,
    userId: input.userId,
    displayName: row.displayName,
    householdLabel: row.householdLabel,
    language: input.language,
    parentWords: input.parentWords,
    kind: 'calendar_removed',
  });
  if (notice.status === 'skipped') {
    console.warn(
      { outcome: 'group_plan_calendar_removal_unsent', reason: notice.reason },
      'group plan calendar: removal confirmation not sent',
    );
  }
  return { status: 'removed', familyId, familyEventId: removed.familyEventId };
}

/**
 * A lock's 1:1 line goes to the adult the old ask went to only while they are still a
 * parent (primary or co-parent) of that household here. Anyone else gets nothing.
 */
async function stillParentOf(
  ports: CalendarTurnPorts,
  input: { chatId: string; userId: string; familyId: string; kind: CalendarPrivateKind },
): Promise<CalendarSkipReason | null> {
  const home = await resolveHousehold(ports, input.chatId, input.userId);
  if (home.status === 'skipped') return home.reason;
  if (home.status === 'one' && home.familyId === input.familyId) return null;
  console.info(
    { outcome: 'group_plan_calendar_not_a_parent', kind: input.kind },
    'group plan calendar: no longer a parent of that household, nothing sent',
  );
  return 'not_a_parent';
}

/** The key a lock's send goes out once under: plan, new start, household. Never a clock. */
function lockSendKey(plan: GroupPlanRecord, familyId: string): string {
  return `${plan.id}:${plan.startsAt?.toISOString() ?? 'none'}:${familyId}`;
}

/**
 * A lock withdrew this household's open ask. Ask once more, about the new start, the
 * parent who was asked before. The send is keyed on plan, new start and household.
 */
export async function reaskAfterLockedStart(
  input: {
    plan: GroupPlanRecord;
    row: CalendarConsentRow;
    userId: string;
    language: ReplyLanguage | null;
    now: Date;
  },
  ports: CalendarTurnPorts,
): Promise<CalendarEffect> {
  if (!input.plan.startsAt) return { status: 'skipped', reason: 'no_start' };
  const { familyId } = input.row;
  const refused = await stillParentOf(ports, {
    chatId: input.plan.chatId,
    userId: input.userId,
    familyId,
    kind: 'calendar_ask',
  });
  if (refused) return { status: 'skipped', reason: refused };
  const claimed = await ports.store.claimCalendarAsk({
    planId: input.plan.id,
    familyId,
    memberKey: input.row.memberKey,
    displayName: input.row.displayName,
    householdLabel: input.row.householdLabel,
    now: input.now,
  });
  if (!claimed) return { status: 'asked' };
  const sent = await deliverPrivate(ports, {
    plan: input.plan,
    familyId,
    userId: input.userId,
    displayName: input.row.displayName,
    householdLabel: input.row.householdLabel,
    language: input.language,
    parentWords: null,
    kind: 'calendar_ask',
    sendKey: lockSendKey(input.plan, familyId),
  });
  if (sent.status === 'skipped') {
    await ports.store.releaseCalendarAsk(
      input.plan.id,
      familyId,
      input.userId,
      sent.reason === 'no_thread' ? 'no_thread' : 'send_failed',
    );
    console.warn(
      { outcome: 'group_plan_calendar_reask_unsent', reason: sent.reason },
      'group plan calendar: ask after the new start not sent',
    );
    return { status: 'skipped', reason: sent.reason };
  }
  await ports.store.noteCalendarAsked({
    planId: input.plan.id,
    familyId,
    actorUserId: input.userId,
  });
  return { status: 'asked' };
}

/**
 * A lock moved the plan. The copy this household accepted moves to the new start with
 * its audit row in that household, in one transaction, and the parent who agreed hears
 * it in a line the model writes while they are still a parent there. A failed move pages
 * #ops and leaves the copy where it was; a line the model cannot write pages #ops and the
 * copy still moves.
 */
export async function moveWrittenCopy(
  input: {
    plan: GroupPlanRecord;
    previousStartsAt: Date | null;
    row: CalendarConsentRow;
    userId: string | null;
    language: ReplyLanguage | null;
    now: Date;
  },
  ports: CalendarTurnPorts & { pager: OpsPager },
): Promise<CalendarEffect> {
  const { familyId } = input.row;
  if (!input.plan.startsAt) return { status: 'skipped', reason: 'no_start' };
  const moved = await ports.store.commitCalendarMove({
    planId: input.plan.id,
    chatId: input.plan.chatId,
    familyId,
    title: input.plan.title,
    startsAt: input.plan.startsAt,
    location: input.plan.location,
  });
  if (moved.status === 'failed') {
    console.error(
      { outcome: 'group_plan_calendar_move_failed' },
      'group plan calendar: the accepted copy did not move',
    );
    await ports.pager.page({ site: 'group_plan_calendar_move', facts: { failure: 'move_failed' } });
    return { status: 'skipped', reason: 'write_failed' };
  }
  const effect: CalendarEffect = { status: 'moved', familyId, familyEventId: moved.familyEventId };
  if (moved.status === 'unchanged') return effect;
  if (
    input.userId &&
    (await stillParentOf(ports, {
      chatId: input.plan.chatId,
      userId: input.userId,
      familyId,
      kind: 'calendar_moved',
    }))
  ) {
    return effect;
  }

  const timeZone = await ports.store.householdTimeZone(familyId);
  const spoken = await composeGroupPlanRsvpLine(
    {
      skill: GROUP_PLAN_RSVP_CALENDAR_MOVED_SKILL,
      kind: 'calendar_moved',
      language: input.language,
      parentWords: null,
      facts: {
        ...askFacts(input.plan, input.row.displayName, input.row.householdLabel),
        startsAt: householdWhen(input.plan.startsAt, timeZone),
        previousStartsAt: householdWhen(input.previousStartsAt, timeZone),
      },
      questions: 0,
    },
    ports.composer ?? productionGroupPlanRsvpComposer(),
  );
  if (spoken.status === 'skipped') {
    console.error(
      { outcome: 'group_plan_calendar_moved_unwritten', reason: spoken.reason },
      'group plan calendar: moved line not written',
    );
    await ports.pager.page({
      site: 'group_plan_calendar_move',
      facts: { failure: 'line_unwritten' },
    });
    return effect;
  }
  if (!input.userId || !ports.privateSend) {
    console.warn(
      {
        outcome: 'group_plan_calendar_moved_unsent',
        reason: input.userId ? 'not_configured' : 'no_parent',
      },
      'group plan calendar: moved line not sent',
    );
    return effect;
  }
  const sent = await ports.privateSend.send({
    planId: input.plan.id,
    familyId,
    userId: input.userId,
    text: spoken.line,
    kind: 'calendar_moved',
    sendKey: lockSendKey(input.plan, familyId),
  });
  if (sent.status === 'skipped') {
    console.warn(
      { outcome: 'group_plan_calendar_moved_unsent', reason: sent.reason },
      'group plan calendar: moved line not sent',
    );
  }
  return effect;
}
