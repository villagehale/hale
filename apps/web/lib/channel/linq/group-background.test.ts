import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeFakeDb } from '~/lib/channel/intake/fakes';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { linqGroupBackgroundEnabled } from './config';
import {
  HOUSEHOLD_GROUP_BACKGROUND,
  noteGroupBackgroundChange,
  openHouseholdLinqGroup,
  setHouseholdGroupBackgroundOnce,
} from './group';
import { parseLinqWebhook } from './payload';
import { LINQ_WEBHOOK_VERSION } from './signature';

const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = new Date('2026-10-31T12:00:00.000Z');
const FAMILY = '00000000-0000-4000-8000-0000000000f1';
const USER = '00000000-0000-4000-8000-0000000000u1';
const PARENT = '+14165550101';
const COPARENT = '+14165550102';
const CHAT = '8f392755-6865-4b18-880a-227f9d8b458f';

type Call = [url: RequestInfo | URL, init?: RequestInit];

function linqFetch() {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/chats') && init?.method === 'POST') {
      return Response.json({ chat: { id: 'group-1', message: { id: 'open-1' } } }, { status: 201 });
    }
    return Response.json({}, { status: 202 });
  });
}

function backgroundCalls(fetchMock: { mock: { calls: Call[] } }) {
  return fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/background'));
}

async function seed() {
  process.env.APP_ENCRYPTION_KEY = ENC_KEY;
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', '+15555550100');
  vi.stubEnv('PREVIEW_CAPTURE_TRANSPORT', '');
  const fake = makeFakeDb();
  fake.db.insert(schema.parentChannels).values({
    userId: USER,
    familyId: FAMILY,
    kind: 'sms',
    phoneE164Encrypted: encryptString(PARENT),
    phoneE164Hash: phoneBlindIndex(PARENT),
    verifiedAt: NOW,
  } as never);
  await fake.db.insert(schema.families).values({ id: FAMILY, displayName: 'Fixture' } as never);
  await fake.db.insert(schema.channelMessages).values({
    familyId: FAMILY,
    parentUserId: USER,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    providerChatId: CHAT,
    providerMessageId: 'in-1',
  } as never);
  return fake;
}

const open = (fake: ReturnType<typeof makeFakeDb>, fetchMock: typeof fetch) =>
  openHouseholdLinqGroup(fake.db, {
    familyId: FAMILY,
    parentUserId: USER,
    parentPhoneE164: PARENT,
    coParentPhoneE164: COPARENT,
    now: NOW,
    fetch: fetchMock,
  });

