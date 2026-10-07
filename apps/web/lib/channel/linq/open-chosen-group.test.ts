import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { openChosenHouseholdGroup } from './open-chosen-group';

const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-09-24T12:00:00.000Z');
const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const USER = '00000000-0000-4000-8000-0000000000u1';
const USER_B = '00000000-0000-4000-8000-0000000000u2';
const PARENT = '+14165550101';
const COPARENT = '+14165550102';
const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';

function enrol(fake: ReturnType<typeof makeFakeDb>, phone: string, userId: string): void {
  fake.db.insert(schema.parentChannels).values({
    userId,
    familyId: FAMILY,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  } as never);
}

function seedParent(fake: ReturnType<typeof makeFakeDb>): void {
  process.env.APP_ENCRYPTION_KEY = ENC_KEY;
  fake.db.insert(schema.families).values({ id: FAMILY, displayName: 'Fixture' } as never);
  fake.db.insert(schema.users).values({ id: USER, name: 'Ada' } as never);
  enrol(fake, PARENT, USER);
  fake.db.insert(schema.channelMessages).values({
    familyId: FAMILY,
    parentUserId: USER,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    providerChatId: CHAT,
    providerMessageId: 'in-1',
  } as never);
}

afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
});

describe('openChosenHouseholdGroup', () => {
  it('does nothing when the flag is off', async () => {
    const fake = makeFakeDb();
    seedParent(fake);
    const fetchMock = vi.fn();
    await expect(
      openChosenHouseholdGroup(fake.db, {
        mode: 'new',
        familyId: FAMILY,
        parentUserId: USER,
        parentPhoneE164: PARENT,
        now: NOW,
        inboundBody: 'start a new one',
        fetch: fetchMock,
      }),
    ).resolves.toEqual({ status: 'flag_off' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not open a group when the model chose the one they already have', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    const fake = makeFakeDb();
    seedParent(fake);
    const fetchMock = vi.fn();
    await expect(
      openChosenHouseholdGroup(fake.db, {
        mode: 'existing',
        familyId: FAMILY,
        parentUserId: USER,
        parentPhoneE164: PARENT,
        now: NOW,
        inboundBody: 'add you to our group',
        fetch: fetchMock,
      }),
    ).resolves.toEqual({ status: 'not_new' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens the household thread when the co-parent is already seated', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+15555550100');
    const fake = makeFakeDb();
    seedParent(fake);
    fake.db.insert(schema.users).values({ id: USER_B, name: 'Sam' } as never);
    enrol(fake, COPARENT, USER_B);
    fake.db.insert(schema.familyMembers).values({
      familyId: FAMILY,
      userId: USER_B,
      role: 'co_parent',
    } as never);
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/chats') && init?.method === 'POST') {
        return Response.json(
          { chat: { id: 'group-1', message: { id: 'open-1' } } },
          { status: 201 },
        );
      }
      return Response.json({}, { status: 200 });
    });
    await expect(
      openChosenHouseholdGroup(fake.db, {
        mode: 'new',
        familyId: FAMILY,
        parentUserId: USER,
        parentPhoneE164: PARENT,
        now: NOW,
        inboundBody: 'start a new group',
        fetch: fetchMock,
      }),
    ).resolves.toEqual({ status: 'opened', chatId: 'group-1' });
    const created = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(created.to).toEqual([PARENT, COPARENT]);
  });

  it('names the missing phone and does not call Linq', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    const fake = makeFakeDb();
    seedParent(fake);
    const fetchMock = vi.fn();
    await expect(
      openChosenHouseholdGroup(fake.db, {
        mode: 'new',
        familyId: FAMILY,
        parentUserId: USER,
        parentPhoneE164: PARENT,
        now: NOW,
        inboundBody: 'yes, start one',
        fetch: fetchMock,
      }),
    ).resolves.toEqual({ status: 'waiting_phone' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(fake.rows(schema.auditLog).map((row) => row.actionTaken)).toContain('linq_group_held');
  });

  it('leaves an unconfirmed number to the co-parent invite when that invite is dark', async () => {
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    const fake = makeFakeDb();
    seedParent(fake);
    const fetchMock = vi.fn();
    await expect(
      openChosenHouseholdGroup(fake.db, {
        mode: 'new',
        familyId: FAMILY,
        parentUserId: USER,
        parentPhoneE164: PARENT,
        now: NOW,
        inboundBody: 'Sam 416-555-0199',
        namedPhone: { phoneE164: '+14165550199', name: 'Sam' },
        fetch: fetchMock,
      }),
    ).resolves.toEqual({ status: 'invite_dark' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
