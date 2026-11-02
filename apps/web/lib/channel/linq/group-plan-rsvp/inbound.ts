import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import {
  linqGroupPlanRsvpCalendarEnabled,
  linqGroupPlanRsvpEnabled,
  linqGroupPollsEnabled,
  linqPollsEnabled,
} from '../config';
import { type OneToOneSend, sendHouseholdPrivateLine } from '../connect-link-1to1';
import { familySpeechLanguage } from '../family-outbound';
import { sendChoicePoll } from '../poll';
import { primaryParentId } from '../roster-ask';
import type { LinqTapback } from '../transport';
import {
  type CalendarConsentReader,
  postgresGroupPlanCalendarWriter,
  postgresGroupPlanHouseholds,
  sharedCalendarConsentReader,
} from './calendar';
import { answerPendingCalendarAsk } from './calendar-turn';
import { memberKeyFromHandle, memberKeyFromName } from './member-key';
import {
  GROUP_POLL_CHOICE_KIND,
  GROUP_POLL_KIND,
  type GroupPollCardPort,
  type GroupPollTurnResult,
  takeGroupPollCardVote,
} from './poll-turn';
import type { GroupPlanRsvpReader } from './reading';
import {
  GROUP_PLAN_CALENDAR_ASK_TEMPLATE,
  GROUP_PLAN_CALENDAR_REMOVED_TEMPLATE,
  GROUP_PLAN_CALENDAR_WRITTEN_TEMPLATE,
  GROUP_PLAN_RSVP_TEMPLATE,
  GROUP_POLL_TEMPLATE,
  sendGroupPlanRsvpLine,
} from './send';
import { createPostgresGroupPlanRsvpStore } from './store';
import type { PlanTally } from './tally';
import { type GroupPlanRsvpTurnOutcome, takeGroupPlanRsvpTurn } from './turn';
import type { GroupPlanRsvpComposer } from './voice';

