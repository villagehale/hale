import { schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { departCoParent } from '~/lib/channel/coparent/depart';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import {
  DROP_SINGLE_OPEN_PLAN_INDEX,
  seedJoinConsent,
  seedTextedHale,
} from '~/lib/testing/group-scenes';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { leaveFamilyFromSharedGroup } from '../multi-family';
import { postgresGroupPlanCalendarWriter } from './calendar';
import { moveGroupPlanCalendarCopies } from './inbound';
import { runGroupPlanMovedNoticeRedrive } from './moved-redrive';
import { createPostgresGroupPlanRsvpStore } from './store';
import { fakeGroupPlanRsvpComposer } from './voice-fake';

/**
 * VIL-689 · a moved plan touches a household's copy only while that household is still in the
 * chat and the copy is still on its calendar, and its notice goes to a parent who is in that
 * household now. Both the lock and the morning re-drive of a held notice hold to this.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const CHAT = 'chat-moved-household';
const NOON = new Date('2026-11-12T17:00:00.000Z');
const MORNING = new Date('2026-11-13T13:15:00.000Z'); // 08:15 Toronto: the re-drive slot
const SAT_11 = new Date('2026-11-14T16:00:00.000Z');
const SAT_13 = new Date('2026-11-14T18:00:00.000Z');
const PHONE_1 = '+15555550141';
const PHONE_2 = '+15555550142';

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
  await db.exec(DROP_SINGLE_OPEN_PLAN_INDEX);
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  vi.stubEnv('LINQ_GROUP_SCENES_ENABLED', 'true');
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_PLAN_RSVP_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_PLAN_CALENDAR_ENABLED', 'true');
});
afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table families, users, linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_group_plans, consent_records, audit_log, channel_messages cascade',
  );
});

async function seedUser(name: string) {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name, timezone: 'America/Toronto' })
    .returning({ id: schema.users.id });
  return user?.id as string;
}

async function seedFamilyRow(name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  return family?.id as string;
}

async function channel(userId: string, familyId: string, phone: string) {
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOON,
  });
}

async function joinChat(familyId: string, userId: string, phone: string) {
  await seedTextedHale(db.database, { familyId, userId, at: new Date(NOON.getTime() - 9e7) });
  await db.database
    .insert(schema.linqMultiFamilyJoins)
    .values({ chatId: CHAT, familyId, joinedByUserId: userId, joinedAt: NOON });
  await db.database.insert(schema.linqMultiFamilyMembers).values({
    chatId: CHAT,
    familyId,
    userId,
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    role: 'parent',
  });
  await seedJoinConsent(db.database, { chatId: CHAT, familyId, userId });
}

/** A plan with one household's written copy, the OK given by `decider`. */
async function writtenCopy(input: {
  hostFamilyId: string;
  copyFamilyId: string;
  hostUserId: string;
  decider: string;
}) {
  const store = createPostgresGroupPlanRsvpStore(db.database);
  const plan = await store.createPlan({
    chatId: CHAT,
    familyId: input.hostFamilyId,
    title: 'picnic',
    startsAt: SAT_11,
    location: null,
    rsvpDeadlineAt: null,
    createdByUserId: input.hostUserId,
    expected: [],
    now: NOON,
  });
  await store.claimCalendarAsk({
    planId: plan.id,
    familyId: input.copyFamilyId,
    memberKey: 'key-decider',
    displayName: 'Decider',
    householdLabel: null,
    now: NOON,
  });
  const written = await postgresGroupPlanCalendarWriter(db.database).write({
    planId: plan.id,
    chatId: CHAT,
    familyId: input.copyFamilyId,
    title: 'picnic',
    startsAt: SAT_11,
    location: null,
  });
  if (written.status === 'failed') throw new Error('seed write failed');
  await store.markCalendarWritten({
    planId: plan.id,
    familyId: input.copyFamilyId,
    familyEventId: written.familyEventId,
    actorUserId: input.decider,
    now: NOON,
  });
  return { plan, store, copyId: written.familyEventId };
}

/** One household, two parents in the chat; the co-parent gave the OK. */
async function coParentHousehold() {
  const familyId = await seedFamilyRow('Household');
  const primary = await seedUser('Pat');
  const coParent = await seedUser('Sam');
  await db.database.insert(schema.familyMembers).values([
    { familyId, userId: primary, role: 'primary_parent' },
    { familyId, userId: coParent, role: 'co_parent' },
  ]);
  await channel(primary, familyId, PHONE_1);
  await channel(coParent, familyId, PHONE_2);
  await joinChat(familyId, primary, PHONE_1);
  await seedTextedHale(db.database, {
    familyId,
    userId: coParent,
    at: new Date(NOON.getTime() - 9e7),
  });
  await db.database.insert(schema.linqMultiFamilyMembers).values({
    chatId: CHAT,
    familyId,
    userId: coParent,
    phoneE164Encrypted: encryptString(PHONE_2),
    phoneE164Hash: phoneBlindIndex(PHONE_2),
    role: 'co_parent',
  });
  const copy = await writtenCopy({
    hostFamilyId: familyId,
    copyFamilyId: familyId,
    hostUserId: primary,
    decider: coParent,
  });
  return { familyId, primary, coParent, ...copy };
}

/** A host household and a guest household in the chat; the guest wrote its copy. */
async function hostAndGuest() {
  const host = await seedFamilyRow('Host');
  const guest = await seedFamilyRow('Guest');
  const hostUser = await seedUser('Hana');
  const guestUser = await seedUser('Gus');
  await db.database.insert(schema.familyMembers).values([
    { familyId: host, userId: hostUser, role: 'primary_parent' },
    { familyId: guest, userId: guestUser, role: 'primary_parent' },
  ]);
  await channel(hostUser, host, PHONE_1);
  await channel(guestUser, guest, PHONE_2);
  await joinChat(host, hostUser, PHONE_1);
  await joinChat(guest, guestUser, PHONE_2);
  const copy = await writtenCopy({
    hostFamilyId: host,
    copyFamilyId: guest,
    hostUserId: hostUser,
    decider: guestUser,
  });
  return { host, guest, hostUser, guestUser, ...copy };
}

function ports(now: Date) {
  const sent: { to: string; body: string }[] = [];
  return {
    sent,
    ports: {
      database: db.database,
      now,
      composer: fakeGroupPlanRsvpComposer(),
      oneToOne: {
        text: async ({ to, body }: { to: string; body: string }) => {
          sent.push({ to, body });
          return { providerMessageId: `dm-${sent.length}`, chatId: `dm-${sent.length}` };
        },
        link: async () => ({ providerMessageId: 'unused' }),
      },
    },
  };
}

async function lock(planId: string, store: ReturnType<typeof createPostgresGroupPlanRsvpStore>, actor: string) {
  const wire = ports(NOON);
  await store.setPlanStart(planId, SAT_13, actor, NOON);
  const effects = await moveGroupPlanCalendarCopies(wire.ports, {
    chatId: CHAT,
    planId,
    actorUserId: actor,
  });
  return { sent: wire.sent, effects };
}

/** A move the night held: the audit debt with no notice sent yet. */
async function heldMove(
  input: { planId: string; familyId: string; copyId: string; actor: string },
  store: ReturnType<typeof createPostgresGroupPlanRsvpStore>,
) {
  await store.setPlanStart(input.planId, SAT_13, input.actor, NOON);
  await db.database
    .update(schema.familyEvents)
    .set({ startsAt: SAT_13 })
    .where(eq(schema.familyEvents.id, input.copyId));
  await store.noteCalendarMoved({
    planId: input.planId,
    familyId: input.familyId,
    familyEventId: input.copyId,
    startsAt: SAT_13,
    actorUserId: input.actor,
  });
}

async function copyStart(id: string) {
  const [row] = await db.database
    .select({ startsAt: schema.familyEvents.startsAt })
    .from(schema.familyEvents)
    .where(eq(schema.familyEvents.id, id));
  return row?.startsAt;
}

async function liveCopies(id: string) {
  return db.database
    .select({ id: schema.familyEvents.id })
    .from(schema.familyEvents)
    .where(and(eq(schema.familyEvents.id, id), isNull(schema.familyEvents.deletedAt)));
}

describe('a moved notice goes to a parent who is in the household now', () => {
  it('positive control: the parent who gave the OK, still in the household, hears it', async () => {
    const h = await coParentHousehold();
    const { sent } = await lock(h.plan.id, h.store, h.primary);
    expect(sent.map((line) => line.to)).toEqual([PHONE_2]);
    expect(await copyStart(h.copyId)).toEqual(SAT_13);
  });

  it('a co-parent who left and enrolled in a household of their own hears nothing of the old one', async () => {
    const h = await coParentHousehold();
    const departed = await departCoParent(db.database, {
      familyId: h.familyId,
      actorUserId: h.coParent,
      now: NOON,
    });
    expect(departed.outcome).toBe('departed');
    const own = await seedFamilyRow('Own');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: own, userId: h.coParent, role: 'primary_parent' });
    await channel(h.coParent, own, PHONE_2);
    const { sent } = await lock(h.plan.id, h.store, h.primary);
    expect(sent.map((line) => line.to)).toEqual([PHONE_1]);
    expect(sent.map((line) => line.to)).not.toContain(PHONE_2);
  });

  it('after a plain departure the parent still in the household hears the move', async () => {
    const h = await coParentHousehold();
    await departCoParent(db.database, {
      familyId: h.familyId,
      actorUserId: h.coParent,
      now: NOON,
    });
    const { sent } = await lock(h.plan.id, h.store, h.primary);
    expect(sent.map((line) => line.to)).toEqual([PHONE_1]);
  });

  it('the morning re-drive of a held notice goes to a current parent too', async () => {
    const h = await coParentHousehold();
    await heldMove(
      { planId: h.plan.id, familyId: h.familyId, copyId: h.copyId, actor: h.primary },
      h.store,
    );
    await departCoParent(db.database, {
      familyId: h.familyId,
      actorUserId: h.coParent,
      now: NOON,
    });
    const own = await seedFamilyRow('Own');
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: own, userId: h.coParent, role: 'primary_parent' });
    await channel(h.coParent, own, PHONE_2);
    const wire = ports(MORNING);
    const run = await runGroupPlanMovedNoticeRedrive(wire.ports);
    expect(run.sent).toBe(1);
    expect(wire.sent.map((line) => line.to)).toEqual([PHONE_1]);
  });
});

