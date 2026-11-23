import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendGoogleConnectorCard } from '~/lib/channel/intake/connector-offer';
import type { FriendVoiceComposer } from '~/lib/channel/intake/friend-voice';
import { placeHold } from '~/lib/channel/intake/opt-out-hold';
import {
  type FirstTouchPersisted,
  createSession,
  loadOpenSessionByFamily,
  saveSession,
} from '~/lib/channel/intake/session';
import {
  type ChannelTransport,
  FakeTransport,
  type OutboundMessage,
} from '~/lib/channel/intake/transport';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { scriptedSaidLine } from '~/lib/channel/voice/scripted-said-line.fixture';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  CONNECTOR_CONNECTED_TEMPLATE_KEY,
  type ConnectedNoticePorts,
  sendConnectorConnectedText,
} from './connected-notice';
import { FRESH_CONNECTOR_LINK_TEMPLATE_KEY, textFreshConnectorLink } from './fresh-link';

/**
 * VIL-721 · every text the one Google link adds, on real Postgres. A row says sent only
 * once Linq took the text; one provider key covers a retry of a send that may have landed;
 * a certain refusal is told apart from an unclear failure; and a stop, an erasure or a
 * line hold that arrives before the send stops it.
 */

const NOW = new Date('2026-10-14T17:00:00.000Z');
const LATER = new Date(NOW.getTime() + 60_000);
const PHONE = '+15555550143';
const OTHER_PHONE = '+15555550144';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');
const PROSE = 'Google prose (test fixture).';
const CARD_TEMPLATE = 'intake:google_card';

const REFUSED = () => new LinqSendError('2001', 400, true);
const UNCLEAR = () => new LinqSendError('timeout', 0, false);

const voice: FriendVoiceComposer = {
  async compose() {
    return { reply: 'Receipt (test fixture).' };
  },
};

type Send = (input: OutboundMessage) => Promise<{ providerMessageId: string }>;

function transportOf(send: Send): ChannelTransport & { calls: OutboundMessage[] } {
  const calls: OutboundMessage[] = [];
  return {
    calls,
    async send(input) {
      calls.push(input);
      return send(input);
    },
  };
}

