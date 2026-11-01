import { beforeAll, describe, expect, it } from 'vitest';
import type { CalendarConsentReader, GroupPlanCalendarWriter } from './calendar';
import { calendarConsentUserMessage } from './calendar';
import { memberKeyFromHandle } from './member-key';
import { createMemoryGroupPlanRsvpStore, createMemoryWorld } from './memory-store';
import type { GroupPlanRsvpReader, GroupPlanRsvpReading } from './reading';
import { takeGroupPlanRsvpTurn } from './turn';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-picnic';
const PRIYA = '+14165550101';
const SAM = '+14165550102';
const NOW = new Date('2026-10-28T16:00:00.000Z');
const LATER = new Date('2026-10-28T17:00:00.000Z');

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

function consentOf(
  decision: 'ok' | 'decline' | 'not_this',
  confidence: 'high' | 'low' = 'high',
): CalendarConsentReader & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    async read(input) {
      texts.push(input.text);
      return { decision, confidence };
    },
  };
}

function writerSpy(): GroupPlanCalendarWriter & { familyIds: string[] } {
  const familyIds: string[] = [];
  return {
    familyIds,
    async write(input) {
      familyIds.push(input.familyId);
      return { status: 'written', familyEventId: `evt-${input.familyId}` };
    },
  };
}

function households(map: Record<string, string>) {
  return {
    async resolve(input: { userId: string | null }) {
      if (!input.userId || !(input.userId in map)) return { status: 'none' as const };
      const familyId = map[input.userId];
      return familyId ? { status: 'one' as const, familyId } : { status: 'none' as const };
    },
  };
}

async function picnic() {
  const world = createMemoryWorld();
  world.families.set(CHAT, { familyId: 'fam-covering', timeZone: 'America/Toronto' });
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
      haleCustomer: true,
    },
  ]);
  const store = createMemoryGroupPlanRsvpStore(world);
  const texts: { text: string; kind?: string }[] = [];
  await takeGroupPlanRsvpTurn(
    {
      chatId: CHAT,
      senderHandle: PRIYA,
      senderName: 'Priya',
      text: 'keep count for the picnic',
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
        deadline: null,
        response: null,
        headcount: 1,
        householdLabel: null,
        coversNames: [],
        confidence: 'high',
      }),
      composer: fakeGroupPlanRsvpComposer(),
      send: async ({ text, kind }) => {
        texts.push({ text, kind });
        return { providerMessageId: `msg-${texts.length}` };
      },
      enabled: () => true,
    },
  );
  texts.length = 0;
  return { world, store, texts };
}

function calendarDeps(input: {
  store: Awaited<ReturnType<typeof picnic>>['store'];
  texts: { text: string; kind?: string }[];
  reader: GroupPlanRsvpReader;
  consent?: CalendarConsentReader;
  writer?: GroupPlanCalendarWriter;
  homes?: ReturnType<typeof households>;
  composer?: ReturnType<typeof fakeGroupPlanRsvpComposer>;
  enabled?: boolean;
}) {
  return {
    store: input.store,
    reader: input.reader,
    consentReader: input.consent,
    calendar: input.writer,
    households: input.homes ?? households({ 'u-priya': 'fam-priya', 'u-sam': 'fam-sam' }),
    composer: input.composer ?? fakeGroupPlanRsvpComposer(),
    send: async ({ text, kind }: { text: string; kind?: string }) => {
      input.texts.push({ text, kind });
      return { providerMessageId: `msg-${input.texts.length}` };
    },
    enabled: () => true,
    calendarEnabled: () => input.enabled ?? true,
  };
}

