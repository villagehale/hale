import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYNTHETIC_PROBE_PREFIX } from '~/lib/channels/phone';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { METRICS_EXCLUDED_FAMILIES_ENV } from '~/lib/loop/metrics-scope';
import { DEAD_LETTER_PAGE_ROUTE, FIRST_HELLO_PAGE_ROUTE } from '~/lib/monitoring/failure-page';
import type { OpsPageOutcome } from '~/lib/monitoring/ops-slack';
import { createTestDb, seedFamily, type SeededFamily, type TestDb } from '~/lib/testing/pglite';
import { aggregateOpsDaily, OPS_DAILY_ROUTE, type OpsDailyReport, runOpsDaily } from './ops-daily';

/**
 * The daily #ops post over the real tables (VIL-409). Every family is invented, its
 * parent lives on an explicit non-default timezone, and no founder channel is seeded,
 * so the excluded count is exact.
 */

const KEY = Buffer.alloc(32, 9).toString('base64');
// The run fires at 13:14 UTC. The window is the 24h ending on the floored hour.
const NOW = new Date('2026-03-03T13:14:00Z');
const WINDOW_START = new Date('2026-03-02T13:00:00Z');
const mins = (m: number) => new Date(WINDOW_START.getTime() + m * 60_000);
const secsAfter = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

let db: TestDb;
let real: SeededFamily;
let probe: SeededFamily;
let listed: SeededFamily;
let report: OpsDailyReport;

async function seedFamilyWithPhone(name: string, phone: string): Promise<SeededFamily> {
  const family = await seedFamily(db.database, name);
  await db.database
    .update(schema.users)
    .set({ timezone: 'Pacific/Auckland' })
    .where(eq(schema.users.id, family.parentUserId));
  await db.database.insert(schema.parentChannels).values({
    userId: family.parentUserId,
    familyId: family.familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: new Date('2026-01-01T00:00:00Z'),
  });
  return family;
}

async function inbound(
  family: SeededFamily,
  at: Date,
  providerChatId: string | null = null,
): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'hello',
      providerChatId,
      sentAt: at,
      createdAt: at,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('inbound insert returned no row');
  return row.id;
}

async function outbound(
  family: SeededFamily,
  at: Date,
  fields: {
    status: 'sent' | 'failed' | 'suppressed_quiet_hours';
    templateKey?: string;
    errorCode?: string;
  },
): Promise<void> {
  await db.database.insert(schema.channelMessages).values({
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    channel: 'sms',
    direction: 'out',
    category: 'reply',
    status: fields.status,
    templateKey: fields.templateKey ?? null,
    errorCode: fields.errorCode ?? null,
    sentAt: at,
    createdAt: at,
  });
}

async function ledger(
  family: SeededFamily,
  action: string,
  messageId: string,
  at: Date,
  after: Record<string, string> | null = null,
): Promise<void> {
  await db.database.insert(schema.auditLog).values({
    familyId: family.familyId,
    actor: family.parentUserId,
    actionTaken: action,
    targetTable: 'channel_messages',
    targetId: messageId,
    after,
    occurredAt: at,
  });
}

async function run(
  family: SeededFamily,
  at: Date,
  fields: {
    promptCacheHit: boolean | null;
    cacheReadTokens?: number;
    promptTokens?: number;
    costUsd: string;
    latencyMs?: number;
    agentName?: 'coach-channel-sms' | 'reply-copy';
  },
): Promise<void> {
  await db.database.insert(schema.agentRuns).values({
    familyId: family.familyId,
    agentName: fields.agentName ?? 'coach-channel-sms',
    modelUsed: 'test-model',
    promptTokens: fields.promptTokens ?? 100,
    completionTokens: 10,
    costUsd: fields.costUsd,
    latencyMs: fields.latencyMs ?? 1000,
    promptCacheHit: fields.promptCacheHit,
    cacheReadTokens: fields.cacheReadTokens ?? null,
    startedAt: at,
    completedAt: at,
    status: 'completed',
  });
}

