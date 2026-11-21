import { type BillingNoticeEventFacts, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSmsChannel } from '~/lib/channel/adapters/phone-sms';
import { ChannelRetryableError, dispatchLoopMessage } from '~/lib/channel/dispatch';
import type { ChannelTransport, OutboundMessage } from '~/lib/channel/intake/transport';
import {
  familyOutboundTarget,
  familyOutboundTargetForUser,
} from '~/lib/channel/linq/family-outbound';
import type { Channel, ChannelSendOutcome, LoopMessage } from '~/lib/channel/types';
import { buildDispatchPorts } from '~/lib/channel/wiring';
import { resolveSendablePhone } from '~/lib/channels/sms-consent-core';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { loopTemplateRenderer } from '~/lib/loop/templates/registry';
import type { OpsPage, OpsPager } from '~/lib/monitoring/failure-page';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { BillingNoticeCompose, BillingNoticeFacts } from './compose';
import { recordBillingNoticeIntent } from './record';
import { type BillingNoticeRunDeps, runBillingNoticeTick } from './run';
import type { NoticeSubscription } from './subscription-read';

/**
 * VIL-735 · the drain's half of a billing notice, on the shipped dispatch and real
 * migrations. Stood in: the writer (a model call), the subscription read (Stripe) and
 * Linq's chat list and send. What the model writes is the billing-notice eval's job.
 * Toronto in November is UTC-5.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const SINCE = '2026-11-01T00:00:00Z';
const ARMED = { BILLING_THREAD_NOTICES_ENABLED: 'true', BILLING_THREAD_NOTICES_SINCE: SINCE };
const CHAT = 'chat-direct-1';
const SESSION_AT = new Date('2026-11-23T17:50:00Z');
/** 13:00 in Toronto. */
const AFTERNOON = new Date('2026-11-23T18:00:00Z');
const minutes = (n: number) => n * 60_000;
const later = (from: Date, n: number) => new Date(from.getTime() + minutes(n));

const ACTIVE: NoticeSubscription = {
  status: 'active',
  createdAt: SESSION_AT,
  currentPeriodEnd: new Date('2027-11-21T17:00:00Z'),
  cancelAtPeriodEnd: false,
};

let db: TestDb;
let familyId: string;
let parentUserId: string;
let seq = 0;
let clock: { now: Date };
let pages: OpsPage[];
let linqCalls: { userId: string; text: string }[];
let linqAnswers: ChannelSendOutcome[];
let composed: BillingNoticeFacts[];
let subscription: NoticeSubscription;
let subscriptionReads: string[];

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function seedPhone(userId: string, family: string) {
  seq += 1;
  const phone = `+1416555${String(3000 + seq).padStart(4, '0')}`;
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId: family,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date('2026-10-01T12:00:00Z'),
  });
}

async function seedThread(userId: string, family: string, chat = CHAT) {
  await db.database.insert(schema.channelMessages).values({
    familyId: family,
    parentUserId: userId,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    status: 'delivered',
    providerChatId: chat,
    sentAt: new Date('2026-11-02T15:00:00Z'),
    createdAt: new Date('2026-11-02T15:00:00Z'),
  });
}

async function seedCheckout(userId: string, family: string) {
  await db.database.insert(schema.auditLog).values({
    familyId: family,
    actor: userId,
    actionTaken: 'billing_checkout_started',
    targetTable: 'families',
    targetId: family,
    after: { tier: 'plus', period: 'annual' },
    occurredAt: new Date(SESSION_AT.getTime() + 1000),
  });
}

async function seedHousehold(tier: 'free' | 'plus' | 'family' = 'plus') {
  ({ familyId, parentUserId } = await seedFamily(db.database));
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Toronto' })
    .where(eq(schema.users.id, parentUserId));
  await db.database
    .update(schema.families)
    .set({ planTier: tier, stripeCustomerId: `cus_${familyId}` })
    .where(eq(schema.families.id, familyId));
  await seedPhone(parentUserId, familyId);
  await seedThread(parentUserId, familyId);
  await seedCheckout(parentUserId, familyId);
}

beforeEach(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LOOP_SEND_ENABLED', 'true');
  vi.stubEnv('PROACTIVE_CADENCE', 'off');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  clock = { now: AFTERNOON };
  pages = [];
  linqCalls = [];
  linqAnswers = [];
  composed = [];
  subscription = ACTIVE;
  subscriptionReads = [];
  // The tick reads every family's due rows, so one test's leftovers would be the next's.
  await db.database.delete(schema.billingNotices);
  await db.database.delete(schema.stripeBillingEvents);
  await seedHousehold();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const REFUND = {
  chargeId: 'ch_1',
  refundedMinor: 15900,
  chargeMinor: 15900,
  currency: 'cad',
  full: true,
};

const paymentFacts = (over: Partial<BillingNoticeEventFacts> = {}): BillingNoticeEventFacts => ({
  eventIds: ['evt_pay'],
  sessionCreatedAt: SESSION_AT.toISOString(),
  sessionTier: 'plus',
  subscriptionId: 'sub_1',
  ...over,
});

async function insertNotice(over: {
  lane?: 'payment' | 'plan_change';
  facts?: BillingNoticeEventFacts;
  status?: 'open' | 'sending' | 'sent' | 'dropped';
  dropReason?: string;
  lastEventAt?: Date;
  nextTryAt?: Date;
  createdAt?: Date;
  attempts?: number;
  parentUserId?: string | null;
  family?: string;
}) {
  const lane = over.lane ?? 'payment';
  const [row] = await db.database
    .insert(schema.billingNotices)
    .values({
      familyId: over.family ?? familyId,
      lane,
      status: over.status ?? 'open',
      dropReason: over.dropReason ?? null,
      parentUserId: over.parentUserId === undefined ? null : over.parentUserId,
      facts: over.facts ?? paymentFacts(),
      lastEventAt: over.lastEventAt ?? later(AFTERNOON, -5),
      nextTryAt: over.nextTryAt ?? AFTERNOON,
      createdAt: over.createdAt ?? later(AFTERNOON, -5),
      attempts: over.attempts ?? 0,
    })
    .returning();
  if (!row) throw new Error('no notice row');
  return row;
}

const refundNotice = (over: Parameters<typeof insertNotice>[0] = {}) =>
  insertNotice({
    lane: 'plan_change',
    facts: { eventIds: ['evt_refund'], refunds: [{ ...REFUND, subscriptionId: 'sub_1' }] },
    ...over,
  });

const noticeRow = async (id: string) => {
  const [row] = await db.database
    .select()
    .from(schema.billingNotices)
    .where(eq(schema.billingNotices.id, id));
  if (!row) throw new Error('notice row gone');
  return row;
};

const auditRows = (verb: string) =>
  db.database
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, verb)));

