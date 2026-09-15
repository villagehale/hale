import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CANARY_PHONE_E164 } from '~/lib/channel/canary/config';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';
import { loadAgentSpend } from './agent-spend';
import { loadAuditMix } from './audit-mix';
import { loadDbErrors } from './errors';
import { loadGrowth } from './growth';
import { loadIntakeFunnel } from './intake-funnel';
import { loadPulse } from './pulse';
import { loadRadar } from './radar';
import { loadTextingTrends } from './texting';
import { loadTextingByHour } from './texting-hours';
import { loadWatchedSpots } from './watched-spots';

/**
 * Every admin loader runs against REAL Postgres (the migrated pglite schema).
 * The texting test proves the bucket math; this one proves the rest of the
 * SQL — percentile_cont, filter clauses, enum casts, make_interval — parses
 * and executes. A loader with a syntax error would render its panel's error
 * boundary forever while every mocked test stayed green.
 */

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('admin loaders execute against real Postgres', () => {
  it('loadPulse: a full 24-slot band with zeroed counters', async () => {
    const pulse = await loadPulse(db.database);
    expect(pulse.hourly).toHaveLength(24);
    expect(pulse).toMatchObject({
      familiesToday: 0,
      msgsInToday: 0,
      msgsOutToday: 0,
      newFamiliesToday: 0,
      failuresToday: 0,
      spendTodayUsd: 0,
    });
  });

  it('loadGrowth: totals, tiers and days', async () => {
    expect(await loadGrowth(db.database)).toEqual({
      days: [],
      tiers: [],
      foundingCount: 0,
      total: 0,
    });
  });

  it('loadIntakeFunnel / loadAuditMix / loadTextingTrends: empty day sets', async () => {
    expect(await loadIntakeFunnel(db.database)).toEqual({ days: [], sources: [] });
    expect(await loadAuditMix(db.database)).toEqual([]);
    expect(await loadTextingTrends(db.database)).toEqual([]);
  });

  it('loadAgentSpend: days + byAgentDay (percentile_cont parses)', async () => {
    expect(await loadAgentSpend(db.database)).toEqual({ days: [], byAgentDay: [] });
  });

  it('loadRadar: upcoming, freshness, outcomes', async () => {
    expect(await loadRadar(db.database)).toEqual({
      upcoming: [],
      freshestVerifiedAt: null,
      lastVerifyRun: null,
      outcomes: [],
    });
  });

  it('loadWatchedSpots: nothing is being watched', async () => {
    expect(await loadWatchedSpots(db.database)).toEqual({
      live: 0,
      pending: 0,
      unreadable: 0,
      lastPolledAt: null,
      armFailures24h: 0,
    });
  });

  it('loadDbErrors: merged empty ledger', async () => {
    expect(await loadDbErrors(db.database)).toEqual([]);
  });
});

describe('loadAgentSpend — day-grain leaderboard rows (seeded, exact)', () => {
  it('groups runs, failures and cost by Toronto day × agent', async () => {
    const fam = await seedFamily(db.database, 'Spend Family');
    const run = (
      agentName: 'reviewer' | 'drafter',
      startedAt: string,
      status: 'completed' | 'failed' | 'timed_out' | 'killed_cost' = 'completed',
      costUsd = '0.010000',
    ) => ({
      familyId: fam.familyId,
      agentName,
      modelUsed: 'claude-sonnet-5',
      status,
      costUsd,
      startedAt: new Date(startedAt),
    });

    await db.database.insert(schema.agentRuns).values([
      run('reviewer', '2026-08-10T15:00:00.000Z'),
      run('reviewer', '2026-08-10T16:00:00.000Z', 'failed', '0.020000'),
      // timed_out and killed_cost are failures too — the ONE failure
      // vocabulary, same as the Operations tab's classes.
      run('reviewer', '2026-08-10T17:00:00.000Z', 'timed_out', '0.005000'),
      // 03:00Z on Aug 11 is Toronto Aug 10, 23:00 — the boundary is Toronto's.
      run('drafter', '2026-08-11T03:00:00.000Z'),
      run('drafter', '2026-08-11T15:00:00.000Z'),
      run('drafter', '2026-08-11T16:00:00.000Z', 'killed_cost', '0.040000'),
    ]);

    const { days, byAgentDay } = await loadAgentSpend(db.database);
    expect(byAgentDay).toEqual([
      { day: '2026-08-10', agent: 'drafter', runs: 1, failedRuns: 0, costUsd: 0.01 },
      { day: '2026-08-10', agent: 'reviewer', runs: 3, failedRuns: 2, costUsd: 0.035 },
      { day: '2026-08-11', agent: 'drafter', runs: 2, failedRuns: 1, costUsd: 0.05 },
    ]);
    expect(days).toEqual([
      {
        day: '2026-08-10',
        costUsd: 0.045,
        runs: 4,
        failedRuns: 2,
        cacheHits: 0,
        cacheKnown: 0,
        p50LatencyMs: null,
      },
      {
        day: '2026-08-11',
        costUsd: 0.05,
        runs: 2,
        failedRuns: 1,
        cacheHits: 0,
        cacheKnown: 0,
        p50LatencyMs: null,
      },
    ]);
  });
});

