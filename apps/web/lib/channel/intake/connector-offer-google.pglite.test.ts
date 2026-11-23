import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  type ConnectorOfferPorts,
  INTAKE_GOOGLE_CARD_TEMPLATE_KEY,
  googleCardDedupeKey,
  sendGoogleConnectorCard,
} from './connector-offer';
import { type ChannelTransport, FakeTransport } from './transport';

/**
 * VIL-721 · the ONE card: the model's prose, then one link that connects Gmail and the
 * calendar together (`/connect?t=…&to=google`). Read back from the real schema: the claim
 * row, the family's one-offer dedupe key, and the mint's audit row.
 */

const KEY = Buffer.alloc(32, 9).toString('base64');
const PHONE = '+15555550143';
const NOW = new Date('2026-10-14T17:00:00.000Z');
/** 23:30 in Chicago (CDT), inside the parent's own quiet hours. */
const NIGHT = new Date('2026-10-15T04:30:00.000Z');
const CHAT = 'chat-google';
const PROSE = 'Google prose (test fixture).';

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  vi.stubEnv('APP_URL', 'https://app.example.com');
  // The Linq preview bubble is refused, so the link goes once, as its own text.
  vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ error: { code: 2001 } }, { status: 400 })),
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

async function seedParent(options: { enrolled?: boolean } = {}) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Google card family', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: 'sms:google-parent', name: 'Parent', timezone: 'America/Chicago' })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  if (options.enrolled !== false) {
    await db.database.insert(schema.parentChannels).values({
      userId: parentUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
  }
  return { familyId, parentUserId };
}

function imessage(): ChannelTransport & { bodies: string[] } {
  const real = new FakeTransport();
  const bodies: string[] = [];
  return {
    bodies,
    async send(input) {
      bodies.push(input.body);
      const sent = await real.send(input);
      return { ...sent, transport: 'imessage', chatId: CHAT };
    },
  };
}

function ports(transport: ChannelTransport): ConnectorOfferPorts {
  return { transport, threadMessage: async () => 'conv-1' };
}

function offer(
  parent: { familyId: string; parentUserId: string },
  transport: ChannelTransport,
  over: { voice?: string | undefined; now?: Date; ridesReply?: boolean; inGroup?: boolean } = {},
) {
  return sendGoogleConnectorCard(
    db.database,
    {
      ...parent,
      phoneE164: PHONE,
      now: over.now ?? NOW,
      ridesReply: over.ridesReply ?? true,
      inGroup: over.inGroup ?? false,
      voice: 'voice' in over ? over.voice : PROSE,
    },
    ports(transport),
  );
}

async function cards(familyId: string) {
  const rows = await db.database
    .select({
      templateKey: schema.channelMessages.templateKey,
      status: schema.channelMessages.status,
      errorCode: schema.channelMessages.errorCode,
      dedupeKey: schema.channelMessages.dedupeKey,
    })
    .from(schema.channelMessages)
    .where(eq(schema.channelMessages.familyId, familyId));
  return rows.filter((row) => row.templateKey === INTAKE_GOOGLE_CARD_TEMPLATE_KEY);
}

async function mints(familyId: string) {
  return db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'connector_link_minted'),
      ),
    );
}

describe('sendGoogleConnectorCard (VIL-721)', () => {
  it('sends the prose, then ONE link for both, and spends the family offer', async () => {
    const parent = await seedParent();
    const transport = imessage();

    expect(await offer(parent, transport)).toBe('sent');

    expect(transport.bodies[0]).toBe(PROSE);
    const links = transport.bodies.filter((body) => body.startsWith('https://'));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(/^https:\/\/app\.example\.com\/connect\?t=[^&]+&to=google$/);
    expect(await cards(parent.familyId)).toEqual([
      expect.objectContaining({
        errorCode: null,
        dedupeKey: googleCardDedupeKey(parent.familyId),
      }),
    ]);
    expect(await mints(parent.familyId)).toEqual([{ after: { provider: 'google' } }]);
  });

  it('never goes on a group turn: no send, no token, and the family keeps its one offer', async () => {
    const parent = await seedParent();
    const group = imessage();

    expect(await offer(parent, group, { inGroup: true })).toBe('group_thread');

    expect(group.bodies).toEqual([]);
    expect(await cards(parent.familyId)).toEqual([]);
    expect(await mints(parent.familyId)).toEqual([]);

    const own = imessage();
    expect(await offer(parent, own)).toBe('sent');
    expect(own.bodies.filter((body) => body.includes('to=google'))).toHaveLength(1);
  });

  it('is the family’s one offer: a second call sends and mints nothing', async () => {
    const parent = await seedParent();
    await offer(parent, imessage());
    const again = imessage();

    expect(await offer(parent, again)).toBe('already_sent');
    expect(again.bodies).toEqual([]);
    expect(await mints(parent.familyId)).toHaveLength(1);
  });

  it.each(['', undefined])(
    'sends nothing without the model’s prose (%j): no fixed line stands in',
    async (voice) => {
      const parent = await seedParent();
      const transport = imessage();

      expect(await offer(parent, transport, { voice })).toBe('voice_unsent');
      expect(transport.bodies).toEqual([]);
      expect(await cards(parent.familyId)).toEqual([
        expect.objectContaining({ status: 'failed', errorCode: 'voice_unsent', dedupeKey: null }),
      ]);
    },
  );

  it('names a parent with no verified channel, sends nothing, and releases the claim', async () => {
    const parent = await seedParent({ enrolled: false });
    const transport = imessage();

    expect(await offer(parent, transport)).toBe('not_enrolled');
    expect(transport.bodies).toEqual([]);
    expect(await cards(parent.familyId)).toEqual([
      expect.objectContaining({ status: 'failed', dedupeKey: null }),
    ]);
  });

  it('holds a card that does not ride the parent’s own reply during their night', async () => {
    const parent = await seedParent();
    const transport = imessage();

    expect(await offer(parent, transport, { now: NIGHT, ridesReply: false })).toBe(
      'suppressed_quiet_hours',
    );
    expect(transport.bodies).toEqual([]);
    expect(await cards(parent.familyId)).toEqual([
      expect.objectContaining({ status: 'suppressed_quiet_hours', dedupeKey: null }),
    ]);
    expect(await mints(parent.familyId)).toEqual([]);
  });

  it('drops a URL the model wrote into its prose: only the minted link goes', async () => {
    const parent = await seedParent();
    const transport = imessage();

    await offer(parent, transport, { voice: 'Tap https://elsewhere.example/x to connect both.' });

    expect(transport.bodies.join('\n')).not.toContain('elsewhere.example');
    expect(transport.bodies.filter((body) => body.startsWith('https://'))).toHaveLength(1);
  });
});