describe('the texts the one Google link adds', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;

  // One database for the file: a fresh pglite per case costs seconds each.
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
    vi.stubEnv('FRIEND_VOICE_MODEL_FIELDS_ENABLED', 'false');
    // The Linq preview bubble is refused, so a link goes once, as its own text.
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: { code: 2001 } }, { status: 400 })),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await db.exec(
      'truncate table families, users, sms_intake_sessions, opt_out_held_messages cascade',
    );
  });

  const rowsOf = (templateKey: string) =>
    db.database
      .select()
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.familyId, familyId),
          eq(schema.channelMessages.templateKey, templateKey),
        ),
      );

  const card = (transport: ChannelTransport, now = NOW) =>
    sendGoogleConnectorCard(
      db.database,
      { familyId, parentUserId, phoneE164: PHONE, now, ridesReply: true, voice: PROSE },
      { transport, threadMessage: async () => 'conversation-id' },
    );

  const fresh = (transport: ChannelTransport) =>
    textFreshConnectorLink(
      db.database,
      { familyId, parentUserId, provider: 'google', now: NOW },
      {
        transport,
        threadMessage: async () => 'conversation-id',
        saidLine: scriptedSaidLine(),
      },
    );

  const noticePorts = (transport: ChannelTransport): ConnectedNoticePorts => ({
    transport,
    friendVoice: voice,
    threadMessage: async () => 'conversation-id',
  });

  const receipt = (transport: ChannelTransport, connectId = randomUUID()) =>
    sendConnectorConnectedText(
      db.database,
      { familyId, parentUserId, provider: 'google', connectId, now: NOW, fromBundle: true },
      noticePorts(transport),
    );

  const senders = [
    { name: 'the card', template: CARD_TEMPLATE, go: (t: ChannelTransport) => card(t) },
    {
      name: 'the fresh link',
      template: FRESH_CONNECTOR_LINK_TEMPLATE_KEY,
      go: (t: ChannelTransport) => fresh(t),
    },
    {
      name: 'the receipt',
      template: CONNECTOR_CONNECTED_TEMPLATE_KEY,
      go: (t: ChannelTransport) => receipt(t),
    },
  ];

  describe.each(senders)('$name', ({ template, go }) => {
    it('claims nothing while Linq has the text, and says sent only once Linq took it', async () => {
      const during: { status: string; errorCode: string | null; sentAt: Date | null }[] = [];
      const transport = transportOf(async () => {
        const rows = await rowsOf(template);
        during.push(
          ...rows.map((row) => ({
            status: row.status,
            errorCode: row.errorCode,
            sentAt: row.sentAt,
          })),
        );
        return { providerMessageId: 'linq-accepted' };
      });

      await go(transport);

      expect(during[0]).toEqual({ status: 'failed', errorCode: 'send_in_flight', sentAt: null });
      const [row] = await rowsOf(template);
      expect(row).toMatchObject({
        status: 'queued',
        errorCode: null,
        providerMessageId: 'linq-accepted',
      });
      expect(row?.sentAt).toEqual(NOW);
      expect(transport.calls[0]?.sendKey).toBe(row?.id);
      const audit = await db.database
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, row?.id ?? ''));
      expect(audit.map((entry) => [entry.actionTaken, entry.audience])).toEqual([
        ['sms_reply_sent', parentUserId],
      ]);
    });

    it('marks an unclear failure as maybe landed, never sent', async () => {
      await go(
        transportOf(async () => {
          throw UNCLEAR();
        }),
      );

      const [row] = await rowsOf(template);
      expect(row).toMatchObject({ status: 'failed', errorCode: 'unconfirmed:timeout' });
      expect(row?.providerMessageId).toBeNull();
      expect(row?.sentAt).toBeNull();
    });

    it('marks a certain refusal as refused, with the code Linq gave', async () => {
      await go(
        transportOf(async () => {
          throw REFUSED();
        }),
      );

      const [row] = await rowsOf(template);
      expect(row).toMatchObject({ status: 'failed', errorCode: '2001', dedupeKey: null });
      expect(row?.sentAt).toBeNull();
    });

    it.each(['stopped', 'erasure', 'held'] as const)(
      'sends nothing to a parent who is %s by send time, and leaves no row claiming it',
      async (gate) => {
        if (gate === 'stopped') {
          await db.database
            .update(schema.parentChannels)
            .set({ revokedAt: NOW })
            .where(eq(schema.parentChannels.userId, parentUserId));
        }
        if (gate === 'erasure') {
          await db.database
            .update(schema.families)
            .set({ scheduledDeletionAt: LATER })
            .where(eq(schema.families.id, familyId));
        }
        if (gate === 'held') {
          await placeHold(db.database, {
            phoneHash: phoneBlindIndex(PHONE),
            providerMessageId: 'held-text',
            heldAt: NOW,
            nextReadAt: NOW,
          });
        }
        const transport = new FakeTransport();

        await go(transport);

        expect(transport.sent).toEqual([]);
        const rows = await rowsOf(template);
        expect(rows.filter((row) => row.status !== 'failed')).toEqual([]);
        expect(rows.filter((row) => row.errorCode === 'send_in_flight')).toEqual([]);
      },
    );
  });

  describe('a retry of the card', () => {
    it('reuses the provider key after an unclear failure, so a landed text is not doubled', async () => {
      const first = transportOf(async () => {
        throw UNCLEAR();
      });
      await card(first);
      const second = new FakeTransport();

      const label = await card(second, LATER);

      expect(label).toBe('sent');
      expect(first.calls[0]?.sendKey).toBeTruthy();
      expect(second.sent[0]?.sendKey).toBe(first.calls[0]?.sendKey);
      expect(await rowsOf(CARD_TEMPLATE)).toHaveLength(1);
    });

    it('uses a new provider key after a certain refusal', async () => {
      const first = transportOf(async () => {
        throw REFUSED();
      });
      await card(first);
      const second = new FakeTransport();

      const label = await card(second, LATER);

      expect(label).toBe('sent');
      expect(second.sent[0]?.sendKey).toBeTruthy();
      expect(second.sent[0]?.sendKey).not.toBe(first.calls[0]?.sendKey);
    });

    it('does not send again once Linq took it', async () => {
      await card(new FakeTransport());
      const second = new FakeTransport();

      expect(await card(second, LATER)).toBe('already_sent');
      expect(second.sent).toEqual([]);
    });

    it('keeps the words as sent when only the link fails, and frees the offer for its link', async () => {
      let call = 0;
      const transport = transportOf(async () => {
        call += 1;
        if (call === 2) throw REFUSED();
        return { providerMessageId: 'linq-prose' };
      });

      const label = await card(transport);

      expect(label).toBe('link_unsent');
      const [row] = await rowsOf(CARD_TEMPLATE);
      expect(row).toMatchObject({
        status: 'queued',
        providerMessageId: 'linq-prose',
        errorCode: null,
        dedupeKey: null,
      });
      const retry = new FakeTransport();
      expect(await card(retry, LATER)).toBe('sent');
      expect(retry.sent.map((message) => message.body)).toEqual([
        PROSE,
        expect.stringContaining('to=google'),
      ]);
    });
  });

  describe('a co-parent’s connect', () => {
    let otherUserId: string;

    beforeEach(async () => {
      const [other] = await db.database
        .insert(schema.users)
        .values({ externalAuthId: 'sms:other-parent', name: 'Other parent' })
        .returning({ id: schema.users.id });
      otherUserId = other?.id as string;
      await db.database
        .insert(schema.familyMembers)
        .values({ familyId, userId: otherUserId, role: 'co_parent' });
      await db.database.insert(schema.parentChannels).values({
        userId: otherUserId,
        familyId,
        kind: 'sms',
        phoneE164Encrypted: encryptString(OTHER_PHONE),
        phoneE164Hash: phoneBlindIndex(OTHER_PHONE),
        verifiedAt: new Date('2026-10-01T00:00:00.000Z'),
      });
    });

    it('never lands on the other parent’s onboarding, and asks nothing from it', async () => {
      const opened = await createSession(db.database, {
        phoneE164: PHONE,
        state: 'awaiting_details',
        sourceCode: null,
      });
      const firstTouch = {
        language: 'en',
        place: null,
        locationRequest: null,
        given: { parentName: 'First parent' },
        coldStart: {
          step: 'follow',
          group: false,
          findBody: '1. Swim - Saturday',
          activity: null,
          day: null,
          nameLineSent: true,
          signupDateKnown: false,
          signupAsked: false,
          calendarAsked: false,
          emailAsked: false,
          schoolMentioned: false,
        },
      } as unknown as FirstTouchPersisted;
      await saveSession(
        db.database,
        opened,
        { familyId, userId: parentUserId, firstTouch },
        NOW,
      );
      const heard: (string | null | undefined)[] = [];
      const transport = new FakeTransport();

      await sendConnectorConnectedText(
        db.database,
        {
          familyId,
          parentUserId: otherUserId,
          provider: 'google',
          connectId: randomUUID(),
          now: NOW,
          fromBundle: true,
        },
        {
          ...noticePorts(transport),
          friendVoice: {
            async compose(input) {
              heard.push(input.parentName);
              return { reply: 'Receipt (test fixture).' };
            },
          },
        },
      );

      expect(transport.sent.map((message) => message.to)).toEqual([OTHER_PHONE]);
      expect(heard).toHaveLength(1);
      expect(heard[0]).not.toBe('First parent');
      const after = await loadOpenSessionByFamily(db.database, familyId);
      expect(after?.firstTouch?.given?.parentName).toBe('First parent');
      expect(after?.firstTouch?.given?.connectGoogle).toBeUndefined();
      expect(after?.firstTouch?.coldStart?.googleOffered).toBeUndefined();
      expect(after?.transcript).toEqual([]);
    });
  });
});
