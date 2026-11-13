import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { knownHouseholdTimezone } from '~/lib/channel/household-timezone';
import { inProactiveQuietHours } from '~/lib/channel/outbound-gate';
import { namesFacts } from '~/lib/signup/parent-quote';
import {
  linqGroupPlanRsvpCalendarEnabled,
  linqGroupPlanRsvpEnabled,
  linqGroupPollsEnabled,
  linqPollsEnabled,
} from '../config';
import { type OneToOneSend, sendHouseholdPrivateLine } from '../connect-link-1to1';
import { familySpeechLanguage } from '../family-outbound';
import { lastOneToOneLineId } from '../last-1to1-line';
import { sendChoicePoll } from '../poll';
import { primaryParentId } from '../roster-ask';
import type { LinqTapback } from '../transport';
import {
  type CalendarConsentReader,
  type CalendarConsentReading,
  type CalendarPrivateKind,
  type CalendarPrivateLine,
  groupPlanCalendarLineInput,
  postgresGroupPlanCalendarWriter,
  postgresGroupPlanHouseholds,
  hostFamilyIdForPlan,
  sharedCalendarConsentReader,
} from './calendar';
import {
  type CalendarEffect,
  type MovedCopyEffect,
  answerPendingCalendarAsk,
  householdWhen,
  moveWrittenCopies,
  settleCalendarAfterAnswer,
} from './calendar-turn';
import { senderMemberKey } from './member-key';
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
  GROUP_PLAN_CALENDAR_MOVED_TEMPLATE,
  GROUP_PLAN_CALENDAR_REMOVED_TEMPLATE,
  GROUP_PLAN_CALENDAR_WHICH_TEMPLATE,
  GROUP_PLAN_CALENDAR_WRITTEN_TEMPLATE,
  GROUP_PLAN_RSVP_TEMPLATE,
  GROUP_POLL_TEMPLATE,
  sendGroupPlanRsvpLine,
} from './send';
import { createPostgresGroupPlanRsvpStore } from './store';
import type { PlanRsvpResponse, PlanTally } from './tally';
import { type GroupPlanRsvpTurnOutcome, takeGroupPlanRsvpTurn } from './turn';
import {
  type GroupPlanRsvpComposer,
  composeGroupPlanRsvpLine,
  productionGroupPlanRsvpComposer,
} from './voice';

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
export async function householdLanguage(database: Database, familyId: string) {
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

function calendarTemplate(kind: CalendarPrivateKind): string {
  if (kind === 'calendar_ask') return GROUP_PLAN_CALENDAR_ASK_TEMPLATE;
  if (kind === 'calendar_written') return GROUP_PLAN_CALENDAR_WRITTEN_TEMPLATE;
  if (kind === 'calendar_moved') return GROUP_PLAN_CALENDAR_MOVED_TEMPLATE;
  if (kind === 'calendar_which') return GROUP_PLAN_CALENDAR_WHICH_TEMPLATE;
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
    async send(line: CalendarPrivateLine) {
      const templateKey = calendarTemplate(line.kind);
      const result = await sendHouseholdPrivateLine(ports.database, {
        familyId: line.familyId,
        userId: line.userId,
        body: line.text,
        templateKey,
        dedupeKey:
          line.dedupeKey ??
          `${templateKey}:${line.planId}:${line.familyId}:${ports.now.toISOString()}`,
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
      if (sent.status === 'held') return { status: 'skipped', reason: sent.reason };
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
    /** VIL-686: Secret Santa runs in this chat. */
    secretSanta?: boolean;
  },
): Promise<GroupPlanRsvpTurnOutcome> {
  if (!linqGroupPlanRsvpEnabled() && !linqGroupPollsEnabled()) return { handled: false };
  const store = createPostgresGroupPlanRsvpStore(ports.database);
  const live = linqGroupPlanRsvpEnabled()
    ? await store.loadLivePlan(input.chatId, ports.now)
    : null;
  const livePoll = linqGroupPollsEnabled() ? await store.loadLivePoll(input.chatId) : null;
  const cover = await store.coveringFamily(input.chatId);
  const hostFamilyId = await hostFamilyIdForPlan(
    postgresGroupPlanHouseholds(ports.database),
    cover,
    { chatId: input.chatId, userId: input.senderUserId },
  );
  if (!live && !livePoll && !hostFamilyId) return { handled: false };

  return takeGroupPlanRsvpTurn(
    {
      chatId: input.chatId,
      senderHandle: input.senderHandle,
      senderName: await senderNameOf(ports.database, input.senderUserId ?? null),
      senderUserId: input.senderUserId ?? null,
      text: input.text,
      tapback: input.tapback,
      tapbackMessageId: input.tapbackMessageId,
      secretSanta: input.secretSanta,
      language: 'en',
      calendarLanguage: await calendarHouseholdLanguage(
        ports.database,
        input.chatId,
        input.senderUserId ?? null,
      ),
      timeZone: hostFamilyId ? await knownHouseholdTimezone(ports.database, hostFamilyId) : null,
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

export function groupPlanCalendarPorts(ports: GroupPlanRsvpInboundPorts) {
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
 * VIL-399 — an answer recorded on a plan outside this module's turn (a native card tap, a
 * group-experience read, a locked time) takes the same household OK before anything lands
 * on that household's calendar: the VIL-503 1:1 ask, never a silent write. Off unless plan
 * RSVPs and their calendar step are both on, exactly as the turn itself reads them.
 */
export async function settleGroupPlanCalendarAfterRsvp(
  ports: GroupPlanRsvpInboundPorts,
  input: {
    chatId: string;
    planId: string;
    userId: string | null;
    memberKey: string;
    displayName: string;
    response: PlanRsvpResponse;
    parentWords: string | null;
    /** Hale starts this ask (a lock someone else sent): this household hears it by day only. */
    proactive?: true;
  },
): Promise<CalendarEffect | undefined> {
  if (!linqGroupPlanRsvpEnabled() || !linqGroupPlanRsvpCalendarEnabled()) return undefined;
  const store = createPostgresGroupPlanRsvpStore(ports.database);
  const plan = await store.loadLivePlan(input.chatId, ports.now);
  if (!plan || plan.id !== input.planId) return undefined;
  if (input.proactive) {
    const home = input.userId
      ? await postgresGroupPlanHouseholds(ports.database).resolve({
          chatId: input.chatId,
          userId: input.userId,
        })
      : null;
    const zone = home?.status === 'one' ? await store.householdTimeZone(home.familyId) : null;
    if (zone === null || inProactiveQuietHours(ports.now, zone)) {
      console.info(
        { outcome: 'group_plan_calendar_ask_held_quiet', zoneKnown: zone !== null },
        'group plan calendar: an ask Hale would start waits; not sent outside the daytime',
      );
      return undefined;
    }
  }
  return settleCalendarAfterAnswer(
    {
      chatId: input.chatId,
      plan,
      userId: input.userId,
      memberKey: input.memberKey,
      displayName: input.displayName,
      householdLabel: null,
      response: input.response,
      language: await calendarHouseholdLanguage(ports.database, input.chatId, input.userId),
      parentWords: input.parentWords,
      now: ports.now,
    },
    { store, ...groupPlanCalendarPorts(ports) },
  );
}

/**
 * VIL-689 — a locked time moved this plan. Households whose copy Hale already wrote get it
 * moved and one notice each, by day on their own clock (a night notice waits for the
 * morning re-drive). Off exactly when the calendar step is off.
 */
export async function moveGroupPlanCalendarCopies(
  ports: GroupPlanRsvpInboundPorts,
  input: { chatId: string; planId: string; actorUserId: string | null },
): Promise<MovedCopyEffect[] | { status: 'skipped'; reason: string } | undefined> {
  if (!linqGroupPlanRsvpEnabled() || !linqGroupPlanRsvpCalendarEnabled()) return undefined;
  const store = createPostgresGroupPlanRsvpStore(ports.database);
  const plan = await store.loadLivePlan(input.chatId, ports.now);
  if (!plan || plan.id !== input.planId) return undefined;
  return moveWrittenCopies(
    { chatId: input.chatId, plan, actorUserId: input.actorUserId, now: ports.now },
    {
      store,
      ...groupPlanCalendarPorts(ports),
      daytime: async (familyId) => {
        const zone = await store.householdTimeZone(familyId);
        return zone !== null && !inProactiveQuietHours(ports.now, zone);
      },
      languageOf: (familyId) => householdLanguage(ports.database, familyId),
    },
  );
}

type PrivateCalendarCandidate = Awaited<
  ReturnType<ReturnType<typeof createPostgresGroupPlanRsvpStore>['listOpenCalendarAsks']>
>[number];

/**
 * One ask is that ask. Several asks: a reply binds only an ask its words name, by a whole
 * word of the plan's title (code-checked), and only when the reader also reads a decision
 * on it. The model alone never picks among several asks: a decision with no ask named, or
 * with more than one named, is `ambiguous` and Hale asks which one. No decision on any
 * ask leaves the turn to the 1:1 door.
 */
async function pickPrivateCalendarAsk(
  ports: GroupPlanRsvpInboundPorts,
  input: { senderName: string | null; text: string },
  open: PrivateCalendarCandidate[],
): Promise<
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: PrivateCalendarCandidate[] }
  | {
      kind: 'one';
      plan: PrivateCalendarCandidate['plan'];
      consent: PrivateCalendarCandidate['consent'];
      decided?: CalendarConsentReading;
    }
> {
  const only = open[0];
  if (open.length === 0 || !only) return { kind: 'none' };
  if (open.length === 1) return { kind: 'one', plan: only.plan, consent: only.consent };
  const named = open.filter((item) =>
    namesFacts(input.text, { activity: item.plan.title, host: '' }),
  );
  const reader = ports.consentReader ?? sharedCalendarConsentReader();
  const hits: { item: PrivateCalendarCandidate; reading: CalendarConsentReading }[] = [];
  for (const item of named.length > 0 ? named : open) {
    const reading = await reader.read({
      text: input.text,
      tapback: null,
      senderName: input.senderName,
      consent: item.consent.status === 'declined' ? 'declined' : 'asked',
      ask: {
        title: item.plan.title,
        startsAt: item.plan.startsAt?.toISOString() ?? null,
        location: item.plan.location,
        displayName: item.consent.displayName,
        householdLabel: item.consent.householdLabel,
      },
    });
    if (!reading || reading.confidence !== 'high' || reading.decision === 'not_this') continue;
    if (item.consent.status === 'declined' && reading.decision !== 'reopen') continue;
    if (item.consent.status !== 'declined' && reading.decision === 'reopen') continue;
    hits.push({ item, reading });
  }
  const hit = hits[0];
  if (!hit) return { kind: 'none' };
  if (named.length === 1 && hits.length === 1) {
    return { kind: 'one', plan: hit.item.plan, consent: hit.item.consent, decided: hit.reading };
  }
  return { kind: 'ambiguous', candidates: hits.map((entry) => entry.item) };
}

/**
 * The reply could answer more than one ask: one model-written 1:1 question naming those
 * plans. Each of them then counts that question as its last line, so the parent's next
 * reply (naming one) is read against them. Nothing is written or withdrawn here.
 */
async function askWhichCalendarPlan(
  ports: GroupPlanRsvpInboundPorts,
  store: ReturnType<typeof createPostgresGroupPlanRsvpStore>,
  input: { senderUserId: string; senderName: string | null; text: string },
  candidates: PrivateCalendarCandidate[],
): Promise<'sent' | { skipped: string }> {
  const first = candidates[0];
  if (!first) return { skipped: 'no_candidates' };
  const choices = [];
  for (const item of candidates) {
    const zone = await store.householdTimeZone(item.consent.familyId);
    choices.push({
      title: item.plan.title,
      startsAt: householdWhen(item.plan.startsAt, zone),
    });
  }
  const spoken = await composeGroupPlanRsvpLine(
    groupPlanCalendarLineInput({
      kind: 'calendar_which',
      language: await householdLanguage(ports.database, first.consent.familyId),
      parentWords: input.text,
      facts: {
        title: first.plan.title,
        startsAt: null,
        location: null,
        displayName: input.senderName ?? first.consent.displayName,
        householdLabel: null,
        choices,
      },
    }),
    ports.composer ?? productionGroupPlanRsvpComposer(),
  );
  if (spoken.status === 'skipped') {
    console.warn(
      { outcome: 'group_plan_calendar_which_unsent', reason: spoken.reason },
      'group plan calendar: which-plan question not written',
    );
    return { skipped: spoken.reason };
  }
  const sent = await privateCalendarSend(ports).send({
    planId: first.plan.id,
    familyId: first.consent.familyId,
    userId: input.senderUserId,
    text: spoken.line,
    kind: 'calendar_which',
  });
  if (sent.status !== 'sent') return { skipped: sent.reason };
  if (sent.providerMessageId) {
    for (const item of candidates) {
      await store.setCalendarAskMessage(
        item.plan.id,
        item.consent.familyId,
        sent.providerMessageId,
      );
    }
  }
  await ports.database.insert(schema.auditLog).values({
    familyId: first.consent.familyId,
    actor: input.senderUserId,
    actionTaken: 'linq_group_plan_calendar_which_asked',
    targetTable: 'linq_group_plans',
    targetId: first.plan.id,
    after: { plans: candidates.length },
  });
  return 'sent';
}

/**
 * A 1:1 reply to the private calendar ask. The group chat is not this message's
 * chat. One open ask for this parent is answered here; anything else is left
 * for the normal 1:1 door.
 *
 * An open ask is answerable only while Hale's last 1:1 line is one of the asks.
 * Once Hale has asked something else, a yes answers that, not the calendar. A
 * decline stays readable: only the reader's `reopen` (they brought the calendar
 * up themselves) changes it.
 */
export async function considerPrivateCalendarReply(
  ports: GroupPlanRsvpInboundPorts,
  input: { senderUserId: string; senderName: string | null; chatId: string; text: string },
): Promise<GroupPlanRsvpTurnOutcome | { handled: false }> {
  if (!linqGroupPlanRsvpCalendarEnabled()) return { handled: false };
  const store = createPostgresGroupPlanRsvpStore(ports.database);
  const listed = await store.listOpenCalendarAsks(input.senderUserId);
  const lastLine = listed.some((item) => item.consent.status === 'asked')
    ? await lastOneToOneLineId(ports.database, {
        parentUserId: input.senderUserId,
        chatId: input.chatId,
      })
    : null;
  const askIsLastLine =
    lastLine !== null &&
    listed.some(
      (item) => item.consent.status === 'asked' && item.consent.askProviderMessageId === lastLine,
    );
  const open = listed.filter((item) => item.consent.status === 'declined' || askIsLastLine);
  if (open.length < listed.length) {
    console.info(
      { outcome: 'group_plan_calendar_ask_not_last_line', count: listed.length - open.length },
      'group plan calendar: 1:1 reply left to the 1:1 door',
    );
  }
  const picked = await pickPrivateCalendarAsk(ports, input, open);
  if (picked.kind === 'none') return { handled: false };
  if (picked.kind === 'ambiguous') {
    const which = await askWhichCalendarPlan(ports, store, input, picked.candidates);
    return {
      handled: true,
      outcome: 'group_plan_calendar_unwritten',
      count: which === 'sent' ? 'intake' : 'ignored',
      notice: which === 'sent' ? 'sent' : { skipped: 'not_sent' },
    };
  }
  const { plan, consent, decided } = picked;
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
      ...(decided ? { decided } : {}),
    },
    { store, ...groupPlanCalendarPorts(ports) },
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
    { store, ...groupPlanCalendarPorts(ports) },
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
  const memberKey = await senderMemberKey(
    { handle: input.senderHandle, name: senderName },
    async () => {
      const poll = await store.pollForCard(input.chatId, input.card.providerMessageId);
      return poll ? store.pollVoterKeys(poll.id) : [];
    },
  );
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
