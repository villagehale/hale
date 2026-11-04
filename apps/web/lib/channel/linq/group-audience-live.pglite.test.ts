import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { groupAudienceAllows } from './group-audience';
import type { ListChatHandles } from './roster';
import { LinqSendError, listLinqParticipantHandles } from './transport';

/**
 * The family-chat floor reads who is in the chat now. A household line goes in only when
 * every present person other than Hale is a live member of this chat's roster, and the
 * scope is the narrowest role among the people actually present.
 */

const KEY = Buffer.alloc(32, 9).toString('base64');
const CHAT = 'chat-floor-live';
const OTHER_CHAT = 'chat-floor-unclaimed';
const HALE = '+15555550100';
const MOM = '+15555550111';
const DAD = '+15555550112';
const FRIEND = '+15555550113';
const STRANGER = '+15555550199';
const NANNY_EMAIL = 'nanny@example.com';

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
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users, linq_group_rosters cascade');
});

type MemberSeed = {
  phone: string;
  status: (typeof schema.linqGroupRosterMembers.$inferInsert)['status'];
  confirmedRole?: (typeof schema.linqGroupRosterMembers.$inferInsert)['confirmedRole'];
};

async function seedFamily(chatId: string | null): Promise<string> {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Floor test family',
      provinceOrState: 'BC',
      postalCode: 'V5K0A1',
      linqGroupChatId: chatId,
    })
    .returning({ id: schema.families.id });
  return family?.id as string;
}

async function seedRoster(familyId: string, members: MemberSeed[]): Promise<void> {
  const [roster] = await db.database
    .insert(schema.linqGroupRosters)
    .values({ chatId: CHAT, familyId, source: 'added_to_existing', status: 'confirmed' })
    .returning({ id: schema.linqGroupRosters.id });
  for (const member of members) {
    await db.database.insert(schema.linqGroupRosterMembers).values({
      rosterId: roster?.id as string,
      chatId: CHAT,
      phoneE164Hash: phoneBlindIndex(member.phone),
      status: member.status,
      confirmedRole: member.confirmedRole ?? null,
    });
  }
}

const PARENTS: MemberSeed[] = [
  { phone: MOM, status: 'known_parent' },
  { phone: DAD, status: 'confirmed', confirmedRole: 'co_parent' },
];

function listOf(handles: string[], isGroup: boolean | null = true) {
  return vi.fn<ListChatHandles>(async () => ({ status: 'ok', handles, isGroup }));
}

function docsFetch(handles: Array<Record<string, unknown>>): typeof fetch {
  return (async () =>
    Response.json(
      { chat: { id: CHAT, is_group: true, handles } },
      { status: 200 },
    )) as typeof fetch;
}

function realList(fetchImpl: typeof fetch): ListChatHandles {
  return (input) => listLinqParticipantHandles({ ...input, fetch: fetchImpl });
}

