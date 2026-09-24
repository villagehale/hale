import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  deliverFamilyOutbound,
  familyOutboundTarget,
  flushGroupDecisionSyncs,
  queueGroupActivityDecision,
} from './family-outbound';

/**
 * A claimed group is the home channel. No group keeps the caller's door.
 * A 1:1 decision posts one sync bubble into the group and does not text SMS.
 */

const GROUP = 'chat-home';
const PERSONAL = 'chat-one-to-one';
const GROUP_MESSAGES = `https://api.linqapp.com/api/partner/v3/chats/${GROUP}/messages`;
const NOW = new Date('2026-09-24T15:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

function wire(): {
  fetch: typeof fetch;
  linqUrls: () => string[];
  twilioUrls: () => string[];
  bodies: () => string;
} {
  const linqUrls: string[] = [];
  const twilioUrls: string[] = [];
  const bodies: string[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const target = String(url);
    if (target.includes('twilio.com')) twilioUrls.push(target);
    else linqUrls.push(target);
    if (init?.body) bodies.push(String(init.body));
    return new Response(JSON.stringify({ message: { id: 'msg-1' } }), { status: 201 });
  });
  return {
    fetch: fetchMock as unknown as typeof fetch,
    linqUrls: () => linqUrls,
    twilioUrls: () => twilioUrls,
    bodies: () => bodies.join('\n'),
  };
}

async function seed(chatId: string | null): Promise<{ familyId: string; parentUserId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'Barton + kids',
      provinceOrState: 'ON',
      postalCode: 'M6H2H9',
      linqGroupChatId: chatId,
    })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${family?.id}`, name: 'Barton' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId: parentUserId,
    role: 'primary_parent',
  });
  return { familyId, parentUserId };
}

describe('familyOutboundTarget', () => {
  it('returns the group when one is claimed', async () => {
    const seeded = await seed(GROUP);
    await expect(familyOutboundTarget(db.database, seeded.familyId)).resolves.toEqual({
      channel: 'group',
      chatId: GROUP,
      familyId: seeded.familyId,
    });
  });

  it('stays on the legacy door when the family has no group', async () => {
    const seeded = await seed(null);
    await expect(familyOutboundTarget(db.database, seeded.familyId)).resolves.toEqual({
      channel: 'legacy',
    });
  });
});

describe('deliverFamilyOutbound', () => {
  it('sends a scheduled-style body to the group and not to SMS', async () => {
    const seeded = await seed(GROUP);
    const legacy = new FakeTransport();
    const http = wire();
    const delivered = await deliverFamilyOutbound(db.database, {
      familyId: seeded.familyId,
      body: 'Richmond Hill rec opens Tuesday.',
      to: '+14165550100',
      legacy,
      fetch: http.fetch,
      shareGroupCap: false,
    });
    expect(delivered).toMatchObject({ status: 'sent', channel: 'imessage', chatId: GROUP });
    expect(legacy.sent).toEqual([]);
    expect(http.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(http.twilioUrls()).toEqual([]);
    expect(http.bodies()).toContain('Richmond Hill rec opens Tuesday.');
  });

  it('keeps a family without a group on the legacy transport', async () => {
    const seeded = await seed(null);
    const legacy = new FakeTransport();
    const http = wire();
    vi.stubGlobal('fetch', http.fetch);
    const delivered = await deliverFamilyOutbound(db.database, {
      familyId: seeded.familyId,
      body: 'Same nudge as before.',
      to: '+14165550100',
      legacy,
      fetch: http.fetch,
    });
    expect(delivered.status).toBe('sent');
    if (delivered.status === 'sent') expect(delivered.channel).toBe('sms');
    expect(legacy.bodies()).toEqual(['Same nudge as before.']);
    expect(http.linqUrls()).toEqual([]);
    expect(http.twilioUrls()).toEqual([]);
  });
});

describe('a 1:1 decision syncs the group', () => {
  it('waits until the 1:1 is quiet, then posts one picked line and not SMS', async () => {
    const seeded = await seed(GROUP);
    const http = wire();
    const queued = await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision: {
        decision: 'picked',
        activity: 'swim',
        kid: 'Maya',
        day: 'Tuesday',
        time: '4:00',
      },
      now: NOW,
    });
    expect(queued).toBe('queued');
    const early = await flushGroupDecisionSyncs(db.database, { now: NOW, fetch: http.fetch });
    expect(early.sent).toBe(0);
    expect(http.linqUrls()).toEqual([]);
    const settled = new Date(NOW.getTime() + 10 * 60 * 1000);
    const flushed = await flushGroupDecisionSyncs(db.database, {
      now: settled,
      fetch: http.fetch,
    });
    expect(flushed.sent).toBe(1);
    expect(http.linqUrls()).toEqual([GROUP_MESSAGES]);
    expect(http.twilioUrls()).toEqual([]);
    expect(http.bodies()).toContain('Quick sync: Barton picked swim for Maya, Tuesday at 4:00.');
    expect(http.bodies()).not.toMatch(/inbox|subject|@|booked/i);
    const [row] = await db.database
      .select({
        channel: schema.channelMessages.channel,
        providerChatId: schema.channelMessages.providerChatId,
        templateKey: schema.channelMessages.templateKey,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, seeded.familyId));
    expect(row).toMatchObject({
      channel: 'imessage',
      providerChatId: GROUP,
      templateKey: 'linq:group_sync',
    });
  });

  it('does not post a second bubble when the decision was already in the group', async () => {
    const seeded = await seed(GROUP);
    const http = wire();
    const result = await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: GROUP,
      decision: {
        decision: 'passed',
        activity: 'swim',
        kid: 'Maya',
      },
      now: NOW,
    });
    expect(result).toBe('skipped');
    expect(http.linqUrls()).toEqual([]);
  });

  it('does nothing for a family without a group', async () => {
    const seeded = await seed(null);
    const http = wire();
    const result = await queueGroupActivityDecision(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      originChatId: PERSONAL,
      decision: {
        decision: 'picked',
        activity: 'swim',
        kid: 'Maya',
        day: 'Tuesday',
        time: '4:00',
      },
      now: NOW,
    });
    expect(result).toBe('skipped');
    expect(http.linqUrls()).toEqual([]);
  });
});
