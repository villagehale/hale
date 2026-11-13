import type { Database } from '@hale/db';
import {
  groupLinkCardsEnabled,
  groupPollsEnabled,
  groupPrivateQuestionEnabled,
  linqPollsEnabled,
} from '../config';
import {
  type GroupPlanHouseholdResolver,
  postgresGroupPlanHouseholds,
} from '../group-plan-rsvp/calendar';
import { senderMemberKey } from '../group-plan-rsvp/member-key';
import { type PlanRef, refPlanId } from '../group-plan-rsvp/plan-identity';
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
  /**
   * The door's first reader (VIL-442) already read this message as a lock on the open poll,
   * so it is not read again here.
   */
  decided?: 'time_lock';
  /** With `decided`: the open poll's option key the lock named in the same message. */
  lockChoice?: string;
  /**
   * The plan the door's first reader (VIL-442) resolved this message to, by id. This turn binds
   * a message to a plan only through it: absent, nothing here binds to an open plan.
   */
  planRef?: PlanRef;
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
  /** Which household a seated parent belongs to here. Production: postgresGroupPlanHouseholds. */
  planHouseholds?: GroupPlanHouseholdResolver;
}

export interface SettleCalendarInput {
  planId: string;
  userId: string | null;
  memberKey: string;
  displayName: string;
  response: PlanRsvpResponse;
  parentWords: string | null;
  /** Hale starts this ask (a lock someone else sent): by day only. */
  proactive?: true;
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

/** The open plan the door's first reader resolved this message to, by id; else none. */
async function resolvedPlan(
  input: GroupExperienceTurnInput,
  plans: GroupPlanRsvpStore,
): Promise<GroupPlanRecord | null> {
  const planId = refPlanId(input.planRef);
  return planId ? plans.loadOpenPlan(input.chatId, planId, input.now) : null;
}

async function liveView(
  store: GroupExperienceStore,
  plans: GroupPlanRsvpStore,
  input: GroupExperienceTurnInput,
): Promise<GroupExperienceLiveView> {
  const chatId = input.chatId;
  const rsvp = await store.loadLive(chatId, 'rsvp_poll');
  const time = await store.loadLive(chatId, 'time_poll');
  const link = await store.loadLive(chatId, 'link_card');
  const plan = await resolvedPlan(input, plans);
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
 * The plan a poll or RSVP opening is about. It binds to an open plan only by the id the door's
 * first reader resolved (and this reader agrees it is that plan). A titled event opens its own
 * plan only when the first reader read it as another event, or no plan is open at all; other
 * open plans stay open. Anything else binds to no plan.
 */
async function planFor(
  input: GroupExperienceTurnInput,
  plans: GroupPlanRsvpStore,
  reading: GroupExperienceReading,
): Promise<
  { status: 'live'; plan: GroupPlanRecord } | { status: 'new'; title: string } | { status: 'none' }
> {
  const resolved = await resolvedPlan(input, plans);
  if (resolved && reading.samePlan !== false) return { status: 'live', plan: resolved };
  const title = reading.title?.trim();
  if (!title || resolved) return { status: 'none' };
  if (input.planRef?.status === 'other') return { status: 'new', title };
  const open = await plans.listOpenPlans(input.chatId, input.now);
  return open.length === 0 && input.planRef?.status !== 'unclear'
    ? { status: 'new', title }
    : { status: 'none' };
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
  if (input.decided === 'time_lock') {
    // The first reader read a lock on the VIL-471 poll it was shown: that poll, and only it.
    if (!allowedKind('time_lock')) return { handled: false };
    return lockGroupPoll(
      input,
      ports,
      plans,
      input.lockChoice ?? null,
      await denyForChat(ports, input.chatId),
    );
  }
  const reader = ports.reader ?? productionGroupExperienceReader();
  if (!reader) return { handled: true, outcome: 'group_experience_unread', count: 'ignored' };

  const urls = groupLinkCardsEnabled() ? httpsUrlsIn(input.text) : [];
  const live = await liveView(store, plans, input);
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
  // A text answer is the first reader's to record (it binds by plan id). One this reader alone
  // calls an answer is not recorded on any plan.
  if (reading.kind === 'rsvp_vote') return { handled: false };
  if (reading.kind === 'rsvp_tally') return tallyRsvp(input, ports, plans, deny);
  if (reading.kind === 'time_open') return openTime(input, ports, store, plans, reading, deny);
  if (reading.kind === 'time_vote' && reading.optionKey) {
    return voteTime(input, ports, store, reading.optionKey, deny);
  }
  if (reading.kind === 'time_lock') {
    return lockTime(input, ports, store, plans, reading.optionKey, deny);
  }
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

async function tallyRsvp(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  plans: GroupPlanRsvpStore,
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
  const plan = await resolvedPlan(input, plans);
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
    payload: {
      planId: plan?.id ?? null,
      options,
      votes: {},
      card: cardResult === 'sent',
      createdBy: await senderKeyOf(input),
    },
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

async function senderKeyOf(input: GroupExperienceTurnInput): Promise<string> {
  return senderMemberKey({ handle: input.senderHandle, name: input.senderName }, async () => []);
}

/**
 * The choice a lock lands on. A choice the message named counts only as a tie-break among the
 * leaders; it never beats an option with more votes. One leader wins on its own. A tie with no
 * leader named is `tie`: nothing locks, and Hale asks which.
 */
export function lockedChoice(
  counts: readonly { key: string; votes: number }[],
  named: string | null | undefined,
): { status: 'won'; key: string } | { status: 'tie'; keys: string[] } {
  const top = Math.max(0, ...counts.map((option) => option.votes));
  const leaders = counts.filter((option) => option.votes === top).map((option) => option.key);
  if (named && leaders.includes(named)) return { status: 'won', key: named };
  const only = leaders.length === 1 ? leaders[0] : undefined;
  if (only && top > 0) return { status: 'won', key: only };
  return { status: 'tie', keys: leaders };
}

/**
 * Whether this sender's lock may move `plan`: the person who opened the poll, or a seated Hale
 * parent of the plan's host household. Anyone else's lock moves no plan.
 */
async function mayMovePlan(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  plan: GroupPlanRecord,
  creatorKey: string | null,
): Promise<boolean> {
  if (creatorKey && creatorKey === (await senderKeyOf(input))) return true;
  if (!input.senderUserId) return false;
  const households = ports.planHouseholds ?? postgresGroupPlanHouseholds(ports.database);
  const home = await households.resolve({ chatId: input.chatId, userId: input.senderUserId });
  return home.status === 'one' && home.familyId === plan.familyId;
}

/** A lock that would move a plan, from someone who may not move it: nothing closes or moves. */
function lockRefused(): GroupExperienceTurnOutcome {
  console.info(
    { outcome: 'group_lock_not_authorized' },
    'group experience: a lock that would move a plan came from someone who may not move it',
  );
  return { handled: true, outcome: 'group_experience_recorded', count: 'ignored' };
}

/** A tie nothing breaks: one short model-written line asking which of the leaders. */
async function askTieBreak(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  leaders: readonly string[],
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
  if (leaders.length < 2) {
    return { handled: true, outcome: 'group_experience_recorded', count: 'ignored' };
  }
  const spoken = await speak(ports, input, 'time_tie', { leaders }, 1, 'group', deny);
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
  return { handled: true, outcome: 'group_experience_spoken', count: 'intake', notice: 'sent' };
}

async function speakLock(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  winner: string,
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome | 'sent'> {
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
  return 'sent';
}

/** VIL-399's own time poll. With none open, a lock this reader read is on the VIL-471 poll. */
async function lockTime(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  store: GroupExperienceStore,
  plans: GroupPlanRsvpStore,
  named: string | null,
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
  const live = await store.loadLive(input.chatId, 'time_poll');
  if (!live) return lockGroupPoll(input, ports, plans, named, deny);
  const options = Array.isArray(live.payload.options)
    ? (live.payload.options as { key: string; text: string; startsAt?: string | null }[])
    : [];
  const votes = (live.payload.votes as Record<string, string> | undefined) ?? {};
  const counts = options.map((option) => ({
    key: option.key,
    votes: Object.values(votes).filter((key) => key === option.key).length,
  }));
  const planId = typeof live.payload.planId === 'string' ? live.payload.planId : null;
  const plan = planId ? await plans.loadOpenPlan(input.chatId, planId, input.now) : null;
  const creator = typeof live.payload.createdBy === 'string' ? live.payload.createdBy : null;
  const authorized = plan ? await mayMovePlan(input, ports, plan, creator) : true;
  const choice = lockedChoice(counts, authorized ? named : null);
  if (choice.status === 'tie') {
    const leaders = options.filter((o) => choice.keys.includes(o.key)).map((o) => o.text);
    return askTieBreak(input, ports, leaders, deny);
  }
  const won = options.find((option) => option.key === choice.key) ?? null;
  if (!won) return { handled: false };
  const startsAt = typeof won.startsAt === 'string' ? won.startsAt : null;
  if (plan && startsAt && !authorized) return lockRefused();
  const said = await speakLock(input, ports, won.text, deny);
  if (said !== 'sent') return said;
  if (plan && startsAt) await placePlan(input, ports, plans, plan, startsAt);
  await store.close(live.id, input.now);
  return { handled: true, outcome: 'group_experience_spoken', count: 'intake', notice: 'sent' };
}

/**
 * A locked choice places the poll's own plan, named by id when the poll opened, while that plan
 * is still open. A label is never parsed into a date: no placed instant, no plan time. Every
 * household whose copy Hale wrote gets it moved (one daytime notice each); yes households get
 * the OK ask.
 */
async function placePlan(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  plans: GroupPlanRsvpStore,
  plan: GroupPlanRecord,
  startsAt: string,
): Promise<void> {
  const placed = new Date(startsAt);
  if (Number.isNaN(placed.getTime())) return;
  if (!(await plans.setPlanStart(plan.id, placed, input.senderUserId, input.now))) return;
  await moveCalendar(ports, input, plan.id);
  const { rows } = await plans.loadTally(plan.id);
  for (const yes of await plans.listYesRsvps(plan.id)) {
    await settleCalendar(ports, input, {
      planId: plan.id,
      userId: yes.userId,
      memberKey: yes.memberKey,
      displayName: rows.find((row) => row.memberKey === yes.memberKey)?.displayName ?? 'someone',
      response: 'yes',
      parentWords: null,
      proactive: true,
    });
  }
}

/**
 * VIL-471 owns the chat's open poll. A lock lands on the single leader, or on a leader the
 * message named when the leaders tie; a tie nothing breaks asks which. A choice placed on a plan
 * when the poll opened (the poll's own plan, by id) moves that plan and its written copies, and
 * only the poll's creator or the plan's host household may lock it that way.
 */
async function lockGroupPoll(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  plans: GroupPlanRsvpStore,
  named: string | null,
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
  const poll = await plans.loadLivePoll(input.chatId);
  if (!poll) return { handled: false };
  const tally = await plans.loadPollTally(poll.id);
  const placedPlanId = poll.options.find((option) => option.places)?.places?.planId ?? null;
  const plan = placedPlanId
    ? await plans.loadOpenPlan(input.chatId, placedPlanId, input.now)
    : null;
  const authorized = plan ? await mayMovePlan(input, ports, plan, poll.createdByMemberKey) : true;
  const choice = lockedChoice(
    tally.options.map((option) => ({ key: option.key, votes: option.votes })),
    authorized ? named : null,
  );
  if (choice.status === 'tie') {
    const leaders = poll.options.filter((o) => choice.keys.includes(o.key)).map((o) => o.text);
    return askTieBreak(input, ports, leaders, deny);
  }
  const won = poll.options.find((option) => option.key === choice.key);
  if (!won) return { handled: true, outcome: 'group_experience_recorded', count: 'ignored' };
  const places = won.places && plan && won.places.planId === plan.id ? won.places : null;
  if (places && !authorized) return lockRefused();
  const said = await speakLock(input, ports, won.text, deny);
  if (said !== 'sent') return said;
  await plans.closePoll(poll.id, input.senderUserId, input.now);
  if (places && plan) await placePlan(input, ports, plans, plan, places.startsAt);
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
