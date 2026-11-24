import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { loadIcsFeed, mintIcsToken } from '~/lib/loop/ics-feed';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  considerCalendarTapback,
  considerPrivateCalendarReply,
  settleCalendarsAfterLockedStart,
  settleGroupExperienceCalendar,
} from '../group-plan-rsvp/inbound';
import { createPostgresGroupPlanRsvpStore } from '../group-plan-rsvp/store';
import { fakeGroupPlanRsvpComposer } from '../group-plan-rsvp/voice-fake';
import { considerGroupExperience } from './inbound';
import { createPostgresGroupExperienceStore } from './store';
import { takeGroupExperienceTurn } from './turn';
import { fakeGroupExperienceComposer } from './voice-fake';

/**
 * Two households in one group. No SMS leaves the process: the 1:1 and group
 * sends are captured here. One household agrees to the calendar write. The
 * other says yes to the plan and does not agree. Only the agreeing household
 * gets a family_events row and an ICS feed entry.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-two-family-calendar';
const PRIYA_PHONE = '+14375550111';
const SAM_PHONE = '+14375550112';
const NOW = new Date('2026-11-14T15:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

async function parent(input: { name: string; phone: string; chat?: string }) {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: input.name,
      provinceOrState: 'ON',
      primaryLanguage: 'en',
      ...(input.chat ? { linqGroupChatId: input.chat } : {}),
    })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: `imessage:${input.phone}`,
      name: input.name,
      timezone: 'America/Toronto',
    })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId,
    role: 'primary_parent',
  });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(input.phone),
    phoneE164Hash: phoneBlindIndex(input.phone),
    verifiedAt: NOW,
  });
  return { familyId, userId };
}

async function seat(input: { familyId: string; userId: string; phone: string }) {
  const [consent] = await db.database
    .insert(schema.consentRecords)
    .values({
      userId: input.userId,
      familyId: input.familyId,
      consentType: 'multi_family_group',
      granted: true,
      consentScope: CHAT,
      policyVersion: 'test',
    })
    .returning({ id: schema.consentRecords.id });
  await db.database.insert(schema.linqMultiFamilyJoins).values({
    chatId: CHAT,
    familyId: input.familyId,
    joinedByUserId: input.userId,
    consentRecordId: consent?.id,
    joinedAt: NOW,
  });
  await db.database.insert(schema.linqMultiFamilyMembers).values({
    chatId: CHAT,
    familyId: input.familyId,
    userId: input.userId,
    phoneE164Encrypted: encryptString(input.phone),
    phoneE164Hash: phoneBlindIndex(input.phone),
    role: 'parent',
    seatedAt: NOW,
  });
}

describe('a yes writes one calendar event, and only after that household agrees', () => {
  it('with the flag on, in production, only the consenting family gets the event', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('GROUP_POLLS_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED', 'true');

    const priya = await parent({ name: 'Priya', phone: PRIYA_PHONE, chat: CHAT });
    const sam = await parent({ name: 'Sam', phone: SAM_PHONE });
    await seat({ familyId: sam.familyId, userId: sam.userId, phone: SAM_PHONE });
    const priyaFeed = await mintIcsToken(db.database, priya.familyId, 'feed_subscription');
    const samFeed = await mintIcsToken(db.database, sam.familyId, 'feed_subscription');

    const store = createPostgresGroupPlanRsvpStore(db.database);
    await store.createPlan({
      chatId: CHAT,
      familyId: priya.familyId,
      title: 'Saturday picnic',
      startsAt: new Date('2026-11-14T16:00:00.000Z'),
      location: 'the park',
      rsvpDeadlineAt: null,
      createdByUserId: priya.userId,
      expected: [],
      now: NOW,
    });

    const group: string[] = [];
    const privateLines: { to: string; body: string }[] = [];
    let n = 0;
    const oneToOne = {
      text: async (input: { to: string; body: string }) => {
        privateLines.push({ to: input.to, body: input.body });
        n += 1;
        return { providerMessageId: `priv-${n}`, chatId: null };
      },
      link: async () => ({ providerMessageId: 'link' }),
    };
    const calendarVoice = fakeGroupPlanRsvpComposer();

    async function sayYes(input: { name: string; phone: string; userId: string; at: Date }) {
      return considerGroupExperience(
        {
          database: db.database,
          now: input.at,
          send: async ({ text }) => {
            group.push(text);
            return { providerMessageId: `group-${group.length}` };
          },
          reader: {
            read: async () => ({
              kind: 'rsvp_vote',
              title: null,
              response: 'yes',
              optionKey: null,
              options: [],
              confidence: 'high',
            }),
          },
          composer: fakeGroupExperienceComposer(),
          calendarAfterAnswer: (answer) =>
            settleGroupExperienceCalendar(
              {
                database: db.database,
                now: answer.now,
                composer: calendarVoice,
                oneToOne,
              },
              answer,
            ),
        },
        {
          chatId: CHAT,
          senderHandle: input.phone,
          senderUserId: input.userId,
          coveringFamilyId: priya.familyId,
          text: 'we are in',
        },
      );
    }

    const priyaYes = await sayYes({
      name: 'Priya',
      phone: PRIYA_PHONE,
      userId: priya.userId,
      at: NOW,
    });
    const samYes = await sayYes({
      name: 'Sam',
      phone: SAM_PHONE,
      userId: sam.userId,
      at: new Date(NOW.getTime() + 60_000),
    });
    expect(priyaYes.handled).toBe(true);
    expect(samYes.handled).toBe(true);

    const beforeConsent = await db.database
      .select({ familyId: schema.familyEvents.familyId, title: schema.familyEvents.title })
      .from(schema.familyEvents);
    expect(beforeConsent).toEqual([]);

    const agreed = await considerPrivateCalendarReply(
      {
        database: db.database,
        now: new Date(NOW.getTime() + 120_000),
        composer: calendarVoice,
        consentReader: { read: async () => ({ decision: 'ok', confidence: 'high' }) },
        oneToOne,
      },
      {
        senderUserId: priya.userId,
        senderName: 'Priya',
        chatId: 'priya-1to1',
        text: 'yes put it on our calendar',
      },
    );
    expect(agreed.handled).toBe(true);

    const events = await db.database
      .select({
        familyId: schema.familyEvents.familyId,
        title: schema.familyEvents.title,
        source: schema.familyEvents.source,
        deletedAt: schema.familyEvents.deletedAt,
      })
      .from(schema.familyEvents);
    expect(events).toEqual([
      {
        familyId: priya.familyId,
        title: 'Saturday picnic',
        source: 'placement',
        deletedAt: null,
      },
    ]);

    const priyaIcs = await loadIcsFeed(db.database, priyaFeed.token, NOW);
    const samIcs = await loadIcsFeed(db.database, samFeed.token, NOW);
    expect(priyaIcs).toContain('Saturday picnic');
    expect(samIcs ?? '').not.toContain('Saturday picnic');

    expect(group).toEqual(['rsvp_tally.', 'rsvp_tally.']);
    expect(privateLines).toEqual([
      {
        to: PRIYA_PHONE,
        body: 'calendar_ask Saturday picnic Priya Sat, Nov 14 at 11:00 AM?',
      },
      {
        to: SAM_PHONE,
        body: 'calendar_ask Saturday picnic Sam Sat, Nov 14 at 11:00 AM?',
      },
      {
        to: PRIYA_PHONE,
        body: 'calendar_written Saturday picnic Priya Sat, Nov 14 at 11:00 AM.',
      },
    ]);
  });

  it('with the flag off, a completing yes writes no family_events row for either family', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('GROUP_POLLS_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED', '');
    const priya = await parent({ name: 'Priya', phone: PRIYA_PHONE, chat: CHAT });
    const sam = await parent({ name: 'Sam', phone: SAM_PHONE });
    await seat({ familyId: sam.familyId, userId: sam.userId, phone: SAM_PHONE });
    const store = createPostgresGroupPlanRsvpStore(db.database);
    await store.createPlan({
      chatId: CHAT,
      familyId: priya.familyId,
      title: 'Saturday picnic',
      startsAt: new Date('2026-11-14T16:00:00.000Z'),
      location: 'the park',
      rsvpDeadlineAt: null,
      createdByUserId: priya.userId,
      expected: [],
      now: NOW,
    });
    const asked: string[] = [];
    const sayYes = (userId: string, phone: string, at: Date) =>
      considerGroupExperience(
        {
          database: db.database,
          now: at,
          send: async () => ({ providerMessageId: 'group-1' }),
          reader: {
            read: async () => ({
              kind: 'rsvp_vote' as const,
              title: null,
              response: 'yes' as const,
              optionKey: null,
              options: [],
              confidence: 'high' as const,
            }),
          },
          composer: fakeGroupExperienceComposer(),
          calendarAfterAnswer: async (answer) => {
            asked.push(answer.response);
          },
        },
        {
          chatId: CHAT,
          senderHandle: phone,
          senderUserId: userId,
          coveringFamilyId: priya.familyId,
          text: 'we are in',
        },
      );
    expect(
      (await sayYes(priya.userId, PRIYA_PHONE, NOW)).handled &&
        (await sayYes(sam.userId, SAM_PHONE, new Date(NOW.getTime() + 60_000))).handled,
    ).toBe(true);
    expect(asked).toEqual([]);
    expect(
      await db.database.select({ id: schema.familyEvents.id }).from(schema.familyEvents),
    ).toEqual([]);
  });

  it('a locked new start moves an accepted copy and a tap on the old ask writes nothing', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('GROUP_POLLS_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
    vi.stubEnv('LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED', 'true');
    const priya = await parent({ name: 'Priya', phone: PRIYA_PHONE, chat: CHAT });
    const sam = await parent({ name: 'Sam', phone: SAM_PHONE });
    await seat({ familyId: sam.familyId, userId: sam.userId, phone: SAM_PHONE });
    const plans = createPostgresGroupPlanRsvpStore(db.database);
    const plan = await plans.createPlan({
      chatId: CHAT,
      familyId: priya.familyId,
      title: 'Saturday picnic',
      startsAt: new Date('2026-11-14T16:00:00.000Z'),
      location: 'the park',
      rsvpDeadlineAt: null,
      createdByUserId: priya.userId,
      expected: [],
      now: NOW,
    });
    const privateLines: { to: string; body: string; id: string }[] = [];
    let n = 0;
    const oneToOne = {
      text: async (input: { to: string; body: string }) => {
        n += 1;
        const id = `priv-${n}`;
        privateLines.push({ to: input.to, body: input.body, id });
        return { providerMessageId: id, chatId: null };
      },
      link: async () => ({ providerMessageId: 'link' }),
    };
    const calendarVoice = fakeGroupPlanRsvpComposer();
    const settle = {
      database: db.database,
      now: NOW,
      composer: calendarVoice,
      oneToOne,
    };
    const sayYes = (userId: string, phone: string, at: Date) =>
      considerGroupExperience(
        {
          ...settle,
          now: at,
          send: async () => ({ providerMessageId: `group-${n}` }),
          reader: {
            read: async () => ({
              kind: 'rsvp_vote' as const,
              title: null,
              response: 'yes' as const,
              optionKey: null,
              options: [],
              confidence: 'high' as const,
            }),
          },
          composer: fakeGroupExperienceComposer(),
          calendarAfterAnswer: (answer) =>
            settleGroupExperienceCalendar({ ...settle, now: answer.now }, answer),
        },
        {
          chatId: CHAT,
          senderHandle: phone,
          senderUserId: userId,
          coveringFamilyId: priya.familyId,
          text: 'we are in',
        },
      );
    await sayYes(priya.userId, PRIYA_PHONE, NOW);
    await sayYes(sam.userId, SAM_PHONE, new Date(NOW.getTime() + 60_000));
    const agreed = await considerPrivateCalendarReply(
      {
        ...settle,
        now: new Date(NOW.getTime() + 120_000),
        consentReader: { read: async () => ({ decision: 'ok', confidence: 'high' }) },
      },
      {
        senderUserId: priya.userId,
        senderName: 'Priya',
        chatId: 'priya-1to1',
        text: 'yes put it on our calendar',
      },
    );
    expect(agreed.handled).toBe(true);
    const samAsk = privateLines.find((line) => line.to === SAM_PHONE);
    expect(samAsk?.body.startsWith('calendar_ask')).toBe(true);

    const locked = new Date('2026-11-30T17:00:00.000Z');
    const experience = createPostgresGroupExperienceStore(db.database);
    await experience.upsertLive({
      chatId: CHAT,
      familyId: priya.familyId,
      kind: 'time_poll',
      subjectKey: plan.id,
      payload: {
        planId: plan.id,
        options: [{ key: 'a', text: locked.toISOString() }],
        votes: { [PRIYA_PHONE]: 'a', [SAM_PHONE]: 'a' },
      },
      now: new Date(NOW.getTime() + 180_000),
    });
    const lock = await takeGroupExperienceTurn(
      {
        chatId: CHAT,
        familyId: priya.familyId,
        senderHandle: PRIYA_PHONE,
        senderUserId: priya.userId,
        senderName: 'Priya',
        senderFamilyId: priya.familyId,
        text: 'lock it',
        language: 'en',
        now: new Date(NOW.getTime() + 180_000),
      },
      {
        database: db.database,
        store: experience,
        plans,
        reader: {
          read: async () => ({
            kind: 'time_lock',
            title: null,
            response: null,
            optionKey: null,
            options: [],
            confidence: 'high',
          }),
        },
        composer: fakeGroupExperienceComposer(),
        send: async () => ({ providerMessageId: 'lock-line' }),
        households: async () => [priya.familyId, sam.familyId],
        calendarAfterStartChange: (change) =>
          settleCalendarsAfterLockedStart({ ...settle, now: change.now }, change),
      },
    );
    expect(lock).toMatchObject({ handled: true, outcome: 'group_experience_spoken' });

    const oldTap = await considerCalendarTapback(
      { ...settle, now: new Date(NOW.getTime() + 240_000) },
      {
        senderUserId: sam.userId,
        senderName: 'Sam',
        messageId: samAsk?.id ?? '',
        tapback: 'like',
      },
    );
    expect(oldTap.handled).toBe(false);

    const events = await db.database
      .select({
        familyId: schema.familyEvents.familyId,
        startsAt: schema.familyEvents.startsAt,
      })
      .from(schema.familyEvents);
    expect(events).toEqual([{ familyId: priya.familyId, startsAt: locked }]);
    expect(privateLines.filter((line) => line.to === SAM_PHONE).map((line) => line.body)).toEqual([
      'calendar_ask Saturday picnic Sam Sat, Nov 14 at 11:00 AM?',
      'calendar_ask Saturday picnic Sam Mon, Nov 30 at 12:00 PM?',
    ]);
  });
});
