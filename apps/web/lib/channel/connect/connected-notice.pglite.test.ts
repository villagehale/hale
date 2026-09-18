import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { TwilioSendError } from '~/lib/channel/twilio/transport';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  CONNECTOR_CONNECTED_TEMPLATE_KEY,
  type ConnectedNoticePorts,
  connectedNoticeLabel,
  connectorConnectedDedupeKey,
  defaultConnectedNoticePorts,
  sendConnectorConnectedText,
} from './connected-notice';
import { CONNECTOR_CONNECTED_TEXT } from './text-connect';

/**
 * The receipt Hale texts back the moment Google hands the parent to the callback.
 *
 * pglite rather than a chain fake, because the one promise worth testing here is a SQL
 * one: the partial unique index on `channel_messages.dedupe_key` is what makes "a
 * replayed callback cannot text twice" true, and a fake answers whatever rows it holds.
 */

const NOW = new Date('2026-09-17T15:00:00.000Z');
const PHONE = '+14165550143';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');

describe('sendConnectorConnectedText', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;
  let connectId: string;
  let transport: FakeTransport;
  let threaded: Array<{ familyId: string; parentUserId: string; body: string }>;
  let ports: ConnectedNoticePorts;

  async function seedChannel(): Promise<void> {
    await db.database.insert(schema.parentChannels).values({
      userId: parentUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
  }

  beforeEach(async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);
    db = await createTestDb();
    const seeded = await seedFamily(db.database);
    familyId = seeded.familyId;
    parentUserId = seeded.parentUserId;
    connectId = randomUUID();
    transport = new FakeTransport();
    threaded = [];
    ports = {
      transport,
      threadMessage: async (_database, input) => {
        threaded.push(input);
        return 'conversation-id';
      },
    };
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  function send(provider: 'gcal' | 'gmail' = 'gcal') {
    return sendConnectorConnectedText(
      db.database,
      { familyId, parentUserId, provider, connectId, now: NOW },
      ports,
    );
  }

  it('texts the verified number once, with the locked calendar words', async () => {
    await seedChannel();

    const outcome = await send('gcal');

    expect(connectedNoticeLabel(outcome)).toBe('sent');
    expect(transport.sent).toEqual([{ to: PHONE, body: CONNECTOR_CONNECTED_TEXT.gcal }]);
  });

  it('writes the ledger row the dedupe key hangs on, and threads what it said', async () => {
    await seedChannel();

    const outcome = await send('gmail');
    if (outcome.status !== 'sent') throw new Error(`expected sent, got ${outcome.status}`);

    const [row] = await db.database
      .select({
        familyId: schema.channelMessages.familyId,
        parentUserId: schema.channelMessages.parentUserId,
        channel: schema.channelMessages.channel,
        direction: schema.channelMessages.direction,
        category: schema.channelMessages.category,
        templateKey: schema.channelMessages.templateKey,
        dedupeKey: schema.channelMessages.dedupeKey,
        status: schema.channelMessages.status,
        providerMessageId: schema.channelMessages.providerMessageId,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.id, outcome.channelMessageId));

    expect(row).toEqual({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'reply',
      templateKey: CONNECTOR_CONNECTED_TEMPLATE_KEY,
      dedupeKey: connectorConnectedDedupeKey(connectId),
      status: 'queued',
      providerMessageId: 'fake-out-1',
    });
    // The coach must be able to read back what Hale just said on this number.
    expect(threaded).toEqual([
      { familyId, parentUserId, body: CONNECTOR_CONNECTED_TEXT.gmail },
    ]);
  });

  it('is a no-op on a replayed callback: the same connect is never texted twice', async () => {
    await seedChannel();

    const first = await send('gcal');
    const second = await send('gcal');

    expect([connectedNoticeLabel(first), connectedNoticeLabel(second)]).toEqual([
      'sent',
      'already_sent',
    ]);
    expect(transport.sent).toHaveLength(1);
    expect(threaded).toHaveLength(1);
  });

  /**
   * A RECONNECT IS A SECOND CONNECT, and it earns its own receipt. The integration row
   * is upserted on (family, user, provider), so its id survives a disconnect and comes
   * back on the reconnect — keying the receipt on it would leave a parent who reconnects
   * from a text staring at a Connected page that never texts back. The key is the
   * connect itself, so the replay guard above and this both hold.
   */
  it('texts again when the parent disconnects and reconnects', async () => {
    await seedChannel();

    const first = await send('gcal');
    connectId = randomUUID();
    const reconnect = await send('gcal');

    expect([connectedNoticeLabel(first), connectedNoticeLabel(reconnect)]).toEqual([
      'sent',
      'sent',
    ]);
    expect(transport.sent).toHaveLength(2);
    expect(threaded).toHaveLength(2);
  });

  it('names the missing number rather than pretending it sent (rule #11)', async () => {
    // No parent_channels row at all: nothing to text, and nothing was claimed either —
    // the dedupe key must stay free for the retry that follows a verified number.
    const outcome = await send('gcal');

    expect(connectedNoticeLabel(outcome)).toBe('no_send_target');
    expect(transport.sent).toEqual([]);
    const rows = await db.database
      .select({ id: schema.channelMessages.id })
      .from(schema.channelMessages);
    expect(rows).toEqual([]);
  });

  it('names a provider refusal with its code, and keeps the key consumed', async () => {
    await seedChannel();
    ports = {
      ...ports,
      transport: {
        send: () => Promise.reject(new TwilioSendError('21610', 400)),
      },
    };

    const outcome = await send('gcal');

    expect(connectedNoticeLabel(outcome)).toBe('send_failed:21610');
    const [row] = await db.database
      .select({
        status: schema.channelMessages.status,
        errorCode: schema.channelMessages.errorCode,
        dedupeKey: schema.channelMessages.dedupeKey,
      })
      .from(schema.channelMessages);
    expect(row).toEqual({
      status: 'failed',
      errorCode: '21610',
      dedupeKey: connectorConnectedDedupeKey(connectId),
    });
    expect(threaded).toEqual([]);
  });

  it('never throws the redirect away when the path breaks under it', async () => {
    await seedChannel();
    ports = {
      ...ports,
      threadMessage: () => Promise.reject(new Error('conversation write failed')),
    };

    const outcome = await send('gcal');

    // Its own word, not `send_failed`: the throw landed AFTER the text left, so
    // claiming nothing was sent would be a guess the operator would act on.
    expect(connectedNoticeLabel(outcome)).toBe('errored');
    expect(transport.sent).toHaveLength(1);
  });

  it('wires a real transport in production, not just in the tests that inject one', () => {
    // Every test above hands in a fake, which can never fail on a missing default.
    const wired = defaultConnectedNoticePorts();
    expect(typeof wired.transport.send).toBe('function');
    expect(wired.threadMessage).toBe(threadProactiveMessage);
  });

  it('keeps both receipts inside one GSM-7 segment', () => {
    for (const body of Object.values(CONNECTOR_CONNECTED_TEXT)) {
      expect({ encoding: smsEncoding(body), segments: smsSegments(body) }).toEqual({
        encoding: 'gsm7',
        segments: 1,
      });
    }
  });
});
