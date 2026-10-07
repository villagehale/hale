import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeChannelSigninToken } from '~/lib/auth/channel-signin';
import { sendYearConnectorCards } from '~/lib/channel/intake/connector-offer';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { connectorLinkHandler } from '~/lib/channel/router/handlers';
import type { HandlerContext } from '~/lib/channel/router/route';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { offerConnectorLink, offerConnectorLinks } from './offer';

/**
 * The connector handoff's mint — a verified parent's "connect my calendar" becomes a
 * single-use sign-in link, an audit row, and one locked reply. Over REAL Postgres so
 * the enrollment gate, the token write and the audit write are the deployed SQL.
 *
 * Rule #11: every way this can decline to hand over a link is a NAMED outcome —
 * `not_enrolled`, `mint_failed` — never a silent fall-through.
 */

const NOW = new Date('2026-08-31T15:00:00.000Z');
const PHONE = '+14165550188';
const APP_KEY = Buffer.alloc(32, 7).toString('base64');

describe('offerConnectorLink', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;

  beforeEach(async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);
    db = await createTestDb();
    const seeded = await seedFamily(db.database);
    familyId = seeded.familyId;
    parentUserId = seeded.parentUserId;
    await db.database.insert(schema.parentChannels).values({
      userId: parentUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  it('mints a link for a verified parent, with the audit row beside it (rule #6)', async () => {
    const outcome = await offerConnectorLink(db.database, {
      familyId,
      parentUserId,
      provider: 'gcal',
      now: NOW,
    });

    if (outcome.status !== 'minted') throw new Error(`expected minted, got ${outcome.status}`);
    // The deep link is the point: `to` is what lets the redeem page skip Settings.
    expect(outcome.url).toMatch(
      /^https:\/\/app\.villagehale\.com\/connect\?t=[A-Za-z0-9_-]+&to=gcal$/,
    );

    const tokens = await db.database.select().from(schema.channelSigninTokens);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.userId).toBe(parentUserId);
    // The URL carries the raw token; the row holds only its digest.
    expect(outcome.url).not.toContain(tokens[0]?.tokenHash);

    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'connector_link_minted'));
    expect(audits).toHaveLength(1);
    expect(audits[0]?.familyId).toBe(familyId);
    expect(audits[0]?.actor).toBe(parentUserId);
    expect(audits[0]?.after).toEqual({ provider: 'gcal' });
    // Never the token, never the number (rule #1).
    expect(JSON.stringify(audits[0])).not.toContain(PHONE);
  });

  /**
   * The intake offer names both connectors, so it carries both links — and BOTH have to
   * still be alive when the text lands. This is the assertion that stops a mint whose
   * second call kills its own first link.
   */
  it('mints a live link per provider when one message offers two', async () => {
    const outcome = await offerConnectorLinks(db.database, {
      familyId,
      parentUserId,
      providers: ['gcal', 'gmail'],
      now: NOW,
    });

    if (outcome.status !== 'minted') throw new Error(`expected minted, got ${outcome.status}`);
    const [calendar, gmail] = outcome.urls;
    expect(calendar).toMatch(
      /^https:\/\/app\.villagehale\.com\/connect\?t=[A-Za-z0-9_-]+&to=gcal$/,
    );
    expect(gmail).toMatch(/^https:\/\/app\.villagehale\.com\/connect\?t=[A-Za-z0-9_-]+&to=gmail$/);
    expect(calendar).not.toBe(gmail);

    const tokens = await db.database.select().from(schema.channelSigninTokens);
    expect(tokens).toHaveLength(2);
    expect(tokens.map((row) => row.consumedAt)).toEqual([null, null]);

    // Rule #6: two capabilities, two rows, each naming the connector it was minted for.
    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, 'connector_link_minted'));
    expect(audits.map((row) => row.after)).toEqual(
      expect.arrayContaining([{ provider: 'gcal' }, { provider: 'gmail' }]),
    );
    expect(audits).toHaveLength(2);
  });

  /**
   * The year-open cards are TWO texts and ONE ask. Minting each card on its own
   * invalidated the calendar token the moment the Gmail card was minted, so the
   * calendar tap was dead on arrival and Gmail — the later mint — still worked.
   */
  it('keeps both year-card links redeemable after both texts have gone out', async () => {
    const transport = new FakeTransport();
    const outcome = await sendYearConnectorCards(
      db.database,
      {
        familyId,
        parentUserId,
        phoneE164: PHONE,
        language: 'en',
        now: NOW,
        ridesReply: true,
      },
      { transport, threadMessage: async () => 'conversation-id' },
    );

    expect(outcome).toEqual({ calendar: 'sent', gmail: 'sent' });
    const [calendarBody, gmailBody] = transport.bodies();
    const calendarToken = calendarBody?.match(/[?&]t=([A-Za-z0-9_-]+)/)?.[1];
    const gmailToken = gmailBody?.match(/[?&]t=([A-Za-z0-9_-]+)/)?.[1];
    if (!calendarToken || !gmailToken) throw new Error('expected a token in each card');
    expect(calendarBody).toContain('to=gcal');
    expect(gmailBody).toContain('to=gmail');

    await db.database
      .update(schema.users)
      .set({ externalAuthId: 'sms:year-card-test' })
      .where(eq(schema.users.id, parentUserId));
    const later = new Date(NOW.getTime() + 1000);
    expect((await consumeChannelSigninToken(calendarToken, db.database, { now: later })).ok).toBe(
      true,
    );
    expect((await consumeChannelSigninToken(gmailToken, db.database, { now: later })).ok).toBe(
      true,
    );
  });

  it('names not_enrolled when the channel is gone, and mints nothing', async () => {
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: NOW })
      .where(eq(schema.parentChannels.userId, parentUserId));

    const outcome = await offerConnectorLink(db.database, {
      familyId,
      parentUserId,
      provider: 'gcal',
      now: NOW,
    });
    expect(outcome).toEqual({ status: 'not_enrolled' });
    expect(await db.database.select().from(schema.channelSigninTokens)).toHaveLength(0);
    expect(await db.database.select().from(schema.auditLog)).toHaveLength(0);
  });

  it('names not_enrolled for a non-parent role', async () => {
    await db.database
      .update(schema.familyMembers)
      .set({ role: 'extended' })
      .where(eq(schema.familyMembers.userId, parentUserId));

    const outcome = await offerConnectorLink(db.database, {
      familyId,
      parentUserId,
      provider: 'gmail',
      now: NOW,
    });
    expect(outcome).toEqual({ status: 'not_enrolled' });
  });

  it('names mint_failed when the write cannot land', async () => {
    await db.exec('DROP TABLE channel_signin_tokens');

    const outcome = await offerConnectorLink(db.database, {
      familyId,
      parentUserId,
      provider: 'gcal',
      now: NOW,
    });
    expect(outcome.status).toBe('mint_failed');
  });
});

