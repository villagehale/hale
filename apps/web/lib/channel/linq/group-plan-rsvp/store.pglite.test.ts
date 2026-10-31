import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { memberKeyFromHandle } from './member-key';
import { createPostgresGroupPlanRsvpStore } from './store';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT = '+14165550111';
const CHAT = 'chat-pglite-plan';
const NOW = new Date('2026-10-28T16:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

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

async function seedFamily() {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Patel',
      provinceOrState: 'ON',
      linqGroupChatId: CHAT,
    })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({
      externalAuthId: 'imessage:Priya',
      name: 'Priya Patel',
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
    phoneE164Encrypted: encryptString(PARENT),
    phoneE164Hash: phoneBlindIndex(PARENT),
    verifiedAt: NOW,
  });
  await db.database.insert(schema.linqGroupMembers).values({
    familyId,
    chatId: CHAT,
    userId,
    phoneE164Encrypted: encryptString(PARENT),
    phoneE164Hash: phoneBlindIndex(PARENT),
    role: 'parent',
    seatedAt: NOW,
  });
  return { familyId, userId };
}

describe('postgres group plan rsvp store', () => {
  it('creates a plan, upserts an edit, and claims a follow-up once', async () => {
    const { familyId, userId } = await seedFamily();
    const store = createPostgresGroupPlanRsvpStore(db.database);
    const cover = await store.coveringFamily(CHAT);
    expect(cover?.familyId).toBe(familyId);

    const seated = await store.seatedExpected(CHAT);
    expect(seated).toHaveLength(1);
    expect(seated[0]?.haleCustomer).toBe(true);

    const plan = await store.createPlan({
      chatId: CHAT,
      familyId,
      title: 'Saturday picnic',
      startsAt: new Date('2026-11-01T16:00:00.000Z'),
      location: 'the park',
      rsvpDeadlineAt: new Date('2026-10-31T16:00:00.000Z'),
      createdByUserId: userId,
      expected: seated,
      now: NOW,
    });

    const key = memberKeyFromHandle(PARENT) as string;
    await store.upsertRsvp({
      planId: plan.id,
      memberKey: key,
      displayName: 'Priya',
      householdLabel: null,
      userId,
      haleCustomer: true,
      response: 'yes',
      headcount: 4,
      source: 'text',
      coversKeys: [],
      verbatim: 'we are in',
      now: NOW,
    });
    const first = await store.loadTally(plan.id);
    expect(first.tally.yesHeads).toBe(4);

    const edited = await store.upsertRsvp({
      planId: plan.id,
      memberKey: key,
      displayName: 'Priya',
      householdLabel: null,
      userId,
      haleCustomer: true,
      response: 'yes',
      headcount: 1,
      source: 'text',
      coversKeys: [],
      verbatim: 'actually just me',
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(edited.edited).toBe(true);
    const after = await store.loadTally(plan.id);
    expect(after.tally.yesHeads).toBe(1);
    expect(after.tally.yesCount).toBe(1);

    const claimed = await store.claimFollowup(plan.id, 1, NOW);
    expect(claimed).toBe(true);
    expect(await store.claimFollowup(plan.id, 1, NOW)).toBe(false);
    await store.markFollowupSent(plan.id, 1, NOW);
    expect(await store.claimFollowup(plan.id, 1, NOW)).toBe(false);

    const audits = await db.database
      .select({ action: schema.auditLog.actionTaken })
      .from(schema.auditLog);
    expect(audits.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'linq_group_plan_started',
        'linq_group_plan_rsvp_recorded',
        'linq_group_plan_rsvp_edited',
      ]),
    );
  });
});