beforeAll(async () => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('FOUNDER_ALERT_EMAIL', '');
  vi.stubEnv('WELCOME_BCC', '');
  db = await createTestDb();

  real = await seedFamilyWithPhone('Larkspur Household', '+15555550111');
  probe = await seedFamilyWithPhone('Probe Household', `${SYNTHETIC_PROBE_PREFIX}0177`);
  listed = await seedFamilyWithPhone('QA Household', '+15555550122');
  vi.stubEnv(METRICS_EXCLUDED_FAMILIES_ENV, listed.familyId);

  // Twenty 1:1 inbounds, each answered by the turn ledger 1..20 seconds later.
  for (let i = 0; i < 20; i += 1) {
    const at = mins(60 + i);
    const id = await inbound(real, at);
    await ledger(real, 'sms_turn_answered', id, secsAfter(at, i + 1));
  }

  // The wrong-pairing guard: an inbound followed only by category-`reply` out-rows that
  // are not answers, and no ledger row. It is a gap, not a fast answer.
  const unanswered = await inbound(real, mins(200));
  for (const templateKey of [
    'followup:activity',
    'linq:upgrade_ask',
    'linq:poll',
    'connector:connected',
  ]) {
    await outbound(real, mins(201), { status: 'sent', templateKey });
  }
  await ledger(real, 'sms_turn_unanswered', unanswered, mins(202), { reason: 'turn_timeout' });
  await ledger(real, 'sms_turn_unanswered', unanswered, mins(203), { reason: 'gate_timeout' });
  await ledger(real, 'sms_turn_unanswered', unanswered, mins(204), { reason: 'gate_timeout' });

  // A dead-lettered in-window inbound for the real family, and one for an excluded one.
  await db.database.insert(schema.rateLimits).values({
    identifier: `${real.familyId}:${unanswered}`,
    route: DEAD_LETTER_PAGE_ROUTE,
    windowStart: new Date(0),
    count: 0,
  });
  const listedInbound = await inbound(listed, mins(300));
  await db.database.insert(schema.rateLimits).values({
    identifier: `${listed.familyId}:${listedInbound}`,
    route: DEAD_LETTER_PAGE_ROUTE,
    windowStart: new Date(0),
    count: 1,
  });

  // A group inbound Hale stayed quiet on.
  await db.database.insert(schema.linqGroupMembers).values({
    familyId: real.familyId,
    chatId: 'group-chat-fixture',
    userId: real.parentUserId,
    phoneE164Encrypted: encryptString('+15555550111'),
    phoneE164Hash: phoneBlindIndex('+15555550111'),
    role: 'parent',
  });
  await inbound(real, mins(400), 'group-chat-fixture');

  // The probe answers slowly; counting it would wreck p95.
  for (let i = 0; i < 2; i += 1) {
    const at = mins(500 + i);
    const id = await inbound(probe, at);
    await ledger(probe, 'sms_turn_answered', id, secsAfter(at, 999));
  }

  // Sends: one real failure, one held; an excluded family's failure is not counted.
  await outbound(real, mins(600), { status: 'failed', errorCode: 'carrier_rejected' });
  await outbound(real, mins(601), { status: 'suppressed_quiet_hours' });
  await outbound(listed, mins(602), { status: 'failed', errorCode: 'listed_only_code' });
  await outbound(probe, mins(603), { status: 'failed', errorCode: 'probe_only_code' });

  // Turn failures and deferrals.
  await ledger(real, 'sms_turn_failed', unanswered, mins(700), {
    lane: 'coach',
    reason: 'apology_sent',
  });
  await ledger(listed, 'sms_turn_failed', listedInbound, mins(701), {
    lane: 'coach',
    reason: 'notice_unsent',
  });
  await ledger(real, 'sms_turn_deferred', unanswered, mins(702), { providerFailure: 'billing' });
  await ledger(real, 'sms_turn_deferred', unanswered, mins(703));

  // A first hello that failed for an intake session opened in the window.
  const [session] = await db.database
    .insert(schema.smsIntakeSessions)
    .values({
      phoneHash: phoneBlindIndex('+15555550133'),
      phoneEncrypted: encryptString('+15555550133'),
      state: 'awaiting_place',
      dataEncrypted: encryptString('{}'),
      createdAt: mins(800),
    })
    .returning({ id: schema.smsIntakeSessions.id });
  if (!session) throw new Error('intake session insert returned no row');
  await db.database.insert(schema.rateLimits).values({
    identifier: `${session.id}:send_failed`,
    route: FIRST_HELLO_PAGE_ROUTE,
    windowStart: new Date(0),
    count: 1,
  });

  // agent_runs for the texted coach: 3 hits, 1 miss, 2 unmeasured. Two rows carry
  // cache tokens (read 300 / prompt 100 each); the rest are NULL.
  const hits: Array<boolean | null> = [true, true, true, false, null, null];
  for (const [i, hit] of hits.entries()) {
    await run(real, mins(900 + i), {
      promptCacheHit: hit,
      ...(i < 2 ? { cacheReadTokens: 300, promptTokens: 100 } : {}),
      costUsd: '0.100000',
      latencyMs: (i + 1) * 1000,
    });
  }
  await run(probe, mins(910), { promptCacheHit: true, costUsd: '9.000000' });

  // Outside the window: neither counted nor an active family.
  const stale = await inbound(real, new Date(WINDOW_START.getTime() - 60 * 60_000));
  await ledger(real, 'sms_turn_answered', stale, new Date(WINDOW_START.getTime() - 59 * 60_000));

  report = await aggregateOpsDaily(db.database, NOW);
}, 120_000);