function defaultText(facts: BillingNoticeFacts): string {
  const named = facts.plan === 'Free' ? 'the free plan' : facts.plan;
  const money = facts.refunds.length > 0 ? ` ${facts.refunds[0]?.amount} went back to you.` : '';
  return `You're on ${named} now.${money}`;
}

type ComposeAnswer =
  | BillingNoticeCompose
  | ((signal: AbortSignal) => Promise<BillingNoticeCompose>);

function deps(over: Partial<BillingNoticeRunDeps> & { answers?: ComposeAnswer[] } = {}) {
  const { answers, ...rest } = over;
  const sms: Channel = {
    kind: 'sms',
    async send({ userId, rendered }) {
      linqCalls.push({ userId, text: rendered.text });
      const next = linqAnswers.shift();
      return (
        next ?? {
          status: 'sent',
          providerMessageId: `linq-msg-${linqCalls.length}-${Math.random()}`,
          providerChatId: CHAT,
          transport: 'imessage',
        }
      );
    },
  };
  const ports = {
    ...buildDispatchPorts(db.database, {
      channels: { sms },
      renderer: loopTemplateRenderer,
      now: () => clock.now,
    }),
    claimEnforce: {
      enforces: () => true,
      decide: async () => ({ status: 'clean' as const }),
    },
  };
  const pager: OpsPager = {
    async page(page) {
      pages.push(page);
      return 'paged';
    },
  };
  const built: BillingNoticeRunDeps = {
    env: ARMED,
    now: () => clock.now,
    runStartedAt: clock.now.getTime(),
    pager,
    subscriptions: {
      read: async (id) => {
        subscriptionReads.push(id);
        return subscription;
      },
    },
    charges: {
      lookupCharge: async () => ({
        customerId: 'cus_1',
        subscriptionId: 'sub_1',
        subscriptionStatus: 'active',
        familyId: null,
      }),
    },
    findDirectChat: async () => CHAT,
    compose: async ({ facts, signal }) => {
      composed.push(facts);
      const next = answers?.shift();
      if (typeof next === 'function') return next(signal);
      return next ?? { status: 'written', text: defaultText(facts) };
    },
    dispatch: (message: LoopMessage) => dispatchLoopMessage(message, ports),
    ...rest,
  };
  return built;
}

const tick = (over: Parameters<typeof deps>[0] = {}) =>
  runBillingNoticeTick(db.database, deps(over));

describe('a text the parent gets', () => {
  it('Linq accepts: sent, linked to its ledger row, one audit row, in that parent’s thread', async () => {
    const notice = await insertNotice({});
    await expect(tick()).resolves.toMatchObject({ sent: 1 });

    expect(linqCalls).toEqual([{ userId: parentUserId, text: "You're on Plus now." }]);
    const row = await noticeRow(notice.id);
    expect(row.status).toBe('sent');
    expect(row.parentUserId).toBe(parentUserId);
    const [ledger] = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.dedupeKey, `billing_notice:${notice.id}:sms`));
    expect(row.channelMessageId).toBe(ledger?.id);
    expect(ledger?.category).toBe('alert');
    expect(ledger?.body).toBeNull();
    const audits = await auditRows('billing_notice_sent');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.audience).toBe(parentUserId);
    const thread = await db.database
      .select({ content: schema.messages.content })
      .from(schema.messages)
      .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
      .where(eq(schema.conversations.familyId, familyId));
    expect(thread.map((turn) => turn.content)).toContain("You're on Plus now.");
  });

  it('a second tick after it sent sends nothing', async () => {
    await insertNotice({});
    await tick();
    await tick();
    expect(linqCalls).toHaveLength(1);
  });

  it('two overlapping ticks send once', async () => {
    await insertNotice({});
    await Promise.all([tick(), tick()]);
    expect(linqCalls).toHaveLength(1);
  });

  it('with a confirmed family group the real adapter sends 1:1 and never touches the group', async () => {
    vi.stubEnv('LINQ_GROUP_COPARENT', 'on');
    vi.stubEnv('LINQ_GROUP_ONBOARDING_V2_ENABLED', 'true');
    vi.stubEnv('LINQ_FROM_E164', '+15555550100');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const groupChat = `chat-group-${familyId}`;
    const payerPhone = (await resolveSendablePhone(db.database, parentUserId)) as string;
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: groupChat })
      .where(eq(schema.families.id, familyId));
    const [roster] = await db.database
      .insert(schema.linqGroupRosters)
      .values({ chatId: groupChat, familyId, source: 'added_to_existing', status: 'confirmed' })
      .returning({ id: schema.linqGroupRosters.id });
    await db.database.insert(schema.linqGroupRosterMembers).values({
      rosterId: roster?.id as string,
      chatId: groupChat,
      phoneE164Hash: phoneBlindIndex(payerPhone),
      status: 'known_parent',
    });
    // Positive control: this group is live for a line everyone in it may hear.
    await expect(
      familyOutboundTarget(db.database, familyId, {
        contentClass: 'schedule',
        listChatHandles: async () => ({ status: 'ok', handles: [payerPhone], isGroup: true }),
      }),
    ).resolves.toEqual({ channel: 'group', chatId: groupChat, familyId });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sent: OutboundMessage[] = [];
    const transport: ChannelTransport = {
      async send(input) {
        sent.push(input);
        return { providerMessageId: `linq-${familyId}`, transport: 'imessage', chatId: CHAT };
      },
    };
    const ports = {
      ...buildDispatchPorts(db.database, {
        channels: {
          sms: createSmsChannel({
            resolveTarget: (id) => resolveSendablePhone(db.database, id),
            familyTarget: (id) => familyOutboundTargetForUser(db.database, id),
            database: db.database,
            configured: true,
            transport,
          }),
        },
        renderer: loopTemplateRenderer,
        now: () => clock.now,
      }),
      claimEnforce: { enforces: () => true, decide: async () => ({ status: 'clean' as const }) },
    };
    const notice = await insertNotice({});

    await tick({ dispatch: (message) => dispatchLoopMessage(message, ports) });

    expect((await noticeRow(notice.id)).status).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: payerPhone, body: "You're on Plus now." });
    expect(fetchSpy).not.toHaveBeenCalled();
    const ledger = await db.database
      .select({ chatId: schema.channelMessages.providerChatId })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.familyId, familyId),
          eq(schema.channelMessages.direction, 'out'),
        ),
      );
    expect(ledger.map((row) => row.chatId)).toEqual([CHAT]);
  });
});

