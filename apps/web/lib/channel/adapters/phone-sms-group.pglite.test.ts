import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { familyOutboundTargetForUser } from '~/lib/channel/linq/family-outbound';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import type { RenderedContent } from '../types';
import { createSmsChannel } from './phone-sms';

/**
 * VIL-565: with group onboarding v2 unset, no flag lets a loop reminder into a family
 * group. Every loop send names no content class, so the floor refuses it and the
 * reminder goes 1:1, the same as it does with v2 on.
 */

const KEY = Buffer.alloc(32, 3).toString('base64');
const CHAT = 'chat-adapter-household';
const GROUP_MESSAGES = `/chats/${CHAT}/messages`;
const HALE = '+15555550140';
const MOM = '+15555550141';
const DAD = '+15555550142';
// Midday in the family's own zone, outside quiet hours.
const MIDDAY = new Date('2026-10-14T19:00:00.000Z');

const ADULT_REMINDER: Extract<RenderedContent, { kind: 'sms' }> = {
  kind: 'sms',
  text: 'Your dentist visit is tomorrow at 10.',
  modelWritten: false,
};
const KID_REMINDER: Extract<RenderedContent, { kind: 'sms' }> = {
  kind: 'sms',
  text: 'Swim for the kids is tomorrow at 4.',
  modelWritten: false,
};

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(MIDDAY);
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_FROM_E164', HALE);
  vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
  vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', '');
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await db.exec('truncate table families, users, linq_group_rosters cascade');
});

async function seedHousehold(): Promise<{ familyId: string; userId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Adapter family',
      provinceOrState: 'BC',
      postalCode: 'V5K0A1',
      linqGroupChatId: CHAT,
    })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:adapter-mom', name: 'Mom', timezone: 'America/Vancouver' })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId, role: 'primary_parent' });
  const [roster] = await db.database
    .insert(schema.linqGroupRosters)
    .values({ chatId: CHAT, familyId, source: 'added_to_existing', status: 'confirmed' })
    .returning({ id: schema.linqGroupRosters.id });
  for (const [phone, status, confirmedRole] of [
    [MOM, 'known_parent', null],
    [DAD, 'confirmed', 'co_parent'],
  ] as const) {
    await db.database.insert(schema.linqGroupRosterMembers).values({
      rosterId: roster?.id as string,
      chatId: CHAT,
      phoneE164Hash: phoneBlindIndex(phone),
      status,
      confirmedRole,
    });
  }
  return { familyId, userId };
}

/** Every Linq call the adapter makes outside the fake 1:1 transport. */
function linqSpy() {
  const urls: string[] = [];
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = String(url);
    urls.push(target);
    if (init?.method === 'GET') {
      return Response.json({
        chat: { id: CHAT, is_group: true, handles: [{ handle: MOM }, { handle: DAD }] },
      });
    }
    return Response.json({ message: { id: `msg-${urls.length}` } }, { status: 201 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { groupSends: () => urls.filter((url) => url.endsWith(GROUP_MESSAGES)) };
}

describe('loop reminders with group onboarding v2 unset', () => {
  it('sends an adult and a kid reminder 1:1, and posts nothing into the family group', async () => {
    const { userId } = await seedHousehold();
    const spy = linqSpy();
    const transport = new FakeTransport();
    const channel = createSmsChannel({
      resolveTarget: async () => MOM,
      configured: true,
      transport,
      database: db.database,
      familyTarget: (user) => familyOutboundTargetForUser(db.database, user),
    });

    await channel.send({ userId, rendered: ADULT_REMINDER });
    await channel.send({ userId, rendered: KID_REMINDER });

    expect(transport.sent.map((sent) => sent.body)).toEqual([
      ADULT_REMINDER.text,
      KID_REMINDER.text,
    ]);
    expect(spy.groupSends()).toEqual([]);
  });

  it('positive control: a group target does reach the group, and the spy sees it', async () => {
    const { familyId, userId } = await seedHousehold();
    const spy = linqSpy();
    const transport = new FakeTransport();
    const channel = createSmsChannel({
      resolveTarget: async () => MOM,
      configured: true,
      transport,
      database: db.database,
      familyTarget: async () => ({ channel: 'group', chatId: CHAT, familyId }),
    });

    await channel.send({ userId, rendered: KID_REMINDER });

    expect(spy.groupSends()).toHaveLength(1);
    expect(transport.sent).toEqual([]);
  });
});
