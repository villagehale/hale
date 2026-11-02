import type { ReplyLanguage } from '~/lib/channel/language';
import type { LinqTapback } from '../transport';
import {
  type CalendarAskFacts,
  type CalendarConsentReader,
  type CalendarPrivateKind,
  type CalendarPrivateSender,
  type GroupPlanCalendarWriter,
  type GroupPlanHouseholdResolver,
  type HouseholdResolution,
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
  | 'write_failed'
  | 'remove_failed';

export type CalendarEffect =
  | { status: 'asked' }
  | { status: 'written'; familyId: string; familyEventId: string }
  | { status: 'declined' }
  | { status: 'removed'; familyId: string; familyEventId: string }
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
    language: ReplyLanguage;
    kind: CalendarPrivateKind;
  },
): Promise<{ status: 'sent' } | { status: 'skipped'; reason: CalendarSkipReason }> {
  const spoken = await composeGroupPlanRsvpLine(
    groupPlanCalendarLineInput({
      kind: input.kind,
      language: input.language,
      facts: askFacts(input.plan, input.displayName, input.householdLabel),
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
    language: ReplyLanguage;
    now: Date;
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
  if (!input.text.trim() && !tapback) return { consumed: false };

  const reader = ports.consentReader ?? sharedCalendarConsentReader();
  const reading = await reader.read({
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
    return reopenCalendarAsk(input, ports, familyId, row);
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
  if (!ports.calendar) {
    console.warn({ outcome: 'not_configured' }, 'group plan calendar: no writer');
    return {
      consumed: true,
      kind: 'unwritten',
      effect: { status: 'skipped', reason: 'not_configured' },
    };
  }

  const written = await ports.calendar.write({
    planId: input.plan.id,
    chatId: input.chatId,
    familyId,
    title: input.plan.title,
    startsAt: input.plan.startsAt,
    location: input.plan.location,
  });
  if (written.status === 'failed') {
    return {
      consumed: true,
      kind: 'unwritten',
      effect: { status: 'skipped', reason: 'write_failed' },
    };
  }
  await ports.store.markCalendarWritten({
    planId: input.plan.id,
    familyId,
    familyEventId: written.familyEventId,
    actorUserId: input.userId,
    now: input.now,
  });

  const notice = await deliverPrivate(ports, {
    plan: input.plan,
    familyId,
    userId: input.userId,
    displayName: row.displayName,
    householdLabel: row.householdLabel,
    language: input.language,
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
    language: ReplyLanguage;
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
    kind: 'calendar_ask',
  });
  if (sent.status === 'skipped') {
    await ports.store.releaseCalendarAsk(input.plan.id, familyId, input.userId);
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
    language: ReplyLanguage;
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
      await ports.store.releaseCalendarAsk(input.plan.id, familyId, input.userId);
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
    kind: 'calendar_ask',
  });
  if (sent.status === 'skipped') {
    await ports.store.releaseCalendarAsk(input.plan.id, familyId, input.userId);
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
    language: ReplyLanguage;
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