describe('a send that does not reach them', () => {
  const refused: ChannelSendOutcome = {
    status: 'error',
    code: 'http_422',
    message: 'refused',
    transient: false,
  };

  it('a Linq refusal is never sent, counts one attempt, and retries with a fresh write', async () => {
    const notice = await insertNotice({});
    linqAnswers = [refused];
    await tick();
    let row = await noticeRow(notice.id);
    expect(row.status).toBe('open');
    expect(row.attempts).toBe(1);
    expect(row.nextTryAt).toEqual(later(AFTERNOON, 5));
    expect(await auditRows('billing_notice_sent')).toHaveLength(0);
    const failed = await auditRows('billing_notice_send_failed');
    expect(failed.map((a) => a.after)).toEqual([
      { lane: 'payment', reason: 'send_refused', attempts: 1 },
    ]);

    clock.now = later(AFTERNOON, 5);
    await tick();
    row = await noticeRow(notice.id);
    expect(row.status).toBe('sent');
    expect(composed).toHaveLength(2);
    expect(linqCalls).toHaveLength(2);
  });

  it('four refusals: four tries at 5, 10 and 20 minutes, one page, then never offered again', async () => {
    const notice = await insertNotice({});
    linqAnswers = [refused, refused, refused, refused];
    const gaps = [5, 10, 20];
    await tick();
    for (const gap of gaps) {
      clock.now = later(clock.now, gap);
      await tick();
    }
    const row = await noticeRow(notice.id);
    expect(linqCalls).toHaveLength(4);
    expect(row.status).toBe('dropped');
    expect(row.dropReason).toBe('send_retries_exhausted');
    expect(pages).toEqual([
      {
        site: 'billing_notice_unsent',
        ref: notice.id,
        facts: { lane: 'payment', reason: 'send_refused' },
      },
    ]);
    clock.now = later(clock.now, 60);
    await tick();
    expect(linqCalls).toHaveLength(4);
    expect(pages).toHaveLength(1);
  });

  it('two families exhausted in one hour are each paged, each with its own ref', async () => {
    const first = await insertNotice({ attempts: 3 });
    const firstFamily = familyId;
    await seedHousehold();
    const second = await insertNotice({ attempts: 3 });
    linqAnswers = [refused, refused];
    await tick();
    expect(pages.map((page) => page.ref).sort()).toEqual([first.id, second.id].sort());
    expect(firstFamily).not.toBe(familyId);
  });

  it('the writer returns nothing: zero Linq calls, retried, then dropped and paged', async () => {
    const notice = await insertNotice({ attempts: 3 });
    await tick({ answers: [{ status: 'failed', reason: 'unwritten' }] });
    expect(linqCalls).toHaveLength(0);
    const row = await noticeRow(notice.id);
    expect(row.dropReason).toBe('send_retries_exhausted');
    expect(pages[0]?.facts).toEqual({ lane: 'payment', reason: 'unwritten' });
  });

  it('the fact check refuses both drafts: zero Linq calls, a failed attempt named fact_check', async () => {
    const notice = await insertNotice({});
    await tick({ answers: [{ status: 'failed', reason: 'fact_check' }] });
    expect(linqCalls).toHaveLength(0);
    const row = await noticeRow(notice.id);
    expect(row.status).toBe('open');
    expect(row.attempts).toBe(1);
    expect((await auditRows('billing_notice_send_failed'))[0]?.after).toEqual({
      lane: 'payment',
      reason: 'fact_check',
      attempts: 1,
    });
  });

  it('a row that never sent and ages past 72 hours drops stale and pages', async () => {
    const notice = await insertNotice({ lastEventAt: later(AFTERNOON, -73 * 60) });
    await tick();
    const row = await noticeRow(notice.id);
    expect(row.status).toBe('dropped');
    expect(row.dropReason).toBe('stale');
    expect(pages[0]?.facts).toEqual({ lane: 'payment', reason: 'stale' });
    expect(linqCalls).toHaveLength(0);
  });

  it('a retryable throw from the channel is a failed attempt with no text', async () => {
    const notice = await insertNotice({});
    await tick({
      dispatch: async () => {
        throw new ChannelRetryableError('sms', 'timeout', 'linq timed out');
      },
    });
    const row = await noticeRow(notice.id);
    expect(row.status).toBe('open');
    expect(row.attempts).toBe(1);
  });

  it('a row that throws costs the next family nothing, and is counted as an attempt', async () => {
    const bad = await insertNotice({});
    const badFamily = familyId;
    await seedHousehold();
    const good = await insertNotice({ nextTryAt: later(AFTERNOON, -1) });
    await db.database
      .update(schema.billingNotices)
      .set({ nextTryAt: later(AFTERNOON, -2) })
      .where(eq(schema.billingNotices.id, bad.id));
    const summary = await tick({
      findDirectChat: async (phone) => {
        const { resolveSendablePhone } = await import('~/lib/channels/sms-consent-core');
        const [member] = await db.database
          .select({ userId: schema.familyMembers.userId })
          .from(schema.familyMembers)
          .where(eq(schema.familyMembers.familyId, badFamily));
        if ((await resolveSendablePhone(db.database, member?.userId as string)) === phone) {
          throw new TypeError('bug in one family');
        }
        return CHAT;
      },
    });
    expect(summary).toMatchObject({ sent: 1, retrying: 1 });
    expect((await noticeRow(good.id)).status).toBe('sent');
    const row = await noticeRow(bad.id);
    expect(row.status).toBe('open');
    expect(row.attempts).toBe(1);
  });

  it('a claim-gate refusal is a failed attempt, paged as claim_gate on the last try', async () => {
    const notice = await insertNotice({ attempts: 3 });
    await tick({ answers: [{ status: 'written', text: "You're on Max now." }] });
    expect(linqCalls).toHaveLength(0);
    expect((await noticeRow(notice.id)).dropReason).toBe('send_retries_exhausted');
    expect(pages[0]?.facts).toEqual({ lane: 'payment', reason: 'claim_gate' });
  });
});