describe('connectorLinkHandler', () => {
  let db: TestDb;
  let familyId: string;
  let parentUserId: string;

  beforeEach(async () => {
    vi.stubEnv('APP_ENCRYPTION_KEY', APP_KEY);
    db = await createTestDb();
    const seeded = await seedFamily(db.database);
    familyId = seeded.familyId;
    parentUserId = seeded.parentUserId;
    await db.database.insert(schema.parentChannels).values({
      userId: parentUserId,
      familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(PHONE),
      phoneE164Hash: phoneBlindIndex(PHONE),
      verifiedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.close();
  });

  function turn(body: string, conversationId = 'conv-1'): HandlerContext {
    return {
      familyId,
      parentUserId,
      conversationId,
      body,
      // This handler answers through its verdict; a self-send here would be a bug.
      send: async () => {
        throw new Error('connector handler must not send for itself');
      },
      now: NOW,
      resolved: null,
      openQuestions: async () => [],
      inboundChannelMessageId: 'channel-message-1',
    };
  }

  it("claims the founder's exact ask and replies with the link", async () => {
    const verdict = await connectorLinkHandler().handle(
      db.database,
      turn('I want you to connect my Google Calendar'),
    );

    if (!verdict.claimed) throw new Error('expected the handler to claim');
    expect(verdict.outcome).toBe('sent');
    expect(verdict.reply).toContain('https://app.villagehale.com/connect?t=');
    expect(verdict.reply).toContain('Google Calendar');
    expect(verdict.reply).toContain('Good for 15 minutes.');
  });

  it('answers a French ask with the French twin', async () => {
    const verdict = await connectorLinkHandler().handle(
      db.database,
      turn('Connecte mon Google Agenda svp'),
    );
    if (!verdict.claimed) throw new Error('expected the handler to claim');
    expect(verdict.reply).toContain('Google Agenda');
    expect(verdict.reply).toContain('Bon pour 15 minutes.');
  });

  it("does NOT mint for a question about the calendar's contents", async () => {
    const verdict = await connectorLinkHandler().handle(
      db.database,
      turn("what's on my calendar this week"),
    );
    expect(verdict.claimed).toBe(false);
    // The must-not-mint half: no token, no audit row, nothing to leak.
    expect(await db.database.select().from(schema.channelSigninTokens)).toHaveLength(0);
    expect(await db.database.select().from(schema.auditLog)).toHaveLength(0);
  });

  async function threadOffer(content: string, earlier?: string): Promise<string> {
    const [conversation] = await db.database
      .insert(schema.conversations)
      .values({ familyId })
      .returning({ id: schema.conversations.id });
    if (!conversation) throw new Error('expected a conversation');
    if (earlier) {
      await db.database.insert(schema.messages).values({
        conversationId: conversation.id,
        role: 'assistant',
        content: earlier,
        createdAt: new Date('2026-08-31T14:00:00.000Z'),
      });
    }
    await db.database.insert(schema.messages).values({
      conversationId: conversation.id,
      role: 'assistant',
      content,
      createdAt: new Date('2026-08-31T14:05:00.000Z'),
    });
    return conversation.id;
  }

  const GMAIL_OFFER =
    'Connect Gmail: https://app.villagehale.com/connect?t=old-gmail&to=gmail Good for 15 minutes.';
  const CALENDAR_OFFER =
    'Connect your calendar: https://app.villagehale.com/connect?t=old-gcal&to=gcal Good for 15 minutes.';

  it.each(['give me a fresh one', 'new link', 'it expired'])(
    'mints a fresh Gmail link for %j instead of telling them what to text',
    async (body) => {
      const conversationId = await threadOffer(GMAIL_OFFER);
      const verdict = await connectorLinkHandler().handle(db.database, turn(body, conversationId));
      if (!verdict.claimed) throw new Error('expected the handler to claim');
      expect(verdict.outcome).toBe('sent');
      expect(verdict.reply).toContain('tap to connect your Gmail');
      expect(verdict.reply).toContain('to=gmail');
      expect(verdict.reply).toContain('Good for 15 minutes.');
      expect(verdict.reply).not.toMatch(/text me the words/i);
      expect(verdict.reply).not.toContain('old-gmail');
      const tokens = await db.database.select().from(schema.channelSigninTokens);
      expect(tokens).toHaveLength(1);
      const audits = await db.database
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.actionTaken, 'connector_link_minted'));
      expect(audits.map((row) => row.after)).toEqual([{ provider: 'gmail' }]);
    },
  );

  it('mints a fresh calendar link when that was the offer', async () => {
    const conversationId = await threadOffer(CALENDAR_OFFER);
    const verdict = await connectorLinkHandler().handle(
      db.database,
      turn('give me a fresh one', conversationId),
    );
    if (!verdict.claimed) throw new Error('expected the handler to claim');
    expect(verdict.reply).toContain('tap to connect your Google Calendar');
    expect(verdict.reply).toContain('to=gcal');
    expect(verdict.reply).not.toContain('old-gcal');
  });

  it('does not mint a fresh link when the last Hale message was not a connect link', async () => {
    const conversationId = await threadOffer('What should I call you?', GMAIL_OFFER);
    const verdict = await connectorLinkHandler().handle(
      db.database,
      turn('new link', conversationId),
    );
    expect(verdict.claimed).toBe(false);
    expect(await db.database.select().from(schema.channelSigninTokens)).toHaveLength(0);
  });

  it('does not mint when nothing was offered', async () => {
    const [conversation] = await db.database
      .insert(schema.conversations)
      .values({ familyId })
      .returning({ id: schema.conversations.id });
    if (!conversation) throw new Error('expected a conversation');
    const verdict = await connectorLinkHandler().handle(
      db.database,
      turn('it expired', conversation.id),
    );
    expect(verdict.claimed).toBe(false);
    expect(await db.database.select().from(schema.channelSigninTokens)).toHaveLength(0);
  });

  it('answers a mint failure honestly rather than deferring the turn (mint_failed named)', async () => {
    await db.exec('DROP TABLE channel_signin_tokens');
    const verdict = await connectorLinkHandler().handle(
      db.database,
      turn('connect my google calendar'),
    );
    if (!verdict.claimed) throw new Error('expected the handler to claim');
    expect(verdict.outcome).toBe('mint_failed');
    expect(verdict.reply).toContain('nothing was changed');
  });

  it('sends the link 1:1 and says nothing in the group when the ask came from the family group', async () => {
    const GROUP = 'chat-family-group';
    const PERSONAL = 'chat-parent-direct';
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, familyId));
    const rows: Record<string, string> = {};
    for (const [chatId, at] of [
      [PERSONAL, new Date('2026-08-31T14:00:00.000Z')],
      [GROUP, new Date('2026-08-31T14:59:00.000Z')],
    ] as const) {
      const [row] = await db.database
        .insert(schema.channelMessages)
        .values({
          familyId,
          parentUserId,
          channel: 'imessage',
          direction: 'in',
          category: 'reply',
          providerMessageId: `in-${chatId}`,
          providerChatId: chatId,
          status: 'delivered',
          body: 'connect my google calendar',
          sentAt: at,
          createdAt: at,
        })
        .returning({ id: schema.channelMessages.id });
      rows[chatId] = row?.id as string;
    }
    const wire: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        wire.push({ url: String(url), body: String(init?.body ?? '') });
        return Response.json({ message: { id: 'out-1' } });
      }),
    );

    const verdict = await connectorLinkHandler().handle(db.database, {
      ...turn('connect my google calendar'),
      inboundChannelMessageId: rows[GROUP] as string,
    });

    expect(verdict).toEqual({ claimed: true, outcome: 'sent_1to1', reply: null });
    expect(wire).toHaveLength(1);
    expect(wire[0]?.url).toContain(`/chats/${PERSONAL}/messages`);
    expect(wire[0]?.body).toContain('to=gcal');
    expect(wire.some((call) => call.url.includes(GROUP))).toBe(false);
    vi.unstubAllGlobals();
  });

  async function inboundIn(chatId: string, at: Date): Promise<string> {
    const [row] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'imessage',
        direction: 'in',
        category: 'reply',
        providerMessageId: `in-${chatId}`,
        providerChatId: chatId,
        status: 'delivered',
        body: 'give me a fresh one',
        sentAt: at,
        createdAt: at,
      })
      .returning({ id: schema.channelMessages.id });
    return row?.id as string;
  }

  it('asked again for both links in the group: one 1:1 text carries both, and both still work', async () => {
    const GROUP = 'chat-family-group';
    const PERSONAL = 'chat-parent-direct';
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, familyId));
    await inboundIn(PERSONAL, new Date('2026-08-31T14:00:00.000Z'));
    const groupRow = await inboundIn(GROUP, new Date('2026-08-31T14:59:00.000Z'));
    const conversationId = await threadOffer(
      'Calendar: https://app.villagehale.com/connect?t=old-gcal&to=gcal Gmail: https://app.villagehale.com/connect?t=old-gmail&to=gmail',
    );
    const wire: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        wire.push({ url: String(url), body: String(init?.body ?? '') });
        return Response.json({ message: { id: `out-${wire.length}` } });
      }),
    );

    const verdict = await connectorLinkHandler().handle(db.database, {
      ...turn('give me a fresh one', conversationId),
      inboundChannelMessageId: groupRow,
    });

    expect(verdict).toEqual({ claimed: true, outcome: 'sent_1to1', reply: null });
    expect(wire).toHaveLength(1);
    expect(wire[0]?.url).toContain(`/chats/${PERSONAL}/messages`);
    expect(wire[0]?.body).toContain('to=gcal');
    expect(wire[0]?.body).toContain('to=gmail');
    const tokens = await db.database
      .select({ consumedAt: schema.channelSigninTokens.consumedAt })
      .from(schema.channelSigninTokens);
    expect(tokens.map((row) => row.consumedAt)).toEqual([null, null]);
    vi.unstubAllGlobals();
  });

  it('a parent whose only thread with Hale is the group gets no_chat, not a link-less text called sent', async () => {
    const GROUP = 'chat-family-group';
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    vi.stubEnv('LINQ_FROM_E164', '+14165550100');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: GROUP })
      .where(eq(schema.families.id, familyId));
    const groupRow = await inboundIn(GROUP, new Date('2026-08-31T14:59:00.000Z'));
    const wire: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        wire.push(String(url));
        return Response.json({ chat: { id: 'direct-new', message: { id: 'out-1' } } });
      }),
    );

    const verdict = await connectorLinkHandler().handle(db.database, {
      ...turn('connect my google calendar'),
      inboundChannelMessageId: groupRow,
    });

    expect(verdict).toEqual({ claimed: true, outcome: 'group_1to1_no_chat', reply: null });
    expect(wire).toEqual([]);
    const outbound = await db.database
      .select({ channel: schema.channelMessages.channel })
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.direction, 'out'));
    expect(outbound).toEqual([]);
    vi.unstubAllGlobals();
  });
});
