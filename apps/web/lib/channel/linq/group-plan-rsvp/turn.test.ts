import { beforeAll, describe, expect, it } from 'vitest';
import { memberKeyFromHandle } from './member-key';
import { createMemoryGroupPlanRsvpStore, createMemoryWorld } from './memory-store';
import type { GroupPlanRsvpReader, GroupPlanRsvpReading } from './reading';
import { groupPlanRsvpTakesTheTurn, takeGroupPlanRsvpTurn } from './turn';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-picnic';
const PRIYA = '+14165550101';
const SAM = '+14165550102';
const MAYA = '+14165550103';
const NOW = new Date('2026-10-28T16:00:00.000Z');

beforeAll(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
});

function readerOf(reading: GroupPlanRsvpReading): GroupPlanRsvpReader {
  return { read: async () => reading };
}

function rsvp(
  response: 'yes' | 'no' | 'maybe',
  extras: Partial<GroupPlanRsvpReading> = {},
): GroupPlanRsvpReading {
  return {
    intent: 'rsvp',
    planTitle: null,
    startsAt: null,
    location: null,
    deadline: null,
    response,
    headcount: 1,
    householdLabel: null,
    coversNames: [],
    confidence: 'high',
    ...extras,
  };
}

function worldWithPicnic() {
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

async function startPicnic(world = worldWithPicnic()) {
  const store = createMemoryGroupPlanRsvpStore(world);
  const texts: string[] = [];
  const start = await takeGroupPlanRsvpTurn(
    {
      chatId: CHAT,
      senderHandle: PRIYA,
      senderName: 'Priya',
      text: 'Hale, can you keep count for the picnic Saturday?',
      tapback: null,
      language: 'en',
      now: NOW,
    },
    {
      store,
      reader: readerOf({
        intent: 'start_tracking',
        planTitle: 'Saturday picnic',
        startsAt: '2026-11-01T16:00:00.000Z',
        location: 'the park',
        deadline: '2026-10-31T16:00:00.000Z',
        response: null,
        headcount: 1,
        householdLabel: null,
        coversNames: [],
        confidence: 'high',
      }),
      composer: fakeGroupPlanRsvpComposer(),
      send: async ({ text }) => {
        texts.push(text);
        return { providerMessageId: `msg-${texts.length}` };
      },
      enabled: () => true,
    },
  );
  return { world, store, texts, start };
}

describe('takeGroupPlanRsvpTurn', () => {
  it('is dark when the flag is off', async () => {
    const { store } = await startPicnic();
    const outcome = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: SAM,
        senderName: 'Sam',
        text: 'we are in',
        tapback: null,
        language: 'en',
        now: NOW,
      },
      {
        store,
        reader: readerOf(rsvp('yes')),
        composer: fakeGroupPlanRsvpComposer(),
        send: async () => ({ providerMessageId: 'x' }),
        enabled: () => false,
      },
    );
    expect(outcome).toEqual({ handled: false });
  });

  it('starts tracking any plan and speaks once with the waiting names', async () => {
    const { start, texts } = await startPicnic();
    expect(start.handled).toBe(true);
    if (!start.handled) return;
    expect(start.outcome).toBe('group_plan_spoken');
    expect(start.tally?.toGo).toBe(3);
    expect(texts[0]).toContain('Saturday picnic');
    expect(texts[0]).toContain('Priya');
  });

  it('records an ordinary yes from a non-customer and stays quiet', async () => {
    const { store, texts } = await startPicnic();
    const before = texts.length;
    const outcome = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: SAM,
        senderName: 'Sam',
        text: 'count me in',
        tapback: null,
        language: 'en',
        now: NOW,
      },
      {
        store,
        reader: readerOf(rsvp('yes')),
        composer: fakeGroupPlanRsvpComposer(),
        send: async ({ text }) => {
          texts.push(text);
          return { providerMessageId: `msg-${texts.length}` };
        },
        enabled: () => true,
      },
    );
    expect(outcome.handled).toBe(true);
    if (!outcome.handled) return;
    expect(outcome.outcome).toBe('group_plan_recorded');
    expect(outcome.tally?.yesCount).toBe(1);
    expect(outcome.tally?.toGo).toBe(2);
    expect(texts.length).toBe(before);
  });

  it('stays quiet on banter while a plan is live', async () => {
    const { store, texts } = await startPicnic();
    const before = texts.length;
    const outcome = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: SAM,
        senderName: 'Sam',
        text: 'lol the juice boxes again',
        tapback: null,
        language: 'en',
        now: NOW,
      },
      {
        store,
        reader: readerOf({
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
        }),
        composer: fakeGroupPlanRsvpComposer(),
        send: async ({ text }) => {
          texts.push(text);
          return { providerMessageId: `msg-${texts.length}` };
        },
        enabled: () => true,
      },
    );
    expect(outcome).toMatchObject({ handled: true, outcome: 'group_plan_chatter' });
    expect(texts.length).toBe(before);
  });

  it('keeps the count right after an edit', async () => {
    const { store } = await startPicnic();
    const deps = {
      store,
      composer: fakeGroupPlanRsvpComposer(),
      send: async () => ({ providerMessageId: 'x' }),
      enabled: () => true,
    };
    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: MAYA,
        senderName: 'Maya',
        text: 'we are in, all three of us',
        tapback: null,
        language: 'en',
        now: NOW,
      },
      {
        ...deps,
        reader: readerOf(
          rsvp('yes', { headcount: 3, householdLabel: 'the Chens', coversNames: ['Wei', 'Lin'] }),
        ),
      },
    );
    const edited = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: MAYA,
        senderName: 'Maya',
        text: 'actually just me',
        tapback: null,
        language: 'en',
        now: new Date(NOW.getTime() + 60_000),
      },
      {
        ...deps,
        reader: readerOf({
          intent: 'edit',
          planTitle: null,
          startsAt: null,
          location: null,
          deadline: null,
          response: 'yes',
          headcount: 1,
          householdLabel: null,
          coversNames: [],
          confidence: 'high',
        }),
      },
    );
    expect(edited.handled).toBe(true);
    if (!edited.handled) return;
    expect(edited.outcome).toBe('group_plan_spoken');
    expect(edited.tally?.yesHeads).toBe(1);
    expect(edited.tally?.yesCount).toBe(1);
  });

  it('reads a thumbs-up from someone who is not a Hale customer', async () => {
    const { store } = await startPicnic();
    const outcome = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: SAM,
        senderName: 'Sam',
        text: '',
        tapback: 'like',
        language: 'en',
        now: NOW,
      },
      {
        store,
        reader: {
          read: async (input) => {
            expect(input.tapback).toBe('like');
            return rsvp('yes');
          },
        },
        composer: fakeGroupPlanRsvpComposer(),
        send: async () => ({ providerMessageId: 'x' }),
        enabled: () => true,
      },
    );
    expect(outcome.handled).toBe(true);
    if (!outcome.handled) return;
    expect(outcome.tally?.yesCount).toBe(1);
  });

  it('does not take the inbound turn for banter — other group jobs can still run', async () => {
    const { store } = await startPicnic();
    const outcome = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: SAM,
        senderName: 'Sam',
        text: 'lol the juice boxes again',
        tapback: null,
        language: 'en',
        now: NOW,
      },
      {
        store,
        reader: readerOf({
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
        }),
        composer: fakeGroupPlanRsvpComposer(),
        send: async () => ({ providerMessageId: 'x' }),
        enabled: () => true,
      },
    );
    expect(groupPlanRsvpTakesTheTurn(outcome)).toBe(false);
  });

  it('names a skipped send when the model cannot write — no fallback line', async () => {
    const { store } = await startPicnic();
    const outcome = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        text: 'where do we stand',
        tapback: null,
        language: 'en',
        now: NOW,
      },
      {
        store,
        reader: readerOf({
          intent: 'ask_tally',
          planTitle: null,
          startsAt: null,
          location: null,
          deadline: null,
          response: null,
          headcount: 1,
          householdLabel: null,
          coversNames: [],
          confidence: 'high',
        }),
        composer: fakeGroupPlanRsvpComposer({ fail: true }),
        send: async () => ({ providerMessageId: 'x' }),
        enabled: () => true,
      },
    );
    expect(outcome).toMatchObject({
      handled: true,
      outcome: 'group_plan_line_unsent',
      notice: { skipped: 'model_failed' },
    });
  });
});
