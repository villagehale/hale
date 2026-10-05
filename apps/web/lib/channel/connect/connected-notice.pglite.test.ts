import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
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
    expect(transport.sent[0]).toEqual({ to: PHONE, body: CONNECTOR_CONNECTED_TEXT.gcal });
    expect(transport.sent[1]?.body).toContain('to=gmail');
    expect(transport.sent[1]?.body).toContain('unverified app');
    expect(transport.sent).toHaveLength(2);
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
    expect(threaded).toEqual([{ familyId, parentUserId, body: CONNECTOR_CONNECTED_TEXT.gmail }]);
  });

  it('is a no-op on a replayed callback: the same connect is never texted twice', async () => {
    await seedChannel();

    const first = await send('gcal');
    const second = await send('gcal');

    expect([connectedNoticeLabel(first), connectedNoticeLabel(second)]).toEqual([
      'sent',
      'already_sent',
    ]);
    expect(transport.sent).toHaveLength(2);
    expect(threaded).toHaveLength(2);
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
    // The Gmail card is one per family. The reconnect texts the receipt again.
    expect(transport.sent).toHaveLength(3);
    expect(threaded).toHaveLength(3);
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
        send: () => Promise.reject(new LinqSendError('21610', 400, true)),
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

  it('sends the Gmail card in the same iMessage chat as the calendar receipt', async () => {
    await seedChannel();
    const chatId = '8f392755-6865-4b18-880a-227f9d8b458f';
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerMessageId: 'msg-in-parent',
      providerChatId: chatId,
      status: 'delivered',
      body: 'hello',
      sentAt: new Date('2026-09-23T22:40:00.000Z'),
    });
    const imessage = vi.fn(async () => ({ providerMessageId: 'msg-out-linq' }));
    ports = { ...ports, imessage };

    const outcome = await send('gcal');

    expect(connectedNoticeLabel(outcome)).toBe('sent');
    expect(transport.sent).toEqual([]);
    expect(imessage).toHaveBeenCalledTimes(2);
    const calls = imessage.mock.calls as unknown as Array<[{ chatId: string; body: string }]>;
    expect(calls[0]?.[0]).toMatchObject({
      chatId,
      body: CONNECTOR_CONNECTED_TEXT.gcal,
    });
    expect(calls[1]?.[0]?.body).toContain('to=gmail');
    expect(calls[1]?.[0]?.chatId).toBe(chatId);
  });

  it('sends an iMessage family the receipt in the stored Linq chat, not over Twilio', async () => {
    await seedChannel();
    const chatId = '8f392755-6865-4b18-880a-227f9d8b458f';
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerMessageId: 'msg-in-parent',
      providerChatId: chatId,
      status: 'delivered',
      body: 'hello',
      sentAt: new Date('2026-09-23T22:40:00.000Z'),
    });
    const imessage = vi.fn(async () => ({ providerMessageId: 'msg-out-linq' }));
    ports = { ...ports, imessage };

    const outcome = await send('gmail');
    if (outcome.status !== 'sent') throw new Error(`expected sent, got ${outcome.status}`);

    expect(transport.sent).toEqual([]);
    expect(imessage).toHaveBeenCalledWith({
      chatId,
      body: CONNECTOR_CONNECTED_TEXT.gmail,
    });
    const [row] = await db.database
      .select({
        channel: schema.channelMessages.channel,
        providerChatId: schema.channelMessages.providerChatId,
        providerMessageId: schema.channelMessages.providerMessageId,
        status: schema.channelMessages.status,
        body: schema.channelMessages.body,
      })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.id, outcome.channelMessageId));
    expect(row).toEqual({
      channel: 'imessage',
      providerChatId: chatId,
      providerMessageId: 'msg-out-linq',
      status: 'sent',
      body: null,
    });
  });

  it('stays on Twilio when the latest turn was SMS, even if an older iMessage chat exists', async () => {
    await seedChannel();
    await db.database.insert(schema.channelMessages).values([
      {
        familyId,
        parentUserId,
        channel: 'imessage',
        direction: 'in',
        category: 'reply',
        providerChatId: '8f392755-6865-4b18-880a-227f9d8b458f',
        status: 'delivered',
        sentAt: new Date('2026-09-23T20:00:00.000Z'),
        createdAt: new Date('2026-09-23T20:00:00.000Z'),
      },
      {
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        sentAt: new Date('2026-09-23T22:00:00.000Z'),
        createdAt: new Date('2026-09-23T22:00:00.000Z'),
      },
    ]);
    const imessage = vi.fn(async () => ({ providerMessageId: 'should-not-send' }));
    ports = { ...ports, imessage };

    const outcome = await send('gmail');

    expect(connectedNoticeLabel(outcome)).toBe('sent');
    expect(transport.sent).toEqual([{ to: PHONE, body: CONNECTOR_CONNECTED_TEXT.gmail }]);
    expect(imessage).not.toHaveBeenCalled();
  });

  it('names a missing Linq chat and does not fall through to Twilio', async () => {
    await seedChannel();
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      providerChatId: null,
      status: 'delivered',
      sentAt: new Date('2026-09-23T22:00:00.000Z'),
    });
    const imessage = vi.fn(async () => ({ providerMessageId: 'should-not-send' }));
    ports = { ...ports, imessage };

    const outcome = await send('gcal');

    expect(connectedNoticeLabel(outcome)).toBe('no_chat');
    expect(transport.sent).toEqual([]);
    expect(imessage).not.toHaveBeenCalled();
    const rows = await db.database
      .select({ id: schema.channelMessages.id })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.direction, 'out'));
    expect(rows).toEqual([]);
  });

  function calendarItem(title: string, start: string, end: string) {
    return { title, start, end, allDay: false, location: null, declined: false };
  }

  it('hands the model only kid items: a clash between two kid activities is kept, the parent appointment is not', async () => {
    vi.stubEnv('ONBOARDING_FRIEND_VOICE_ENABLED', 'on');
    await seedChannel();
    await seedChild(db.database, familyId, 'Maya', 48, undefined, NOW);
    const seen: Array<{ titles: string[]; overlaps: Array<{ earlier: string; later: string }> }> =
      [];
    ports = {
      ...ports,
      friendVoice: {
        async compose(input) {
          if (input.step === 'email') {
            return { reply: 'Want me to watch school and camp email for the dates?' };
          }
          const synced = input.synced;
          seen.push({
            titles: (synced?.calendar ?? []).map((item) => item.title),
            overlaps: synced?.overlaps ?? [],
          });
          const clash = synced?.overlaps[0];
          return {
            reply: clash
              ? `${clash.earlier} runs into ${clash.later} that Saturday. I can remind you the evening before.`
              : 'Your calendar is connected.',
            ahaMention: clash?.earlier ?? null,
          };
        },
      },
    };

    const outcome = await sendConnectorConnectedText(
      db.database,
      {
        familyId,
        parentUserId,
        provider: 'gcal',
        connectId,
        now: NOW,
        aha: {
          provider: 'gcal',
          read: 'ok',
          calendar: [
            calendarItem(
              'Swim at the rec centre',
              '2026-09-12T13:00:00.000Z',
              '2026-09-12T14:00:00.000Z',
            ),
            calendarItem('Maya soccer', '2026-09-12T13:30:00.000Z', '2026-09-12T14:30:00.000Z'),
            calendarItem('Dentist', '2026-09-12T13:45:00.000Z', '2026-09-12T14:45:00.000Z'),
            calendarItem('Budget review', '2026-09-14T13:00:00.000Z', '2026-09-14T14:00:00.000Z'),
          ],
          email: [],
          overlaps: [
            { earlier: 'Swim at the rec centre', later: 'Maya soccer' },
            { earlier: 'Maya soccer', later: 'Dentist' },
          ],
        },
      },
      ports,
    );

    expect(connectedNoticeLabel(outcome)).toBe('sent');
    expect(seen).toEqual([
      {
        titles: ['Swim at the rec centre', 'Maya soccer'],
        overlaps: [{ earlier: 'Swim at the rec centre', later: 'Maya soccer' }],
      },
    ]);
    const receipt = transport.sent[0]?.body ?? '';
    expect(receipt).toContain('Swim at the rec centre');
    expect(receipt).toContain('Maya soccer');
    expect(receipt).not.toContain('Dentist');
    expect(receipt).not.toContain('Budget review');
    expect(receipt).not.toMatch(/\?/);
  });

  it('says nothing from a calendar that holds only the parent: no wow, a plain receipt', async () => {
    vi.stubEnv('ONBOARDING_FRIEND_VOICE_ENABLED', 'on');
    await seedChannel();
    await seedChild(db.database, familyId, 'Maya', 48, undefined, NOW);
    const reads: string[] = [];
    ports = {
      ...ports,
      friendVoice: {
        async compose(input) {
          if (input.step === 'email') {
            return { reply: 'Want me to watch school and camp email for the dates?' };
          }
          reads.push(input.synced?.read ?? 'missing');
          expect(input.synced?.calendar).toEqual([]);
          expect(input.synced?.overlaps).toEqual([]);
          return { reply: 'Your calendar is connected.', ahaMention: null };
        },
      },
    };

    const outcome = await sendConnectorConnectedText(
      db.database,
      {
        familyId,
        parentUserId,
        provider: 'gcal',
        connectId,
        now: NOW,
        aha: {
          provider: 'gcal',
          read: 'ok',
          calendar: [
            calendarItem('Dentist', '2026-09-12T13:00:00.000Z', '2026-09-12T14:00:00.000Z'),
            calendarItem('Team standup', '2026-09-12T13:30:00.000Z', '2026-09-12T14:00:00.000Z'),
            calendarItem('Budget review', '2026-09-14T13:00:00.000Z', '2026-09-14T14:00:00.000Z'),
          ],
          email: [],
          overlaps: [{ earlier: 'Dentist', later: 'Team standup' }],
        },
      },
      ports,
    );

    expect(connectedNoticeLabel(outcome)).toBe('sent');
    expect(reads).toEqual(['none_for_kids']);
    const receipt = transport.sent[0]?.body ?? '';
    expect(receipt).toBe('Your calendar is connected.');
    expect(receipt).not.toMatch(/Dentist|standup|Budget/);
  });

  it('says nothing from a mailbox that holds only the parent: receipts and work mail never reach the model', async () => {
    vi.stubEnv('ONBOARDING_FRIEND_VOICE_ENABLED', 'on');
    await seedChannel();
    await seedChild(db.database, familyId, 'Maya', 48, undefined, NOW);
    const reads: string[] = [];
    ports = {
      ...ports,
      friendVoice: {
        async compose(input) {
          if (input.step === 'calendar') {
            return { reply: 'Want me to check your calendar?' };
          }
          reads.push(input.synced?.read ?? 'missing');
          expect(input.synced?.email).toEqual([]);
          return { reply: 'Gmail is connected.', ahaMention: null };
        },
      },
    };

    const outcome = await sendConnectorConnectedText(
      db.database,
      {
        familyId,
        parentUserId,
        provider: 'gmail',
        connectId,
        now: NOW,
        aha: {
          provider: 'gmail',
          read: 'ok',
          calendar: [],
          email: [
            {
              subject: 'Your Amazon order has shipped',
              fromName: 'Amazon',
              receivedAt: '2026-09-11T12:00:00.000Z',
              snippet: 'Arriving Thursday.',
            },
            {
              subject: 'Q3 planning deck',
              fromName: 'Priya (work)',
              receivedAt: '2026-09-11T13:00:00.000Z',
              snippet: 'Comments by Friday please.',
            },
            {
              subject: 'Your lab results are ready',
              fromName: 'Clinic',
              receivedAt: '2026-09-11T14:00:00.000Z',
              snippet: 'Log in to view.',
            },
          ],
          overlaps: [],
        },
      },
      ports,
    );

    expect(connectedNoticeLabel(outcome)).toBe('sent');
    expect(reads).toEqual(['none_for_kids']);
    const receipt = transport.sent[0]?.body ?? '';
    expect(receipt).toBe('Gmail is connected.');
    expect(receipt).not.toMatch(/Amazon|planning deck|lab results/);
  });

  it('wires a real transport in production, not just in the tests that inject one', () => {
    // Every test above hands in a fake, which can never fail on a missing default.
    const wired = defaultConnectedNoticePorts();
    expect(typeof wired.transport.send).toBe('function');
    expect(typeof wired.imessage).toBe('function');
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