afterAll(async () => {
  vi.unstubAllEnvs();
  await db.close();
});

describe('aggregateOpsDaily', () => {
  it('reports the 24h ending on the floored hour', () => {
    expect(report.window).toEqual({ start: WINDOW_START, end: new Date('2026-03-03T13:00:00Z') });
  });

  it('counts the real family and excludes the probe and the env-listed household', () => {
    expect(report.families).toEqual({ real: 1, excluded: 2 });
  });

  it('pairs inbounds with the turn ledger, never with category-reply out-rows', () => {
    expect(report.replies).toEqual({
      inbound: 21,
      answered: 20,
      p50Seconds: 10,
      p95Seconds: 19,
      maxSeconds: 20,
      gaps: 1,
      pending: 0,
      groupInbound: 1,
      groupAnswered: 0,
    });
  });

  it('tallies the unanswered steps by reason', () => {
    expect(report.unanswered).toEqual([
      { reason: 'gate_timeout', count: 2 },
      { reason: 'turn_timeout', count: 1 },
    ]);
  });

  it('counts only real families’ sends, holds and failure codes', () => {
    expect(report.sends).toEqual({
      attempted: 5,
      failed: 1,
      codes: [{ code: 'carrier_rejected', count: 1 }],
    });
    expect(report.held).toEqual([{ reason: 'suppressed_quiet_hours', count: 1 }]);
  });

  it('counts failed, deferred and dead-lettered turns for real families only', () => {
    expect(report.turns).toEqual({
      failed: [{ reason: 'apology_sent', count: 1 }],
      deferred: 2,
      providerDeferred: { billing: 1, auth: 0 },
      deadLettered: 1,
      firstHelloFailures: 1,
    });
  });

  it('reads cache hits and the token rate over measured rows only', () => {
    expect(report.cache).toEqual([
      {
        agentName: 'coach-channel-sms',
        runs: 4,
        hitRuns: 3,
        tokenRate: 0.75,
        tokenRuns: 2,
        latencyP95Ms: 6000,
      },
    ]);
  });

  it('sums the real family’s recorded spend and leaves the probe’s out', () => {
    expect(report.spend.families).toBe(1);
    expect(report.spend.totalUsd).toBeCloseTo(0.6, 6);
  });
});