describe('a crash mid-send', () => {
  it('after Linq accepted: settles sent with no model call and no truth check', async () => {
    const notice = await insertNotice({
      status: 'sending',
      parentUserId,
      nextTryAt: later(AFTERNOON, -1),
    });
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'imessage',
      direction: 'out',
      category: 'alert',
      status: 'sent',
      dedupeKey: `billing_notice:${notice.id}:sms`,
      providerMessageId: `linq-crash-${notice.id}`,
    });
    await db.database
      .update(schema.families)
      .set({ planTier: 'free' })
      .where(eq(schema.families.id, familyId));

    await tick();

    const row = await noticeRow(notice.id);
    expect(row.status).toBe('sent');
    expect(row.channelMessageId).not.toBeNull();
    expect(composed).toHaveLength(0);
    expect(subscriptionReads).toHaveLength(0);
    expect(linqCalls).toHaveLength(0);
  });

  it('with no accepted row: one failed attempt, send_abandoned, back to open', async () => {
    const notice = await insertNotice({
      status: 'sending',
      parentUserId,
      nextTryAt: later(AFTERNOON, -1),
    });
    await tick();
    const row = await noticeRow(notice.id);
    expect(row.status).toBe('open');
    expect(row.attempts).toBe(1);
    expect(row.nextTryAt).toEqual(later(AFTERNOON, 5));
    expect((await auditRows('billing_notice_send_failed'))[0]?.after).toEqual({
      lane: 'payment',
      reason: 'send_abandoned',
      attempts: 1,
    });
    expect(linqCalls).toHaveLength(0);
  });

  it('a lease still running is left alone', async () => {
    const notice = await insertNotice({
      status: 'sending',
      parentUserId,
      nextTryAt: later(AFTERNOON, 5),
    });
    await tick();
    expect((await noticeRow(notice.id)).status).toBe('sending');
  });
});

describe('who receives it', () => {
  it('no thread: nothing sent, named no_thread, not paged', async () => {
    const notice = await insertNotice({});
    await tick({ findDirectChat: async () => null });
    const row = await noticeRow(notice.id);
    expect(row.dropReason).toBe('no_thread');
    expect(linqCalls).toHaveLength(0);
    expect(composed).toHaveLength(0);
    expect(pages).toHaveLength(0);
  });

  it('the payer has no thread and the other parent does: nothing goes to either', async () => {
    const [user] = await db.database
      .insert(schema.users)
      .values({ email: `${familyId}-co@example.test`, name: 'Other Parent' })
      .returning({ id: schema.users.id });
    const coParent = user?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: coParent, role: 'co_parent' });
    await seedPhone(coParent, familyId);
    await seedThread(coParent, familyId, 'chat-coparent');
    const notice = await insertNotice({});
    await tick({ findDirectChat: async () => 'chat-with-no-inbound' });
    expect((await noticeRow(notice.id)).dropReason).toBe('no_thread');
    expect(linqCalls).toHaveLength(0);
  });

  it('a Linq failure on the thread read is a failed attempt, not a drop', async () => {
    const { LinqSendError } = await import('~/lib/channel/linq/transport');
    const notice = await insertNotice({});
    await tick({
      findDirectChat: async () => {
        throw new LinqSendError('network', 0, false);
      },
    });
    const row = await noticeRow(notice.id);
    expect(row.status).toBe('open');
    expect(row.attempts).toBe(1);
    expect((await auditRows('billing_notice_send_failed'))[0]?.after).toMatchObject({
      reason: 'thread_unread',
    });
  });

  it('no resolvable payer: dropped, paged, and the amounts are gone from the row', async () => {
    await db.database
      .delete(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, familyId),
          eq(schema.auditLog.actionTaken, 'billing_checkout_started'),
        ),
      );
    const notice = await refundNotice();
    await tick();
    const row = await noticeRow(notice.id);
    expect(row.dropReason).toBe('payer_unresolved');
    expect(pages[0]?.facts).toEqual({ lane: 'plan_change', reason: 'payer_unresolved' });
    expect(row.facts.refunds?.[0]).toEqual({
      chargeId: 'ch_1',
      currency: 'cad',
      full: true,
      subscriptionId: 'sub_1',
    });
  });

  it('a payer who left the family: recipient_gone, nothing sent', async () => {
    const notice = await insertNotice({ parentUserId });
    await db.database
      .delete(schema.familyMembers)
      .where(eq(schema.familyMembers.userId, parentUserId));
    await tick();
    expect((await noticeRow(notice.id)).dropReason).toBe('recipient_gone');
    expect(linqCalls).toHaveLength(0);
  });

  it('resolves a refund’s subscription once and stores it', async () => {
    const lookupCharge = vi.fn(async () => ({
      customerId: 'cus_1',
      subscriptionId: 'sub_looked_up',
      subscriptionStatus: 'active',
      familyId: null,
    }));
    const notice = await insertNotice({
      lane: 'plan_change',
      facts: { eventIds: ['evt_refund'], refunds: [REFUND] },
    });
    await tick({ charges: { lookupCharge } });
    expect(lookupCharge).toHaveBeenCalledTimes(1);
    const row = await noticeRow(notice.id);
    expect(row.facts.refunds?.[0]?.subscriptionId).toBe('sub_looked_up');
    expect(subscriptionReads).toEqual(['sub_looked_up']);
  });

  it('a charge lookup that fails is a failed attempt subscription_unread', async () => {
    const notice = await insertNotice({
      lane: 'plan_change',
      facts: { eventIds: ['evt_refund'], refunds: [REFUND] },
    });
    await tick({
      charges: {
        lookupCharge: async () => {
          throw new Error('stripe lookup failed: 500');
        },
      },
    });
    const row = await noticeRow(notice.id);
    expect(row.status).toBe('open');
    expect((await auditRows('billing_notice_send_failed'))[0]?.after).toMatchObject({
      reason: 'subscription_unread',
    });
    expect(composed).toHaveLength(0);
  });
});

