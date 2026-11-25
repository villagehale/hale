import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { createPostgresGroupPlanRsvpStore } from '../group-plan-rsvp/store';
import { considerGroupExperience } from './inbound';
import { createPostgresGroupExperienceStore } from './store';
import { takeGroupExperienceTurn } from './turn';
import { fakeGroupExperienceComposer } from './voice-fake';

/**
 * A yes or a time lock in a group chat writes no family's calendar. Only a parent's own
 * OK in their 1:1 may put a group plan on that family's calendar, and that flow lives in
 * group-plan-rsvp. Two households share the chat; nothing leaves the process.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-two-family-no-calendar';
const PRIYA_PHONE = '+14375550111';
const SAM_PHONE = '+14375550112';
const NOW = new Date('2026-11-14T15:00:00.000Z');
const PLAN_START = new Date('2026-11-14T16:00:00.000Z');

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
  vi.stubEnv('GROUP_POLLS_ENABLED', 'true');
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

async function twoFamiliesWithAPlan() {
  const priya = await parent({ name: 'Priya', phone: PRIYA_PHONE, chat: CHAT });
  const sam = await parent({ name: 'Sam', phone: SAM_PHONE });
  await seat({ familyId: sam.familyId, userId: sam.userId, phone: SAM_PHONE });
  const plans = createPostgresGroupPlanRsvpStore(db.database);
  const plan = await plans.createPlan({
    chatId: CHAT,
    familyId: priya.familyId,
    title: 'Saturday picnic',
    startsAt: PLAN_START,
    location: 'the park',
    rsvpDeadlineAt: null,
    createdByUserId: priya.userId,
    expected: [],
    now: NOW,
  });
  return { priya, sam, plans, plan };
}

async function familyEvents() {
  return db.database
    .select({ familyId: schema.familyEvents.familyId })
    .from(schema.familyEvents);
}

describe('a group chat never writes a family calendar on its own', () => {
  it('a yes that completes the tally writes no family_events row for either family', async () => {
    const { priya, sam } = await twoFamiliesWithAPlan();
    const group: string[] = [];
    const sayYes = (userId: string, phone: string, at: Date) =>
      considerGroupExperience(
        {
          database: db.database,
          now: at,
          send: async ({ text }) => {
            group.push(text);
            return { providerMessageId: `group-${group.length}` };
          },
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
        },
        {
          chatId: CHAT,
          senderHandle: phone,
          senderUserId: userId,
          coveringFamilyId: priya.familyId,
          text: 'we are in',
        },
      );

    const priyaYes = await sayYes(priya.userId, PRIYA_PHONE, NOW);
    const samYes = await sayYes(sam.userId, SAM_PHONE, new Date(NOW.getTime() + 60_000));

    // Positive control: the door read both yeses and spoke the tally in the group.
    expect(priyaYes).toMatchObject({ handled: true, outcome: 'group_experience_spoken' });
    expect(samYes).toMatchObject({ handled: true, outcome: 'group_experience_spoken' });
    expect(group).toEqual(['rsvp_tally.', 'rsvp_tally.']);
    expect(await familyEvents()).toEqual([]);
  });

  it('a locked time writes no family_events row for the families that said yes', async () => {
    const { priya, sam, plans, plan } = await twoFamiliesWithAPlan();
    for (const [person, phone] of [
      [priya, PRIYA_PHONE],
      [sam, SAM_PHONE],
    ] as const) {
      await plans.upsertRsvp({
        planId: plan.id,
        memberKey: phone,
        displayName: person === priya ? 'Priya' : 'Sam',
        householdLabel: null,
        userId: person.userId,
        haleCustomer: true,
        response: 'yes',
        headcount: 1,
        source: 'text',
        coversKeys: [],
        verbatim: 'we are in',
        now: NOW,
      });
    }
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
      },
    );

    // Positive control: the lock ran and moved the plan to the winning time.
    expect(lock).toMatchObject({ handled: true, outcome: 'group_experience_spoken' });
    const [stored] = await db.database
      .select({ startsAt: schema.linqGroupPlans.startsAt })
      .from(schema.linqGroupPlans)
      .where(eq(schema.linqGroupPlans.id, plan.id));
    expect(stored?.startsAt).toEqual(locked);
    expect(await familyEvents()).toEqual([]);
  });
});
