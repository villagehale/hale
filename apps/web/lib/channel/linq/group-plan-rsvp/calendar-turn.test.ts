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
  decision: 'ok' | 'decline' | 'reopen' | 'not_this',
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

function writerSpy(): GroupPlanCalendarWriter & { familyIds: string[]; removed: string[] } {
  const familyIds: string[] = [];
  const removed: string[] = [];
  return {
    familyIds,
    removed,
    async write(input) {
      familyIds.push(input.familyId);
      return { status: 'written', familyEventId: `evt-${input.familyId}` };
    },
    async remove(input) {
      removed.push(input.familyId);
      return { status: 'removed', familyEventId: `evt-${input.familyId}` };
    },
  };
}

function privateSpy() {
  const lines: {
    familyId: string;
    userId: string | null;
    kind: string;
    text: string;
    planId: string;
  }[] = [];
  return {
    lines,
    async send(line: {
      planId: string;
      familyId: string;
      userId: string | null;
      text: string;
      kind: string;
    }) {
      expect(line).not.toHaveProperty('chatId');
      lines.push(line);
      return { status: 'sent' as const, providerMessageId: `priv-${lines.length}` };
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
  privateLines?: ReturnType<typeof privateSpy>;
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
    privateSend: input.privateLines ?? privateSpy(),
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
    const priv = privateSpy();
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
        privateLines: priv,
      }),
    );
    expect(asked).toMatchObject({
      handled: true,
      calendar: { status: 'asked' },
    });
    expect(writer.familyIds).toEqual([]);
    expect(priv.lines.map((line) => line.kind)).toEqual(['calendar_ask']);
    expect(priv.lines[0]?.familyId).toBe('fam-priya');
    expect(texts.map((line) => line.kind)).toEqual(['plan']);
    expect(texts.some((line) => line.kind?.startsWith('calendar'))).toBe(false);
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
        privateLines: priv,
      }),
    );
    expect(written).toMatchObject({
      handled: true,
      outcome: 'group_plan_calendar_written',
      calendar: { status: 'written', familyId: 'fam-priya', familyEventId: 'evt-fam-priya' },
      notice: 'sent',
    });
    expect(writer.familyIds).toEqual(['fam-priya']);
    expect(texts.map((line) => line.kind)).toEqual(['plan']);
    expect(priv.lines.map((line) => line.kind)).toEqual(['calendar_ask', 'calendar_written']);
    expect(priv.lines.every((line) => line.familyId === 'fam-priya')).toBe(true);
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
    expect(texts.some((line) => line.kind?.startsWith('calendar'))).toBe(false);
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

  it('reopens a decline only when the reader says they brought the calendar up again', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    const priv = privateSpy();
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
        privateLines: priv,
        consent: consentOf('not_this'),
      }),
    );
    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'leave it off',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 60_000),
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        privateLines: priv,
        consent: consentOf('decline'),
      }),
    );
    const plan = await store.loadLivePlan(CHAT);
    expect((await store.loadCalendarConsent(plan?.id ?? '', 'fam-priya'))?.status).toBe('declined');

    const reopened = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'actually, could it go on our calendar after all',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 120_000),
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        privateLines: priv,
        consent: consentOf('reopen'),
      }),
    );
    expect(reopened).toMatchObject({
      handled: true,
      outcome: 'group_plan_calendar_asked',
      calendar: { status: 'asked' },
    });
    expect(priv.lines.map((line) => line.kind)).toEqual(['calendar_ask', 'calendar_ask']);
    expect(priv.lines.every((line) => line.familyId === 'fam-priya')).toBe(true);
    expect(texts.some((line) => line.kind?.startsWith('calendar'))).toBe(false);
    expect(writer.familyIds).toEqual([]);
  });

  it('a later no removes only the copy Hale wrote and confirms in private', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    const priv = privateSpy();
    const deps = {
      store,
      texts,
      writer,
      privateLines: priv,
      consent: consentOf('ok'),
    };
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
      calendarDeps({ ...deps, reader: readerOf(rsvp('yes')) }),
    );
    await takeGroupPlanRsvpTurn(
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
      calendarDeps({ ...deps, reader: readerOf(rsvp('yes')) }),
    );
    const removed = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'we cannot make it',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 120_000),
      },
      calendarDeps({
        ...deps,
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
        consent: consentOf('not_this'),
      }),
    );
    expect(removed).toMatchObject({
      calendar: { status: 'removed', familyId: 'fam-priya', familyEventId: 'evt-fam-priya' },
    });
    expect(writer.removed).toEqual(['fam-priya']);
    expect(writer.familyIds).toEqual(['fam-priya']);
    expect(priv.lines.map((line) => line.kind)).toEqual([
      'calendar_ask',
      'calendar_written',
      'calendar_removed',
    ]);
    expect(texts.some((line) => line.kind?.startsWith('calendar'))).toBe(false);
    const plan = await store.loadLivePlan(CHAT);
    expect(await store.loadCalendarConsent(plan?.id ?? '', 'fam-priya')).toBeNull();
  });
});

