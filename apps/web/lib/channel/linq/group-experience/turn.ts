import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import {
  groupLinkCardsEnabled,
  groupPollsEnabled,
  groupPrivateQuestionEnabled,
  linqPollsEnabled,
} from '../config';
import type { GroupPlanCopyStore } from '../group-plan-invites';
import { senderMemberKey } from '../group-plan-rsvp/member-key';
import { optionKeyAt } from '../group-plan-rsvp/poll-tally';
import {
  type GroupPlanRsvpStore,
  createPostgresGroupPlanRsvpStore,
} from '../group-plan-rsvp/store';
import { type FamilyPrivateSlice, presentHouseholds } from '../multi-family';
import {
  placeYesFamilyCalendars,
  planAsGroupPlan,
  postgresYesCalendarCopies,
  yesFamilyIdsForPlan,
} from './calendar';
import { GROUP_RSVP_POLL_KIND, GROUP_TIME_POLL_KIND } from './kinds';
import { type ExperiencePollCardPort, postgresExperiencePollCard } from './poll-card';
import { privateDenyTokens } from './privacy';
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
      notice?: 'sent' | { skipped: GroupExperienceVoiceSkip | 'not_sent' };
      card?: 'sent' | { skipped: string };
    };

export interface GroupExperienceTurnInput {
  chatId: string;
  familyId: string;
  senderHandle: string;
  senderUserId: string | null;
  senderName: string | null;
  senderFamilyId: string | null;
  text: string;
  language: 'en' | 'fr';
  now: Date;
}