describe('a copy the parent took off their calendar stays off', () => {
  it('a lock leaves it deleted and says nothing', async () => {
    const h = await coParentHousehold();
    await db.database
      .update(schema.familyEvents)
      .set({ deletedAt: NOON })
      .where(eq(schema.familyEvents.id, h.copyId));
    const { sent, effects } = await lock(h.plan.id, h.store, h.primary);
    expect(await liveCopies(h.copyId)).toHaveLength(0);
    expect(await copyStart(h.copyId)).toEqual(SAT_11);
    expect(sent).toEqual([]);
    expect(effects).toEqual([{ familyId: h.familyId, status: 'skipped', reason: 'copy_removed' }]);
  });

  it('the morning re-drive sends no notice for a copy removed since the move', async () => {
    const h = await coParentHousehold();
    await heldMove(
      { planId: h.plan.id, familyId: h.familyId, copyId: h.copyId, actor: h.primary },
      h.store,
    );
    await db.database
      .update(schema.familyEvents)
      .set({ deletedAt: NOON })
      .where(eq(schema.familyEvents.id, h.copyId));
    const wire = ports(MORNING);
    const run = await runGroupPlanMovedNoticeRedrive(wire.ports);
    expect(run.sent).toBe(0);
    expect(wire.sent).toEqual([]);
    expect(await liveCopies(h.copyId)).toHaveLength(0);
  });
});