describe('the truth checks on a payment', () => {
  it('the tier is Free now: plan_not_paid, zero model calls', async () => {
    await db.database
      .update(schema.families)
      .set({ planTier: 'free' })
      .where(eq(schema.families.id, familyId));
    const notice = await insertNotice({});
    await tick();
    expect((await noticeRow(notice.id)).dropReason).toBe('plan_not_paid');
    expect(composed).toHaveLength(0);
  });

  it('the plan differs from what the session sold: plan_mismatch, zero model calls', async () => {
    await db.database
      .update(schema.families)
      .set({ planTier: 'family' })
      .where(eq(schema.families.id, familyId));
    const notice = await insertNotice({});
    await tick();
    expect((await noticeRow(notice.id)).dropReason).toBe('plan_mismatch');
    expect(composed).toHaveLength(0);
  });

  it('a second purchase while already on Plus: no text, duplicate_payment, paged once', async () => {
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'family_plan_updated',
      targetTable: 'families',
      targetId: familyId,
      before: { planTier: 'free' },
      after: { planTier: 'plus', source: 'stripe', stripeEventId: 'evt_old' },
      occurredAt: new Date('2026-11-10T12:00:00Z'),
    });
    const notice = await insertNotice({});
    await tick();
    expect((await noticeRow(notice.id)).dropReason).toBe('duplicate_payment');
    expect(linqCalls).toHaveLength(0);
    expect(composed).toHaveLength(0);
    expect(pages).toEqual([
      {
        site: 'billing_notice_unsent',
        ref: notice.id,
        facts: { lane: 'payment', reason: 'duplicate_payment' },
      },
    ]);
  });

  it('two different subscriptions merged into one payment row: no text, paged', async () => {
    const notice = await insertNotice({ facts: paymentFacts({ conflictingPayment: true }) });
    await tick();
    expect((await noticeRow(notice.id)).dropReason).toBe('duplicate_payment');
    expect(pages).toHaveLength(1);
    expect(composed).toHaveLength(0);
  });

  it('a first purchase whose invoice row landed before the checkout row still gets the text', async () => {
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'family_plan_updated',
      targetTable: 'families',
      targetId: familyId,
      before: { planTier: 'plus' },
      after: { planTier: 'plus', source: 'stripe', stripeEventId: 'evt_invoice' },
      occurredAt: new Date(SESSION_AT.getTime() + 2000),
    });
    const notice = await insertNotice({});
    await tick();
    expect((await noticeRow(notice.id)).status).toBe('sent');
    expect(composed[0]?.previousPlan).toBe('Free');
  });

  it('a refund after a duplicate payment: no text, duplicate_under_review, paged', async () => {
    await insertNotice({
      status: 'dropped',
      dropReason: 'duplicate_payment',
      createdAt: later(AFTERNOON, -60),
    });
    const notice = await refundNotice();
    await tick();
    expect((await noticeRow(notice.id)).dropReason).toBe('duplicate_under_review');
    expect(linqCalls).toHaveLength(0);
    expect(pages[0]?.facts).toEqual({ lane: 'plan_change', reason: 'duplicate_under_review' });
  });

  it('the subscription read fails on a payment: failed attempt, no text', async () => {
    const notice = await insertNotice({});
    await tick({
      subscriptions: {
        read: async () => {
          throw new Error('stripe lookup failed: 503');
        },
      },
    });
    const row = await noticeRow(notice.id);
    expect(row.status).toBe('open');
    expect(row.attempts).toBe(1);
    expect(composed).toHaveLength(0);
    expect((await auditRows('billing_notice_send_failed'))[0]?.after).toMatchObject({
      reason: 'subscription_unread',
    });
  });
});