export interface GroupPlanRsvpInboundPorts {
  database: Database;
  now: Date;
  send?: (input: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>;
  reader?: GroupPlanRsvpReader;
  composer?: GroupPlanRsvpComposer;
  pollCard?: GroupPollCardPort;
  consentReader?: CalendarConsentReader;
  /** Test seam. Production sends through the household 1:1 door. */
  oneToOne?: OneToOneSend;
}

/** The household's stored language. A missing tag stays null so the writer follows their words. */
async function householdLanguage(database: Database, familyId: string) {
  return familySpeechLanguage(database, familyId);
}

/**
 * Language of the household the calendar step would write, not whichever
 * membership comes back first. None, or two matches, stays null.
 */
async function calendarHouseholdLanguage(
  database: Database,
  chatId: string,
  userId: string | null,
) {
  if (!userId) return null;
  const resolved = await postgresGroupPlanHouseholds(database).resolve({ chatId, userId });
  if (resolved.status !== 'one') return null;
  return householdLanguage(database, resolved.familyId);
}

async function senderNameOf(database: Database, userId: string | null): Promise<string | null> {
  if (!userId) return null;
  const [row] = await database
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  return row?.name?.trim().split(/\s+/)[0] || null;
}

function groupTemplate(kind: 'plan' | 'poll' | undefined) {
  return kind === 'poll' ? GROUP_POLL_TEMPLATE : GROUP_PLAN_RSVP_TEMPLATE;
}

function calendarTemplate(kind: 'calendar_ask' | 'calendar_written' | 'calendar_removed'): string {
  if (kind === 'calendar_ask') return GROUP_PLAN_CALENDAR_ASK_TEMPLATE;
  if (kind === 'calendar_written') return GROUP_PLAN_CALENDAR_WRITTEN_TEMPLATE;
  return GROUP_PLAN_CALENDAR_REMOVED_TEMPLATE;
}

function ledgeredSend(ports: GroupPlanRsvpInboundPorts) {
  return (line: { chatId: string; text: string; kind?: 'plan' | 'poll' }) =>
    ports.send
      ? ports.send({ chatId: line.chatId, text: line.text })
      : sendGroupPlanRsvpLine(ports.database, {
          chatId: line.chatId,
          text: line.text,
          templateKey: groupTemplate(line.kind),
          now: ports.now,
        });
}

function privateCalendarSend(ports: GroupPlanRsvpInboundPorts) {
  return {
    async send(line: {
      planId: string;
      familyId: string;
      userId: string | null;
      text: string;
      kind: 'calendar_ask' | 'calendar_written' | 'calendar_removed';
    }) {
      const templateKey = calendarTemplate(line.kind);
      const result = await sendHouseholdPrivateLine(ports.database, {
        familyId: line.familyId,
        userId: line.userId,
        body: line.text,
        templateKey,
        dedupeKey: `${templateKey}:${line.planId}:${line.familyId}:${ports.now.toISOString()}`,
        now: ports.now,
        ...(ports.oneToOne ? { send: ports.oneToOne } : {}),
      });
      if (result.status === 'sent') {
        return { status: 'sent' as const, providerMessageId: result.providerMessageId };
      }
      return {
        status: 'skipped' as const,
        reason: result.status === 'no_parent' ? ('no_parent' as const) : ('not_sent' as const),
      };
    },
  };
}

/**
 * The native card for a group poll, through the shared `sendChoicePoll` ledger
 * (`linq:poll`, audit `linq_poll_sent`). Each option carries the poll id and its
 * key, so a tap resolves without reading any text.
 */
export function postgresGroupPollCard(database: Database): GroupPollCardPort {
  return {
    enabled: linqPollsEnabled,
    async send(input) {
      const parentUserId = await primaryParentId(database, input.familyId);
      if (!parentUserId) return { status: 'skipped', reason: 'not_configured' };
      const sent = await sendChoicePoll(database, {
        chatId: input.chatId,
        prompt: null,
        options: input.options.map((option) => ({
          text: option.text,
          pollKind: GROUP_POLL_KIND,
          subjectKey: input.pollId,
          choiceKind: GROUP_POLL_CHOICE_KIND,
          choiceValue: option.key,
        })),
        familyId: input.familyId,
        parentUserId,
        now: input.now,
        idempotencyKey: `poll:group:${input.pollId}`,
      });
      if (sent.status === 'sent') {
        const store = createPostgresGroupPlanRsvpStore(database);
        return {
          status: 'sent',
          providerMessageId: sent.providerMessageId,
          options: await store.cardOptions(sent.providerMessageId),
        };
      }
      if (sent.status === 'skipped' && sent.reason === 'flag_off') {
        return { status: 'skipped', reason: 'polls_off' };
      }
      if (sent.status === 'skipped' && sent.reason === 'not_configured') {
        return { status: 'skipped', reason: 'not_configured' };
      }
      return { status: 'skipped', reason: 'refused' };
    },
  };
}

export async function considerGroupPlanRsvp(
  ports: GroupPlanRsvpInboundPorts,
  input: {
    chatId: string;
    senderHandle: string;
    senderUserId?: string | null;
    text: string;
    tapback: LinqTapback | null;
    tapbackMessageId?: string | null;
  },
): Promise<GroupPlanRsvpTurnOutcome> {
  if (!linqGroupPlanRsvpEnabled() && !linqGroupPollsEnabled()) return { handled: false };
  const store = createPostgresGroupPlanRsvpStore(ports.database);
  const live = linqGroupPlanRsvpEnabled() ? await store.loadLivePlan(input.chatId) : null;
  const livePoll = linqGroupPollsEnabled() ? await store.loadLivePoll(input.chatId) : null;
  const cover = await store.coveringFamily(input.chatId);
  if (!live && !livePoll && !cover) return { handled: false };

  return takeGroupPlanRsvpTurn(
    {
      chatId: input.chatId,
      senderHandle: input.senderHandle,
      senderName: await senderNameOf(ports.database, input.senderUserId ?? null),
      senderUserId: input.senderUserId ?? null,
      text: input.text,
      tapback: input.tapback,
      tapbackMessageId: input.tapbackMessageId,
      language: 'en',
      calendarLanguage: await calendarHouseholdLanguage(
        ports.database,
        input.chatId,
        input.senderUserId ?? null,
      ),
      now: ports.now,
    },
    {
      store,
      reader: ports.reader,
      composer: ports.composer,
      send: ledgeredSend(ports),
      pollCard: ports.pollCard ?? postgresGroupPollCard(ports.database),
      households: postgresGroupPlanHouseholds(ports.database),
      calendar: postgresGroupPlanCalendarWriter(ports.database),
      consentReader: ports.consentReader ?? sharedCalendarConsentReader(),
      privateSend: privateCalendarSend(ports),
    },
  );
}

function calendarPorts(ports: GroupPlanRsvpInboundPorts) {
  return {
    households: postgresGroupPlanHouseholds(ports.database),
    calendar: postgresGroupPlanCalendarWriter(ports.database),
    consentReader: ports.consentReader ?? sharedCalendarConsentReader(),
    composer: ports.composer,
    privateSend: privateCalendarSend(ports),
  };
}

function calendarOutcome(
  answered: Awaited<ReturnType<typeof answerPendingCalendarAsk>>,
  tally: PlanTally,
): GroupPlanRsvpTurnOutcome {
  if (!answered.consumed) return { handled: false };
  const outcome =
    answered.kind === 'written'
      ? 'group_plan_calendar_written'
      : answered.kind === 'declined'
        ? 'group_plan_calendar_declined'
        : answered.kind === 'asked'
          ? 'group_plan_calendar_asked'
          : 'group_plan_calendar_unwritten';
  return {
    handled: true,
    outcome,
    count: answered.notice === 'sent' ? 'intake' : 'ignored',
    ...(answered.notice ? { notice: answered.notice } : {}),
    tally,
    calendar: answered.effect,
  };
}

/**
 * A 1:1 reply to the private calendar ask. The group chat is not this message's
 * chat. One open ask for this parent is answered here; anything else is left
 * for the normal 1:1 door.
 */
export async function considerPrivateCalendarReply(
  ports: GroupPlanRsvpInboundPorts,
  input: { senderUserId: string; senderName: string | null; text: string },
): Promise<GroupPlanRsvpTurnOutcome | { handled: false }> {
  if (!linqGroupPlanRsvpCalendarEnabled()) return { handled: false };
  const store = createPostgresGroupPlanRsvpStore(ports.database);
  const open = await store.listOpenCalendarAsks(input.senderUserId);
  if (open.length !== 1) return { handled: false };
  const plan = open[0]?.plan;
  const consent = open[0]?.consent;
  if (!plan || !consent) return { handled: false };
  const answered = await answerPendingCalendarAsk(
    {
      chatId: plan.chatId,
      plan,
      userId: input.senderUserId,
      senderName: input.senderName,
      text: input.text,
      tapback: null,
      language: await householdLanguage(ports.database, consent.familyId),
      now: ports.now,
    },
    { store, ...calendarPorts(ports) },
  );
  if (!answered.consumed) return { handled: false };
  const tally = (await store.loadTally(plan.id)).tally;
  return calendarOutcome(answered, tally);
}

/** A tapback counts only when it lands on the private ask itself. */
export async function considerCalendarTapback(
  ports: GroupPlanRsvpInboundPorts,
  input: {
    senderUserId: string | null;
    senderName: string | null;
    messageId: string;
    tapback: LinqTapback | null;
  },
): Promise<GroupPlanRsvpTurnOutcome | { handled: false }> {
  if (!linqGroupPlanRsvpCalendarEnabled() || !input.tapback) return { handled: false };
  const store = createPostgresGroupPlanRsvpStore(ports.database);
  const found = await store.findCalendarAskByMessage(input.messageId);
  if (!found) return { handled: false };
  const answered = await answerPendingCalendarAsk(
    {
      chatId: found.plan.chatId,
      plan: found.plan,
      userId: input.senderUserId,
      senderName: input.senderName,
      text: '',
      tapback: input.tapback,
      tapbackMessageId: input.messageId,
      language: await householdLanguage(ports.database, found.consent.familyId),
      now: ports.now,
    },
    { store, ...calendarPorts(ports) },
  );
  if (!answered.consumed) return { handled: false };
  const tally = (await store.loadTally(found.plan.id)).tally;
  return calendarOutcome(answered, tally);
}

/**
 * VIL-471 — a tap on a native group poll card (Hale's own, or the VIL-458
 * stuck-group offer). Anyone in the chat counts, Hale customer or not.
 */
export async function considerGroupPollCardVote(
  ports: GroupPlanRsvpInboundPorts,
  input: {
    chatId: string;
    senderHandle: string;
    senderUserId?: string | null;
    event: 'added' | 'removed';
    optionId: string;
    card: {
      providerMessageId: string;
      familyId: string;
      pollKind: string | null;
      subjectKey: string | null;
    };
  },
): Promise<GroupPollTurnResult | { handled: false }> {
  if (!linqGroupPollsEnabled()) return { handled: false };
  const store = createPostgresGroupPlanRsvpStore(ports.database);
  const seated = await store.seatedExpected(input.chatId);
  const senderName = await senderNameOf(ports.database, input.senderUserId ?? null);
  const memberKey =
    memberKeyFromHandle(input.senderHandle) ?? memberKeyFromName(senderName ?? input.senderHandle);
  const seat = seated.find((person) => person.memberKey === memberKey);
  return takeGroupPollCardVote(
    {
      chatId: input.chatId,
      event: input.event,
      optionId: input.optionId,
      card: input.card,
      voter: {
        memberKey,
        displayName: senderName || seat?.displayName || 'someone',
        userId: seat?.userId ?? input.senderUserId ?? null,
        haleCustomer: seat?.haleCustomer ?? false,
      },
      language: 'en',
      now: ports.now,
    },
    {
      store,
      composer: ports.composer,
      send: ledgeredSend(ports),
      card: ports.pollCard ?? postgresGroupPollCard(ports.database),
    },
  );
}