describe('a household that left the shared chat', () => {
  it('positive control: while it is in the chat, its copy moves and it hears it', async () => {
    const f = await hostAndGuest();
    const { sent } = await lock(f.plan.id, f.store, f.hostUser);
    expect(await copyStart(f.copyId)).toEqual(SAT_13);
    expect(sent.map((line) => line.to)).toEqual([PHONE_2]);
  });

  it('after it left and withdrew its consent, a lock neither rewrites its copy nor texts it', async () => {
    const f = await hostAndGuest();
    const left = await leaveFamilyFromSharedGroup(db.database, {
      chatId: CHAT,
      familyId: f.guest,
      userId: f.guestUser,
      verbatim: 'we are out of this group',
      now: NOON,
      send: async () => ({ providerMessageId: 'g-left' }),
    });
    expect(left.outcome).toBe('left');
    const { sent, effects } = await lock(f.plan.id, f.store, f.hostUser);
    expect(await copyStart(f.copyId)).toEqual(SAT_11);
    expect(sent).toEqual([]);
    expect(effects).toEqual([{ familyId: f.guest, status: 'skipped', reason: 'left_chat' }]);
  });

  it('the morning re-drive sends nothing to a household that left after the move', async () => {
    const f = await hostAndGuest();
    await heldMove(
      { planId: f.plan.id, familyId: f.guest, copyId: f.copyId, actor: f.hostUser },
      f.store,
    );
    await leaveFamilyFromSharedGroup(db.database, {
      chatId: CHAT,
      familyId: f.guest,
      userId: f.guestUser,
      verbatim: 'we are out of this group',
      now: NOON,
      send: async () => ({ providerMessageId: 'g-left' }),
    });
    const wire = ports(MORNING);
    const run = await runGroupPlanMovedNoticeRedrive(wire.ports);
    expect(run.sent).toBe(0);
    expect(wire.sent).toEqual([]);
  });

  it('positive control: the re-drive does text a household still in the chat', async () => {
    const f = await hostAndGuest();
    await heldMove(
      { planId: f.plan.id, familyId: f.guest, copyId: f.copyId, actor: f.hostUser },
      f.store,
    );
    const wire = ports(MORNING);
    expect((await runGroupPlanMovedNoticeRedrive(wire.ports)).sent).toBe(1);
    expect(wire.sent.map((line) => line.to)).toEqual([PHONE_2]);
  });
});