describe('groupAudienceAllows reads the live participant list', () => {
  it('THE LEAK: an Apple-ID email beside two confirmed parents holds a schedule line', async () => {
    await seedRoster(await seedFamily(CHAT), PARENTS);

    await expect(
      groupAudienceAllows(db.database, CHAT, 'schedule', listOf([MOM, DAD, NANNY_EMAIL])),
    ).resolves.toEqual({ allowed: false, reason: 'participant_unresolved' });
  });

  it('a phone in the chat with no roster row (a missed add) holds the line', async () => {
    await seedRoster(await seedFamily(CHAT), PARENTS);

    await expect(
      groupAudienceAllows(db.database, CHAT, 'schedule', listOf([MOM, DAD, STRANGER])),
    ).resolves.toEqual({ allowed: false, reason: 'participant_unresolved' });
  });

  it('positive control: the real GET listing the parents and Hale (is_me) is in scope', async () => {
    await seedRoster(await seedFamily(CHAT), PARENTS);
    const fetchImpl = docsFetch([
      { handle: HALE, status: 'active', is_me: true },
      { handle: MOM, status: 'active', is_me: false },
      { handle: DAD, status: 'active', is_me: false },
    ]);

    await expect(
      groupAudienceAllows(db.database, CHAT, 'schedule', realList(fetchImpl)),
    ).resolves.toEqual({ allowed: true, reason: 'in_scope' });
  });

  it("positive control: Hale's own line listed without is_me is skipped, not unresolved", async () => {
    await seedRoster(await seedFamily(CHAT), PARENTS);

    await expect(
      groupAudienceAllows(db.database, CHAT, 'schedule', listOf([MOM, DAD, HALE])),
    ).resolves.toEqual({ allowed: true, reason: 'in_scope' });
  });

  it('a member Linq lists as removed no longer narrows the scope', async () => {
    await seedRoster(await seedFamily(CHAT), [...PARENTS, { phone: FRIEND, status: 'not_family' }]);
    const departed = docsFetch([
      { handle: MOM, status: 'active', is_me: false },
      { handle: DAD, status: 'active', is_me: false },
      { handle: FRIEND, status: 'removed', left_at: '2026-10-30T15:00:00Z', is_me: false },
    ]);
    const stillHere = docsFetch([
      { handle: MOM, status: 'active', is_me: false },
      { handle: DAD, status: 'active', is_me: false },
      { handle: FRIEND, status: 'active', is_me: false },
    ]);

    await expect(
      groupAudienceAllows(db.database, CHAT, 'schedule', realList(departed)),
    ).resolves.toEqual({ allowed: true, reason: 'in_scope' });
    await expect(
      groupAudienceAllows(db.database, CHAT, 'schedule', realList(stillHere)),
    ).resolves.toEqual({ allowed: false, reason: 'group_audience_empty' });
  });

  it('a stale left_at beside an active status still counts as present and holds the line', async () => {
    await seedRoster(await seedFamily(CHAT), PARENTS);
    const readded = docsFetch([
      { handle: MOM, status: 'active', is_me: false },
      { handle: DAD, status: 'active', is_me: false },
      { handle: STRANGER, status: 'active', left_at: '2026-10-30T15:00:00Z', is_me: false },
    ]);
    const removed = docsFetch([
      { handle: MOM, status: 'active', is_me: false },
      { handle: DAD, status: 'active', is_me: false },
      { handle: STRANGER, status: 'removed', left_at: '2026-10-30T15:00:00Z', is_me: false },
    ]);

    await expect(
      groupAudienceAllows(db.database, CHAT, 'schedule', realList(readded)),
    ).resolves.toEqual({ allowed: false, reason: 'participant_unresolved' });
    await expect(
      groupAudienceAllows(db.database, CHAT, 'schedule', realList(removed)),
    ).resolves.toEqual({ allowed: true, reason: 'in_scope' });
  });

  it('a read that fails, is refused (429) or throws holds the line as participants_unverified', async () => {
    await seedRoster(await seedFamily(CHAT), PARENTS);
    const unreachable: ListChatHandles = async () => ({ status: 'unreachable', reason: 'timeout' });
    const rateLimited: ListChatHandles = async () => ({
      status: 'refused',
      code: 'http_429',
      httpStatus: 429,
      permanent: false,
    });
    const threw: ListChatHandles = async () => {
      throw new LinqSendError('preview_capture', 0, true);
    };

    for (const list of [unreachable, rateLimited, threw]) {
      await expect(groupAudienceAllows(db.database, CHAT, 'schedule', list)).resolves.toEqual({
        allowed: false,
        reason: 'participants_unverified',
      });
    }
  });

  it('a chat Linq says is not a group is refused by name', async () => {
    await seedRoster(await seedFamily(CHAT), PARENTS);

    await expect(
      groupAudienceAllows(db.database, CHAT, 'schedule', listOf([MOM, DAD], false)),
    ).resolves.toEqual({ allowed: false, reason: 'chat_not_group' });
  });

  it('makes no read for reply, unclassified or a class no group may hear', async () => {
    await seedRoster(await seedFamily(CHAT), PARENTS);
    const reply = listOf([MOM, DAD]);
    const unclassified = listOf([MOM, DAD]);
    const health = listOf([MOM, DAD]);
    const schedule = listOf([MOM, DAD]);

    await expect(groupAudienceAllows(db.database, CHAT, 'reply', reply)).resolves.toEqual({
      allowed: true,
      reason: 'in_scope',
    });
    await expect(
      groupAudienceAllows(db.database, CHAT, 'unclassified', unclassified),
    ).resolves.toEqual({ allowed: false, reason: 'group_audience_refused' });
    await expect(groupAudienceAllows(db.database, CHAT, 'health', health)).resolves.toEqual({
      allowed: false,
      reason: 'group_audience_refused',
    });
    await expect(groupAudienceAllows(db.database, CHAT, 'schedule', schedule)).resolves.toEqual({
      allowed: true,
      reason: 'in_scope',
    });

    expect(reply).not.toHaveBeenCalled();
    expect(unclassified).not.toHaveBeenCalled();
    expect(health).not.toHaveBeenCalled();
    expect(schedule).toHaveBeenCalledOnce();
  });

  it('V2 unset: a claimed chat with no roster holds a schedule line', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', '');
    await seedFamily(CHAT);

    await expect(
      groupAudienceAllows(db.database, CHAT, 'schedule', listOf([MOM, DAD])),
    ).resolves.toEqual({ allowed: false, reason: 'group_roles_unconfirmed' });
  });

  it('an unclaimed chat with no roster takes a reply only, and reads nothing', async () => {
    await seedFamily(CHAT);
    const schedule = listOf([MOM, DAD]);
    const reply = listOf([MOM, DAD]);

    await expect(
      groupAudienceAllows(db.database, OTHER_CHAT, 'schedule', schedule),
    ).resolves.toEqual({ allowed: false, reason: 'group_roles_unconfirmed' });
    await expect(groupAudienceAllows(db.database, OTHER_CHAT, 'reply', reply)).resolves.toEqual({
      allowed: true,
      reason: 'not_household_group',
    });
    expect(schedule).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
  });
});