describe('loadRadar — per-row verified stamp (seeded, exact)', () => {
  it('carries verifiedAt on every upcoming window', async () => {
    await db.database.insert(schema.registrationWindows).values([
      {
        municipality: 'toronto',
        programDomain: 'rec_program',
        cycleLabel: 'Winter 2027',
        openAt: new Date('2026-12-03T14:00:00.000Z'),
        residentOpenAt: new Date('2026-12-01T14:00:00.000Z'),
        sourceUrl: 'https://example.test/rec',
        verifiedAt: new Date('2026-08-20T12:00:00.000Z'),
      },
    ]);

    const radar = await loadRadar(db.database);
    expect(radar.upcoming).toEqual([
      {
        municipality: 'toronto',
        programDomain: 'rec_program',
        cycleLabel: 'Winter 2027',
        openAt: '2026-12-03T14:00:00Z',
        residentOpenAt: '2026-12-01T14:00:00Z',
        verifiedAt: '2026-08-20T12:00:00Z',
      },
    ]);
  });
});

describe('loadIntakeFunnel — day-grain sources (seeded, exact)', () => {
  it('groups starts and provisioned by Toronto day × code, coalescing null to direct', async () => {
    const fam = await seedFamily(db.database, 'Sources Family');
    const session = (
      phoneHash: string,
      createdAt: string,
      sourceCode: string | null,
      familyId: string | null = null,
    ) => ({
      phoneHash,
      phoneEncrypted: 'enc',
      state: 'awaiting_details',
      dataEncrypted: 'enc',
      sourceCode,
      familyId,
      createdAt: new Date(createdAt),
    });

    await db.database.insert(schema.smsIntakeSessions).values([
      // Toronto Aug 10: two earlyon starts, one provisioned; one direct (null code).
      session('h1', '2026-08-10T15:00:00.000Z', 'earlyon'),
      session('h2', '2026-08-10T16:00:00.000Z', 'earlyon', fam.familyId),
      session('h3', '2026-08-10T17:00:00.000Z', null),
      // 03:00Z on Aug 10 is Toronto Aug 9 — the day boundary is Toronto's.
      session('h4', '2026-08-10T03:00:00.000Z', 'earlyon'),
    ]);

    const { sources } = await loadIntakeFunnel(db.database);
    expect(sources).toEqual([
      { day: '2026-08-09', code: 'earlyon', started: 1, provisioned: 0 },
      { day: '2026-08-10', code: 'direct', started: 1, provisioned: 0 },
      { day: '2026-08-10', code: 'earlyon', started: 2, provisioned: 1 },
    ]);
  });
});

