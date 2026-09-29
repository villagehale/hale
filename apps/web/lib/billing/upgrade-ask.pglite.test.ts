import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { maybeOfferYearRetention, prepareYearRetentionAnswer } from './upgrade-ask.js';
import { YEAR_RETENTION_COPY } from './upgrade-copy.js';

/**
 * The ask and the yes/no land on real Postgres: the unique offer row, the
 * ledger, and the audit. Stripe and Linq are injected.
 */

const DIRECT = 'chat-direct';
const NOW = new Date('2026-09-28T15:00:00.000Z');

describe('year retention on postgres', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(() => {
    vi.stubEnv('IMESSAGE_UPGRADE_ASK', 'on');
    vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
  });

  async function family(input: { stage?: string; group?: string | null; replies?: number } = {}) {
    const seeded = await seedFamily(db.database);
    await db.database
      .update(schema.families)
      .set({
        onboardingStage: (input.stage ?? 'sms_active') as 'sms_active',
        linqGroupChatId: input.group === undefined ? `group-${seeded.familyId}` : input.group,
        planTier: 'free',
      })
      .where(eq(schema.families.id, seeded.familyId));
    const replies = input.replies ?? 1;
    for (let i = 0; i < replies; i += 1) {
      await db.database.insert(schema.channelMessages).values({
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        channel: 'imessage',
        direction: 'out',
        category: 'reply',
        status: 'sent',
        providerChatId: DIRECT,
        providerMessageId: `prior-${seeded.familyId}-${i}`,
        sentAt: NOW,
      });
    }
    return seeded;
  }

  function sender(log: Array<{ chatId: string; text: string }>) {
    return async (message: { chatId: string; text: string }) => {
      log.push(message);
      return { providerMessageId: `out-${log.length}` };
    };
  }

  it('does not ask while the flag is off', async () => {
    vi.stubEnv('IMESSAGE_UPGRADE_ASK', '');
    const seeded = await family();
    const log: Array<{ chatId: string; text: string }> = [];
    const result = await maybeOfferYearRetention(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        parentChatId: DIRECT,
        channel: 'imessage',
        templateKey: null,
        excludeMessageId: null,
        now: NOW,
      },
      { send: sender(log) },
    );
    expect(result).toEqual({ action: 'skip', reason: 'flag_off' });
    expect(log).toEqual([]);
  });

  it('does not ask during intake, or before a utility reply exists', async () => {
    const intake = await family({ stage: 'sms_intake' });
    const first = await family({ replies: 0 });
    const log: Array<{ chatId: string; text: string }> = [];
    const send = sender(log);
    const base = {
      channel: 'imessage' as const,
      templateKey: null,
      excludeMessageId: null,
      now: NOW,
      parentChatId: DIRECT,
    };
    expect(
      await maybeOfferYearRetention(
        db.database,
        { ...base, familyId: intake.familyId, parentUserId: intake.parentUserId },
        { send },
      ),
    ).toEqual({ action: 'skip', reason: 'onboard' });
    expect(
      await maybeOfferYearRetention(
        db.database,
        { ...base, familyId: first.familyId, parentUserId: first.parentUserId },
        { send },
      ),
    ).toEqual({ action: 'skip', reason: 'not_yet' });
    expect(log).toEqual([]);
  });

  it('asks in the group, and does not open a 1:1 when there is no thread to answer', async () => {
    const grouped = await family();
    const alone = await family({ group: null });
    const log: Array<{ chatId: string; text: string }> = [];
    const send = sender(log);
    const asked = await maybeOfferYearRetention(
      db.database,
      {
        familyId: grouped.familyId,
        parentUserId: grouped.parentUserId,
        parentChatId: DIRECT,
        channel: 'imessage',
        templateKey: null,
        excludeMessageId: null,
        now: NOW,
      },
      { send },
    );
    expect(asked).toEqual({
      action: 'asked',
      channel: 'group',
      chatId: `group-${grouped.familyId}`,
    });
    expect(log[0]?.text).toBe(YEAR_RETENTION_COPY.ask);
    expect(log[0]?.chatId).toBe(`group-${grouped.familyId}`);

    const cold = await maybeOfferYearRetention(
      db.database,
      {
        familyId: alone.familyId,
        parentUserId: alone.parentUserId,
        parentChatId: null,
        channel: 'imessage',
        templateKey: null,
        excludeMessageId: null,
        now: NOW,
      },
      { send },
    );
    expect(cold).toEqual({ action: 'skip', reason: 'would_initiate_1_1' });
    expect(log).toHaveLength(1);

    const again = await maybeOfferYearRetention(
      db.database,
      {
        familyId: grouped.familyId,
        parentUserId: grouped.parentUserId,
        parentChatId: DIRECT,
        channel: 'imessage',
        templateKey: null,
        excludeMessageId: null,
        now: NOW,
      },
      { send },
    );
    expect(again).toEqual({ action: 'skip', reason: 'already_offered' });
    expect(log).toHaveLength(1);
  });

  it('replies in the 1:1 the parent opened when the family has no group', async () => {
    const seeded = await family({ group: null });
    const log: Array<{ chatId: string; text: string }> = [];
    const result = await maybeOfferYearRetention(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        parentChatId: DIRECT,
        channel: 'imessage',
        templateKey: null,
        excludeMessageId: null,
        now: NOW,
      },
      { send: sender(log) },
    );
    expect(result).toEqual({ action: 'asked', channel: 'direct', chatId: DIRECT });
  });

  it('on yes sends the link in-thread and syncs the decision to the group', async () => {
    const seeded = await family();
    const log: Array<{ chatId: string; text: string }> = [];
    await maybeOfferYearRetention(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        parentChatId: DIRECT,
        channel: 'imessage',
        templateKey: null,
        excludeMessageId: null,
        now: NOW,
      },
      { send: sender(log) },
    );
    const [inbound] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        channel: 'imessage',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        providerChatId: DIRECT,
        providerMessageId: `in-${seeded.familyId}`,
        body: 'yes',
        sentAt: NOW,
      })
      .returning({ id: schema.channelMessages.id });

    const url = `https://buy.stripe.com/test_year?client_reference_id=${seeded.familyId}`;
    const answer = await prepareYearRetentionAnswer(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        inboundChannelMessageId: inbound?.id ?? null,
        now: NOW,
        polarity: 'yes',
      },
      {
        paymentUrl: async () => url,
        send: sender(log),
      },
    );
    expect(answer.claimed).toBe(true);
    if (!answer.claimed) return;
    expect(answer.reply).toContain(url);
    expect(answer.reply.toLowerCase()).not.toMatch(
      /subscription|ai assistant|\bupgrade\b|\bplus\b|paid part|free side/,
    );
    await answer.afterSend?.('msg-link');

    const [offer] = await db.database
      .select({ status: schema.familyUpgradeOffers.status })
      .from(schema.familyUpgradeOffers)
      .where(eq(schema.familyUpgradeOffers.familyId, seeded.familyId));
    expect(offer?.status).toBe('link_sent');
    expect(
      log.some(
        (message) =>
          message.chatId === `group-${seeded.familyId}` &&
          message.text === YEAR_RETENTION_COPY.groupSyncYes,
      ),
    ).toBe(true);
    expect(log.some((message) => message.text.includes(url))).toBe(false);

    await db.database
      .update(schema.families)
      .set({ stripeCustomerId: 'cus_test', stripeSubscriptionId: 'sub_test' })
      .where(eq(schema.families.id, seeded.familyId));
    const [stored] = await db.database
      .select({
        stripeCustomerId: schema.families.stripeCustomerId,
        stripeSubscriptionId: schema.families.stripeSubscriptionId,
      })
      .from(schema.families)
      .where(eq(schema.families.id, seeded.familyId));
    expect(stored).toEqual({ stripeCustomerId: 'cus_test', stripeSubscriptionId: 'sub_test' });
  });

  it('on no leaves the free plan and does not include a url', async () => {
    const seeded = await family({ group: null });
    await maybeOfferYearRetention(
      db.database,
      {
        familyId: seeded.familyId,
        parentUserId: seeded.parentUserId,
        parentChatId: DIRECT,
        channel: 'imessage',
        templateKey: null,
        excludeMessageId: null,
        now: NOW,
      },
      { send: sender([]) },
    );
    const answer = await prepareYearRetentionAnswer(db.database, {
      familyId: seeded.familyId,
      parentUserId: seeded.parentUserId,
      inboundChannelMessageId: null,
      now: NOW,
      polarity: 'no',
    });
    expect(answer.claimed).toBe(true);
    if (!answer.claimed) return;
    expect(answer.reply).toBe(YEAR_RETENTION_COPY.declined);
    expect(answer.reply).not.toMatch(/https?:\/\//);
    await answer.afterSend?.('msg-no');
    const [offer] = await db.database
      .select({ status: schema.familyUpgradeOffers.status })
      .from(schema.familyUpgradeOffers)
      .where(eq(schema.familyUpgradeOffers.familyId, seeded.familyId));
    expect(offer?.status).toBe('declined');
    const [familyRow] = await db.database
      .select({ planTier: schema.families.planTier })
      .from(schema.families)
      .where(eq(schema.families.id, seeded.familyId));
    expect(familyRow?.planTier).toBe('free');
  });
});
