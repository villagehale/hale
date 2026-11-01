import type { ReplyLanguage } from '~/lib/channel/language';
import type { LinqTapback } from '../transport';
import {
  type CalendarAskFacts,
  type CalendarConsentReader,
  type GroupPlanCalendarWriter,
  type GroupPlanHouseholdResolver,
  type HouseholdResolution,
  groupPlanCalendarLineInput,
  sharedCalendarConsentReader,
} from './calendar';
import type { GroupPlanRecord, GroupPlanRsvpStore } from './store';
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
 * A yes opens one model-written ask for that household. A later message is
 * an OK only when the consent reader says so. The write uses the consent
 * row's family id, never the plan's covering family and never another
 * household. The message text is handed to the reader and is not compared
 * here.
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
  | 'write_failed';

export type CalendarEffect =
  | { status: 'asked' }
  | { status: 'written'; familyId: string; familyEventId: string }
  | { status: 'declined' }
  | { status: 'skipped'; reason: CalendarSkipReason };

export interface CalendarTurnPorts {
  store: GroupPlanRsvpStore;
  households?: GroupPlanHouseholdResolver;
  calendar?: GroupPlanCalendarWriter;
  consentReader?: CalendarConsentReader;
  composer?: GroupPlanRsvpComposer;
  send: (input: {
    chatId: string;
    text: string;
    kind?: 'calendar_ask' | 'calendar_written';
  }) => Promise<{ providerMessageId: string }>;
}

export type PendingCalendarAnswer =
  | { consumed: false }
  | {
      consumed: true;
      kind: 'written' | 'declined' | 'unwritten';
      effect: CalendarEffect;
      notice?: 'sent' | { skipped: GroupPlanRsvpVoiceSkip | 'not_sent' };
    };

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

/**
 * When this sender's household has an open ask, the reader decides the message.
 * Anything that is not a high-confidence OK or decline leaves the RSVP door
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
    language: ReplyLanguage;
    now: Date;
  },
  ports: CalendarTurnPorts,
): Promise<PendingCalendarAnswer> {
  const resolved = await resolveHousehold(ports, input.chatId, input.userId);
  if (!('status' in resolved) || resolved.status !== 'one') return { consumed: false };
  const familyId = resolved.familyId;
  const row = await ports.store.loadCalendarConsent(input.plan.id, familyId);
  if (!row || row.status !== 'asked') return { consumed: false };

  const reader = ports.consentReader ?? sharedCalendarConsentReader();
  const reading = await reader.read({
    text: input.text,
    tapback: input.tapback,
    senderName: input.senderName,
    ask: askFacts(input.plan, row.displayName, row.householdLabel),
  });
  if (!reading || reading.confidence !== 'high' || reading.decision === 'not_this') {
    return { consumed: false };
  }
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

  const spoken = await composeGroupPlanRsvpLine(
    groupPlanCalendarLineInput({
      kind: 'calendar_written',
      language: input.language,
      facts: askFacts(input.plan, row.displayName, row.householdLabel),
    }),
    ports.composer ?? productionGroupPlanRsvpComposer(),
  );
  if (spoken.status === 'skipped') {
    console.warn(
      { outcome: 'group_plan_calendar_notice_unsent', reason: spoken.reason },
      'group plan calendar: confirmation not sent',
    );
    return {
      consumed: true,
      kind: 'written',
      effect: { status: 'written', familyId, familyEventId: written.familyEventId },
      notice: { skipped: spoken.reason },
    };
  }
  try {
    await ports.send({ chatId: input.chatId, text: spoken.line, kind: 'calendar_written' });
  } catch (err) {
    console.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'group plan calendar: confirmation send failed',
    );
    return {
      consumed: true,
      kind: 'written',
      effect: { status: 'written', familyId, familyEventId: written.familyEventId },
      notice: { skipped: 'not_sent' },
    };
  }
  return {
    consumed: true,
    kind: 'written',
    effect: { status: 'written', familyId, familyEventId: written.familyEventId },
    notice: 'sent',
  };
}

/**
 * After a yes is recorded, ask once. A no or a maybe withdraws an ask that
 * has not been answered. A decline or a finished write is left as it is.
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
    await ports.store.releaseCalendarAsk(input.plan.id, familyId);
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

  const spoken = await composeGroupPlanRsvpLine(
    groupPlanCalendarLineInput({
      kind: 'calendar_ask',
      language: input.language,
      facts: askFacts(input.plan, input.displayName, input.householdLabel),
    }),
    ports.composer ?? productionGroupPlanRsvpComposer(),
  );
  if (spoken.status === 'skipped') {
    await ports.store.releaseCalendarAsk(input.plan.id, familyId);
    console.warn(
      { outcome: 'group_plan_calendar_ask_unsent', reason: spoken.reason },
      'group plan calendar: ask not sent',
    );
    return { status: 'skipped', reason: spoken.reason };
  }
  try {
    await ports.send({ chatId: input.chatId, text: spoken.line, kind: 'calendar_ask' });
  } catch (err) {
    await ports.store.releaseCalendarAsk(input.plan.id, familyId);
    console.error(
      { err: err instanceof Error ? err.name : 'unknown' },
      'group plan calendar: ask send failed',
    );
    return { status: 'skipped', reason: 'not_sent' };
  }
  await ports.store.noteCalendarAsked({
    planId: input.plan.id,
    familyId,
    actorUserId: input.userId,
  });
  return { status: 'asked' };
}