describe('loadWatchedSpots — live counts and the arm-failure window (seeded, exact)', () => {
  it('counts live rows only, holds pending back once texted, and dates the last live poll', async () => {
    const fam = await seedFamily(db.database, 'Watched Family');
    const spot = (suffix: string, row: Partial<typeof schema.watchedSpots.$inferInsert>) => ({
      familyId: fam.familyId,
      parentUserId: fam.parentUserId,
      sourceUrl: `https://cityofmarkham.perfectmind.com/course/${suffix}`,
      label: 'a full class',
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
      createdFrom: `CM-${suffix}`,
      ...row,
    });

    await db.database.insert(schema.watchedSpots).values([
      spot('a', { lastPolledAt: new Date('2026-08-30T10:00:00.000Z') }),
      spot('b', {
        pendingKind: 'seat_opened',
        pendingSince: new Date('2026-08-30T11:00:00.000Z'),
        lastPolledAt: new Date('2026-08-30T11:00:00.000Z'),
      }),
      // An opening already carried to a phone: live, but no longer one Hale is
      // holding back — it must not inflate the number that matters at 07:00.
      spot('c', {
        pendingKind: 'waitlist_reopened',
        pendingSince: new Date('2026-08-30T09:00:00.000Z'),
        notifiedMessageId: 'CM-sent',
        lastPolledAt: new Date('2026-08-30T09:00:00.000Z'),
      }),
      // Released, holding the newest poll, a failure streak AND an un-texted pending
      // observation: a loader that forgot `released_at is null` on any of the four
      // counters would show it here.
      spot('d', {
        consecutiveFailures: 3,
        pendingKind: 'seat_opened',
        pendingSince: new Date('2026-09-01T07:00:00.000Z'),
        lastPolledAt: new Date('2026-09-01T08:00:00.000Z'),
        releasedAt: new Date('2026-09-01T08:00:00.000Z'),
        releasedReason: 'notified',
      }),
      spot('e', {
        consecutiveFailures: 2,
        lastPolledAt: new Date('2026-08-30T12:34:56.000Z'),
      }),
    ]);

    const audit = (actionTaken: string, occurredAt: Date) => ({
      familyId: fam.familyId,
      actor: 'system',
      actionTaken,
      targetTable: 'watched_spots',
      occurredAt,
    });
    await db.database.insert(schema.auditLog).values([
      audit('watched_spot_arm_failed', new Date()),
      // The same verb one hour past the window — a window widened to 48h would count
      // it — and TWO successes inside it, so a loader counting the sibling verb by
      // mistake reads 2, never the 1 it happens to share.
      audit('watched_spot_arm_failed', new Date(Date.now() - 25 * 3_600_000)),
      audit('watched_spot_armed', new Date()),
      audit('watched_spot_armed', new Date()),
    ]);

    expect(await loadWatchedSpots(db.database)).toEqual({
      live: 4,
      pending: 1,
      unreadable: 1,
      lastPolledAt: '2026-08-30T12:34:56Z',
      armFailures24h: 1,
    });
  });
});

// Seeds "today" rows, so it must stay LAST — earlier describes assert on
// windows that would otherwise pick these up.
describe('loadPulse — failuresToday uses the one failure vocabulary (seeded, exact)', () => {
  it('counts failed/timed_out/killed_cost runs and outbound failed sends; inbound never', async () => {
    const fam = await seedFamily(db.database, 'Pulse Family');
    const run = (status: 'completed' | 'failed' | 'timed_out' | 'killed_cost') => ({
      familyId: fam.familyId,
      agentName: 'reviewer' as const,
      modelUsed: 'claude-sonnet-5',
      status,
      costUsd: '0.010000',
      startedAt: new Date(),
    });

    await db.database
      .insert(schema.agentRuns)
      .values([run('completed'), run('failed'), run('timed_out'), run('killed_cost')]);

    const message = (
      direction: 'in' | 'out',
      status: 'failed' | 'suppressed_quiet_hours' = 'failed',
    ) => ({
      familyId: fam.familyId,
      parentUserId: fam.parentUserId,
      channel: 'sms' as const,
      direction,
      category: 'reply' as const,
      status,
      createdAt: new Date(),
    });

    // The outbound failure counts; the inbound failed row must never — same
    // structural guard as texting's msgsFailed (#594). The suppression is a row
    // where no provider was contacted, so it is not outbound traffic either.
    await db.database
      .insert(schema.channelMessages)
      .values([message('out'), message('in'), message('out', 'suppressed_quiet_hours')]);

    const pulse = await loadPulse(db.database);
    // 3 failed runs + 1 outbound failed send.
    expect(pulse.failuresToday).toBe(4);
    // Hand-recomputed: the one failed send is the only row that reached the
    // provider today — the suppression must not inflate the founder's out count.
    expect(pulse.msgsOutToday).toBe(1);
  });
});

// Also seeds "today" rows — stays after the empty-ledger assertions above.
describe('loadDbErrors — the send-failure ledger is outbound only (seeded, exact)', () => {
  it('lists an outbound failed send; an inbound failed row never appears', async () => {
    const fam = await seedFamily(db.database, 'Ledger Family');
    const message = (direction: 'in' | 'out', errorCode: string) => ({
      familyId: fam.familyId,
      parentUserId: fam.parentUserId,
      channel: 'sms' as const,
      direction,
      category: 'reply' as const,
      status: 'failed' as const,
      errorCode,
      createdAt: new Date(),
    });

    await db.database
      .insert(schema.channelMessages)
      .values([message('out', '30007'), message('in', '30099')]);

    const codes = (await loadDbErrors(db.database))
      .filter((row) => row.source === 'message')
      .map((row) => row.code);
    // Positive control: the outbound failure IS a ledger row...
    expect(codes).toContain('30007');
    // ...and the inbound one never is.
    expect(codes).not.toContain('30099');
  });
});