describe('the facts the writer is handed', () => {
  async function planRow(eventId: string, before: string, after: string, at: Date) {
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'family_plan_updated',
      targetTable: 'families',
      targetId: familyId,
      before: { planTier: before },
      after: { planTier: after, source: 'stripe', stripeEventId: eventId },
      occurredAt: at,
    });
  }

  const setTier = (planTier: 'free' | 'plus' | 'family') =>
    db.database.update(schema.families).set({ planTier }).where(eq(schema.families.id, familyId));

  it('a payment: plan, previous plan, and the date through which it is paid', async () => {
    await insertNotice({});
    await tick();
    expect(composed[0]).toEqual({
      happened: 'payment',
      language: 'en',
      plan: 'Plus',
      previousPlan: 'Free',
      ended: null,
      refunds: [],
      paidThrough: { date: 'November 21, 2027', renews: true },
    });
  });

  it('a subscription cancelled at period end does not renew', async () => {
    subscription = { ...ACTIVE, cancelAtPeriodEnd: true };
    await insertNotice({});
    await tick();
    expect(composed[0]?.paidThrough).toEqual({ date: 'November 21, 2027', renews: false });
  });

  it('a subscription deleted: the plan ended, on Free, no date and no Stripe read', async () => {
    await setTier('free');
    await planRow('evt_del', 'plus', 'free', later(AFTERNOON, -2));
    await insertNotice({
      lane: 'plan_change',
      facts: { eventIds: ['evt_del'], ended: { subscriptionId: 'sub_1', why: 'cancelled' } },
    });
    await tick();
    expect(composed[0]).toEqual({
      happened: 'plan_change',
      language: 'en',
      plan: 'Free',
      previousPlan: 'Plus',
      ended: { why: 'cancelled' },
      refunds: [],
      paidThrough: null,
    });
    expect(subscriptionReads).toEqual([]);
  });

  it('a full refund with the revoke flag off keeps the tier: money back, still on Plus', async () => {
    await refundNotice();
    await tick();
    expect(composed[0]).toMatchObject({
      plan: 'Plus',
      previousPlan: null,
      ended: null,
      refunds: [{ amount: '$159.00', of: '$159.00', full: true }],
      paidThrough: { date: 'November 21, 2027', renews: true },
    });
  });

  it('a partial refund keeps the tier and says how much of what', async () => {
    await refundNotice({
      facts: {
        eventIds: ['evt_refund'],
        refunds: [{ ...REFUND, refundedMinor: 5000, full: false, subscriptionId: 'sub_1' }],
      },
    });
    await tick();
    expect(composed[0]?.refunds).toEqual([{ amount: '$50.00', of: '$159.00', full: false }]);
    expect(composed[0]?.plan).toBe('Plus');
  });

  it('a full refund the revoke flag took to Free: money back, on Free', async () => {
    await setTier('free');
    await planRow('evt_refund', 'plus', 'free', later(AFTERNOON, -2));
    await refundNotice();
    await tick();
    expect(composed[0]).toMatchObject({
      plan: 'Free',
      previousPlan: 'Plus',
      ended: null,
      refunds: [{ amount: '$159.00', of: '$159.00', full: true }],
      paidThrough: null,
    });
    expect(subscriptionReads).toEqual([]);
  });

  it('previousPlan on a refund plus a cancel is the plan before the first of them', async () => {
    await setTier('free');
    await planRow('evt_refund', 'plus', 'free', later(AFTERNOON, -3));
    await planRow('evt_del', 'free', 'free', later(AFTERNOON, -2));
    await refundNotice({
      facts: {
        eventIds: ['evt_del', 'evt_refund'],
        ended: { subscriptionId: 'sub_1', why: 'cancelled' },
        refunds: [{ ...REFUND, subscriptionId: 'sub_1' }],
      },
    });
    await tick();
    expect(composed[0]?.previousPlan).toBe('Plus');
  });

  it('past_due has no paid-through date', async () => {
    subscription = { ...ACTIVE, status: 'past_due' };
    await refundNotice();
    await tick();
    expect(composed[0]?.paidThrough).toBeNull();
  });

  it('an unresolved clock whose zones disagree on the day states no date', async () => {
    await db.database
      .update(schema.users)
      .set({ timezone: 'UTC' })
      .where(eq(schema.users.id, parentUserId));
    subscription = { ...ACTIVE, currentPeriodEnd: new Date('2027-11-21T05:30:00Z') };
    clock.now = new Date('2026-11-23T19:00:00Z');
    await refundNotice({ lastEventAt: later(clock.now, -5), nextTryAt: clock.now });
    await tick();
    expect(composed).toHaveLength(1);
    expect(composed[0]?.paidThrough).toBeNull();
  });
});