describe('group plan calendar consent', () => {
  it('stays dark when the calendar flag is off — a yes does not ask or write', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    const outcome = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'we are in',
        tapback: null,
        language: 'en',
        now: LATER,
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        enabled: false,
      }),
    );
    expect(outcome).toMatchObject({ handled: true, outcome: 'group_plan_recorded' });
    expect(outcome.handled && outcome.calendar).toBeUndefined();
    expect(writer.familyIds).toEqual([]);
    expect(texts).toEqual([]);
    const plan = await store.loadLivePlan(CHAT);
    expect(await store.loadCalendarConsent(plan?.id ?? '', 'fam-priya')).toBeNull();
  });

  it('asks after a yes and writes only that household after the reader says ok', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    const consent = consentOf('ok');
    const asked = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'the Patels are in',
        tapback: null,
        language: 'en',
        now: LATER,
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes', { householdLabel: 'the Patels', headcount: 3 })),
        writer,
        consent,
      }),
    );
    expect(asked).toMatchObject({
      handled: true,
      calendar: { status: 'asked' },
    });
    expect(writer.familyIds).toEqual([]);
    expect(texts.map((line) => line.kind)).toEqual(['calendar_ask', 'plan']);
    expect(consent.texts).toEqual([]);

    const written = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'please do, the kids would love having it there',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 60_000),
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        consent,
      }),
    );
    expect(written).toMatchObject({
      handled: true,
      outcome: 'group_plan_calendar_written',
      calendar: { status: 'written', familyId: 'fam-priya', familyEventId: 'evt-fam-priya' },
      notice: 'sent',
    });
    expect(writer.familyIds).toEqual(['fam-priya']);
    expect(texts.map((line) => line.kind)).toEqual(['calendar_ask', 'plan', 'calendar_written']);
    expect(consent.texts).toEqual(['please do, the kids would love having it there']);
    const plan = await store.loadLivePlan(CHAT);
    const row = await store.loadCalendarConsent(plan?.id ?? '', 'fam-priya');
    expect(row?.status).toBe('written');
    expect(row?.familyEventId).toBe('evt-fam-priya');
    expect(await store.loadCalendarConsent(plan?.id ?? '', 'fam-sam')).toBeNull();
    expect(await store.loadCalendarConsent(plan?.id ?? '', 'fam-covering')).toBeNull();
  });

  it('does not treat the words yes or ok as consent — the reader decides', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'count us in',
        tapback: null,
        language: 'en',
        now: LATER,
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        consent: consentOf('ok'),
      }),
    );
    const notThis = consentOf('not_this');
    const stillOpen = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'yes',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 60_000),
      },
      calendarDeps({
        store,
        texts,
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
        writer,
        consent: notThis,
      }),
    );
    expect(stillOpen).toMatchObject({ handled: true, outcome: 'group_plan_chatter' });
    expect(writer.familyIds).toEqual([]);

    const declined = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'ok',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 120_000),
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        consent: consentOf('decline'),
      }),
    );
    expect(declined).toMatchObject({
      handled: true,
      outcome: 'group_plan_calendar_declined',
      calendar: { status: 'declined' },
    });
    expect(writer.familyIds).toEqual([]);
    const asks = texts.filter((line) => line.kind === 'calendar_ask').length;
    const again = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'still in',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 180_000),
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        consent: consentOf('ok'),
      }),
    );
    expect(again).toMatchObject({ handled: true, outcome: 'group_plan_recorded' });
    expect(again.handled && again.calendar).toBeUndefined();
    expect(texts.filter((line) => line.kind === 'calendar_ask')).toHaveLength(asks);
    expect(writer.familyIds).toEqual([]);
  });

  it('leaves the other household unwritten until that household agrees', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    const homes = households({ 'u-priya': 'fam-priya', 'u-sam': 'fam-sam' });
    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'in',
        tapback: null,
        language: 'en',
        now: LATER,
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        homes,
        consent: consentOf('ok'),
      }),
    );
    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'add it for us',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 60_000),
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        homes,
        consent: consentOf('ok'),
      }),
    );
    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: SAM,
        senderName: 'Sam',
        senderUserId: 'u-sam',
        text: 'we are coming too',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 120_000),
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        homes,
        consent: consentOf('ok'),
      }),
    );
    expect(writer.familyIds).toEqual(['fam-priya']);
    const plan = await store.loadLivePlan(CHAT);
    expect((await store.loadCalendarConsent(plan?.id ?? '', 'fam-sam'))?.status).toBe('asked');

    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: SAM,
        senderName: 'Sam',
        senderUserId: 'u-sam',
        text: 'ours too, thanks',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 180_000),
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        homes,
        consent: consentOf('ok'),
      }),
    );
    expect(writer.familyIds).toEqual(['fam-priya', 'fam-sam']);
  });

  it('does not ask a household Hale cannot place, or a plan with no start', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    const skipped = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: SAM,
        senderName: 'Sam',
        senderUserId: 'u-sam',
        text: 'in',
        tapback: null,
        language: 'en',
        now: LATER,
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        homes: households({ 'u-priya': 'fam-priya' }),
      }),
    );
    expect(skipped).toMatchObject({ calendar: { status: 'skipped', reason: 'no_household' } });
    expect(writer.familyIds).toEqual([]);

    const bare = createMemoryWorld();
    bare.families.set(CHAT, { familyId: 'fam-covering', timeZone: 'America/Toronto' });
    const bareStore = createMemoryGroupPlanRsvpStore(bare);
    const plan = await bareStore.createPlan({
      chatId: CHAT,
      familyId: 'fam-covering',
      title: 'sometime',
      startsAt: null,
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: null,
      expected: [],
      now: NOW,
    });
    const noStart = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'in',
        tapback: null,
        language: 'en',
        now: LATER,
      },
      calendarDeps({
        store: bareStore,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
      }),
    );
    expect(noStart).toMatchObject({ calendar: { status: 'skipped', reason: 'no_start' } });
    expect(await bareStore.loadCalendarConsent(plan.id, 'fam-priya')).toBeNull();
    expect(writer.familyIds).toEqual([]);
  });

  it('sends nothing and keeps no ask when the model cannot write the question', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    const outcome = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'in',
        tapback: null,
        language: 'en',
        now: LATER,
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        composer: fakeGroupPlanRsvpComposer({ fail: true }),
      }),
    );
    expect(outcome).toMatchObject({ calendar: { status: 'skipped', reason: 'model_failed' } });
    expect(texts).toEqual([]);
    const plan = await store.loadLivePlan(CHAT);
    expect(await store.loadCalendarConsent(plan?.id ?? '', 'fam-priya')).toBeNull();
    expect(writer.familyIds).toEqual([]);
  });

  it('keeps the calendar row when the confirmation cannot be sent', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'in',
        tapback: null,
        language: 'en',
        now: LATER,
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        consent: consentOf('not_this'),
      }),
    );
    const composer = fakeGroupPlanRsvpComposer({ fail: true });
    const outcome = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'put it on ours',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 60_000),
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        consent: consentOf('ok'),
        composer,
      }),
    );
    expect(outcome).toMatchObject({
      outcome: 'group_plan_calendar_written',
      calendar: { status: 'written', familyId: 'fam-priya' },
      notice: { skipped: 'model_failed' },
    });
    expect(writer.familyIds).toEqual(['fam-priya']);
  });

  it('drops an unanswered ask when they are no longer coming, and can ask again later', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'in',
        tapback: null,
        language: 'en',
        now: LATER,
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        consent: consentOf('not_this'),
      }),
    );
    const plan = await store.loadLivePlan(CHAT);
    expect((await store.loadCalendarConsent(plan?.id ?? '', 'fam-priya'))?.status).toBe('asked');
    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'actually we cannot',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 60_000),
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf({
          intent: 'edit',
          planTitle: null,
          startsAt: null,
          location: null,
          deadline: null,
          response: 'no',
          headcount: 1,
          householdLabel: null,
          coversNames: [],
          confidence: 'high',
        }),
        writer,
        consent: consentOf('not_this'),
      }),
    );
    expect(await store.loadCalendarConsent(plan?.id ?? '', 'fam-priya')).toBeNull();
    expect(writer.familyIds).toEqual([]);
  });
});

describe('calendarConsentUserMessage', () => {
  it('sends facts to the reader and no suggested reply', () => {
    const message = calendarConsentUserMessage({
      text: 'sounds right for us',
      tapback: null,
      senderName: 'Priya',
      ask: {
        title: 'Saturday picnic',
        startsAt: '2026-11-01T16:00:00.000Z',
        location: 'the park',
        displayName: 'Priya',
        householdLabel: 'the Patels',
      },
    });
    const body = JSON.parse(message) as {
      text: string;
      ask: { title: string; displayName: string };
    };
    expect(body.text).toBe('sounds right for us');
    expect(body.ask.title).toBe('Saturday picnic');
    expect(body.ask.displayName).toBe('Priya');
    expect(message).not.toContain('reply with');
  });
});
