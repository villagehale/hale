import type { Database } from '@hale/db';
import {
  groupLinkCardsEnabled,
  groupPollsEnabled,
  groupPrivateQuestionEnabled,
  linqPollsEnabled,
} from '../config';
import { senderMemberKey } from '../group-plan-rsvp/member-key';
import { optionKeyAt } from '../group-plan-rsvp/poll-tally';
import {
  type GroupPlanRecord,
  type GroupPlanRsvpStore,
  createPostgresGroupPlanRsvpStore,
} from '../group-plan-rsvp/store';
import { type FamilyPrivateSlice, denyListForChat, presentHouseholds } from '../multi-family';
import {
  moveGroupPlanCalendarCopies,
  settleGroupPlanCalendarAfterRsvp,
} from '../group-plan-rsvp/inbound';
import type { PlanRsvpResponse } from '../group-plan-rsvp/tally';
import type { ListChatHandles } from '../roster';
import { GROUP_EXPERIENCE_TEMPLATE, GROUP_RSVP_POLL_KIND, GROUP_TIME_POLL_KIND } from './kinds';
import { type ExperiencePollCardPort, postgresExperiencePollCard } from './poll-card';
import {
  type GroupExperienceKind,
  type GroupExperienceLiveView,
  type GroupExperienceReader,
  type GroupExperienceReading,
  productionGroupExperienceReader,
} from './reading';
import { sendGroupExperienceLine } from './send';
import { type GroupExperienceStore, createPostgresGroupExperienceStore } from './store';
import { httpsUrlsIn } from './urls';
import {
  type GroupExperienceComposer,
  type GroupExperienceVoiceKind,
  type GroupExperienceVoiceSkip,
  composeGroupExperienceLine,
  productionGroupExperienceComposer,
} from './voice';

export type GroupExperienceTurnOutcome =
  | { handled: false }
  | {
      handled: true;
      outcome:
        | 'group_experience_spoken'
        | 'group_experience_recorded'
        | 'group_experience_unread'
        | 'group_experience_line_unsent'
        | 'group_experience_1to1';
      count: 'ignored' | 'intake';
      notice?: 'sent' | { skipped: GroupExperienceVoiceSkip | 'not_sent' | 'asker_unknown' };
      card?: 'sent' | { skipped: string };
      /** Households this turn texted 1:1. */
      texted?: string[];
    };

export interface GroupExperienceTurnInput {
  chatId: string;
  familyId: string;
  senderHandle: string;
  senderUserId: string | null;
  senderName: string | null;
  senderFamilyId: string | null;
  text: string;
  /** The inbound message's provider id: the key a redelivery of it claims again. */
  messageId: string;
  language: 'en' | 'fr';
  /** The asking household's zone, so the reader can place a proposed time. Null: unknown. */
  timeZone: string | null;
  now: Date;
}