describe('aggregateOpsDaily — spend across families', () => {
  it('reports median, p95 and max over per-family totals', async () => {
    const day = new Date('2026-04-10T13:14:00Z');
    const inWindow = new Date('2026-04-10T05:00:00Z');
    const costs = ['0.100000', '0.500000', '1.400000'];
    for (const [i, cost] of costs.entries()) {
      const family = await seedFamilyWithPhone(`Spend Household ${i}`, `+1555555014${i}`);
      await run(family, inWindow, { promptCacheHit: null, costUsd: cost, agentName: 'reply-copy' });
    }
    const spend = (await aggregateOpsDaily(db.database, day)).spend;
    expect(spend.families).toBe(3);
    expect(spend.totalUsd).toBeCloseTo(2.0, 6);
    expect(spend.medianUsd).toBeCloseTo(0.5, 6);
    expect(spend.p95Usd).toBeCloseTo(1.4, 6);
    expect(spend.maxUsd).toBeCloseTo(1.4, 6);
  });
});

describe('runOpsDaily', () => {
  const claimRows = async (identifier: string) =>
    db.database
      .select({ count: schema.rateLimits.count })
      .from(schema.rateLimits)
      .where(
        and(
          eq(schema.rateLimits.route, OPS_DAILY_ROUTE),
          eq(schema.rateLimits.identifier, identifier),
        ),
      );

  beforeEach(async () => {
    await db.database.delete(schema.rateLimits).where(eq(schema.rateLimits.route, OPS_DAILY_ROUTE));
  });

  it('posts once a day; a second run the same day is already_posted', async () => {
    const post = vi.fn(async (_text: string): Promise<OpsPageOutcome> => 'sent');
    expect(await runOpsDaily(db.database, { post, now: NOW })).toBe('posted');
    expect(await runOpsDaily(db.database, { post, now: new Date('2026-03-03T15:00:00Z') })).toBe(
      'already_posted',
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toContain('real families 1 | excluded 2');
    expect(await claimRows('2026-03-03')).toEqual([{ count: 1 }]);
  });

  for (const outcome of ['failed', 'skipped_not_configured'] as const) {
    it(`releases the claim when the post is ${outcome}, so the next run posts`, async () => {
      const refused = vi.fn(async (_text: string): Promise<OpsPageOutcome> => outcome);
      expect(await runOpsDaily(db.database, { post: refused, now: NOW })).toBe(outcome);
      expect(await claimRows('2026-03-03')).toEqual([]);

      const accepted = vi.fn(async (_text: string): Promise<OpsPageOutcome> => 'sent');
      expect(await runOpsDaily(db.database, { post: accepted, now: NOW })).toBe('posted');
      expect(accepted).toHaveBeenCalledTimes(1);
    });
  }

  it('re-claims an in-progress claim older than two minutes and posts', async () => {
    const crashedAt = Math.floor((NOW.getTime() - 3 * 60_000) / 1000);
    await db.database.insert(schema.rateLimits).values({
      identifier: '2026-03-03',
      route: OPS_DAILY_ROUTE,
      windowStart: new Date(0),
      count: crashedAt,
    });
    const post = vi.fn(async (_text: string): Promise<OpsPageOutcome> => 'sent');
    expect(await runOpsDaily(db.database, { post, now: NOW })).toBe('posted');
    expect(post).toHaveBeenCalledTimes(1);
    expect(await claimRows('2026-03-03')).toEqual([{ count: 1 }]);
  });

  it('leaves an in-progress claim younger than two minutes alone', async () => {
    const startedAt = Math.floor((NOW.getTime() - 30_000) / 1000);
    await db.database.insert(schema.rateLimits).values({
      identifier: '2026-03-03',
      route: OPS_DAILY_ROUTE,
      windowStart: new Date(0),
      count: startedAt,
    });
    const post = vi.fn(async (_text: string): Promise<OpsPageOutcome> => 'sent');
    expect(await runOpsDaily(db.database, { post, now: NOW })).toBe('already_posted');
    expect(post).not.toHaveBeenCalled();
  });

  it('still posts on a day with no families', async () => {
    const post = vi.fn(async (_text: string): Promise<OpsPageOutcome> => 'sent');
    expect(await runOpsDaily(db.database, { post, now: new Date('2025-01-01T13:14:00Z') })).toBe(
      'posted',
    );
    expect(post.mock.calls[0]?.[0]).toContain('real families 0 | excluded 0');
  });
});