describe('when it may go', () => {
  it('a receipt at 01:00 local, one minute after payment, goes', async () => {
    clock.now = new Date('2026-11-24T06:00:00Z');
    await insertNotice({
      lastEventAt: later(clock.now, -1),
      createdAt: later(clock.now, -1),
      nextTryAt: clock.now,
      facts: paymentFacts({ sessionCreatedAt: later(clock.now, -2).toISOString() }),
    });
    subscription = { ...ACTIVE, createdAt: later(clock.now, -2) };
    await tick();
    expect(linqCalls).toHaveLength(1);
  });

  it('a three-hour-old payment at 03:00 local is held, then goes after 08:00', async () => {
    const threeAm = new Date('2026-11-24T08:00:00Z');
    clock.now = threeAm;
    const notice = await insertNotice({
      lastEventAt: later(threeAm, -180),
      createdAt: later(threeAm, -180),
      nextTryAt: threeAm,
    });
    await tick();
    expect(linqCalls).toHaveLength(0);
    expect(composed).toHaveLength(0);
    let row = await noticeRow(notice.id);
    expect(row.status).toBe('open');
    expect(row.attempts).toBe(0);
    expect(row.nextTryAt).toEqual(later(threeAm, 30));

    clock.now = new Date('2026-11-24T13:30:00Z');
    await db.database
      .update(schema.billingNotices)
      .set({ nextTryAt: clock.now })
      .where(eq(schema.billingNotices.id, notice.id));
    await tick();
    row = await noticeRow(notice.id);
    expect(row.status).toBe('sent');
  });

  it('a parent stored as UTC, resolve flag off: a 03:30 refund waits, no zone written, goes at 13:30', async () => {
    await db.database
      .update(schema.users)
      .set({ timezone: 'UTC' })
      .where(eq(schema.users.id, parentUserId));
    const night = new Date('2026-11-24T08:30:00Z');
    clock.now = night;
    const notice = await refundNotice({
      lastEventAt: later(night, -10),
      createdAt: later(night, -10),
      nextTryAt: night,
    });
    await tick();
    expect(composed).toHaveLength(0);
    expect((await noticeRow(notice.id)).status).toBe('open');
    const [user] = await db.database
      .select({ resolved: schema.users.resolvedTimezone })
      .from(schema.users)
      .where(eq(schema.users.id, parentUserId));
    expect(user?.resolved).toBeNull();
    expect(await auditRows('family_timezone_resolved')).toHaveLength(0);

    clock.now = new Date('2026-11-24T18:30:00Z');
    await db.database
      .update(schema.billingNotices)
      .set({ nextTryAt: clock.now })
      .where(eq(schema.billingNotices.id, notice.id));
    await tick();
    expect((await noticeRow(notice.id)).status).toBe('sent');
  });

  it('a refund at 23:00 is held, absorbs a cancel at 02:00, and goes as one text after 08:00', async () => {
    const elevenPm = new Date('2026-11-24T04:00:00Z');
    clock.now = elevenPm;
    const notice = await refundNotice({
      lastEventAt: later(elevenPm, -11),
      createdAt: later(elevenPm, -11),
      nextTryAt: elevenPm,
    });
    await tick();
    expect(composed).toHaveLength(0);

    const twoAm = new Date('2026-11-24T07:00:00Z');
    clock.now = twoAm;
    await db.database
      .update(schema.families)
      .set({ planTier: 'free' })
      .where(eq(schema.families.id, familyId));
    const outcome = await recordBillingNoticeIntent(
      db.database,
      {
        id: 'evt_cancel_night',
        type: 'customer.subscription.deleted',
        livemode: true,
        created: Math.floor(twoAm.getTime() / 1000),
        data: {
          object: {
            id: 'sub_1',
            metadata: { familyId },
            cancellation_details: { reason: 'cancellation_requested' },
          },
        },
      },
      { status: 'applied', tier: 'free' },
      { env: ARMED, now: twoAm },
    );
    expect(outcome).toBe('recorded');

    clock.now = new Date('2026-11-24T14:00:00Z');
    await db.database
      .update(schema.billingNotices)
      .set({ nextTryAt: clock.now })
      .where(eq(schema.billingNotices.id, notice.id));
    await tick();
    expect(linqCalls).toHaveLength(1);
    expect(composed).toHaveLength(1);
    expect(composed[0]).toMatchObject({
      plan: 'Free',
      ended: { why: 'cancelled' },
      refunds: [{ amount: '$159.00' }],
    });
  });

  it.each([
    ['sends paused', 'sends_paused', minutes(15)],
    ['an unread opt-out', 'opt_out_unread', minutes(60)],
  ])('%s waits with no attempt used', async (_label, cause, wait) => {
    const notice = await insertNotice({});
    if (cause === 'sends_paused') {
      vi.stubEnv('PROACTIVE_SENDS_PAUSED', 'true');
    } else {
      const { parentUserId: _unused } = { parentUserId };
      const { readSendablePhoneForTest } = await holdSender();
      expect(readSendablePhoneForTest).toBeTruthy();
    }
    await tick();
    const row = await noticeRow(notice.id);
    expect(row.status).toBe('open');
    expect(row.attempts).toBe(0);
    expect(row.nextTryAt).toEqual(new Date(AFTERNOON.getTime() + wait));
    expect(linqCalls).toHaveLength(0);
  });

  async function holdSender() {
    const { resolveSendablePhone } = await import('~/lib/channels/sms-consent-core');
    const phone = await resolveSendablePhone(db.database, parentUserId);
    await db.database.insert(schema.optOutReadHolds).values({
      phoneHash: phoneBlindIndex(phone as string),
      heldAt: AFTERNOON,
    });
    return { readSendablePhoneForTest: phone };
  }

  it('an opt-out hold set during compose: zero Linq calls, back to open', async () => {
    const notice = await insertNotice({});
    await tick({
      answers: [
        async () => {
          await holdSender();
          return { status: 'written', text: "You're on Plus now." };
        },
      ],
    });
    expect(linqCalls).toHaveLength(0);
    const row = await noticeRow(notice.id);
    expect(row.status).toBe('open');
    expect(row.attempts).toBe(0);
  });

  it('no live consent: dropped no_consent, zero Linq calls', async () => {
    await db.database
      .update(schema.parentChannels)
      .set({ revokedAt: AFTERNOON })
      .where(eq(schema.parentChannels.userId, parentUserId));
    const notice = await insertNotice({ parentUserId });
    await tick();
    expect((await noticeRow(notice.id)).dropReason).toBe('no_consent');
    expect(linqCalls).toHaveLength(0);
  });

  it('Alerts switched off: dropped category_off, zero Linq calls', async () => {
    await db.database.insert(schema.loopPrefs).values({ userId: parentUserId, catAlert: false });
    const notice = await insertNotice({});
    await tick();
    expect((await noticeRow(notice.id)).dropReason).toBe('category_off');
    expect(linqCalls).toHaveLength(0);
    expect(composed).toHaveLength(0);
  });

  it('a family scheduled for deletion: dropped, zero Linq calls', async () => {
    await db.database
      .update(schema.families)
      .set({ scheduledDeletionAt: later(AFTERNOON, 60) })
      .where(eq(schema.families.id, familyId));
    const notice = await insertNotice({});
    await tick();
    expect((await noticeRow(notice.id)).dropReason).toBe('erasure_scheduled');
    expect(linqCalls).toHaveLength(0);
  });
});