// Seeds "today" rows too — last, for the same reason the two above are late.
describe('the founder dashboards count FAMILY traffic, not the inbound canary', () => {
  it('a probe turn moves no numeral; a real parent in the same batch moves all of them', async () => {
    const real = await seedFamily(db.database, 'Real Family');
    const probe = await seedFamily(db.database, 'Hale inbound canary');
    await db.database.insert(schema.parentChannels).values({
      userId: probe.parentUserId,
      familyId: probe.familyId,
      kind: 'sms',
      phoneE164Encrypted: encryptString(CANARY_PHONE_E164),
      phoneE164Hash: phoneBlindIndex(CANARY_PHONE_E164),
      verifiedAt: new Date(),
    });

    const before = {
      pulse: await loadPulse(db.database),
      trends: await loadTextingTrends(db.database),
      hours: await loadTextingByHour(db.database),
      mix: await loadAuditMix(db.database),
    };

    const inbound = (fam: { familyId: string; parentUserId: string }) => ({
      familyId: fam.familyId,
      parentUserId: fam.parentUserId,
      channel: 'sms' as const,
      direction: 'in' as const,
      category: 'reply' as const,
      status: 'delivered' as const,
      createdAt: new Date(),
    });

    // Six canary ticks — one hour of the shipped 9-59/10 cadence — and ONE real
    // parent. Every numeral below must move by exactly the one.
    await db.database
      .insert(schema.channelMessages)
      .values([
        inbound(probe),
        inbound(probe),
        inbound(probe),
        inbound(probe),
        inbound(probe),
        inbound(probe),
        inbound(real),
      ]);

    // The same seven turns in the audit trail. A canary tick leaves TWO rows —
    // the door's and the handler's — both actored by the household's own parent
    // (twilio/inbound.ts, canary/handler.ts), which is the column the mix joins on.
    const acting = (fam: { familyId: string; parentUserId: string }, action: string) => ({
      familyId: fam.familyId,
      actor: fam.parentUserId,
      actionTaken: action,
      targetTable: 'channel_messages',
    });
    const tick = (fam: { familyId: string; parentUserId: string }) => [
      acting(fam, 'sms_reply_received'),
      acting(fam, 'sms_canary_answered'),
    ];
    await db.database
      .insert(schema.auditLog)
      .values([
        ...tick(probe),
        ...tick(probe),
        ...tick(probe),
        ...tick(probe),
        ...tick(probe),
        ...tick(probe),
        acting(real, 'sms_reply_received'),
      ]);

    const after = {
      pulse: await loadPulse(db.database),
      trends: await loadTextingTrends(db.database),
      hours: await loadTextingByHour(db.database),
      mix: await loadAuditMix(db.database),
    };

    // POSITIVE CONTROL first: the real parent did land, so a zero delta below
    // cannot be the seed silently failing.
    expect(after.pulse.msgsInToday).toBe(before.pulse.msgsInToday + 1);
    expect(after.pulse.familiesToday).toBe(before.pulse.familiesToday + 1);

    const strip = (p: { hourly: { count: number }[] }) =>
      p.hourly.reduce((sum, slot) => sum + slot.count, 0);
    expect(strip(after.pulse)).toBe(strip(before.pulse) + 1);

    const msgsIn = (rows: { msgsIn: number }[]) => rows.reduce((sum, r) => sum + r.msgsIn, 0);
    const senders = (rows: { senders: number }[]) => rows.reduce((sum, r) => sum + r.senders, 0);
    expect(msgsIn(after.trends)).toBe(msgsIn(before.trends) + 1);
    expect(senders(after.trends)).toBe(senders(before.trends) + 1);

    const hourly = (rows: { count: number }[]) => rows.reduce((sum, r) => sum + r.count, 0);
    expect(hourly(after.hours)).toBe(hourly(before.hours) + 1);

    const acted = (rows: { action: string; count: number }[], action: string) =>
      rows.filter((r) => r.action === action).reduce((sum, r) => sum + r.count, 0);
    expect(acted(after.mix, 'sms_reply_received')).toBe(
      acted(before.mix, 'sms_reply_received') + 1,
    );
    expect(acted(after.mix, 'sms_canary_answered')).toBe(0);
  });
});