describe('a removal confirmation the model cannot write', () => {
  it('still removes the copy and sends nothing', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    const priv = privateSpy();
    const shared = {
      store,
      texts,
      writer,
      privateLines: priv,
    };
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
      calendarDeps({ ...shared, reader: readerOf(rsvp('yes')), consent: consentOf('not_this') }),
    );
    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'add it',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 60_000),
      },
      calendarDeps({ ...shared, reader: readerOf(rsvp('yes')), consent: consentOf('ok') }),
    );
    const before = priv.lines.length;
    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: 'out',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 120_000),
      },
      calendarDeps({
        ...shared,
        composer: fakeGroupPlanRsvpComposer({ fail: true }),
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
        consent: consentOf('not_this'),
      }),
    );
    expect(writer.removed).toEqual(['fam-priya']);
    expect(priv.lines).toHaveLength(before);
    expect(texts.some((line) => line.kind?.startsWith('calendar'))).toBe(false);
  });
});

describe('another parent in the same household', () => {
  it('does not withdraw the ask when someone else says no', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    const priv = privateSpy();
    const homes = households({ 'u-priya': 'fam-priya', 'u-sam': 'fam-priya' });
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
        privateLines: priv,
        consent: consentOf('not_this'),
      }),
    );
    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: SAM,
        senderName: 'Sam',
        senderUserId: 'u-sam',
        text: 'I cannot',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 60_000),
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('no')),
        writer,
        homes,
        privateLines: priv,
        consent: consentOf('not_this'),
      }),
    );
    const plan = await store.loadLivePlan(CHAT);
    expect((await store.loadCalendarConsent(plan?.id ?? '', 'fam-priya'))?.status).toBe('asked');
    expect(writer.removed).toEqual([]);
    expect(priv.lines.map((line) => line.kind)).toEqual(['calendar_ask']);
  });

  it('ignores a tapback that did not land on the private ask', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    const priv = privateSpy();
    const consent = consentOf('ok');
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
        privateLines: priv,
        consent,
      }),
    );
    const missed = await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        senderName: 'Priya',
        senderUserId: 'u-priya',
        text: '',
        tapback: 'like',
        tapbackMessageId: 'some-other-message',
        language: 'en',
        now: new Date(LATER.getTime() + 60_000),
      },
      calendarDeps({
        store,
        texts,
        reader: readerOf(rsvp('yes')),
        writer,
        privateLines: priv,
        consent,
      }),
    );
    expect(missed.handled && missed.outcome).not.toBe('group_plan_calendar_written');
    expect(writer.familyIds).toEqual([]);
    expect(consent.texts).toEqual([]);
  });

  it('keeps a written entry when a co-parent says no and the other is still a yes', async () => {
    const { store, texts } = await picnic();
    const writer = writerSpy();
    const priv = privateSpy();
    const homes = households({ 'u-priya': 'fam-priya', 'u-sam': 'fam-priya' });
    const shared = {
      store,
      texts,
      writer,
      homes,
      privateLines: priv,
      consent: consentOf('ok'),
    };
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
      calendarDeps({ ...shared, reader: readerOf(rsvp('yes')) }),
    );
    await takeGroupPlanRsvpTurn(
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
      calendarDeps({ ...shared, reader: readerOf(rsvp('yes')) }),
    );
    await takeGroupPlanRsvpTurn(
      {
        chatId: CHAT,
        senderHandle: SAM,
        senderName: 'Sam',
        senderUserId: 'u-sam',
        text: 'I cannot',
        tapback: null,
        language: 'en',
        now: new Date(LATER.getTime() + 120_000),
      },
      calendarDeps({ ...shared, reader: readerOf(rsvp('no')) }),
    );
    const plan = await store.loadLivePlan(CHAT);
    expect((await store.loadCalendarConsent(plan?.id ?? '', 'fam-priya'))?.status).toBe('written');
    expect(writer.familyIds).toEqual(['fam-priya']);
    expect(writer.removed).toEqual([]);
  });
});

