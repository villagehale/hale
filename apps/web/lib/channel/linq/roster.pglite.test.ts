import { createHmac } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { linqGroupOnboardingV2Enabled } from './config';
import { fakeGroupOnboardingComposer } from './group-onboarding-voice-fake';
import { handleLinqInboundRequest } from './inbound';
import {
  type ListChatHandles,
  attachRosterToFamily,
  ejectHouseholdGroup,
  ensureRoster,
  startGroupRoster,
} from './roster';
import type { RosterReading } from './roster-reading';

/**
 * Group onboarding v2, PR A: the roster ledger. Hale is added to a family's existing
 * group, reads who is in it, and records what it found. Nobody is seated and nothing is
 * sent from here — every step is a named outcome.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const HALE = '+14165550100';
const PARENT = '+14165550111';
const COPARENT = '+14165550112';
const NANNY = '+14165550113';
const OTHER_PARENT = '+14165550121';
const UNKNOWN_A = '+14165550131';
const UNKNOWN_B = '+14165550132';
const NOW = new Date('2026-10-06T18:00:00.000Z');
const CHAT = 'chat-family-group';

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
  vi.stubEnv('LINQ_FROM_E164', HALE);
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

function handlesOk(handles: string[], isGroup: boolean | null = true) {
  const calls: string[] = [];
  const list: ListChatHandles = async ({ chatId }) => {
    calls.push(chatId);
    return { status: 'ok', handles, isGroup };
  };
  return { list, calls };
}

async function seedHousehold(
  phone: string,
  name: string,
  options: { linqGroupChatId?: string | null; database?: TestDb['database'] } = {},
) {
  const database = options.database ?? db.database;
  const [family] = await database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON', linqGroupChatId: options.linqGroupChatId })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const userId = await seedPerson(familyId, phone, name, 'primary_parent', database);
  return { familyId, userId };
}

async function seedPerson(
  familyId: string,
  phone: string,
  name: string,
  role: 'primary_parent' | 'co_parent' | 'nanny',
  database: TestDb['database'] = db.database,
) {
  const [user] = await database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${name}`, name })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await database.insert(schema.familyMembers).values({ familyId, userId, role });
  await database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  return userId;
}

async function rosters() {
  return db.database.select().from(schema.linqGroupRosters);
}

async function membersOf(chatId: string) {
  const rows = await db.database
    .select()
    .from(schema.linqGroupRosterMembers)
    .where(eq(schema.linqGroupRosterMembers.chatId, chatId));
  return new Map(rows.map((row) => [row.phoneE164Hash, row]));
}

async function chatOf(familyId: string) {
  const [row] = await db.database
    .select({ chatId: schema.families.linqGroupChatId })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return row?.chatId ?? null;
}

async function auditVerbs(familyId: string) {
  const rows = await db.database
    .select({ actionTaken: schema.auditLog.actionTaken, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
  return rows;
}

async function nothingSentOrSeated() {
  expect(await db.database.select().from(schema.channelMessages)).toEqual([]);
  expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
  expect(await db.database.select().from(schema.consentRecords)).toEqual([]);
}

describe('LINQ_GROUP_ONBOARDING_V2_ENABLED', () => {
  it('is on only when the flag is exactly true after trimming', () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    expect(linqGroupOnboardingV2Enabled()).toBe(true);
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true\n');
    expect(linqGroupOnboardingV2Enabled()).toBe(true);
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'on');
    expect(linqGroupOnboardingV2Enabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'false');
    expect(linqGroupOnboardingV2Enabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', '');
    expect(linqGroupOnboardingV2Enabled()).toBe(false);
    vi.unstubAllEnvs();
    expect(linqGroupOnboardingV2Enabled()).toBe(false);
  });
});

describe('startGroupRoster', () => {
  it('is flag_off when dark, and reads nothing', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'on');
    await seedHousehold(PARENT, 'Parent');
    const { list, calls } = handlesOk([PARENT, UNKNOWN_A]);

    expect(
      await startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: list,
      }),
    ).toEqual({ outcome: 'flag_off' });
    expect(calls).toEqual([]);
    expect(await rosters()).toEqual([]);
  });

  it('matches one family: known parent marked, everyone else proposed, chat claimed, nobody seated', async () => {
    const { familyId, userId } = await seedHousehold(PARENT, 'Parent');
    await seedPerson(familyId, NANNY, 'Nanny', 'nanny');
    const { list, calls } = handlesOk([PARENT, UNKNOWN_A, UNKNOWN_B, NANNY]);

    const result = await startGroupRoster(db.database, {
      chatId: CHAT,
      source: 'added_to_existing',
      now: NOW,
      listHandles: list,
    });

    expect(result).toEqual({
      outcome: 'roster_matched',
      status: 'roles_proposed',
      familyId,
      knownParents: 1,
      confirmed: 0,
      proposed: 3,
      skippedHandles: 0,
    });
    expect(calls).toEqual([CHAT]);

    const [roster] = await rosters();
    expect(roster).toMatchObject({
      chatId: CHAT,
      familyId,
      source: 'added_to_existing',
      status: 'roles_proposed',
      memberCount: 4,
      rosterFetchedAt: NOW,
    });

    const members = await membersOf(CHAT);
    expect(members.size).toBe(4);
    expect(members.get(phoneBlindIndex(PARENT))).toMatchObject({
      status: 'known_parent',
      knownUserId: userId,
      userId: null,
    });
    for (const phone of [UNKNOWN_A, UNKNOWN_B, NANNY]) {
      expect(members.get(phoneBlindIndex(phone))).toMatchObject({
        status: 'proposed',
        proposedRole: 'unknown',
        knownUserId: null,
        userId: null,
        confirmedRole: null,
        connectStep: 'none',
      });
    }
    for (const row of members.values()) {
      expect(row.phoneE164Encrypted).not.toContain('555');
      expect(row.rosterId).toBe(roster?.id);
    }

    expect(await chatOf(familyId)).toBe(CHAT);
    const audits = await auditVerbs(familyId);
    expect(audits.map((row) => row.actionTaken).sort()).toEqual([
      'linq_group_claimed',
      'linq_group_roster_fetched',
    ]);
    const fetched = audits.find((row) => row.actionTaken === 'linq_group_roster_fetched');
    expect(fetched?.after).toEqual({
      status: 'roles_proposed',
      source: 'added_to_existing',
      memberCount: 4,
      knownParents: 1,
      confirmed: 0,
      proposed: 3,
      skippedHandles: 0,
    });
    expect(JSON.stringify(audits)).not.toContain('555');
    await nothingSentOrSeated();
  });

  it('matches no family: no_family roster that belongs to nobody, and no claim', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    const { list } = handlesOk([UNKNOWN_A, UNKNOWN_B]);

    expect(
      await startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: list,
      }),
    ).toEqual({ outcome: 'roster_no_family', skippedHandles: 0 });

    const [roster] = await rosters();
    expect(roster).toMatchObject({ status: 'no_family', familyId: null, memberCount: 2 });
    const members = await membersOf(CHAT);
    expect([...members.values()].map((row) => row.status)).toEqual(['proposed', 'proposed']);
    expect(await chatOf(familyId)).toBeNull();
    expect(await auditVerbs(familyId)).toEqual([]);
    await nothingSentOrSeated();
  });

  it('matches two families: mixed_family, silent, neither family claims the chat', async () => {
    const one = await seedHousehold(PARENT, 'Parent');
    const two = await seedHousehold(OTHER_PARENT, 'Other');
    const { list } = handlesOk([PARENT, OTHER_PARENT, UNKNOWN_A]);

    expect(
      await startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: list,
      }),
    ).toEqual({ outcome: 'roster_mixed_family', skippedHandles: 0 });

    const [roster] = await rosters();
    expect(roster).toMatchObject({ status: 'mixed_family', familyId: null });
    expect(await chatOf(one.familyId)).toBeNull();
    expect(await chatOf(two.familyId)).toBeNull();
    for (const family of [one, two]) {
      const audits = await auditVerbs(family.familyId);
      expect(audits).toEqual([
        {
          actionTaken: 'linq_group_roster_fetched',
          after: expect.objectContaining({ status: 'mixed_family' }),
        },
      ]);
    }
    await nothingSentOrSeated();
  });

  it('holds a failed GET as roster_pending, then the next call fetches into the same roster', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    const down: ListChatHandles = async () => ({ status: 'unreachable', reason: 'timeout' });

    expect(
      await startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: down,
      }),
    ).toEqual({ outcome: 'roster_fetch_failed', reason: 'unreachable' });
    const [pending] = await rosters();
    expect(pending).toMatchObject({ status: 'roster_pending', memberCount: null, familyId: null });
    expect((await membersOf(CHAT)).size).toBe(0);

    const refused: ListChatHandles = async () => ({
      status: 'refused',
      code: '2001',
      httpStatus: 404,
      permanent: true,
    });
    expect(
      await ensureRoster(db.database, { chatId: CHAT, now: NOW, listHandles: refused }),
    ).toEqual({ outcome: 'roster_fetch_failed', reason: 'refused' });

    const { list } = handlesOk([PARENT, UNKNOWN_A]);
    expect(await ensureRoster(db.database, { chatId: CHAT, now: NOW, listHandles: list })).toEqual({
      outcome: 'roster_matched',
      status: 'roles_proposed',
      familyId,
      knownParents: 1,
      confirmed: 0,
      proposed: 1,
      skippedHandles: 0,
    });
    const all = await rosters();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe(pending?.id);
    expect(all[0]?.source).toBe('added_to_existing');
  });

  it('is idempotent across is_me participant.added and chat.created, even when they race', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    const { list, calls } = handlesOk([PARENT, UNKNOWN_A, UNKNOWN_B]);

    const [fromCreated, fromAdded] = await Promise.allSettled([
      startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        handles: [PARENT, UNKNOWN_A, UNKNOWN_B],
        now: NOW,
        listHandles: list,
      }),
      startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: list,
      }),
    ]);

    expect(fromCreated).toMatchObject({
      status: 'fulfilled',
      value: { outcome: 'roster_matched', familyId },
    });
    expect(fromAdded).toEqual({
      status: 'fulfilled',
      value: { outcome: 'roster_already', status: 'roster_pending' },
    });
    expect(calls).toEqual([]);
    expect(await rosters()).toHaveLength(1);
    expect((await membersOf(CHAT)).size).toBe(3);

    expect(
      await startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: list,
      }),
    ).toEqual({ outcome: 'roster_already', status: 'roles_proposed' });
    expect(calls).toEqual([]);
    expect((await membersOf(CHAT)).size).toBe(3);
  });

  it('skips Hale’s own line and a handle that is not a phone, and says how many', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    const { list } = handlesOk([HALE, 'grandparent@example.test', PARENT, UNKNOWN_A]);

    expect(
      await startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: list,
      }),
    ).toMatchObject({ outcome: 'roster_matched', familyId, proposed: 1, skippedHandles: 2 });
    const members = await membersOf(CHAT);
    expect([...members.keys()].sort()).toEqual(
      [phoneBlindIndex(PARENT), phoneBlindIndex(UNKNOWN_A)].sort(),
    );
  });

  it('refuses a chat another family already holds, without touching either family', async () => {
    const mine = await seedHousehold(PARENT, 'Parent');
    const holder = await seedHousehold(OTHER_PARENT, 'Holder', { linqGroupChatId: CHAT });
    const { list } = handlesOk([PARENT, UNKNOWN_A]);

    expect(
      await startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: list,
      }),
    ).toEqual({ outcome: 'roster_chat_claimed_elsewhere' });
    const [roster] = await rosters();
    expect(roster).toMatchObject({ status: 'refused', familyId: null });
    expect(await chatOf(mine.familyId)).toBeNull();
    expect(await chatOf(holder.familyId)).toBe(CHAT);
    expect(await auditVerbs(mine.familyId)).toEqual([]);
  });

  it('refuses a second group for a family that already holds one, and keeps the first', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent', { linqGroupChatId: 'chat-first' });
    const { list } = handlesOk([PARENT, UNKNOWN_A]);

    expect(
      await startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: list,
      }),
    ).toEqual({ outcome: 'roster_family_has_other_chat', familyId });
    const [roster] = await rosters();
    expect(roster).toMatchObject({ status: 'refused', familyId });
    expect(await chatOf(familyId)).toBe('chat-first');
    expect((await auditVerbs(familyId)).map((row) => row.actionTaken)).toEqual([
      'linq_group_roster_fetched',
    ]);
  });

  it('claims a refused chat when Hale is added again after the family let go of its first group', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent', { linqGroupChatId: 'chat-first' });
    const { list, calls } = handlesOk([PARENT, UNKNOWN_A]);
    const addAgain = () =>
      startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: list,
      });

    expect(await addAgain()).toEqual({ outcome: 'roster_family_has_other_chat', familyId });
    expect(await addAgain()).toEqual({ outcome: 'roster_family_has_other_chat', familyId });
    expect(calls).toEqual([CHAT, CHAT]);
    expect(await chatOf(familyId)).toBe('chat-first');

    expect(
      await ejectHouseholdGroup(db.database, { chatId: 'chat-first', now: NOW }),
    ).toMatchObject({ outcome: 'ejected', familyId });
    expect(await addAgain()).toMatchObject({
      outcome: 'roster_matched',
      status: 'roles_proposed',
      familyId,
    });
    expect(await chatOf(familyId)).toBe(CHAT);
    const [roster] = await rosters();
    expect(roster).toMatchObject({ chatId: CHAT, status: 'roles_proposed', familyId });
    expect((await membersOf(CHAT)).size).toBe(2);
    await nothingSentOrSeated();
  });

  it('names a chat that is not a group and claims nothing', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    const { list, calls } = handlesOk([PARENT], false);

    expect(
      await startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: list,
      }),
    ).toEqual({ outcome: 'roster_not_group' });
    const [roster] = await rosters();
    expect(roster).toMatchObject({ status: 'not_group', familyId: null });
    expect((await membersOf(CHAT)).size).toBe(0);
    expect(await chatOf(familyId)).toBeNull();
    expect(await auditVerbs(familyId)).toEqual([]);

    expect(
      await startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: list,
      }),
    ).toEqual({ outcome: 'roster_already', status: 'not_group' });
    expect(calls).toEqual([CHAT]);
    await nothingSentOrSeated();
  });
});

describe('ensureRoster', () => {
  it('backfills a claimed chat: the seated co-parent is confirmed, not re-asked', async () => {
    const { familyId, userId } = await seedHousehold(PARENT, 'Parent', { linqGroupChatId: CHAT });
    const coParentId = await seedPerson(familyId, COPARENT, 'CoParent', 'co_parent');
    const { list } = handlesOk([PARENT, COPARENT, UNKNOWN_A]);

    expect(await ensureRoster(db.database, { chatId: CHAT, now: NOW, listHandles: list })).toEqual({
      outcome: 'roster_matched',
      status: 'roles_proposed',
      familyId,
      knownParents: 1,
      confirmed: 1,
      proposed: 1,
      skippedHandles: 0,
    });
    const [roster] = await rosters();
    expect(roster).toMatchObject({ source: 'backfill', status: 'roles_proposed', familyId });
    const members = await membersOf(CHAT);
    expect(members.get(phoneBlindIndex(PARENT))).toMatchObject({
      status: 'known_parent',
      knownUserId: userId,
    });
    expect(members.get(phoneBlindIndex(COPARENT))).toMatchObject({
      status: 'confirmed',
      confirmedRole: 'co_parent',
      userId: coParentId,
      knownUserId: coParentId,
      confirmedAt: NOW,
    });
    expect(members.get(phoneBlindIndex(UNKNOWN_A))).toMatchObject({ status: 'proposed' });
    expect(await chatOf(familyId)).toBe(CHAT);

    expect(await ensureRoster(db.database, { chatId: CHAT, now: NOW, listHandles: list })).toEqual({
      outcome: 'roster_already',
      status: 'roles_proposed',
    });
  });

  it('marks a backfilled roster confirmed when everyone in it is already known', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent', { linqGroupChatId: CHAT });
    await seedPerson(familyId, COPARENT, 'CoParent', 'co_parent');
    const { list } = handlesOk([PARENT, COPARENT]);

    expect(
      await ensureRoster(db.database, { chatId: CHAT, now: NOW, listHandles: list }),
    ).toMatchObject({ outcome: 'roster_matched', status: 'confirmed', proposed: 0 });
    const [roster] = await rosters();
    expect(roster).toMatchObject({ status: 'confirmed', confirmedAt: NOW });
  });

  it('retries a refused roster on a group inbound only once the block is gone', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent', { linqGroupChatId: 'chat-first' });
    const { list, calls } = handlesOk([PARENT, UNKNOWN_A]);
    await startGroupRoster(db.database, {
      chatId: CHAT,
      source: 'added_to_existing',
      now: NOW,
      listHandles: list,
    });
    expect(calls).toEqual([CHAT]);

    expect(await ensureRoster(db.database, { chatId: CHAT, now: NOW, listHandles: list })).toEqual({
      outcome: 'roster_already',
      status: 'refused',
    });
    expect(calls).toEqual([CHAT]);
    expect(await auditVerbs(familyId)).toHaveLength(1);

    await ejectHouseholdGroup(db.database, { chatId: 'chat-first', now: NOW });
    expect(
      await ensureRoster(db.database, { chatId: CHAT, now: NOW, listHandles: list }),
    ).toMatchObject({ outcome: 'roster_matched', familyId });
    expect(calls).toEqual([CHAT, CHAT]);
    expect(await chatOf(familyId)).toBe(CHAT);
  });

  it('leaves an unclaimed chat with no roster alone', async () => {
    await seedHousehold(PARENT, 'Parent');
    const { list, calls } = handlesOk([PARENT]);
    expect(await ensureRoster(db.database, { chatId: CHAT, now: NOW, listHandles: list })).toEqual({
      outcome: 'roster_absent',
    });
    expect(calls).toEqual([]);
    expect(await rosters()).toEqual([]);
  });
});

describe('attachRosterToFamily', () => {
  it('turns a waiting no_family roster into the family’s group once a member finishes intake', async () => {
    const { list } = handlesOk([UNKNOWN_A, UNKNOWN_B]);
    await startGroupRoster(db.database, {
      chatId: CHAT,
      source: 'added_to_existing',
      now: NOW,
      listHandles: list,
    });

    expect(await attachRosterToFamily(db.database, { phoneE164: UNKNOWN_A, now: NOW })).toEqual({
      outcome: 'attached',
      rosters: [{ chatId: CHAT, outcome: 'roster_no_family', skippedHandles: 0 }],
    });

    const { familyId, userId } = await seedHousehold(UNKNOWN_A, 'Newcomer');
    expect(await attachRosterToFamily(db.database, { phoneE164: UNKNOWN_A, now: NOW })).toEqual({
      outcome: 'attached',
      rosters: [
        {
          chatId: CHAT,
          outcome: 'roster_matched',
          status: 'roles_proposed',
          familyId,
          knownParents: 1,
          confirmed: 0,
          proposed: 1,
          skippedHandles: 0,
        },
      ],
    });
    const [roster] = await rosters();
    expect(roster).toMatchObject({ status: 'roles_proposed', familyId });
    const members = await membersOf(CHAT);
    expect(members.get(phoneBlindIndex(UNKNOWN_A))).toMatchObject({
      status: 'known_parent',
      knownUserId: userId,
    });
    expect(members.get(phoneBlindIndex(UNKNOWN_B))).toMatchObject({ status: 'proposed' });
    expect(await chatOf(familyId)).toBe(CHAT);

    expect(await attachRosterToFamily(db.database, { phoneE164: UNKNOWN_B, now: NOW })).toEqual({
      outcome: 'attached',
      rosters: [],
    });
  });
});

describe('ejectHouseholdGroup', () => {
  it('lets go of the chat: family back to 1:1, roster ejected, seats closed, audited', async () => {
    const { familyId, userId } = await seedHousehold(PARENT, 'Parent');
    const { list } = handlesOk([PARENT, UNKNOWN_A]);
    await startGroupRoster(db.database, {
      chatId: CHAT,
      source: 'added_to_existing',
      now: NOW,
      listHandles: list,
    });
    await db.database.insert(schema.linqGroupMembers).values({
      familyId,
      chatId: CHAT,
      userId,
      phoneE164Encrypted: encryptString(PARENT),
      phoneE164Hash: phoneBlindIndex(PARENT),
      role: 'parent',
    });
    const later = new Date(NOW.getTime() + 60_000);

    expect(await ejectHouseholdGroup(db.database, { chatId: CHAT, now: later })).toEqual({
      outcome: 'ejected',
      familyId,
      seatsRemoved: 1,
      familySeatsKept: 0,
    });
    expect(await chatOf(familyId)).toBeNull();
    const [roster] = await rosters();
    expect(roster).toMatchObject({ status: 'ejected', ejectedAt: later });
    const members = await membersOf(CHAT);
    expect([...members.values()].map((row) => row.status)).toEqual(['removed', 'removed']);
    const [seat] = await db.database.select().from(schema.linqGroupMembers);
    expect(seat?.removedAt).toEqual(later);
    expect((await auditVerbs(familyId)).map((row) => row.actionTaken)).toContain(
      'linq_group_ejected',
    );

    expect(await ejectHouseholdGroup(db.database, { chatId: CHAT, now: later })).toEqual({
      outcome: 'not_claimed',
    });
  });

  it('rebuilds the roster when Hale is added back after an eject', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    const { list } = handlesOk([PARENT, UNKNOWN_A]);
    const start = () =>
      startGroupRoster(db.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: list,
      });
    await start();
    await ejectHouseholdGroup(db.database, { chatId: CHAT, now: NOW });

    expect(await start()).toMatchObject({ outcome: 'roster_matched', familyId });
    expect(await rosters()).toHaveLength(1);
    expect(await chatOf(familyId)).toBe(CHAT);
    const live = (
      await db.database
        .select({ status: schema.linqGroupRosterMembers.status })
        .from(schema.linqGroupRosterMembers)
    ).map((row) => row.status);
    expect(live.sort()).toEqual(['known_parent', 'proposed', 'removed', 'removed']);
  });
});

describe('the Linq door hands Hale’s own add to the roster', () => {
  const SECRET_BYTES = Buffer.alloc(32, 9);
  const TS = String(Math.floor(NOW.getTime() / 1000));

  function signed(body: unknown): Request {
    const raw = JSON.stringify(body);
    const mac = createHmac('sha256', SECRET_BYTES)
      .update(`evt_roster.${TS}.${raw}`)
      .digest('base64');
    return new Request('https://app.villagehale.com/api/channels/linq/inbound?version=2026-02-03', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'evt_roster',
        'webhook-timestamp': TS,
        'webhook-signature': `v1,${mac}`,
      },
      body: raw,
    });
  }

  function addedMe() {
    return {
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'participant.added',
      event_id: 'evt_roster',
      created_at: NOW.toISOString(),
      data: {
        chat_id: CHAT,
        handle: HALE,
        participant: { handle: HALE, is_me: true, service: 'iMessage', status: 'active' },
      },
    };
  }

  function door(list?: ListChatHandles, database: TestDb['database'] = db.database) {
    const outcomes: string[] = [];
    const sends: Array<{ chatId: string; text: string; replyTo?: string }> = [];
    const jobs: unknown[] = [];
    const voice = fakeGroupOnboardingComposer();
    const deps = {
      database,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      countOutcome: async (outcome: string) => {
        outcomes.push(outcome);
      },
      enqueue: async (job: unknown) => {
        jobs.push(job);
      },
      now: () => NOW,
      groupVoice: voice,
      readGroupReply: async (text: string): Promise<RosterReading> =>
        text === 'grandma here!'
          ? { kind: 'role', role: 'grandparent', parentRole: null, relation: null }
          : { kind: 'unclear' },
      listChatHandles: list,
      sendGroupText: async (input: { chatId: string; text: string; replyTo?: string }) => {
        sends.push(input);
        return { providerMessageId: `out-${sends.length}` };
      },
    } as unknown as Parameters<typeof handleLinqInboundRequest>[1];
    return { deps, outcomes, sends, jobs, voice };
  }

  function groupMessage(sender: string, text: string, messageId: string) {
    return {
      api_version: 'v3',
      webhook_version: '2026-02-03',
      event_type: 'message.received',
      event_id: 'evt_roster',
      created_at: NOW.toISOString(),
      data: {
        chat: { id: CHAT, is_group: true },
        id: messageId,
        direction: 'inbound',
        sender_handle: { handle: sender, is_me: false },
        parts: [{ type: 'text', value: text }],
        sent_at: NOW.toISOString(),
        service: 'iMessage',
      },
    };
  }

  function addedSomeone(handle: string) {
    return {
      ...addedMe(),
      data: {
        chat_id: CHAT,
        handle,
        participant: { handle, is_me: false, service: 'iMessage', status: 'active' },
      },
    };
  }

  beforeEach(() => {
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_WEBHOOK_SECRET', `whsec_${SECRET_BYTES.toString('base64')}`);
  });

  it('starts the roster from GET /chats on an is_me participant.added when lit', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: CHAT,
        is_group: true,
        handles: [
          { handle: HALE, is_me: true },
          { handle: PARENT, is_me: false },
          { handle: UNKNOWN_A, is_me: false },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { deps, sends, voice } = door();

    const response = await handleLinqInboundRequest(signed(addedMe()), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      outcome: 'roster_matched',
      ask: 'roster_asked',
      notice: { outcome: 'sent', source: 'composed' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await chatOf(familyId)).toBe(CHAT);
    expect((await membersOf(CHAT)).size).toBe(2);
    expect(voice.calls.map((call) => call.input.kind)).toEqual(['roster_ask']);
    expect(sends.map((send) => send.chatId)).toEqual([CHAT]);
    expect(await db.database.select().from(schema.linqGroupMembers)).toEqual([]);
    expect(await db.database.select().from(schema.consentRecords)).toEqual([]);
  });

  it('starts the roster from chat.created handles without a GET', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { deps } = door();

    const response = await handleLinqInboundRequest(
      signed({
        ...addedMe(),
        event_type: 'chat.created',
        data: {
          id: CHAT,
          is_group: true,
          handles: [
            { handle: HALE, is_me: true },
            { handle: PARENT, is_me: false },
            { handle: UNKNOWN_A, is_me: false },
          ],
        },
      }),
      deps,
    );
    expect(await response.json()).toMatchObject({ outcome: 'roster_matched', ask: 'roster_asked' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await chatOf(familyId)).toBe(CHAT);
  });

  it('says the one no-family line when Hale is added to a chat where it knows nobody', async () => {
    const { deps, sends, voice } = door(handlesOk([UNKNOWN_A, UNKNOWN_B]).list);
    const response = await handleLinqInboundRequest(signed(addedMe()), deps);
    expect(await response.json()).toEqual({
      outcome: 'roster_no_family',
      ask: 'roster_no_family',
      notice: { outcome: 'sent', source: 'composed' },
    });
    expect(voice.calls.map((call) => call.input.kind)).toEqual(['no_family_yet']);
    expect(sends).toHaveLength(1);

    const quiet = await handleLinqInboundRequest(
      signed(groupMessage(UNKNOWN_A, 'who is this?', 'in-quiet')),
      deps,
    );
    expect(await quiet.json()).toEqual({ outcome: 'roster_no_family_quiet' });
    expect(sends).toHaveLength(1);
  });

  it('seats a member on their own reply in the group, and does not hand that reply to the coach', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    const { deps, sends, jobs } = door(handlesOk([PARENT, UNKNOWN_A]).list);
    await handleLinqInboundRequest(signed(addedMe()), deps);

    const reply = await handleLinqInboundRequest(
      signed(groupMessage(UNKNOWN_A, 'grandma here!', 'in-gran')),
      deps,
    );
    expect(await reply.json()).toMatchObject({ outcome: 'role_confirmed', role: 'grandparent' });
    expect(jobs).toEqual([]);
    expect(sends.at(-1)?.replyTo).toBe('in-gran');
    const roles = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, familyId));
    expect(roles.map((row) => row.role).sort()).toEqual(['grandparent', 'primary_parent']);
  });

  it('asks, and does not seat, someone added to a claimed group, whatever the co-parent flag says', async () => {
    vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
    const { familyId } = await seedHousehold(PARENT, 'Parent', { linqGroupChatId: CHAT });
    const { deps, sends, voice } = door(handlesOk([PARENT]).list);

    const response = await handleLinqInboundRequest(signed(addedSomeone(UNKNOWN_A)), deps);
    expect(await response.json()).toMatchObject({ outcome: 'member_asked' });
    expect(voice.calls.map((call) => call.input.kind)).toEqual(['member_ask']);
    expect(sends).toHaveLength(1);
    const roles = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, familyId));
    expect(roles).toEqual([{ role: 'primary_parent' }]);
    expect(await db.database.select().from(schema.consentRecords)).toEqual([]);

    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', '');
    const dark = await handleLinqInboundRequest(signed(addedSomeone(UNKNOWN_B)), deps);
    expect(await dark.json()).toMatchObject({ outcome: 'group_coparent_seated' });
    expect(
      (
        await db.database
          .select({ role: schema.familyMembers.role })
          .from(schema.familyMembers)
          .where(eq(schema.familyMembers.familyId, familyId))
      )
        .map((row) => row.role)
        .sort(),
    ).toEqual(['co_parent', 'primary_parent']);
    expect(sends).toHaveLength(2);
  });

  it('claims a new group from the phrase and asks who is who instead of seating the first phone', async () => {
    const { familyId } = await seedHousehold(PARENT, 'Parent');
    const { deps, sends, voice } = door(handlesOk([PARENT, UNKNOWN_A]).list);
    const body = groupMessage(PARENT, 'this is our year', 'in-claim');
    (body.data.chat as Record<string, unknown>).handles = [
      { handle: PARENT, is_me: false },
      { handle: UNKNOWN_A, is_me: false },
    ];

    const response = await handleLinqInboundRequest(signed(body), deps);
    expect(await response.json()).toMatchObject({
      outcome: 'group_claimed',
      roster: 'roster_matched',
      ask: 'roster_asked',
    });
    expect(await chatOf(familyId)).toBe(CHAT);
    expect(voice.calls.map((call) => call.input.kind)).toEqual(['roster_ask']);
    expect(sends).toHaveLength(1);
    const roles = await db.database
      .select({ role: schema.familyMembers.role })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, familyId));
    expect(roles).toEqual([{ role: 'primary_parent' }]);
  });

  it('keeps today’s signal_from_me answer when the flag is dark', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', '');
    await seedHousehold(PARENT, 'Parent');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { deps } = door();

    const response = await handleLinqInboundRequest(signed(addedMe()), deps);
    expect(await response.json()).toEqual({ outcome: 'signal_from_me' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await rosters()).toEqual([]);
  });

  describe('before migration 0158 reaches the database', () => {
    let bare: TestDb;

    beforeAll(async () => {
      bare = await createTestDb();
      await bare.exec('drop table linq_group_roster_members; drop table linq_group_rosters;');
    });

    afterEach(async () => {
      await bare.exec('truncate table families, users cascade');
    });

    afterAll(async () => {
      await bare.close();
    });

    it('names not_migrated for someone added to a claimed group, and asks nobody', async () => {
      await seedHousehold(PARENT, 'Parent', { linqGroupChatId: CHAT, database: bare.database });
      const { deps, sends, voice } = door(handlesOk([PARENT]).list, bare.database);

      const response = await handleLinqInboundRequest(signed(addedSomeone(UNKNOWN_A)), deps);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ outcome: 'not_migrated' });
      expect(voice.calls).toEqual([]);
      expect(sends).toEqual([]);
    });

    it('claims a new group from the phrase but names not_migrated instead of asking', async () => {
      const { familyId } = await seedHousehold(PARENT, 'Parent', { database: bare.database });
      const { deps, sends, voice } = door(handlesOk([PARENT, UNKNOWN_A]).list, bare.database);

      const response = await handleLinqInboundRequest(
        signed(groupMessage(PARENT, 'this is our year', 'in-claim-bare')),
        deps,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        outcome: 'group_claimed',
        claim: 'claimed',
        roster: 'not_migrated',
      });
      const [family] = await bare.database
        .select({ chatId: schema.families.linqGroupChatId })
        .from(schema.families)
        .where(eq(schema.families.id, familyId));
      expect(family?.chatId).toBe(CHAT);
      expect(voice.calls).toEqual([]);
      expect(sends).toEqual([]);
    });
  });
});

describe('before migration 0158 reaches the database', () => {
  let bare: TestDb;

  beforeAll(async () => {
    bare = await createTestDb();
    await bare.exec('drop table linq_group_roster_members; drop table linq_group_rosters;');
  });

  afterAll(async () => {
    await bare.close();
  });

  it('names not_migrated instead of failing the webhook', async () => {
    const { list, calls } = handlesOk([PARENT]);
    expect(
      await startGroupRoster(bare.database, {
        chatId: CHAT,
        source: 'added_to_existing',
        now: NOW,
        listHandles: list,
      }),
    ).toEqual({ outcome: 'not_migrated' });
    expect(
      await ensureRoster(bare.database, { chatId: CHAT, now: NOW, listHandles: list }),
    ).toEqual({ outcome: 'not_migrated' });
    expect(await attachRosterToFamily(bare.database, { phoneE164: PARENT, now: NOW })).toEqual({
      outcome: 'not_migrated',
    });
    expect(await ejectHouseholdGroup(bare.database, { chatId: CHAT, now: NOW })).toEqual({
      outcome: 'not_migrated',
    });
    expect(calls).toEqual([]);
  });
});