afterEach(() => {
  process.env.APP_ENCRYPTION_KEY = '';
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('VIL-478 household group background', () => {
  it('flag is dark by default and always dark on Production', () => {
    vi.stubEnv('LINQ_GROUP_BACKGROUND_ENABLED', '');
    expect(linqGroupBackgroundEnabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_BACKGROUND_ENABLED', 'on');
    expect(linqGroupBackgroundEnabled()).toBe(false);
    vi.stubEnv('LINQ_GROUP_BACKGROUND_ENABLED', 'true');
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect(linqGroupBackgroundEnabled()).toBe(true);
    vi.stubEnv('VERCEL_ENV', 'production');
    expect(linqGroupBackgroundEnabled()).toBe(false);
  });

  it('sets ice once, colour only, when Hale creates the household group — no bubble', async () => {
    const fake = await seed();
    vi.stubEnv('LINQ_GROUP_BACKGROUND_ENABLED', 'true');
    const fetchMock = linqFetch();
    await expect(open(fake, fetchMock)).resolves.toEqual({ status: 'opened', chatId: 'group-1' });
    const calls = backgroundCalls(fetchMock);
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain('/chats/group-1/background');
    expect(calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.[1]?.body))).toEqual({ type: 'color', variant: 'ice' });
    expect(HOUSEHOLD_GROUP_BACKGROUND).toBe('ice');
    const outbound = fake
      .rows(schema.channelMessages)
      .filter((row) => (row as { direction: string }).direction === 'out');
    expect(outbound).toHaveLength(1);
    expect(
      fake.rows(schema.auditLog).map((r) => (r as { actionTaken: string }).actionTaken),
    ).toContain('linq_group_background_set');
  });

  it('does not touch an existing group (re-add path) or run with the flag dark', async () => {
    const fake = await seed();
    vi.stubEnv('LINQ_GROUP_BACKGROUND_ENABLED', '');
    const dark = linqFetch();
    await open(fake, dark);
    expect(backgroundCalls(dark)).toEqual([]);

    vi.stubEnv('LINQ_GROUP_BACKGROUND_ENABLED', 'true');
    const readd = linqFetch();
    await expect(
      openHouseholdLinqGroup(fake.db, {
        familyId: FAMILY,
        parentUserId: USER,
        parentPhoneE164: PARENT,
        coParentPhoneE164: '+14165550109',
        now: NOW,
        fetch: readd,
      }),
    ).resolves.toEqual({ status: 'added', chatId: 'group-1' });
    expect(backgroundCalls(readd)).toEqual([]);
  });

  it('a background refusal never blocks the group open', async () => {
    const fake = await seed();
    vi.stubEnv('LINQ_GROUP_BACKGROUND_ENABLED', 'true');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/background')) return Response.json({}, { status: 400 });
      if (String(url).endsWith('/chats') && init?.method === 'POST') {
        return Response.json(
          { chat: { id: 'group-1', message: { id: 'open-1' } } },
          { status: 201 },
        );
      }
      return Response.json({}, { status: 202 });
    });
    await expect(open(fake, fetchMock)).resolves.toEqual({ status: 'opened', chatId: 'group-1' });
  });

  it('a parent change (actor_handle.is_me false) is recorded and Hale never sets over it', async () => {
    const fake = await seed();
    await fake.db.update(schema.families).set({ linqGroupChatId: 'group-1' } as never);
    vi.stubEnv('LINQ_GROUP_BACKGROUND_ENABLED', 'true');

    await expect(
      noteGroupBackgroundChange(fake.db, { chatId: 'group-1', isFromMe: true }),
    ).resolves.toBe('linq_background_mine');
    await expect(
      noteGroupBackgroundChange(fake.db, { chatId: 'group-1', isFromMe: false }),
    ).resolves.toBe('linq_background_parent_noted');

    const fetchMock = linqFetch();
    await expect(
      setHouseholdGroupBackgroundOnce(fake.db, {
        familyId: FAMILY,
        parentUserId: USER,
        chatId: 'group-1',
        fetch: fetchMock,
      }),
    ).resolves.toBe('parent_owned');
    expect(backgroundCalls(fetchMock)).toEqual([]);
    await expect(
      noteGroupBackgroundChange(fake.db, { chatId: 'other-chat', isFromMe: false }),
    ).resolves.toBe('linq_background_no_family');
  });

  it("a parent's change on an OLD group never blocks the family's next group (Devin #991)", async () => {
    const fake = await seed();
    await fake.db.update(schema.families).set({ linqGroupChatId: 'group-old' } as never);
    vi.stubEnv('LINQ_GROUP_BACKGROUND_ENABLED', 'true');
    await expect(
      noteGroupBackgroundChange(fake.db, { chatId: 'group-old', isFromMe: false }),
    ).resolves.toBe('linq_background_parent_noted');

    const fetchMock = linqFetch();
    await expect(
      setHouseholdGroupBackgroundOnce(fake.db, {
        familyId: FAMILY,
        parentUserId: USER,
        chatId: 'group-new',
        fetch: fetchMock,
      }),
    ).resolves.toBe('set');
    expect(String(backgroundCalls(fetchMock)[0]?.[0])).toContain('/chats/group-new/background');
    await expect(
      setHouseholdGroupBackgroundOnce(fake.db, {
        familyId: FAMILY,
        parentUserId: USER,
        chatId: 'group-old',
        fetch: linqFetch(),
      }),
    ).resolves.toBe('parent_owned');
  });

  it('reads chat.background_updated actor_handle.is_me off the webhook', () => {
    const parse = (isMe: boolean) =>
      parseLinqWebhook(
        {
          webhook_version: LINQ_WEBHOOK_VERSION,
          event_type: 'chat.background_updated',
          data: {
            chat_id: 'group-1',
            background: { type: 'color', variant: 'plum' },
            actor_handle: { handle: PARENT, is_me: isMe },
          },
        },
        NOW,
      );
    expect(parse(false)).toMatchObject({
      kind: 'signal',
      signal: { event: 'chat.background_updated', chatId: 'group-1', isFromMe: false },
    });
    expect(parse(true)).toMatchObject({ kind: 'signal', signal: { isFromMe: true } });
  });
});