describe('the private ask lands after the group line', () => {
  it('sends the household ask only once the group has the tally', async () => {
    const { store, texts } = await picnic();
    const order: string[] = [];
    const priv = privateSpy();
    const deps = calendarDeps({
      store,
      texts,
      reader: readerOf(rsvp('yes', { householdLabel: 'the Patels' })),
      writer: writerSpy(),
      privateLines: priv,
      consent: consentOf('not_this'),
    });
    await takeGroupPlanRsvpTurn(
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
      {
        ...deps,
        send: async (line) => {
          order.push('group');
          return deps.send(line);
        },
        privateSend: {
          async send(line) {
            order.push('private');
            return priv.send(line);
          },
        },
      },
    );
    expect(order).toEqual(['group', 'private']);
    expect(priv.lines.map((line) => line.kind)).toEqual(['calendar_ask']);
    expect(texts.map((line) => line.kind)).toEqual(['plan']);
  });
});

describe('why a calendar ask was set aside', () => {
  it('records that the ask did not send', async () => {
    const { world, store, texts } = await picnic();
    await takeGroupPlanRsvpTurn(
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
      {
        ...calendarDeps({
          store,
          texts,
          reader: readerOf(rsvp('yes')),
          writer: writerSpy(),
          consent: consentOf('not_this'),
        }),
        privateSend: {
          async send() {
            return { status: 'skipped' as const, reason: 'not_sent' as const };
          },
        },
      },
    );
    expect(
      world.audits.filter((row) => row.actionTaken === 'linq_group_plan_calendar_withdrawn'),
    ).toEqual([
      expect.objectContaining({
        after: expect.objectContaining({ reason: 'send_failed' }),
      }),
    ]);
  });

  it('records that the household said no', async () => {
    const { world, store, texts } = await picnic();
    const priv = privateSpy();
    const shared = {
      store,
      texts,
      writer: writerSpy(),
      privateLines: priv,
      homes: households({ 'u-priya': 'fam-priya' }),
      consent: consentOf('not_this'),
    };
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
      calendarDeps({ ...shared, reader: readerOf(rsvp('yes')) }),
    );
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
      calendarDeps({ ...shared, reader: readerOf(rsvp('no')) }),
    );
    expect(
      world.audits.filter((row) => row.actionTaken === 'linq_group_plan_calendar_withdrawn'),
    ).toEqual([
      expect.objectContaining({
        after: expect.objectContaining({ reason: 'household_said_no' }),
      }),
    ]);
  });

  it('records that the plan changed when that is the fact', async () => {
    const { world, store } = await picnic();
    const plan = await store.loadLivePlan(CHAT);
    await store.claimCalendarAsk({
      planId: plan?.id ?? '',
      familyId: 'fam-priya',
      memberKey: 'priya',
      displayName: 'Priya',
      householdLabel: null,
      now: LATER,
    });
    expect(
      await store.releaseCalendarAsk(plan?.id ?? '', 'fam-priya', 'u-priya', 'plan_changed'),
    ).toBe(true);
    expect(world.audits.at(-1)).toMatchObject({
      actionTaken: 'linq_group_plan_calendar_withdrawn',
      after: { reason: 'plan_changed' },
    });
  });
});

describe('calendarConsentUserMessage', () => {
  it('sends facts to the reader and no suggested reply', () => {
    const message = calendarConsentUserMessage({
      text: 'sounds right for us',
      tapback: null,
      senderName: 'Priya',
      consent: 'asked',
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
