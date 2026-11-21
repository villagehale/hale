import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { seedJoinConsent, seedTextedHale } from '~/lib/testing/group-scenes';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { PlanRef } from '../group-plan-rsvp/plan-identity';
import { createPostgresGroupPlanRsvpStore } from '../group-plan-rsvp/store';
import { considerGroupExperience } from './inbound';
import type { GroupExperienceReading } from './reading';
import { fakeGroupExperienceComposer } from './voice-fake';

/**
 * VIL-689 · a who's-in line collects answers, so the plan that holds them exists before Hale
 * asks. No plan can open: no line. The one-open-plan index stays in place here, as on Prod.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-rsvp-open';
const NOW = new Date('2026-11-12T17:00:00.000Z');
const HALE = '+15555550100';
const PARENT_A = '+15555550161';
const PARENT_B = '+15555550162';
const GUEST = '+15555550169';

let db: TestDb;
beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.stubEnv('LINQ_GROUP_SCENES_ENABLED', 'true');
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', HALE);
  for (const flag of [
    'LINQ_MULTI_FAMILY_GROUPS_ENABLED',
    'LINQ_GROUP_MEMBERS_ENABLED',
    'LINQ_GROUP_PLAN_RSVP_ENABLED',
    'GROUP_POLLS_ENABLED',
  ]) {
    vi.stubEnv(flag, 'true');
  }
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_group_experience, linq_group_plans, consent_records, audit_log, channel_messages cascade',
  );
});

async function seedFamily(phone: string, name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name, timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  await db.database.insert(schema.linqSharedGroupPeople).values({
    chatId: CHAT,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    familyId,
    userId,
    firstName: name,
  });
  await db.database
    .insert(schema.linqMultiFamilyJoins)
    .values({ chatId: CHAT, familyId, joinedByUserId: userId, joinedAt: NOW });
  await db.database.insert(schema.linqMultiFamilyMembers).values({
    chatId: CHAT,
    familyId,
    userId,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    role: 'parent',
  });
  await seedJoinConsent(db.database, { chatId: CHAT, familyId, userId });
  await seedTextedHale(db.database, { familyId, userId, at: new Date(NOW.getTime() - 9e7) });
  return { familyId, userId };
}

const rsvpOpen: GroupExperienceReading = {
  kind: 'rsvp_open',
  title: 'zoo',
  samePlan: null,
  response: null,
  optionKey: null,
  options: [],
  starts: [],
  confidence: 'high',
};

async function ask(input: {
  sender: string;
  senderUserId: string | null;
  senderFamilyId: string | null;
  coveringFamilyId: string;
  messageId: string;
  planRef?: PlanRef;
  send?: (line: { chatId: string; text: string }) => Promise<{ providerMessageId: string }>;
}) {
  const group: string[] = [];
  const out = await considerGroupExperience(
    {
      database: db.database,
      now: NOW,
      reader: { read: async () => rsvpOpen },
      composer: fakeGroupExperienceComposer({
        body: () => 'who is in for the zoo?',
      }),
      listChatHandles: async () => ({
        status: 'ok',
        handles: [HALE, PARENT_A, PARENT_B],
        isGroup: true,
      }),
      send:
        input.send ??
        (async ({ text }) => {
          group.push(text);
          return { providerMessageId: `g-${group.length}` };
        }),
    },
    {
      chatId: CHAT,
      senderHandle: input.sender,
      senderUserId: input.senderUserId,
      senderFamilyId: input.senderFamilyId,
      coveringFamilyId: input.coveringFamilyId,
      text: 'Hale who is in for the zoo Sunday?',
      messageId: input.messageId,
      ...(input.planRef ? { planRef: input.planRef } : {}),
    },
  );
  return { out, group };
}

async function planRows() {
  return db.database
    .select({
      id: schema.linqGroupPlans.id,
      title: schema.linqGroupPlans.title,
      closedAt: schema.linqGroupPlans.closedAt,
    })
    .from(schema.linqGroupPlans)
    .where(eq(schema.linqGroupPlans.chatId, CHAT));
}

describe('a who-is-in line needs a plan to hold the answers', () => {
  it('positive control: a Hale household opens the plan, and the line goes out', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const { out, group } = await ask({
      sender: PARENT_A,
      senderUserId: a.userId,
      senderFamilyId: a.familyId,
      coveringFamilyId: a.familyId,
      messageId: 'm-open-1',
    });
    expect(out).toMatchObject({ handled: true, outcome: 'group_experience_spoken' });
    expect(group).toEqual(['who is in for the zoo?']);
    const plans = await planRows();
    expect(plans.map((plan) => plan.title)).toEqual(['zoo']);
    expect(plans[0]?.closedAt).toBeNull();
  });

  it('a guest with no Hale household asks nobody for answers nothing would record', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const { out, group } = await ask({
      sender: GUEST,
      senderUserId: null,
      senderFamilyId: null,
      coveringFamilyId: a.familyId,
      messageId: 'm-guest-1',
    });
    expect(out).toEqual({ handled: false });
    expect(group).toEqual([]);
    expect(await planRows()).toEqual([]);
  });

  it('while the one-open-plan index refuses a second plan, no collecting line goes out', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    const b = await seedFamily(PARENT_B, 'Bao');
    await createPostgresGroupPlanRsvpStore(db.database).createPlan({
      chatId: CHAT,
      familyId: a.familyId,
      title: 'picnic',
      startsAt: null,
      location: null,
      rsvpDeadlineAt: null,
      createdByUserId: a.userId,
      expected: [],
      now: NOW,
    });
    const { out, group } = await ask({
      sender: PARENT_B,
      senderUserId: b.userId,
      senderFamilyId: b.familyId,
      coveringFamilyId: a.familyId,
      messageId: 'm-second-1',
      planRef: { status: 'other' },
    });
    expect(out).toEqual({ handled: false });
    expect(group).toEqual([]);
    expect((await planRows()).map((plan) => plan.title)).toEqual(['picnic']);
  });

  it('a line that does not land closes the plan it opened, so nothing collects in silence', async () => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const { out } = await ask({
      sender: PARENT_A,
      senderUserId: a.userId,
      senderFamilyId: a.familyId,
      coveringFamilyId: a.familyId,
      messageId: 'm-refused-1',
      send: async () => {
        throw new Error('linq refused');
      },
    });
    expect(out).toMatchObject({ handled: true, outcome: 'group_experience_line_unsent' });
    const plans = await planRows();
    expect(plans).toHaveLength(1);
    expect(plans[0]?.closedAt).toEqual(NOW);
    const audits = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'linq_group_plan_closed'));
    expect(audits.map((row) => row.after)).toEqual([{ reason: 'unsent' }]);
  });

  it.each([
    ['read as another event', { status: 'other' } as PlanRef],
    ['with no plan named', undefined],
  ])('a redelivered message %s opens no second plan and keeps the turn', async (_label, planRef) => {
    const a = await seedFamily(PARENT_A, 'Ada');
    await seedFamily(PARENT_B, 'Bao');
    const once = {
      sender: PARENT_A,
      senderUserId: a.userId,
      senderFamilyId: a.familyId,
      coveringFamilyId: a.familyId,
      messageId: 'm-redelivered-1',
      ...(planRef ? { planRef } : {}),
    };
    const first = await ask(once);
    expect(first.group).toHaveLength(1);
    const second = await ask(once);
    expect(second.group).toEqual([]);
    expect(second.out).toMatchObject({ handled: true, outcome: 'group_experience_line_unsent' });
    const plans = await planRows();
    expect(plans).toHaveLength(1);
    expect(plans[0]?.closedAt).toBeNull();
  });
});