export interface GroupExperienceTurnPorts {
  database: Database;
  store?: GroupExperienceStore;
  plans?: GroupPlanRsvpStore;
  reader?: GroupExperienceReader;
  composer?: GroupExperienceComposer;
  pollCard?: ExperiencePollCardPort;
  /**
   * An answer on a plan goes to the VIL-503 household OK before any calendar write.
   * Production: settleGroupPlanCalendarAfterRsvp.
   */
  settleCalendar?: (input: SettleCalendarInput) => Promise<unknown>;
  /**
   * A locked time moved a plan: households whose copy Hale already wrote get it moved and
   * one notice each. Production: moveGroupPlanCalendarCopies.
   */
  moveCalendar?: (input: { planId: string; actorUserId: string | null }) => Promise<unknown>;
  /** The group transport under the ledgered send. Production: Linq. */
  send?: (input: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>;
  /**
   * Unit seam replacing the whole ledgered send (no database). The door never passes it:
   * production and door tests always go through sendGroupExperienceLine.
   */
  sendLine?: (input: { chatId: string; text: string; dedupeKey: string }) => Promise<unknown>;
  listChatHandles?: ListChatHandles;
  sendOneToOne?: (input: {
    familyId: string;
    text: string;
    url?: string | null;
    dedupeKey: string;
    /** A parent of `familyId` who asked: they hear it, not the household's primary parent. */
    askerUserId?: string | null;
  }) => Promise<'sent' | 'not_sent'>;
  /** The asking household's own slice, for its 1:1 answer only. */
  privateSlices?: (familyIds: readonly string[]) => Promise<FamilyPrivateSlice[]>;
  /** Terms no group line may carry. Production: every household's, via denyListForChat. */
  deny?: () => Promise<readonly string[]>;
  recent?: () => Promise<{ from: 'hale' | 'member'; text: string }[]>;
  households?: (chatId: string) => Promise<string[]>;
}

export interface SettleCalendarInput {
  planId: string;
  userId: string | null;
  memberKey: string;
  displayName: string;
  response: PlanRsvpResponse;
  parentWords: string | null;
}

async function settleCalendar(
  ports: GroupExperienceTurnPorts,
  input: GroupExperienceTurnInput,
  answer: SettleCalendarInput,
): Promise<void> {
  if (ports.settleCalendar) {
    await ports.settleCalendar(answer);
    return;
  }
  await settleGroupPlanCalendarAfterRsvp(
    { database: ports.database, now: input.now },
    { chatId: input.chatId, ...answer },
  );
}

async function moveCalendar(
  ports: GroupExperienceTurnPorts,
  input: GroupExperienceTurnInput,
  planId: string,
): Promise<void> {
  if (ports.moveCalendar) {
    await ports.moveCalendar({ planId, actorUserId: input.senderUserId });
    return;
  }
  await moveGroupPlanCalendarCopies(
    { database: ports.database, now: input.now },
    { chatId: input.chatId, planId, actorUserId: input.senderUserId },
  );
}

async function liveView(
  store: GroupExperienceStore,
  plans: GroupPlanRsvpStore,
  chatId: string,
  now: Date,
): Promise<GroupExperienceLiveView> {
  const rsvp = await store.loadLive(chatId, 'rsvp_poll');
  const time = await store.loadLive(chatId, 'time_poll');
  const link = await store.loadLive(chatId, 'link_card');
  const plan = await plans.loadLivePlan(chatId, now);
  // A poll VIL-471 owns is still the chat's open vote: the reader may see a lock on it.
  const groupPoll = time ? null : await plans.loadLivePoll(chatId);
  return {
    rsvp: rsvp || plan ? { title: plan?.title ?? null } : null,
    time: time
      ? {
          question: typeof time.payload.question === 'string' ? time.payload.question : null,
          options: Array.isArray(time.payload.options)
            ? (time.payload.options as { key: string; text: string }[])
            : [],
        }
      : groupPoll
        ? {
            question: groupPoll.question,
            options: groupPoll.options.map((option) => ({ key: option.key, text: option.text })),
          }
        : null,
    link: link && typeof link.payload.url === 'string' ? { url: link.payload.url } : null,
  };
}

/**
 * The plan a poll or RSVP opening is about. Only the reader's yes ties it to the open plan;
 * an event the reader names as another one opens its own plan (closing the open one);
 * anything else binds to no plan.
 */
async function planFor(
  input: GroupExperienceTurnInput,
  plans: GroupPlanRsvpStore,
  reading: GroupExperienceReading,
): Promise<
  { status: 'live'; plan: GroupPlanRecord } | { status: 'new'; title: string } | { status: 'none' }
> {
  const live = await plans.loadLivePlan(input.chatId, input.now);
  if (live && reading.samePlan === true) return { status: 'live', plan: live };
  const title = reading.title?.trim();
  if (title && (!live || reading.samePlan === false)) return { status: 'new', title };
  return { status: 'none' };
}

async function openPlan(
  input: GroupExperienceTurnInput,
  plans: GroupPlanRsvpStore,
  title: string,
): Promise<GroupPlanRecord> {
  return plans.createPlan({
    chatId: input.chatId,
    familyId: input.familyId,
    title,
    startsAt: null,
    location: null,
    rsvpDeadlineAt: null,
    createdByUserId: input.senderUserId,
    expected: await plans.seatedExpected(input.chatId),
    now: input.now,
  });
}

function allowedKind(kind: GroupExperienceKind): boolean {
  if (kind === 'none') return false;
  if (
    kind === 'rsvp_open' ||
    kind === 'rsvp_vote' ||
    kind === 'rsvp_tally' ||
    kind === 'time_open' ||
    kind === 'time_vote' ||
    kind === 'time_lock'
  ) {
    return groupPollsEnabled();
  }
  if (kind === 'link_facts') return groupLinkCardsEnabled();
  if (kind === 'private_question') return groupPrivateQuestionEnabled();
  return false;
}

async function speak(
  ports: GroupExperienceTurnPorts,
  input: GroupExperienceTurnInput,
  kind: GroupExperienceVoiceKind,
  facts: Record<string, unknown>,
  questions: 0 | 1,
  audience: 'group' | 'one_to_one',
  deny: readonly string[],
): Promise<
  | { status: 'composed'; line: string; options: string[] }
  | { status: 'skipped'; reason: GroupExperienceVoiceSkip }
> {
  return composeGroupExperienceLine(
    {
      skill: 'group-experience-voice',
      kind,
      language: input.language,
      audience,
      questions,
      facts,
    },
    ports.composer ?? productionGroupExperienceComposer(),
    deny,
  );
}

async function sendGroup(
  ports: GroupExperienceTurnPorts,
  input: GroupExperienceTurnInput,
  text: string,
): Promise<'sent' | 'not_sent'> {
  const dedupeKey = `${GROUP_EXPERIENCE_TEMPLATE}:${input.chatId}:${input.messageId}`;
  try {
    if (ports.sendLine) {
      await ports.sendLine({ chatId: input.chatId, text, dedupeKey });
      return 'sent';
    }
    const sent = await sendGroupExperienceLine(ports.database, {
      chatId: input.chatId,
      familyId: input.familyId,
      text,
      now: input.now,
      dedupeKey,
      ...(ports.send ? { send: ports.send } : {}),
      ...(ports.listChatHandles ? { listChatHandles: ports.listChatHandles } : {}),
    });
    if ('duplicate' in sent) {
      console.info(
        { outcome: 'group_experience_duplicate' },
        'group experience: this message already had its group line',
      );
      return 'not_sent';
    }
    return 'sent';
  } catch (err) {
    console.warn(
      { err: err instanceof Error ? err.name : 'unknown' },
      'group experience: group line did not land',
    );
    return 'not_sent';
  }
}

async function householdsInChat(
  ports: GroupExperienceTurnPorts,
  chatId: string,
  coveringFamilyId: string,
): Promise<string[]> {
  if (ports.households) {
    const present = await ports.households(chatId);
    return present.length > 0 ? present : [coveringFamilyId];
  }
  const present = await presentHouseholds(ports.database, chatId, {
    includeStopped: false,
    includeLeft: false,
  });
  return present.length > 0 ? present : [coveringFamilyId];
}

async function denyForChat(
  ports: GroupExperienceTurnPorts,
  chatId: string,
): Promise<readonly string[]> {
  return ports.deny ? ports.deny() : denyListForChat(ports.database, chatId);
}

export async function takeGroupExperienceTurn(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
): Promise<GroupExperienceTurnOutcome> {
  if (!groupPollsEnabled() && !groupLinkCardsEnabled() && !groupPrivateQuestionEnabled()) {
    return { handled: false };
  }
  const store = ports.store ?? createPostgresGroupExperienceStore(ports.database);
  const plans = ports.plans ?? createPostgresGroupPlanRsvpStore(ports.database);
  const reader = ports.reader ?? productionGroupExperienceReader();
  if (!reader) return { handled: true, outcome: 'group_experience_unread', count: 'ignored' };

  const urls = groupLinkCardsEnabled() ? httpsUrlsIn(input.text) : [];
  const live = await liveView(store, plans, input.chatId, input.now);
  const reading = await reader.read({
    text: input.text,
    senderName: input.senderName,
    live,
    urls,
    recent: ports.recent ? await ports.recent() : [],
    clock: input.timeZone ? { now: input.now.toISOString(), timeZone: input.timeZone } : null,
  });
  if (!reading || reading.kind === 'none' || !allowedKind(reading.kind)) {
    return { handled: false };
  }

  const familyIds = await householdsInChat(ports, input.chatId, input.familyId);
  const deny = await denyForChat(ports, input.chatId);

  if (reading.kind === 'rsvp_open') return openRsvp(input, ports, store, plans, reading, deny);
  if (reading.kind === 'rsvp_vote' && reading.response) {
    return voteRsvp(input, ports, store, plans, reading.response, deny);
  }
  if (reading.kind === 'rsvp_tally') return tallyRsvp(input, ports, plans, deny);
  if (reading.kind === 'time_open') return openTime(input, ports, store, plans, reading, deny);
  if (reading.kind === 'time_vote' && reading.optionKey) {
    return voteTime(input, ports, store, reading.optionKey, deny);
  }
  if (reading.kind === 'time_lock') return lockTime(input, ports, store, plans, deny);
  if (reading.kind === 'link_facts') {
    return speakLink(input, ports, store, urls[0] ?? live.link?.url ?? null, familyIds, deny);
  }
  if (reading.kind === 'private_question') {
    return movePrivate(input, ports, store, familyIds, deny);
  }
  return { handled: false };
}

async function openRsvp(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  store: GroupExperienceStore,
  plans: GroupPlanRsvpStore,
  reading: GroupExperienceReading,
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
  const card = ports.pollCard ?? postgresExperiencePollCard(ports.database);
  const target = await planFor(input, plans, reading);
  const spoken = await speak(
    ports,
    input,
    'rsvp_open',
    {
      card: card.enabled() && linqPollsEnabled(),
      title:
        target.status === 'live'
          ? target.plan.title
          : target.status === 'new'
            ? target.title
            : null,
    },
    1,
    'group',
    deny,
  );
  if (spoken.status !== 'composed') {
    return {
      handled: true,
      outcome: 'group_experience_line_unsent',
      count: 'ignored',
      notice: { skipped: spoken.reason },
    };
  }
  const notice = await sendGroup(ports, input, spoken.line);
  if (notice !== 'sent') {
    return {
      handled: true,
      outcome: 'group_experience_line_unsent',
      count: 'ignored',
      notice: { skipped: 'not_sent' },
    };
  }
  if (target.status === 'none') {
    return { handled: true, outcome: 'group_experience_spoken', count: 'intake', notice: 'sent' };
  }
  const plan = target.status === 'live' ? target.plan : await openPlan(input, plans, target.title);
  const options = spoken.options.map((text, index) => ({
    key: optionKeyAt(index),
    text,
    choiceValue: (['yes', 'no', 'maybe'] as const)[index] ?? 'maybe',
  }));
  let cardResult: 'sent' | { skipped: string } = { skipped: 'polls_off' };
  if (card.enabled()) {
    const sent = await card.send({
      chatId: input.chatId,
      familyId: input.familyId,
      subjectKey: plan.id,
      pollKind: GROUP_RSVP_POLL_KIND,
      options,
      now: input.now,
    });
    cardResult = sent.status === 'sent' ? 'sent' : { skipped: sent.reason };
  }
  await store.upsertLive({
    chatId: input.chatId,
    familyId: input.familyId,
    kind: 'rsvp_poll',
    subjectKey: plan.id,
    payload: { planId: plan.id, options, card: cardResult === 'sent' },
    now: input.now,
  });
  return {
    handled: true,
    outcome: 'group_experience_spoken',
    count: 'intake',
    notice: 'sent',
    card: cardResult,
  };
}

async function voteRsvp(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  store: GroupExperienceStore,
  plans: GroupPlanRsvpStore,
  response: 'yes' | 'no' | 'maybe',
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
  const plan = await plans.loadLivePlan(input.chatId, input.now);
  if (!plan) return { handled: false };
  const memberKey = await senderMemberKey(
    { handle: input.senderHandle, name: input.senderName },
    async () => [],
  );
  await plans.upsertRsvp({
    planId: plan.id,
    memberKey,
    displayName: input.senderName || 'someone',
    householdLabel: null,
    userId: input.senderUserId,
    haleCustomer: !!input.senderUserId,
    response,
    headcount: 1,
    source: 'text',
    coversKeys: [],
    verbatim: input.text,
    now: input.now,
  });
  await settleCalendar(ports, input, {
    planId: plan.id,
    userId: input.senderUserId,
    memberKey,
    displayName: input.senderName || 'someone',
    response,
    parentWords: input.text,
  });
  const loaded = await plans.loadTally(plan.id);
  if (loaded.tally.toGo === 0) {
    return tallyRsvp(input, ports, plans, deny, store);
  }
  return { handled: true, outcome: 'group_experience_recorded', count: 'intake' };
}

async function tallyRsvp(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  plans: GroupPlanRsvpStore,
  deny: readonly string[],
  store?: GroupExperienceStore,
): Promise<GroupExperienceTurnOutcome> {
  const plan = await plans.loadLivePlan(input.chatId, input.now);
  if (!plan) return { handled: false };
  const { tally } = await plans.loadTally(plan.id);
  const spoken = await speak(
    ports,
    input,
    'rsvp_tally',
    {
      title: plan.title,
      yesCount: tally.yesCount,
      noCount: tally.noCount,
      maybeCount: tally.maybeCount,
      yesNames: tally.yesNames,
      noNames: tally.noNames,
      maybeNames: tally.maybeNames,
      waitingNames: tally.waitingNames,
      toGo: tally.toGo,
    },
    0,
    'group',
    deny,
  );
  if (spoken.status !== 'composed') {
    return {
      handled: true,
      outcome: 'group_experience_line_unsent',
      count: 'ignored',
      notice: { skipped: spoken.reason },
    };
  }
  const notice = await sendGroup(ports, input, spoken.line);
  if (notice !== 'sent') {
    return {
      handled: true,
      outcome: 'group_experience_line_unsent',
      count: 'ignored',
      notice: { skipped: 'not_sent' },
    };
  }
  if (store) {
    const live = await store.loadLive(input.chatId, 'rsvp_poll');
    if (live && tally.toGo === 0) await store.close(live.id, input.now);
  }
  return { handled: true, outcome: 'group_experience_spoken', count: 'intake', notice: 'sent' };
}

async function openTime(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  store: GroupExperienceStore,
  plans: GroupPlanRsvpStore,
  reading: GroupExperienceReading,
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
  const card = ports.pollCard ?? postgresExperiencePollCard(ports.database);
  const parentOptions = reading.options;
  const target = await planFor(input, plans, reading);
  const spoken = await speak(
    ports,
    input,
    'time_open',
    {
      card: card.enabled() && parentOptions.length >= 2,
      options: parentOptions,
      title:
        target.status === 'live'
          ? target.plan.title
          : target.status === 'new'
            ? target.title
            : null,
    },
    1,
    'group',
    deny,
  );
  if (spoken.status !== 'composed') {
    return {
      handled: true,
      outcome: 'group_experience_line_unsent',
      count: 'ignored',
      notice: { skipped: spoken.reason },
    };
  }
  const notice = await sendGroup(ports, input, spoken.line);
  if (notice !== 'sent') {
    return {
      handled: true,
      outcome: 'group_experience_line_unsent',
      count: 'ignored',
      notice: { skipped: 'not_sent' },
    };
  }
  const fromParent = parentOptions.length >= 2;
  const labels = fromParent ? parentOptions : spoken.options;
  if (labels.length < 2) {
    return { handled: true, outcome: 'group_experience_spoken', count: 'intake', notice: 'sent' };
  }
  const options = labels.slice(0, 6).map((text, index) => ({
    key: optionKeyAt(index),
    text,
    choiceValue: optionKeyAt(index),
    // Only a time the reader placed on the asker's clock; the voice's own labels carry none.
    startsAt: fromParent ? (reading.starts[index] ?? null) : null,
  }));
  const plan =
    target.status === 'live'
      ? target.plan
      : target.status === 'new'
        ? await openPlan(input, plans, target.title)
        : null;
  const subjectKey = plan?.id ?? `time:${input.chatId}`;
  let cardResult: 'sent' | { skipped: string } = { skipped: 'polls_off' };
  if (card.enabled() && linqPollsEnabled()) {
    const sent = await card.send({
      chatId: input.chatId,
      familyId: input.familyId,
      subjectKey,
      pollKind: GROUP_TIME_POLL_KIND,
      options,
      now: input.now,
    });
    cardResult = sent.status === 'sent' ? 'sent' : { skipped: sent.reason };
  }
  await store.upsertLive({
    chatId: input.chatId,
    familyId: input.familyId,
    kind: 'time_poll',
    subjectKey,
    payload: { planId: plan?.id ?? null, options, votes: {}, card: cardResult === 'sent' },
    now: input.now,
  });
  return {
    handled: true,
    outcome: 'group_experience_spoken',
    count: 'intake',
    notice: 'sent',
    card: cardResult,
  };
}

async function voteTime(
  input: GroupExperienceTurnInput,
  _ports: GroupExperienceTurnPorts,
  store: GroupExperienceStore,
  optionKey: string,
  _deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
  const live = await store.loadLive(input.chatId, 'time_poll');
  if (!live) return { handled: false };
  const options = Array.isArray(live.payload.options)
    ? (live.payload.options as { key: string; text: string }[])
    : [];
  if (!options.some((option) => option.key === optionKey)) {
    return { handled: false };
  }
  const votes = {
    ...((live.payload.votes as Record<string, string> | undefined) ?? {}),
    [input.senderHandle]: optionKey,
  };
  await store.patchPayload(live.id, { ...live.payload, votes }, input.now);
  return { handled: true, outcome: 'group_experience_recorded', count: 'intake' };
}

async function lockTime(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  store: GroupExperienceStore,
  plans: GroupPlanRsvpStore,
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
  const live = await store.loadLive(input.chatId, 'time_poll');
  if (!live) return lockGroupPoll(input, ports, plans, deny);
  const options = Array.isArray(live.payload.options)
    ? (live.payload.options as { key: string; text: string; startsAt?: string | null }[])
    : [];
  const votes = (live.payload.votes as Record<string, string> | undefined) ?? {};
  const counts = new Map<string, number>();
  for (const key of Object.values(votes)) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let winnerKey: string | null = null;
  let best = 0;
  let tie = false;
  for (const [key, count] of counts) {
    if (count > best) {
      best = count;
      winnerKey = key;
      tie = false;
    } else if (count === best) {
      tie = true;
    }
  }
  if (!winnerKey || tie || best === 0)
    return { handled: true, outcome: 'group_experience_recorded', count: 'ignored' };
  const won = options.find((option) => option.key === winnerKey) ?? null;
  const winner = won?.text ?? null;
  if (!winner) return { handled: false };
  const spoken = await speak(ports, input, 'time_lock', { winner }, 0, 'group', deny);
  if (spoken.status !== 'composed') {
    return {
      handled: true,
      outcome: 'group_experience_line_unsent',
      count: 'ignored',
      notice: { skipped: spoken.reason },
    };
  }
  const notice = await sendGroup(ports, input, spoken.line);
  if (notice !== 'sent') {
    return {
      handled: true,
      outcome: 'group_experience_line_unsent',
      count: 'ignored',
      notice: { skipped: 'not_sent' },
    };
  }
  // The poll's own plan, fixed when it opened, and only while that plan is still the chat's
  // open plan. A label is never parsed into a date: no placed instant, no plan time.
  const planId = typeof live.payload.planId === 'string' ? live.payload.planId : null;
  const placed = typeof won?.startsAt === 'string' ? new Date(won.startsAt) : null;
  const openPlanNow = planId ? await plans.loadLivePlan(input.chatId, input.now) : null;
  if (
    planId &&
    openPlanNow?.id === planId &&
    placed &&
    !Number.isNaN(placed.getTime()) &&
    (await plans.setPlanStart(planId, placed, input.senderUserId, input.now))
  ) {
    await moveCalendar(ports, input, planId);
    const { rows } = await plans.loadTally(planId);
    for (const yes of await plans.listYesRsvps(planId)) {
      await settleCalendar(ports, input, {
        planId,
        userId: yes.userId,
        memberKey: yes.memberKey,
        displayName: rows.find((row) => row.memberKey === yes.memberKey)?.displayName ?? 'someone',
        response: 'yes',
        parentWords: null,
      });
    }
  }
  await store.close(live.id, input.now);
  return { handled: true, outcome: 'group_experience_spoken', count: 'intake', notice: 'sent' };
}

/**
 * VIL-471 owns the chat's open poll: a lock names its single leader and closes it. Its
 * choices carry no placed instant and no plan, so no plan time moves and no calendar step
 * runs. A tie, or no votes yet, locks nothing.
 */
async function lockGroupPoll(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  plans: GroupPlanRsvpStore,
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
  const poll = await plans.loadLivePoll(input.chatId);
  if (!poll) return { handled: false };
  const tally = await plans.loadPollTally(poll.id);
  const winner = tally.leaders.length === 1 ? tally.leaders[0] : null;
  if (!winner) return { handled: true, outcome: 'group_experience_recorded', count: 'ignored' };
  const spoken = await speak(ports, input, 'time_lock', { winner }, 0, 'group', deny);
  if (spoken.status !== 'composed') {
    return {
      handled: true,
      outcome: 'group_experience_line_unsent',
      count: 'ignored',
      notice: { skipped: spoken.reason },
    };
  }
  const notice = await sendGroup(ports, input, spoken.line);
  if (notice !== 'sent') {
    return {
      handled: true,
      outcome: 'group_experience_line_unsent',
      count: 'ignored',
      notice: { skipped: 'not_sent' },
    };
  }
  await plans.closePoll(poll.id, input.senderUserId, input.now);
  return { handled: true, outcome: 'group_experience_spoken', count: 'intake', notice: 'sent' };
}

async function speakLink(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  store: GroupExperienceStore,
  url: string | null,
  familyIds: readonly string[],
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
  if (!url) return { handled: false };
  const spoken = await speak(
    ports,
    input,
    'link_facts',
    { publicText: input.text, url },
    0,
    'group',
    deny,
  );
  if (spoken.status !== 'composed') {
    return {
      handled: true,
      outcome: 'group_experience_line_unsent',
      count: 'ignored',
      notice: { skipped: spoken.reason },
    };
  }
  const notice = await sendGroup(ports, input, spoken.line);
  if (notice !== 'sent') {
    return {
      handled: true,
      outcome: 'group_experience_line_unsent',
      count: 'ignored',
      notice: { skipped: 'not_sent' },
    };
  }
  await store.upsertLive({
    chatId: input.chatId,
    familyId: input.familyId,
    kind: 'link_card',
    subjectKey: url,
    payload: { url },
    now: input.now,
  });
  const texted: string[] = [];
  if (ports.sendOneToOne) {
    for (const familyId of familyIds) {
      const oneToOne = await speak(ports, input, 'registration_1to1', { url }, 0, 'one_to_one', []);
      if (oneToOne.status !== 'composed') continue;
      const sent = await ports.sendOneToOne({
        familyId,
        text: oneToOne.line,
        url,
        dedupeKey: `group-link:${input.chatId}:${familyId}:${url}`,
      });
      if (sent === 'sent') texted.push(familyId);
    }
  }
  return {
    handled: true,
    outcome: 'group_experience_spoken',
    count: 'intake',
    notice: 'sent',
    texted,
  };
}

async function movePrivate(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  store: GroupExperienceStore,
  familyIds: readonly string[],
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
  // Only the asking household hears it 1:1. An asker with no household here gets no 1:1 and
  // no group promise of one: another family is never texted in their place.
  const targetFamilyId =
    input.senderFamilyId && familyIds.includes(input.senderFamilyId) ? input.senderFamilyId : null;
  if (!targetFamilyId) {
    return {
      handled: true,
      outcome: 'group_experience_line_unsent',
      count: 'ignored',
      notice: { skipped: 'asker_unknown' },
    };
  }
  const spoken = await speak(ports, input, 'private_hold', {}, 0, 'group', deny);
  if (spoken.status === 'composed') {
    const notice = await sendGroup(ports, input, spoken.line);
    if (notice !== 'sent') {
      return {
        handled: true,
        outcome: 'group_experience_line_unsent',
        count: 'ignored',
        notice: { skipped: 'not_sent' },
      };
    }
  } else {
    // Model miss or a private leak: stay quiet in the group, still try 1:1.
  }
  const slices = ports.privateSlices ? await ports.privateSlices([targetFamilyId]) : [];
  const own = slices[0];
  const oneToOne = await speak(
    ports,
    input,
    'private_1to1',
    {
      asked: input.text,
      private: own
        ? { memory: own.memory, calendar: own.calendar, email: own.email, children: own.children }
        : null,
    },
    0,
    'one_to_one',
    [],
  );
  await store.upsertLive({
    chatId: input.chatId,
    familyId: targetFamilyId,
    kind: 'private_question',
    subjectKey: `${input.chatId}:${input.now.toISOString()}`,
    payload: { familyId: targetFamilyId },
    now: input.now,
  });
  if (oneToOne.status === 'composed' && ports.sendOneToOne) {
    const delivered = await ports.sendOneToOne({
      familyId: targetFamilyId,
      text: oneToOne.line,
      dedupeKey: `group-private:${input.chatId}:${targetFamilyId}:${input.now.toISOString()}`,
      askerUserId: input.senderUserId,
    });
    return {
      handled: true,
      outcome: delivered === 'sent' ? 'group_experience_1to1' : 'group_experience_spoken',
      count: 'intake',
      notice: 'sent',
    };
  }
  return { handled: true, outcome: 'group_experience_spoken', count: 'intake' };
}
