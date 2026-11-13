import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { postgresGroupPlanCalendarWriter } from './calendar';
import { runGroupPlanMovedNoticeRedrive } from './moved-redrive';
import { createPostgresGroupPlanRsvpStore } from './store';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

/**
 * VIL-689 · a moved calendar copy owes its household one notice, by day. A move at night
 * holds the notice; the morning re-drive (the shared redrive slot) sends it once.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-moved-redrive';
const NIGHT = new Date('2026-11-13T03:00:00.000Z'); // 22:00 Toronto
const MORNING = new Date('2026-11-13T13:15:00.000Z'); // 08:15 Toronto
const NOON = new Date('2026-11-13T17:00:00.000Z'); // 12:00 Toronto
const PARENT = '+15555550111';
const SUNDAY_14 = new Date('2026-11-15T14:00:00-05:00');

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
  vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_PLAN_RSVP_CALENDAR_ENABLED', 'true');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_group_plans, audit_log, channel_messages cascade',
  );
});

async function movedAtNight() {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ada', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'imessage:ada', name: 'Ada', timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: 'primary_parent' });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT),
    phoneE164Hash: phoneBlindIndex(PARENT),
    verifiedAt: NIGHT,
  });
  const store = createPostgresGroupPlanRsvpStore(db.database);
  const plan = await store.createPlan({
    chatId: CHAT,
    familyId,
    title: 'picnic',
    startsAt: SUNDAY_14,
    location: null,
    rsvpDeadlineAt: null,
    createdByUserId: userId,
    expected: [],
    now: NIGHT,
  });
  const written = await postgresGroupPlanCalendarWriter(db.database).write({
    planId: plan.id,
    chatId: CHAT,
    familyId,
    title: 'picnic',
    startsAt: SUNDAY_14,
    location: null,
  });
  if (written.status === 'failed') throw new Error('seed write failed');
  await store.claimCalendarAsk({
    planId: plan.id,
    familyId,
    memberKey: 'key-ada',
    displayName: 'Ada',
    householdLabel: null,
    now: NIGHT,
  });
  await store.markCalendarWritten({
    planId: plan.id,
    familyId,
    familyEventId: written.familyEventId,
    actorUserId: userId,
    now: NIGHT,
  });
  await store.noteCalendarMoved({
    planId: plan.id,
    familyId,
    familyEventId: written.familyEventId,
    startsAt: SUNDAY_14,
    actorUserId: userId,
  });
  return { familyId, plan };
}

function ports(now: Date) {
  const texted: { to: string; body: string }[] = [];
  return {
    texted,
    ports: {
      database: db.database,
      now,
      composer: fakeGroupPlanRsvpComposer(),
      oneToOne: {
        text: async ({ to, body }: { to: string; body: string }) => {
          texted.push({ to, body });
          return { providerMessageId: `dm-${texted.length}`, chatId: `dm-${texted.length}` };
        },
        link: async () => ({ providerMessageId: 'unused' }),
      },
    },
  };
}

describe('runGroupPlanMovedNoticeRedrive', () => {
  it('sends a held moved notice once, in the morning slot', async () => {
    await movedAtNight();
    const early = ports(NIGHT);
    expect((await runGroupPlanMovedNoticeRedrive(early.ports)).sent).toBe(0);
    expect(early.texted).toEqual([]);

    const morning = ports(MORNING);
    const first = await runGroupPlanMovedNoticeRedrive(morning.ports);
    expect(first.sent).toBe(1);
    expect(morning.texted.map((line) => line.to)).toEqual([PARENT]);
    expect(morning.texted[0]?.body).toContain('calendar_moved');

    const again = ports(MORNING);
    expect((await runGroupPlanMovedNoticeRedrive(again.ports)).sent).toBe(0);
    expect(again.texted).toEqual([]);
  });

  it('owes nothing once the plan has closed', async () => {
    const { plan } = await movedAtNight();
    await db.database
      .update(schema.linqGroupPlans)
      .set({ closedAt: NIGHT })
      .where(eq(schema.linqGroupPlans.id, plan.id));
    const morning = ports(MORNING);
    expect((await runGroupPlanMovedNoticeRedrive(morning.ports)).sent).toBe(0);
    expect(morning.texted).toEqual([]);
  });

  it('outside the slot it waits (a daytime move already sent its own notice)', async () => {
    await movedAtNight();
    const noon = ports(NOON);
    expect((await runGroupPlanMovedNoticeRedrive(noon.ports)).sent).toBe(0);
  });
});
