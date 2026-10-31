import { beforeAll, describe, expect, it } from 'vitest';
import { memberKeyFromHandle } from './member-key';
import {
  type MemoryGroupPlanWorld,
  createMemoryGroupPlanRsvpStore,
  createMemoryWorld,
} from './memory-store';
import type { GroupPollLineInput } from './poll-facts';
import {
  GROUP_POLL_KIND,
  GROUP_STUCK_POLL_KIND,
  type GroupPollCardPort,
  takeGroupPollCardVote,
} from './poll-turn';
import type { GroupPlanRsvpReadInput, GroupPlanRsvpReader, GroupPlanRsvpReading } from './reading';
import { groupPlanRsvpTakesTheTurn, takeGroupPlanRsvpTurn } from './turn';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

/**
 * VIL-471 — polls inside the shared group turn. The reader is a structured
 * stand-in (what the model returned), so these tests check counting, settle
 * points, the card, and the ledger contract — never wording. Wording is the
 * judge eval in apps/worker/evals/group-poll-eval.mjs.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-saturday';
const PRIYA = '+14165550101';
const SAM = '+14165550102';
const MAYA = '+14165550103';
const NOT_HALE = '+14165550199';
const NOW = new Date('2026-10-28T16:00:00.000Z');

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});

function reading(extras: Partial<GroupPlanRsvpReading>): GroupPlanRsvpReading {
  return {
    intent: 'chatter',
    planTitle: null,
    startsAt: null,
    location: null,
    deadline: null,
    response: null,
    headcount: 1,
    householdLabel: null,
    coversNames: [],
    confidence: 'high',
    pollQuestion: null,
    pollOptions: [],
    pollChoice: null,
    ...extras,
  };
}

function scriptedReader(next: GroupPlanRsvpReading) {
  const seen: GroupPlanRsvpReadInput[] = [];
  const reader: GroupPlanRsvpReader = {
    async read(input) {
      seen.push(input);
      return next;
    },
  };
  return { reader, seen };
}

function seededWorld(): MemoryGroupPlanWorld {
  const world = createMemoryWorld();
  world.families.set(CHAT, { familyId: 'fam-priya', timeZone: 'America/Toronto' });
  world.seats.set(CHAT, [
    {
      memberKey: memberKeyFromHandle(PRIYA) as string,
      displayName: 'Priya',
      userId: 'u-priya',
      haleCustomer: true,
    },
    {
      memberKey: memberKeyFromHandle(SAM) as string,
      displayName: 'Sam',
      userId: 'u-sam',
      haleCustomer: false,
    },
    {
      memberKey: memberKeyFromHandle(MAYA) as string,
      displayName: 'Maya',
      userId: null,
      haleCustomer: false,
    },
  ]);
  return world;
}

function fakeCard(
  world: MemoryGroupPlanWorld,
  options: { enabled?: boolean; refuse?: boolean } = {},
) {
  const sent: { pollId: string; options: readonly { key: string; text: string }[] }[] = [];
  const port: GroupPollCardPort = {
    enabled: () => options.enabled ?? true,
    async send(input) {
      if (options.refuse) return { status: 'skipped', reason: 'refused' };
      sent.push({ pollId: input.pollId, options: input.options });
      const providerMessageId = `card-${sent.length}`;
      const cardOptions = input.options.map((option, index) => ({
        optionId: `${providerMessageId}-opt-${index}`,
        text: option.text,
        choiceValue: option.key,
      }));
      world.cards.set(providerMessageId, cardOptions);
      return { status: 'sent', providerMessageId, options: cardOptions };
    },
  };
  return { port, sent };
}

function harness(world = seededWorld(), card?: GroupPollCardPort) {
  const store = createMemoryGroupPlanRsvpStore(world);
  const lines: { text: string; kind?: 'plan' | 'poll' }[] = [];
  const composer = fakeGroupPlanRsvpComposer();
  const turn = (
    sender: string,
    name: string,
    next: GroupPlanRsvpReading,
    flags = { rsvp: false, polls: true },
  ) => {
    const { reader, seen } = scriptedReader(next);
    const outcome = takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: sender,
        senderName: name,
        text: 'a group message',
        tapback: null,
        language: 'en',
        now: NOW,
      },
      {
        store,
        reader,
        composer,
        send: async (line) => {
          lines.push({ text: line.text, kind: line.kind });
          return { providerMessageId: `msg-${lines.length}` };
        },
        enabled: () => flags.rsvp,
        pollsEnabled: () => flags.polls,
        pollCard: card,
      },
    );
    return { outcome, seen };
  };
  return { world, store, lines, composer, turn };
}

const START = reading({
  intent: 'start_poll',
  pollQuestion: 'where Saturday',
  pollOptions: ['zoo', 'science centre', 'splash pad'],
});

function pollLines(composer: ReturnType<typeof fakeGroupPlanRsvpComposer>): GroupPollLineInput[] {
  return composer.calls
    .map((call) => call.input)
    .filter((input): input is GroupPollLineInput => input.skill === 'group-poll-voice');
}

describe('group polls in the shared group turn', () => {
  it('is dark when LINQ_GROUP_POLLS_ENABLED is off: no poll, nothing sent', async () => {
    const h = harness();
    const { outcome } = h.turn(PRIYA, 'Priya', START, { rsvp: false, polls: false });
    expect(await outcome).toEqual({ handled: false });
    expect(h.world.polls.size).toBe(0);
    expect(h.lines).toHaveLength(0);
  });

  it('does not offer the reader poll intents while polls are off', async () => {
    const h = harness();
    const { outcome, seen } = h.turn(PRIYA, 'Priya', reading({ intent: 'chatter' }), {
      rsvp: true,
      polls: false,
    });
    await outcome;
    expect(seen[0]?.polls).toBeUndefined();
  });

  it('hands the reader the live poll as opaque keys once polls are on', async () => {
    const world = seededWorld();
    const h = harness(world, fakeCard(world).port);
    await h.turn(PRIYA, 'Priya', START).outcome;
    const { outcome, seen } = h.turn(SAM, 'Sam', reading({ intent: 'chatter' }));
    await outcome;
    expect(seen[0]?.polls?.live?.options).toEqual([
      { key: 'o1', text: 'zoo' },
      { key: 'o2', text: 'science centre' },
      { key: 'o3', text: 'splash pad' },
    ]);
  });

  it('opens a parent poll: one model line, then the native card, waiting on everyone seated', async () => {
    const world = seededWorld();
    const card = fakeCard(world);
    const h = harness(world, card.port);
    const result = await h.turn(PRIYA, 'Priya', START).outcome;
    expect(result.handled && result.outcome).toBe('group_poll_spoken');
    if (!result.handled) return;
    expect(groupPlanRsvpTakesTheTurn(result)).toBe(true);
    expect(result.card).toBe('sent');
    expect(h.lines).toEqual([expect.objectContaining({ kind: 'poll' })]);
    expect(card.sent[0]?.options.map((option) => option.key)).toEqual(['o1', 'o2', 'o3']);
    const [line] = pollLines(h.composer);
    expect(line?.kind).toBe('poll_started');
    expect(line?.questions).toBe(1);
    expect(line?.facts.card).toBe(true);
    expect(line?.facts.options.map((option) => option.text)).toEqual([
      'zoo',
      'science centre',
      'splash pad',
    ]);
    expect(result.pollTally?.waitingNames).toEqual(['Priya', 'Sam', 'Maya']);
    const [poll] = [...world.polls.values()];
    expect(poll?.origin).toBe('parent');
    expect(poll?.providerMessageId).toBe('card-1');
    expect(poll?.options.every((option) => option.providerOptionId)).toBe(true);
    expect(world.audits.map((row) => row.actionTaken)).toContain('linq_group_poll_started');
  });

  it('names the missing card instead of dropping it: LINQ_POLLS off means text votes only', async () => {
    const world = seededWorld();
    const h = harness(world, fakeCard(world, { enabled: false }).port);
    const result = await h.turn(PRIYA, 'Priya', START).outcome;
    expect(result.handled && result.card).toEqual({ skipped: 'polls_off' });
    expect(pollLines(h.composer)[0]?.facts.card).toBe(false);
    expect(world.polls.size).toBe(1);
  });

  it('names an absent card port on the outcome', async () => {
    const h = harness();
    const result = await h.turn(PRIYA, 'Priya', START).outcome;
    expect(result.handled && result.card).toEqual({ skipped: 'no_card_port' });
  });

  it('asks for the choices when the parent gave fewer than two, and opens nothing', async () => {
    const h = harness();
    const result = await h.turn(
      PRIYA,
      'Priya',
      reading({ intent: 'start_poll', pollQuestion: 'where Saturday', pollOptions: ['zoo'] }),
    ).outcome;
    expect(result.handled && result.outcome).toBe('group_poll_spoken');
    expect(pollLines(h.composer)[0]?.kind).toBe('poll_needs_options');
    expect(h.world.polls.size).toBe(0);
  });

  it('sends nothing and opens nothing when the model cannot write the line', async () => {
    const world = seededWorld();
    const card = fakeCard(world);
    const store = createMemoryGroupPlanRsvpStore(world);
    const sent: string[] = [];
    const result = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        text: 'x',
        tapback: null,
        language: 'en',
        now: NOW,
      },
      {
        store,
        reader: scriptedReader(START).reader,
        composer: fakeGroupPlanRsvpComposer({ fail: true }),
        send: async ({ text }) => {
          sent.push(text);
          return { providerMessageId: 'x' };
        },
        enabled: () => false,
        pollsEnabled: () => true,
        pollCard: card.port,
      },
    );
    expect(result.handled && result.outcome).toBe('group_poll_line_unsent');
    expect(result.handled && result.notice).toEqual({ skipped: 'model_failed' });
    expect(sent).toHaveLength(0);
    expect(card.sent).toHaveLength(0);
    expect(world.polls.size).toBe(0);
  });

  it('records a plain-language pick quietly, and a changed mind counts once', async () => {
    const h = harness();
    await h.turn(PRIYA, 'Priya', START).outcome;
    const first = await h.turn(SAM, 'Sam', reading({ intent: 'poll_vote', pollChoice: 'o1' }))
      .outcome;
    expect(first.handled && first.outcome).toBe('group_poll_recorded');
    const changed = await h.turn(SAM, 'Sam', reading({ intent: 'poll_vote', pollChoice: 'o3' }))
      .outcome;
    expect(changed.handled && changed.pollTally?.options.map((option) => option.votes)).toEqual([
      0, 0, 1,
    ]);
    expect(changed.handled && changed.pollTally?.waitingNames).toEqual(['Priya', 'Maya']);
    expect(h.lines).toHaveLength(1);
  });

  it('ignores a key that is not on the poll: no vote, no line', async () => {
    const h = harness();
    await h.turn(PRIYA, 'Priya', START).outcome;
    const result = await h.turn(SAM, 'Sam', reading({ intent: 'poll_vote', pollChoice: 'o9' }))
      .outcome;
    expect(result.handled && result.outcome).toBe('group_poll_unread');
    const poll = [...h.world.polls.values()][0];
    expect(poll?.votes.size).toBe(0);
    expect(h.lines).toHaveLength(1);
  });

  it('reads the live tally back when asked', async () => {
    const h = harness();
    await h.turn(PRIYA, 'Priya', START).outcome;
    await h.turn(SAM, 'Sam', reading({ intent: 'poll_vote', pollChoice: 'o2' })).outcome;
    const asked = await h.turn(MAYA, 'Maya', reading({ intent: 'ask_poll' })).outcome;
    expect(asked.handled && asked.outcome).toBe('group_poll_spoken');
    const tally = pollLines(h.composer).at(-1);
    expect(tally?.kind).toBe('poll_tally');
    expect(tally?.questions).toBe(0);
    expect(tally?.facts.leaders).toEqual(['science centre']);
    expect(tally?.facts.waitingNames).toEqual(['Priya', 'Maya']);
    expect(tally?.facts.allIn).toBe(false);
  });

  it('speaks once the last person it was waiting on picks, with the tie as a fact', async () => {
    const h = harness();
    await h.turn(PRIYA, 'Priya', START).outcome;
    await h.turn(PRIYA, 'Priya', reading({ intent: 'poll_vote', pollChoice: 'o1' })).outcome;
    await h.turn(SAM, 'Sam', reading({ intent: 'poll_vote', pollChoice: 'o2' })).outcome;
    const last = await h.turn(MAYA, 'Maya', reading({ intent: 'poll_vote', pollChoice: 'o3' }))
      .outcome;
    expect(last.handled && last.outcome).toBe('group_poll_spoken');
    const tally = pollLines(h.composer).at(-1);
    expect(tally?.facts.allIn).toBe(true);
    expect(tally?.facts.leaders).toEqual(['zoo', 'science centre', 'splash pad']);
    expect(h.lines).toHaveLength(2);
  });

  it('leaves a poll intent with no poll open to the rest of the group door', async () => {
    const h = harness();
    const result = await h.turn(SAM, 'Sam', reading({ intent: 'poll_vote', pollChoice: 'o1' }))
      .outcome;
    expect(result).toEqual({ handled: false });
  });

  it('keeps plan RSVPs dark when only polls are on', async () => {
    const h = harness();
    const result = await h.turn(
      PRIYA,
      'Priya',
      reading({ intent: 'start_tracking', planTitle: 'picnic' }),
    ).outcome;
    expect(result).toEqual({ handled: false });
    expect(h.world.plans.size).toBe(0);
  });
});

describe('native card votes', () => {
  async function openWithCard() {
    const world = seededWorld();
    const card = fakeCard(world);
    const h = harness(world, card.port);
    await h.turn(PRIYA, 'Priya', START).outcome;
    const poll = [...world.polls.values()][0];
    if (!poll) throw new Error('no poll');
    return { ...h, poll };
  }

  function tap(
    h: Awaited<ReturnType<typeof openWithCard>>,
    input: {
      handle: string;
      name: string;
      optionId: string;
      event?: 'added' | 'removed';
      pollKind?: string;
      providerMessageId?: string;
    },
  ) {
    return takeGroupPollCardVote(
      {
        chatId: CHAT,
        event: input.event ?? 'added',
        optionId: input.optionId,
        card: {
          providerMessageId: input.providerMessageId ?? 'card-1',
          familyId: 'fam-priya',
          pollKind: input.pollKind ?? GROUP_POLL_KIND,
          subjectKey: input.pollKind === GROUP_STUCK_POLL_KIND ? null : h.poll.id,
        },
        voter: {
          memberKey: memberKeyFromHandle(input.handle) as string,
          displayName: input.name,
          userId: null,
          haleCustomer: false,
        },
        language: 'en',
        now: NOW,
      },
      {
        store: h.store,
        composer: h.composer,
        send: async (line) => {
          h.lines.push({ text: line.text, kind: line.kind });
          return { providerMessageId: 'tap-line' };
        },
      },
    );
  }

  it('counts a tap on Hale’s card for someone who is not a Hale user, and a removal takes it back', async () => {
    const h = await openWithCard();
    const added = await tap(h, { handle: NOT_HALE, name: 'Dev', optionId: 'card-1-opt-1' });
    expect(added.handled && added.outcome).toBe('group_poll_recorded');
    expect(added.handled && added.pollTally?.options[1]?.voterNames).toEqual(['Dev']);
    const stale = await tap(h, {
      handle: NOT_HALE,
      name: 'Dev',
      optionId: 'card-1-opt-0',
      event: 'removed',
    });
    expect(stale.handled && stale.pollTally?.votedCount).toBe(1);
    const removed = await tap(h, {
      handle: NOT_HALE,
      name: 'Dev',
      optionId: 'card-1-opt-1',
      event: 'removed',
    });
    expect(removed.handled && removed.pollTally?.votedCount).toBe(0);
    expect(h.lines).toHaveLength(1);
  });

  it('treats a repeated webhook for the same tap as no change', async () => {
    const h = await openWithCard();
    await tap(h, { handle: SAM, name: 'Sam', optionId: 'card-1-opt-0' });
    await tap(h, { handle: SAM, name: 'Sam', optionId: 'card-1-opt-0' });
    const recorded = h.world.audits.filter(
      (row) => row.actionTaken === 'linq_group_poll_vote_recorded',
    );
    expect(recorded).toHaveLength(1);
  });

  it('a tap and a typed pick from the same person are one vote', async () => {
    const h = await openWithCard();
    await tap(h, { handle: SAM, name: 'Sam', optionId: 'card-1-opt-0' });
    const typed = await h.turn(SAM, 'Sam', reading({ intent: 'poll_vote', pollChoice: 'o2' }))
      .outcome;
    expect(typed.handled && typed.pollTally?.options.map((option) => option.votes)).toEqual([
      0, 1, 0,
    ]);
  });

  it('adopts the VIL-458 stuck-group card on its first vote and keeps counting on it', async () => {
    const world = seededWorld();
    world.cards.set('stuck-card', [
      { optionId: 'stuck-a', text: 'Sat 10am', choiceValue: null },
      { optionId: 'stuck-b', text: 'Sun 2pm', choiceValue: null },
    ]);
    const h = { ...harness(world), poll: { id: 'unused' } } as Awaited<
      ReturnType<typeof openWithCard>
    >;
    const first = await tap(h, {
      handle: NOT_HALE,
      name: 'Dev',
      optionId: 'stuck-b',
      pollKind: GROUP_STUCK_POLL_KIND,
      providerMessageId: 'stuck-card',
    });
    expect(first.handled && first.outcome).toBe('group_poll_recorded');
    const polls = [...world.polls.values()];
    expect(polls).toHaveLength(1);
    expect(polls[0]?.origin).toBe('hale_offer');
    expect(polls[0]?.question).toBeNull();
    expect(polls[0]?.options.map((option) => option.text)).toEqual(['Sat 10am', 'Sun 2pm']);
    await tap(h, {
      handle: SAM,
      name: 'Sam',
      optionId: 'stuck-b',
      pollKind: GROUP_STUCK_POLL_KIND,
      providerMessageId: 'stuck-card',
    });
    expect(world.polls.size).toBe(1);
    const asked = await h.turn(PRIYA, 'Priya', reading({ intent: 'ask_poll' })).outcome;
    expect(asked.handled && asked.pollTally?.options.map((option) => option.votes)).toEqual([0, 2]);
  });

  it('does not count a removal on a stuck card nobody voted on yet', async () => {
    const world = seededWorld();
    world.cards.set('stuck-card', [
      { optionId: 'stuck-a', text: 'Sat', choiceValue: null },
      { optionId: 'stuck-b', text: 'Sun', choiceValue: null },
    ]);
    const h = { ...harness(world), poll: { id: 'unused' } } as Awaited<
      ReturnType<typeof openWithCard>
    >;
    const removed = await tap(h, {
      handle: SAM,
      name: 'Sam',
      optionId: 'stuck-a',
      event: 'removed',
      pollKind: GROUP_STUCK_POLL_KIND,
      providerMessageId: 'stuck-card',
    });
    expect(removed.handled && removed.outcome).toBe('group_poll_unread');
    expect(world.polls.size).toBe(0);
  });

  it('leaves other poll kinds (year-find, logistics) to their own doors', async () => {
    const h = await openWithCard();
    const result = await tap(h, {
      handle: SAM,
      name: 'Sam',
      optionId: 'card-1-opt-0',
      pollKind: 'who_takes',
    });
    expect(result).toEqual({ handled: false });
  });
});
