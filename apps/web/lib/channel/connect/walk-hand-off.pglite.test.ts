import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorDisconnectHandler, connectorLinkHandler } from '~/lib/channel/router/handlers';
import type { HandlerContext } from '~/lib/channel/router/route';
import { scriptedSaidLine } from '~/lib/channel/voice/scripted-said-line.fixture';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import type { GoogleDisconnectPorts } from '~/lib/integrations/google-disconnect';
import { saveConnection } from '~/lib/integrations/store';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { DisconnectReader, DisconnectReading } from './disconnect-read';

/**
 * VIL-721 · a text the onboarding model read as a disconnect or a new-link ask reaches the
 * handler that can act on it, on the model's read alone, in words no pattern knows.
 */

const NOW = new Date('2026-10-14T17:00:00.000Z');
const PHONE = '+15555550143';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');
const TOKENS = { accessToken: 'ya29.secret-access', refreshToken: '1//secret-refresh' };
const OTHER_WORDS = 'take Hale off my Google account';

const ports: GoogleDisconnectPorts = {
  revoker: { revoke: async () => ({ outcome: 'revoked' }) },
  google: {
    async request() {
      throw new Error('push is off in this suite');
    },
  },
  tokenFetch: async () => {
    throw new Error('push is off in this suite');
  },
  env: {},
  now: () => NOW,
};

const reader = (reading: DisconnectReading): DisconnectReader => ({ read: async () => reading });

describe('a walk hand-off at the router', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;

  beforeAll(async () => {
    db = await createTestDb();
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'true');
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const seeded = await seedFamily(db.database);
    familyId = seeded.familyId;
    parentUserId = seeded.parentUserId;
    await db.database.insert(schema.parentChannels).values({
      userId: parentUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await db.exec('truncate table families, users cascade');
  });

  async function turn(body: string, read: string | null): Promise<HandlerContext> {
    const [row] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        providerMessageId: `in-${randomUUID()}`,
        status: 'delivered',
        body,
        sentAt: NOW,
      })
      .returning({ id: schema.channelMessages.id });
    if (read) {
      await db.database.insert(schema.auditLog).values({
        familyId,
        actor: parentUserId,
        actionTaken: 'onboarding_walk_handed_off',
        targetTable: 'channel_messages',
        targetId: row?.id,
        audience: parentUserId,
        after: { read },
      });
    }
    return {
      familyId,
      parentUserId,
      conversationId: randomUUID(),
      body,
      send: async () => ({ providerMessageId: 'prov-1', channel: 'sms' as const }),
      now: NOW,
      resolved: null,
      openQuestions: async () => [],
      inboundChannelMessageId: row?.id ?? null,
    };
  }

  const connect = (provider: 'gcal' | 'gmail') =>
    saveConnection(db.database, {
      familyId,
      userId: parentUserId,
      provider,
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      tokens: TOKENS,
    });

  const live = async (provider: 'gcal' | 'gmail') => {
    const [row] = await db.database
      .select({ enc: schema.integrations.oauthTokensEncrypted })
      .from(schema.integrations)
      .where(
        and(
          eq(schema.integrations.familyId, familyId),
          eq(schema.integrations.userId, parentUserId),
          eq(schema.integrations.provider, provider),
        ),
      );
    return row?.enc != null;
  };

  const disconnect = (reading: DisconnectReading = 'disconnect') =>
    connectorDisconnectHandler(console, scriptedSaidLine(), ports, reader(reading));

  it('ends both connectors on a disconnect read in words no pattern knows', async () => {
    await connect('gcal');
    await connect('gmail');
    const ctx = await turn(OTHER_WORDS, 'disconnect_google');
    const handler = disconnect();

    expect(await handler.detects(db.database, ctx)).toBe(true);
    const verdict = await handler.handle(db.database, ctx);

    expect(verdict).toMatchObject({ claimed: true, outcome: 'revoked', onlyToAsker: true });
    expect([await live('gcal'), await live('gmail')]).toEqual([false, false]);
  });

  it('finds the connector the parent has when the read names none', async () => {
    await connect('gmail');
    const ctx = await turn(OTHER_WORDS, 'disconnect_google');

    const verdict = await disconnect().handle(db.database, ctx);

    expect(verdict).toMatchObject({ claimed: true, outcome: 'revoked' });
    expect(await live('gmail')).toBe(false);
  });

  it('keeps a Calendar-only parent connected when the read names Gmail', async () => {
    await connect('gcal');
    const ctx = await turn('remove my gmail access', 'disconnect_gmail');

    const verdict = await disconnect().handle(db.database, ctx);

    expect(verdict).toMatchObject({ claimed: true, outcome: 'not_connected' });
    expect(await live('gcal')).toBe(true);
  });

  it('ends nothing when the disconnect read says it was a question', async () => {
    await connect('gmail');
    const ctx = await turn('what happens if I take Hale off my Google?', 'disconnect_google');

    const verdict = await disconnect('question').handle(db.database, ctx);

    expect(verdict).toEqual({ claimed: false });
    expect(await live('gmail')).toBe(true);
  });

  it('a fresh-link read mints the one link, and the link handler ignores a disconnect read', async () => {
    const link = connectorLinkHandler(console, scriptedSaidLine());
    const asked = await turn('that thing you sent is dead', 'fresh_link');
    const leaving = await turn('connect my gmail to nothing, take it off', 'disconnect_gmail');

    expect(await link.detects(db.database, asked)).toBe(true);
    expect(await link.detects(db.database, leaving)).toBe(false);
    const verdict = await link.handle(db.database, asked);

    expect(verdict).toMatchObject({ claimed: true, outcome: 'sent' });
    expect(verdict.claimed && verdict.reply).toContain('to=google');
  });

  it('a turn with no hand-off is not claimed, and neither is one while dark', async () => {
    const plain = await turn(OTHER_WORDS, null);
    expect(await disconnect().detects(db.database, plain)).toBe(false);

    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'false');
    const marked = await turn(OTHER_WORDS, 'disconnect_google');
    expect(await disconnect().detects(db.database, marked)).toBe(false);
  });
});
