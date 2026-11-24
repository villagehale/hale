import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { askWriter } from '~/lib/testing/consent-double';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { openChosenHouseholdGroup } from './open-chosen-group';

/**
 * ADD_COMMAND_NO_COLD_TEXT_ENABLED and the new household group. Opening a Linq group
 * with a number is a first text to that number, so with the flag on a group opens only
 * with a co-parent who is already seated, and a number in the parent's message starts
 * no invite.
 */

const FLAG = 'ADD_COMMAND_NO_COLD_TEXT_ENABLED';
const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT = '+14165550101';
const COPARENT = '+14165550102';
const NOW = new Date('2026-11-24T15:00:00.000Z');

let db: TestDb;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
  vi.stubEnv('JOIN_DOOR_MODEL_COPY_ENABLED', 'true');
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', '+15555550100');
  vi.stubEnv(FLAG, 'true');
  fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/chats') && init?.method === 'POST') {
      return Response.json({ chat: { id: 'group-1', message: { id: 'open-1' } } }, { status: 201 });
    }
    return Response.json({}, { status: 200 });
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

async function seedParent(): Promise<{ familyId: string; parentUserId: string }> {
  const seeded = await seedFamily(db.database, 'Ada + kids');
  await db.database.insert(schema.parentChannels).values({
    userId: seeded.parentUserId,
    familyId: seeded.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT),
    phoneE164Hash: phoneBlindIndex(PARENT),
    verifiedAt: NOW,
  });
  await db.database.insert(schema.channelMessages).values({
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    providerChatId: 'chat-parent-1',
    inGroup: false,
    providerMessageId: 'in-1',
    status: 'delivered',
    sentAt: NOW,
  });
  return seeded;
}

async function seedTextedInvite(seeded: { familyId: string; parentUserId: string }) {
  await db.database.insert(schema.caregiverInvites).values({
    familyId: seeded.familyId,
    invitedByUserId: seeded.parentUserId,
    role: 'co_parent',
    displayName: 'Sam',
    phoneE164Encrypted: encryptString(COPARENT),
    phoneE164Hash: phoneBlindIndex(COPARENT),
    state: 'awaiting_caregiver_reply',
    expiresAt: new Date(NOW.getTime() + 3_600_000),
  });
}

async function choose(
  seeded: { familyId: string; parentUserId: string },
  namedPhone?: { phoneE164: string; name: string | null },
) {
  return openChosenHouseholdGroup(db.database, {
    mode: 'new',
    familyId: seeded.familyId,
    parentUserId: seeded.parentUserId,
    parentPhoneE164: PARENT,
    now: NOW,
    inboundBody: namedPhone ? 'Sam 416-555-0102' : 'start a new group',
    ...(namedPhone ? { namedPhone } : {}),
    fetch: fetchMock,
    ask: askWriter(),
  });
}

async function inviteStates(): Promise<string[]> {
  const rows = await db.database
    .select({ state: schema.caregiverInvites.state })
    .from(schema.caregiverInvites);
  return rows.map((row) => row.state);
}

describe('flag on: a new household group texts no number that never texted Hale', () => {
  it('an invite that was texted but never answered does not open a group', async () => {
    const seeded = await seedParent();
    await seedTextedInvite(seeded);

    await expect(choose(seeded)).resolves.toEqual({ status: 'waiting_phone' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('positive control, flag off: the same invite opens a group with that number', async () => {
    vi.stubEnv(FLAG, '');
    const seeded = await seedParent();
    await seedTextedInvite(seeded);

    await expect(choose(seeded)).resolves.toEqual({ status: 'opened', chatId: 'group-1' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).to).toEqual([PARENT, COPARENT]);
  });

  it('a number in the message starts no invite', async () => {
    const seeded = await seedParent();

    await expect(choose(seeded, { phoneE164: COPARENT, name: 'Sam' })).resolves.toEqual({
      status: 'waiting_phone',
    });
    expect(await inviteStates()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('positive control, flag off: the same number starts an invite', async () => {
    vi.stubEnv(FLAG, '');
    const seeded = await seedParent();

    const outcome = await choose(seeded, { phoneE164: COPARENT, name: 'Sam' });

    expect(outcome.status).toBe('invite_started');
    expect(await inviteStates()).toEqual(['awaiting_parent_assent']);
  });
});