describe('one message for a refund and a cancel', () => {
  const cancelEvent = (at: Date) => ({
    id: `evt_cancel_${at.getTime()}`,
    type: 'customer.subscription.deleted',
    livemode: true,
    created: Math.floor(at.getTime() / 1000),
    data: {
      object: {
        id: 'sub_1',
        metadata: { familyId },
        cancellation_details: { reason: 'cancellation_requested' },
      },
    },
  });

  it('a first attempt fails, a cancel lands during the wait: one text covers both', async () => {
    const notice = await refundNotice();
    await tick({ answers: [{ status: 'failed', reason: 'unwritten' }] });
    expect((await noticeRow(notice.id)).status).toBe('open');

    clock.now = later(AFTERNOON, 2);
    await db.database
      .update(schema.families)
      .set({ planTier: 'free' })
      .where(eq(schema.families.id, familyId));
    await recordBillingNoticeIntent(
      db.database,
      cancelEvent(clock.now),
      { status: 'applied', tier: 'free' },
      { env: ARMED, now: clock.now },
    );

    clock.now = later(AFTERNOON, 20);
    await tick();
    expect(linqCalls).toHaveLength(1);
    expect(composed.at(-1)).toMatchObject({
      plan: 'Free',
      ended: { why: 'cancelled' },
      refunds: [{ amount: '$159.00' }],
    });
  });

  it('a cancel lands while an attempt is in flight and it fails: the rows merge into one text', async () => {
    const notice = await refundNotice();
    await tick({
      answers: [
        async () => {
          const at = later(AFTERNOON, 1);
          await db.database
            .update(schema.families)
            .set({ planTier: 'free' })
            .where(eq(schema.families.id, familyId));
          await recordBillingNoticeIntent(
            db.database,
            cancelEvent(at),
            { status: 'applied', tier: 'free' },
            { env: ARMED, now: at },
          );
          return { status: 'failed', reason: 'unwritten' };
        },
      ],
    });

    const rows = await db.database
      .select()
      .from(schema.billingNotices)
      .where(eq(schema.billingNotices.familyId, familyId));
    expect(rows).toHaveLength(2);
    const dropped = rows.find((row) => row.id === notice.id);
    const open = rows.find((row) => row.id !== notice.id);
    expect(dropped?.status).toBe('dropped');
    expect(dropped?.dropReason).toBe('merged');
    expect(open?.status).toBe('open');
    expect(open?.attempts).toBe(1);
    expect(open?.facts.ended?.subscriptionId).toBe('sub_1');
    expect(open?.facts.refunds?.[0]?.refundedMinor).toBe(15900);

    clock.now = later(AFTERNOON, 30);
    await tick();
    expect(linqCalls).toHaveLength(1);
    expect(composed.at(-1)).toMatchObject({ ended: { why: 'cancelled' } });
  });

  it('Stripe says it ended and the tier is still paid: the row waits, then one text', async () => {
    subscription = { ...ACTIVE, status: 'canceled' };
    const notice = await refundNotice();
    await tick();
    expect(composed).toHaveLength(0);
    let row = await noticeRow(notice.id);
    expect(row.status).toBe('open');
    expect(row.attempts).toBe(0);
    expect(row.nextTryAt).toEqual(later(AFTERNOON, 5));

    clock.now = later(AFTERNOON, 3);
    await db.database
      .update(schema.families)
      .set({ planTier: 'free' })
      .where(eq(schema.families.id, familyId));
    await recordBillingNoticeIntent(
      db.database,
      cancelEvent(clock.now),
      { status: 'applied', tier: 'free' },
      { env: ARMED, now: clock.now },
    );
    clock.now = later(AFTERNOON, 15);
    await tick();
    row = await noticeRow(notice.id);
    expect(row.status).toBe('sent');
    expect(linqCalls).toHaveLength(1);
    expect(composed[0]).toMatchObject({ plan: 'Free', ended: { why: 'cancelled' } });
  });

  it('no deletion event within 30 minutes: plan_state_unsettled, paged, nothing sent', async () => {
    subscription = { ...ACTIVE, status: 'canceled' };
    const notice = await refundNotice({ createdAt: later(AFTERNOON, -31) });
    await tick();
    expect((await noticeRow(notice.id)).dropReason).toBe('plan_state_unsettled');
    expect(pages[0]?.facts).toEqual({ lane: 'plan_change', reason: 'plan_state_unsettled' });
    expect(linqCalls).toHaveLength(0);
    expect(composed).toHaveLength(0);
  });
});

describe('the drain’s budget', () => {
  it('a tick past 640 seconds into the run starts no notice', async () => {
    const notice = await insertNotice({});
    await expect(tick({ runStartedAt: AFTERNOON.getTime() - 641_000 })).resolves.toMatchObject({
      stopped: 'budget',
      sent: 0,
    });
    expect((await noticeRow(notice.id)).status).toBe('open');
    expect(composed).toHaveLength(0);
  });

  it('a model call still running at the 740-second deadline aborts and sends nothing', async () => {
    const notice = await insertNotice({});
    // Started inside the budget; by the time the model is called the deadline is 40ms off.
    const runStartedAt = AFTERNOON.getTime() - 639_000;
    await tick({
      runStartedAt,
      findDirectChat: async () => {
        clock.now = new Date(runStartedAt + 740_000 - 40);
        return CHAT;
      },
      answers: [
        (signal) =>
          new Promise<BillingNoticeCompose>((resolve) => {
            signal.addEventListener('abort', () =>
              resolve({ status: 'failed', reason: 'unwritten' }),
            );
          }),
      ],
    });
    expect(linqCalls).toHaveLength(0);
    const row = await noticeRow(notice.id);
    expect(row.status).toBe('open');
    expect(row.attempts).toBe(1);
  });
});

describe('arming', () => {
  it('flag off: nothing is read or sent', async () => {
    const notice = await insertNotice({});
    await expect(tick({ env: {} })).resolves.toEqual({ skipped: 'flag_off' });
    expect((await noticeRow(notice.id)).status).toBe('open');
    expect(linqCalls).toHaveLength(0);
  });

  it('a Preview deploy is a named skip', async () => {
    await insertNotice({});
    await expect(tick({ env: { ...ARMED, VERCEL_ENV: 'preview' } })).resolves.toEqual({
      skipped: 'preview',
    });
    expect(linqCalls).toHaveLength(0);
  });

  it('a re-light with a new SINCE drops a row held from before it, and texts nobody', async () => {
    const notice = await insertNotice({});
    await tick({
      env: { ...ARMED, BILLING_THREAD_NOTICES_SINCE: later(AFTERNOON, -1).toISOString() },
    });
    const row = await noticeRow(notice.id);
    expect(row.status).toBe('dropped');
    expect(row.dropReason).toBe('before_arm');
    expect(linqCalls).toHaveLength(0);
  });
});

describe('what the audit rows carry', () => {
  it('no amount on any of them', async () => {
    await refundNotice();
    await tick();
    const rows = await auditRows('billing_notice_sent');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.after).toEqual({ lane: 'plan_change', attempts: 0 });
    expect(JSON.stringify(rows[0]?.after)).not.toContain('159');
  });
});