export interface GroupExperienceTurnPorts {
  database: Database;
  store?: GroupExperienceStore;
  plans?: GroupPlanRsvpStore;
  reader?: GroupExperienceReader;
  composer?: GroupExperienceComposer;
  pollCard?: ExperiencePollCardPort;
  copies?: GroupPlanCopyStore;
  send?: (input: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>;
  sendOneToOne?: (input: {
    familyId: string;
    text: string;
    url?: string | null;
    dedupeKey: string;
  }) => Promise<'sent' | 'not_sent'>;
  privateSlices?: (familyIds: readonly string[]) => Promise<FamilyPrivateSlice[]>;
  recent?: () => Promise<{ from: 'hale' | 'member'; text: string }[]>;
  households?: (chatId: string) => Promise<string[]>;
}

async function liveView(
  store: GroupExperienceStore,
  plans: GroupPlanRsvpStore,
  chatId: string,
): Promise<GroupExperienceLiveView> {
  const rsvp = await store.loadLive(chatId, 'rsvp_poll');
  const time = await store.loadLive(chatId, 'time_poll');
  const link = await store.loadLive(chatId, 'link_card');
  const plan = await plans.loadLivePlan(chatId);
  return {
    rsvp: rsvp || plan ? { title: plan?.title ?? null } : null,
    time: time
      ? {
          question: typeof time.payload.question === 'string' ? time.payload.question : null,
          options: Array.isArray(time.payload.options)
            ? (time.payload.options as { key: string; text: string }[])
            : [],
        }
      : null,
    link: link && typeof link.payload.url === 'string' ? { url: link.payload.url } : null,
  };
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
  try {
    if (ports.send) {
      await ports.send({ chatId: input.chatId, text });
      return 'sent';
    }
    await sendGroupExperienceLine(ports.database, {
      chatId: input.chatId,
      familyId: input.familyId,
      text,
      now: input.now,
    });
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
  familyIds: readonly string[],
): Promise<string[]> {
  if (!ports.privateSlices) return [];
  return privateDenyTokens(await ports.privateSlices(familyIds));
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
  const live = await liveView(store, plans, input.chatId);
  const reading = await reader.read({
    text: input.text,
    senderName: input.senderName,
    live,
    urls,
    recent: ports.recent ? await ports.recent() : [],
  });
  if (!reading || reading.kind === 'none' || !allowedKind(reading.kind)) {
    return { handled: false };
  }

  const familyIds = await householdsInChat(ports, input.chatId, input.familyId);
  const deny = await denyForChat(ports, familyIds);

  if (reading.kind === 'rsvp_open') return openRsvp(input, ports, store, plans, reading, deny);
  if (reading.kind === 'rsvp_vote' && reading.response) {
    return voteRsvp(input, ports, store, plans, reading.response, deny);
  }
  if (reading.kind === 'rsvp_tally') return tallyRsvp(input, ports, plans, deny);
  if (reading.kind === 'time_open') return openTime(input, ports, store, plans, reading, deny);
  if (reading.kind === 'time_vote' && reading.optionKey) {
    return voteTime(input, ports, store, reading.optionKey, deny);
  }
  if (reading.kind === 'time_lock') return lockTime(input, ports, store, deny);
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
  const livePlan = await plans.loadLivePlan(input.chatId);
  const spoken = await speak(
    ports,
    input,
    'rsvp_open',
    { card: card.enabled() && linqPollsEnabled(), title: livePlan?.title ?? reading.title },
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
  let plan = livePlan;
  if (!plan) {
    const title = reading.title?.trim();
    if (!title) {
      return { handled: true, outcome: 'group_experience_spoken', count: 'intake', notice: 'sent' };
    }
    plan = await plans.createPlan({
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
  const plan = await plans.loadLivePlan(input.chatId);
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
  const plan = await plans.loadLivePlan(input.chatId);
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
  const groupPlan = await planAsGroupPlan(ports.database, plan.id, input.chatId);
  if (groupPlan) {
    const yesIds = await yesFamilyIdsForPlan(ports.database, plan.id);
    await placeYesFamilyCalendars(
      ports.copies ?? postgresYesCalendarCopies(ports.database),
      groupPlan,
      yesIds,
    );
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
  const spoken = await speak(
    ports,
    input,
    'time_open',
    {
      card: card.enabled() && parentOptions.length >= 2,
      options: parentOptions,
      title: (await plans.loadLivePlan(input.chatId))?.title ?? null,
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
  const labels = parentOptions.length >= 2 ? parentOptions : spoken.options;
  if (labels.length < 2) {
    return { handled: true, outcome: 'group_experience_spoken', count: 'intake', notice: 'sent' };
  }
  const options = labels.slice(0, 6).map((text, index) => ({
    key: optionKeyAt(index),
    text,
    choiceValue: optionKeyAt(index),
  }));
  const plan = await plans.loadLivePlan(input.chatId);
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
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
  const live = await store.loadLive(input.chatId, 'time_poll');
  if (!live) return { handled: false };
  const options = Array.isArray(live.payload.options)
    ? (live.payload.options as { key: string; text: string }[])
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
  const winner = options.find((option) => option.key === winnerKey)?.text ?? null;
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
  const planId = typeof live.payload.planId === 'string' ? live.payload.planId : null;
  if (planId) {
    const startsAt = Date.parse(winner);
    if (!Number.isNaN(startsAt)) {
      await ports.database
        .update(schema.linqGroupPlans)
        .set({ startsAt: new Date(startsAt) })
        .where(eq(schema.linqGroupPlans.id, planId));
      const groupPlan = await planAsGroupPlan(ports.database, planId, input.chatId);
      if (groupPlan) {
        const yesIds = await yesFamilyIdsForPlan(ports.database, planId);
        await placeYesFamilyCalendars(
          ports.copies ?? postgresYesCalendarCopies(ports.database),
          groupPlan,
          yesIds,
        );
      }
    }
  }
  await store.close(live.id, input.now);
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
  if (ports.sendOneToOne) {
    for (const familyId of familyIds) {
      const oneToOne = await speak(ports, input, 'registration_1to1', { url }, 0, 'one_to_one', []);
      if (oneToOne.status !== 'composed') continue;
      await ports.sendOneToOne({
        familyId,
        text: oneToOne.line,
        url,
        dedupeKey: `group-link:${input.chatId}:${familyId}:${url}`,
      });
    }
  }
  return { handled: true, outcome: 'group_experience_spoken', count: 'intake', notice: 'sent' };
}

async function movePrivate(
  input: GroupExperienceTurnInput,
  ports: GroupExperienceTurnPorts,
  store: GroupExperienceStore,
  familyIds: readonly string[],
  deny: readonly string[],
): Promise<GroupExperienceTurnOutcome> {
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
  const targetFamilyId =
    input.senderFamilyId && familyIds.includes(input.senderFamilyId)
      ? input.senderFamilyId
      : (familyIds[0] ?? input.familyId);
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
