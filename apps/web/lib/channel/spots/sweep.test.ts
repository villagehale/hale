import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Database, schema } from '@hale/db';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SendRefusalReason } from '~/lib/channel/reconcile/gate';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { recordSpotWatchPromise } from './promise';
import {
  type WatchedSpotsSweepDeps,
  type WatchedSpotsSweepSummary,
  claimWatchedSpotsSlot,
  runWatchedSpotsSweep,
  spotOpenKey,
} from './sweep';

/**
 * VIL-337 · the sweep, against the real DDL and zero network.
 *
 * WHY PGLITE AND NOT A CHAIN FAKE. Everything this sweep is for is a database property:
 * a guarded UPDATE that a second tick loses, a partial unique index that arbitrates a
 * double cron fire, a delivery receipt read back off the row the send wrote. A fake
 * returns whatever it was handed, so it passes just as happily with the WHERE clauses
 * deleted — and the store's writers are therefore called for real here rather than
 * injected (a fake of X can never fail on a bug inside X).
 *
 * WHAT IS INJECTED is every EFFECT that leaves the process: the fetch, the transport,
 * the gate's ports, the clock the run's budget is spent against, and the sleep and
 * random that space the requests. No test reaches a municipality, a carrier or a model.
 *
 * Each test names the mutation it exists to kill.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

/** Markham's "Chess: Preschool", saved with its registration window OPEN and its roster
 * full — the real base every variant below overrides one field of. */
const COURSE_ID = '85770d4d-bce9-4e53-b969-cf7e88775180';
const WIDGET_ID = '11111111-1111-1111-1111-111111111111';
const HOST = 'cityofmarkham.perfectmind.com';
const URL_FOR = (courseId: string, host = HOST) =>
  `https://${host}/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=${WIDGET_ID}&courseId=${courseId}`;
const SOURCE_URL = URL_FOR(COURSE_ID);

const FULL_MODEL = {
  EventId: COURSE_ID,
  StartTime: '05:00 PM',
  StartDay: 'Monday',
  SpotsLeft: 0,
  IsRegistrationClosed: false,
  IsFutureRegistration: false,
  IsWaitListAvailable: true,
  IsFull: true,
  MaximumCapacity: 7,
  WaitListSpotsLeft: 100,
  CanNotBook: true,
  OnlineRegistration: true,
} as const;

/** The real page shape (six saved tenants prove it), wrapping a named-field variant of
 * the real model — so only the override is ever hypothetical. */
function pageWith(overrides: Record<string, unknown> = {}): string {
  const model = { ...FULL_MODEL, ...overrides };
  return `<html><body><script>\r\n  var eventInfo = $.extend(true, {}, {\r\n    BackAction: { Url: '/Clients/BookMe4' }\r\n  }, ${JSON.stringify(model)});\r\n</script></body></html>`;
}

const OPEN_PAGE = pageWith({ IsFull: false, SpotsLeft: 2, CanNotBook: false });
const FULL_PAGE = pageWith();
const WAITLIST_FULL_PAGE = pageWith({ WaitListSpotsLeft: 0 });
const WAITLIST_REOPENED_PAGE = pageWith({ WaitListSpotsLeft: 3 });
const NO_WAITLIST_PAGE = pageWith({ IsWaitListAvailable: false });
const CLOSED_PAGE = pageWith({ IsRegistrationClosed: true });
/** PerfectMind answers an unknown courseId with HTTP 200 and a page carrying no model. */
const ERROR_PAGE = readFileSync(
  join(__dirname, 'fixtures', 'markham-course-not-found.html'),
  'utf8',
);

/** 12:00 Monday in Toronto (EDT) — outside the proactive quiet window. */
const MIDDAY = new Date('2026-09-07T16:00:00.000Z');
/** 02:00 in Toronto — the middle of it. */
const TWO_AM = new Date('2026-09-07T06:00:00.000Z');
const TEN_MINUTES = 600_000;

function later(from: Date, ms: number): Date {
  return new Date(from.getTime() + ms);
}

interface Harness {
  deps: WatchedSpotsSweepDeps;
  /** Every url actually requested, in order, cache hits excluded. */
  fetched: string[];
  /** Every jitter the sweep slept for, in order. */
  slept: number[];
  sent: { to: string; body: string }[];
  threaded: string[];
  pages: Map<string, string | Error>;
  gate: { enrolled: boolean; consented: boolean; recentSends: number };
  refusals: SendRefusalReason[];
  phone: string | null;
  /** Milliseconds the fake wall clock advances per fetch — the run's own budget. */
  msPerFetch: number;
  randomValue: number;
}

function harness(overrides: Partial<Pick<Harness, 'randomValue' | 'msPerFetch'>> = {}): Harness {
  const state: Harness = {
    fetched: [],
    slept: [],
    sent: [],
    threaded: [],
    pages: new Map(),
    gate: { enrolled: true, consented: true, recentSends: 0 },
    refusals: [],
    phone: '+15550001111',
    msPerFetch: 0,
    randomValue: 0.5,
    ...overrides,
    deps: undefined as unknown as WatchedSpotsSweepDeps,
  };

  let clock = 0;
  const ports: OutboundGatePorts = {
    async channelEnrolled() {
      return state.gate.enrolled;
    },
    async watchConsentGranted() {
      return state.gate.consented;
    },
    async countProactiveSends() {
      return state.gate.recentSends;
    },
    async proactiveSentSince() {
      return true;
    },
    async parentTimeZone() {
      return 'America/Toronto';
    },
  };

  state.deps = {
    fetchBody: async (url) => {
      state.fetched.push(url);
      clock += state.msPerFetch;
      const page = state.pages.get(url);
      if (page === undefined) throw new Error(`no fixture wired for ${url}`);
      if (page instanceof Error) throw page;
      return page;
    },
    claimSlot: claimWatchedSpotsSlot,
    buildGate: () => ports,
    refuseUnbackedSend: async () => state.refusals,
    resolveSendablePhone: async () => state.phone,
    transport: {
      async send(input) {
        state.sent.push({ to: input.to, body: input.body });
        return { providerMessageId: `SM-${state.sent.length}` };
      },
    },
    recordSend: async (database, write) => {
      const [row] = await database
        .insert(schema.channelMessages)
        .values({ ...write, direction: 'out' })
        .returning({ id: schema.channelMessages.id });
      if (!row) throw new Error('test recordSend: no row');
      return row.id;
    },
    audit: async (database, row) => {
      await database.insert(schema.auditLog).values(row);
    },
    threadMessage: async (_database, input) => {
      state.threaded.push(input.body);
      return 'conversation-1';
    },
    random: () => state.randomValue,
    sleep: async (ms) => {
      state.slept.push(ms);
    },
    clockMs: () => clock,
  };
  return state;
}

interface SeedOptions {
  sourceUrl?: string;
  label?: string;
  instant?: boolean;
  lastState?: 'full' | 'waitlist_full' | 'open';
  pendingKind?: 'seat_opened' | 'waitlist_reopened' | null;
  consecutiveFailures?: number;
  openTransitions?: number;
  sendAttempts?: number;
  notifiedMessageId?: string | null;
  nextPollAt?: Date;
  expiresAt?: Date;
  now?: Date;
}

/** One live watch and the open promise it is owed against. Written directly rather than
 * through `armWatchedSpot` so a test can start from any point in the lifecycle; the arm
 * itself is proven in store.pglite.test.ts. */
async function seedWatch(
  database: Database,
  family: { familyId: string; parentUserId: string },
  options: SeedOptions = {},
): Promise<string> {
  const now = options.now ?? MIDDAY;
  const expiresAt = options.expiresAt ?? later(now, 30 * 86_400_000);
  const [row] = await database
    .insert(schema.watchedSpots)
    .values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      sourceUrl: options.sourceUrl ?? SOURCE_URL,
      label: options.label ?? 'Milliken swim',
      instant: options.instant ?? false,
      lastState: options.lastState ?? 'full',
      pendingKind: options.pendingKind ?? null,
      pendingSince: options.pendingKind ? later(now, -TEN_MINUTES) : null,
      consecutiveFailures: options.consecutiveFailures ?? 0,
      openTransitions: options.openTransitions ?? 0,
      sendAttempts: options.sendAttempts ?? 0,
      notifiedMessageId: options.notifiedMessageId ?? null,
      nextPollAt: options.nextPollAt ?? later(now, -TEN_MINUTES),
      expiresAt,
      createdFrom: 'CM-ack',
    })
    .returning({ id: schema.watchedSpots.id });
  if (!row) throw new Error('seedWatch: no row');
  await recordSpotWatchPromise(database, {
    familyId: family.familyId,
    channelMessageId: 'CM-ack',
    expiresAt,
  });
  return row.id;
}

async function readWatch(spotId: string) {
  const [row] = await db.database
    .select()
    .from(schema.watchedSpots)
    .where(eq(schema.watchedSpots.id, spotId));
  if (!row) throw new Error('readWatch: gone');
  return row;
}

async function commitment(familyId: string) {
  const [row] = await db.database
    .select()
    .from(schema.agentCommitments)
    .where(
      and(
        eq(schema.agentCommitments.familyId, familyId),
        eq(schema.agentCommitments.commitmentKind, 'spot_watch'),
      ),
    )
    .orderBy(asc(schema.agentCommitments.createdAt));
  return row ?? null;
}

async function auditVerbs(familyId: string) {
  return db.database
    .select({ verb: schema.auditLog.actionTaken, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId))
    .orderBy(asc(schema.auditLog.occurredAt));
}

/** Force the delivery receipt this test is about onto the row the send wrote. */
async function setReceipt(status: 'queued' | 'sent' | 'delivered' | 'failed') {
  await db.database
    .update(schema.channelMessages)
    .set({ status })
    .where(
      and(
        eq(schema.channelMessages.direction, 'out'),
        eq(schema.channelMessages.category, 'spot_open'),
        isNotNull(schema.channelMessages.dedupeKey),
      ),
    );
}

beforeEach(async () => {
  vi.stubEnv('WATCHED_SPOTS_ENABLED', 'true');
  vi.stubEnv('F14_ENABLED', 'true');
  vi.stubEnv('F14_FAMILY_ALLOWLIST', '');
  await db.exec('DELETE FROM families');
  await db.exec('DELETE FROM rate_limits');
  await db.exec('DELETE FROM audit_log');
});

describe('runWatchedSpotsSweep — the delivery-truth invariant', () => {
  it('releases a watch only when the text was CONFIRMED, and tries once more when it was not', async () => {
    // The mutation this kills: releasing the watch (and keeping the promise) on the
    // Twilio ACCEPT. That design passes tick 1 and tick 2 and then marks a household
    // "told" about a seat whose text the carrier threw away.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const spotId = await seedWatch(db.database, family, { lastState: 'full' });

    const tick1 = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);
    expect(tick1.sent).toBe(1);
    expect(tick1.transitions).toBe(1);
    let row = await readWatch(spotId);
    expect(row.releasedAt).toBeNull();
    expect(row.notifiedMessageId).not.toBeNull();
    expect(row.notifiedTransitions).toBe(0);
    expect((await commitment(family.familyId))?.fulfilledAt).toBeNull();

    // Tick 2 — Twilio has accepted and nothing has come back. Still live, and the page
    // is not re-read: there is nothing this tick could learn.
    await setReceipt('queued');
    const before = test.fetched.length;
    const tick2 = await runWatchedSpotsSweep(db.database, test.deps, later(MIDDAY, TEN_MINUTES));
    expect(tick2.awaitingReceipt).toBe(1);
    expect(test.fetched.length).toBe(before);
    expect((await readWatch(spotId)).releasedAt).toBeNull();

    // Tick 3 — DELIVERED. Now, and only now, the watch is over and the promise is kept
    // by the message that kept it.
    await setReceipt('delivered');
    const messageId = (await readWatch(spotId)).notifiedMessageId;
    const tick3 = await runWatchedSpotsSweep(db.database, test.deps, later(MIDDAY, 2 * TEN_MINUTES));
    expect(tick3.released.notified).toBe(1);
    row = await readWatch(spotId);
    expect(row.releasedReason).toBe('notified');
    expect(row.notifiedTransitions).toBe(1);
    const kept = await commitment(family.familyId);
    expect(kept?.fulfilledAt).not.toBeNull();
    expect(kept?.fulfilledBy).toBe(messageId);
    expect(test.sent).toHaveLength(1);
  });

  it('sends a second text on a FAILED receipt, and ends the watch loudly on a second failure', async () => {
    // THE DEFECT CASE. `CONSUMED_SEND_STATUSES` includes 'failed', so the retry must mint
    // a NEW key — the mutation this kills is reusing `spot_open:<id>:1:1`, which the
    // ledger's dedupe would silently swallow, leaving the parent never told and the watch
    // looking healthy forever.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const spotId = await seedWatch(db.database, family, { lastState: 'full' });

    await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);
    await setReceipt('failed');

    const retry = await runWatchedSpotsSweep(db.database, test.deps, later(MIDDAY, TEN_MINUTES));
    expect(retry.sent).toBe(1);
    expect(test.sent).toHaveLength(2);
    const keys = await db.database
      .select({ key: schema.channelMessages.dedupeKey })
      .from(schema.channelMessages)
      .orderBy(asc(schema.channelMessages.createdAt));
    expect(keys.map((k) => k.key)).toEqual([
      spotOpenKey(spotId, 1, 1),
      spotOpenKey(spotId, 1, 2),
    ]);

    await setReceipt('failed');
    const ended = await runWatchedSpotsSweep(db.database, test.deps, later(MIDDAY, 2 * TEN_MINUTES));
    expect(ended.released.delivery_failed).toBe(1);
    expect(test.sent).toHaveLength(2);
    const row = await readWatch(spotId);
    expect(row.releasedReason).toBe('delivery_failed');
    expect(row.notifiedTransitions).toBe(0);
    const voided = await commitment(family.familyId);
    expect(voided?.cancelledReason).toBe('spot_watch_ended');
    expect(voided?.fulfilledAt).toBeNull();
  });
});

describe('runWatchedSpotsSweep — one text per opening', () => {
  it('does nothing at all on a second cron fire inside the same slot', async () => {
    // Kills the removal of the slot claim: because a healthy read no longer advances
    // next_poll_at, nothing else stops a Vercel retry from spending a second round of
    // GETs on a municipality.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, FULL_PAGE);
    await seedWatch(db.database, family, { lastState: 'full' });

    await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);
    const first = test.fetched.length;
    const second = await runWatchedSpotsSweep(db.database, test.deps, later(MIDDAY, 60_000));

    expect(second.skipped.slotClaimed).toBe(true);
    expect(second.polled).toBe(0);
    expect(test.fetched.length).toBe(first);
  });

  it('heals a text whose bookkeeping write was lost, and does not send it again', async () => {
    // The post-send `setNotifiedMessage` failed: the attempt is spent, the ledger row
    // exists, and nothing points at it. Kills the mutation that treats "attempt spent,
    // no pointer" as "send again" unconditionally — that re-texts every ten minutes.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const spotId = await seedWatch(db.database, family, {
      lastState: 'open',
      pendingKind: 'seat_opened',
      openTransitions: 1,
      sendAttempts: 1,
    });
    const [orphan] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'spot_open',
        templateKey: 'spot_open:seat_opened',
        dedupeKey: spotOpenKey(spotId, 1, 1),
        status: 'queued',
        providerMessageId: 'SM-orphan',
      })
      .returning({ id: schema.channelMessages.id });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.healed).toBe(1);
    expect(summary.sent).toBe(0);
    expect(test.sent).toHaveLength(0);
    expect((await readWatch(spotId)).notifiedMessageId).toBe(orphan?.id);
  });

  it('retries past a prior attempt the carrier already judged FAILED, and never heals onto it', async () => {
    // THE HEAL TRAP. `dedupeActive` consumes the key on 'failed' too, so asking it
    // "was this key spent?" answers yes for a text nobody received — and the mutation
    // this kills (healing on key-spent rather than on the ROW's status) re-attaches the
    // watch to a dead row, counts it as `healed`, and then clears it again next tick:
    // heal/clear every ten minutes all night, a fictional Radar count, and the retry
    // arriving a tick late.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const spotId = await seedWatch(db.database, family, {
      lastState: 'open',
      pendingKind: 'seat_opened',
      openTransitions: 1,
      sendAttempts: 1,
    });
    const [dead] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'spot_open',
        templateKey: 'spot_open:seat_opened',
        dedupeKey: spotOpenKey(spotId, 1, 1),
        status: 'failed',
        providerMessageId: 'SM-dead',
      })
      .returning({ id: schema.channelMessages.id });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.sent).toBe(1);
    expect(summary.healed).toBe(0);
    expect(test.sent).toHaveLength(1);
    const keys = await db.database
      .select({ key: schema.channelMessages.dedupeKey })
      .from(schema.channelMessages)
      .orderBy(asc(schema.channelMessages.createdAt));
    expect(keys.map((k) => k.key)).toEqual([spotOpenKey(spotId, 1, 1), spotOpenKey(spotId, 1, 2)]);
    const row = await readWatch(spotId);
    expect(row.sendAttempts).toBe(2);
    expect(row.notifiedMessageId).not.toBe(dead?.id);
  });

  it('ends the watch as delivery_failed when the last attempt left a failed row behind', async () => {
    // The exhausted half of the same seam, and the mutation it kills is folding it into
    // `send_unconfirmed`: a text the carrier explicitly threw away is not a text whose
    // fate is unknown, and the two are different things to tell a founder.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const spotId = await seedWatch(db.database, family, {
      lastState: 'open',
      pendingKind: 'seat_opened',
      openTransitions: 1,
      sendAttempts: 2,
    });
    await db.database.insert(schema.channelMessages).values({
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'spot_open',
      templateKey: 'spot_open:seat_opened',
      dedupeKey: spotOpenKey(spotId, 1, 2),
      status: 'failed',
      providerMessageId: 'SM-dead-2',
    });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.released.delivery_failed).toBe(1);
    expect(summary.healed).toBe(0);
    expect(test.sent).toHaveLength(0);
    expect((await readWatch(spotId)).releasedReason).toBe('delivery_failed');
  });

  it('heals only onto a row a text can still arrive under, not merely onto a row that is not FAILED', async () => {
    // 'failed' is one of FIVE statuses that mean nobody was texted; the other four are
    // the suppressions. The mutation this kills is spelling the guard as the denylist
    // `status !== 'failed'` instead of the allowlist SENT_STATUSES — a denylist that
    // heals onto every suppression today and onto whatever status the enum gains next,
    // silently re-opening the trap the test above closes. The watch would read
    // `notified` on the strength of a row that says, in terms, "this was not sent".
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const spotId = await seedWatch(db.database, family, {
      lastState: 'open',
      pendingKind: 'seat_opened',
      openTransitions: 1,
      sendAttempts: 1,
    });
    const [suppressed] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'spot_open',
        templateKey: 'spot_open:seat_opened',
        dedupeKey: spotOpenKey(spotId, 1, 1),
        status: 'suppressed_consent',
      })
      .returning({ id: schema.channelMessages.id });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.healed).toBe(0);
    expect(summary.sent).toBe(1);
    expect(test.sent).toHaveLength(1);
    const row = await readWatch(spotId);
    expect(row.sendAttempts).toBe(2);
    expect(row.notifiedMessageId).not.toBe(suppressed?.id);
  });

  it('spends the second attempt when the ledger row itself was lost, then ends the watch', async () => {
    // recordSend threw after a successful transport.send: the attempt moved, no row
    // exists under any key. Bounded at two texts per opening, then a NAMED release —
    // kills an unbounded "no row, try again" loop.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const spotId = await seedWatch(db.database, family, {
      lastState: 'open',
      pendingKind: 'seat_opened',
      openTransitions: 1,
      sendAttempts: 2,
    });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.released.send_unconfirmed).toBe(1);
    expect(test.sent).toHaveLength(0);
    expect((await readWatch(spotId)).releasedReason).toBe('send_unconfirmed');
  });

  it('spends the attempt on the transport call, not on the bookkeeping that follows it', async () => {
    // WHERE the attempt is claimed is the whole bound. `recordSend` throws here AFTER
    // the text has left, which is the real failure the ordering exists for — the
    // mutation this kills (claiming the attempt after `recordSend`) leaves the counter
    // at zero for a text that went out and re-texts the household every ten minutes
    // forever, with every other test in this file still green.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    test.deps.recordSend = async () => {
      throw new Error('the ledger write was lost');
    };
    const spotId = await seedWatch(db.database, family, { lastState: 'full' });

    const first = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);
    expect(first).toMatchObject({ transitions: 1, sent: 0, failed: 1 });
    expect((await readWatch(spotId)).sendAttempts).toBe(1);

    const second = await runWatchedSpotsSweep(db.database, test.deps, later(MIDDAY, TEN_MINUTES));
    expect(second.failed).toBe(1);
    expect((await readWatch(spotId)).sendAttempts).toBe(2);

    const third = await runWatchedSpotsSweep(
      db.database,
      test.deps,
      later(MIDDAY, 2 * TEN_MINUTES),
    );
    expect(third.released.send_unconfirmed).toBe(1);

    const fourth = await runWatchedSpotsSweep(
      db.database,
      test.deps,
      later(MIDDAY, 3 * TEN_MINUTES),
    );
    expect(fourth.polled).toBe(0);
    expect(test.sent).toHaveLength(2);
  });
});

describe('runWatchedSpotsSweep — a held observation is re-derived, never replayed', () => {
  it('holds a 2 a.m. opening with nothing written, then sends it in the morning', async () => {
    // The attempt must NOT be spent on a hold: the mutation that claims it before the
    // gate burns one of the two attempts every quiet hour, so a watch that opened at
    // 02:00 has no attempts left by 08:00.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const spotId = await seedWatch(db.database, family, { lastState: 'full', now: TWO_AM });

    const night = await runWatchedSpotsSweep(db.database, test.deps, TWO_AM);

    expect(night.held.quiet_hours).toBe(1);
    expect(night.sent).toBe(0);
    let row = await readWatch(spotId);
    expect(row.pendingKind).toBe('seat_opened');
    expect(row.sendAttempts).toBe(0);
    expect(row.openTransitions).toBe(1);

    const morning = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(morning.sent).toBe(1);
    expect(morning.transitions).toBe(0);
    row = await readWatch(spotId);
    expect(row.sendAttempts).toBe(1);
    expect(test.sent[0]?.body).toContain('2 spots left');
  });

  it('wakes the household that asked to be woken, at 2 a.m.', async () => {
    // The control is the test above: same page, same hour, `instant` false and held.
    // The mutation this kills is the sweep never selecting the instant class (sending
    // every watch as plain `spot_open`), which turns a parent's explicit opt-in into a
    // quiet-hours hold — the opt-in folded into a bucket that means the opposite.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const spotId = await seedWatch(db.database, family, {
      lastState: 'full',
      instant: true,
      now: TWO_AM,
    });

    const night = await runWatchedSpotsSweep(db.database, test.deps, TWO_AM);

    expect(night.sent).toBe(1);
    expect(night.held.quiet_hours).toBe(0);
    expect(test.sent).toHaveLength(1);
    expect((await readWatch(spotId)).sendAttempts).toBe(1);
    const [trail] = await auditVerbs(family.familyId);
    expect(trail?.after).toMatchObject({ instant: true });
  });

  it('drops the held opening when the page refilled overnight, and says nothing', async () => {
    // THE DEFECT CASE for a composer fed a STORED reading: it would text a parent at
    // 08:01 about a seat that closed at 03:00.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const spotId = await seedWatch(db.database, family, { lastState: 'full', now: TWO_AM });
    await runWatchedSpotsSweep(db.database, test.deps, TWO_AM);

    test.pages.set(SOURCE_URL, FULL_PAGE);
    const morning = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(morning.closedBeforeSend).toBe(1);
    expect(morning.sent).toBe(0);
    expect(test.sent).toHaveLength(0);
    const row = await readWatch(spotId);
    expect(row.pendingKind).toBeNull();
    expect(row.lastState).toBe('full');
    expect(row.releasedAt).toBeNull();
  });
});

describe('runWatchedSpotsSweep — a reopened waitlist is news, a closed one is not', () => {
  it('texts about room on the waitlist, with no headcount in it', async () => {
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, WAITLIST_REOPENED_PAGE);
    await seedWatch(db.database, family, { lastState: 'waitlist_full' });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.sent).toBe(1);
    const body = test.sent[0]?.body ?? '';
    expect(body).toContain('room on the waitlist');
    // The model carries WaitListCapacity and WaitListSpotsLeft, so "5 people ahead of
    // you" is arithmetic — the one thing the evidence rule forbids. The only digits this
    // sentence may carry are the link's and the schedule the page serialised.
    expect(body).not.toMatch(/spots?\s+left/i);
    expect(body.replace(SOURCE_URL, '').replace('Monday 05:00 PM', '')).not.toMatch(/\d/);
  });

  it.each([
    ['the queue is still full', WAITLIST_FULL_PAGE, 'waitlist_full'],
    ['the tenant runs no waitlist at all', NO_WAITLIST_PAGE, 'full'],
  ])('says nothing when %s', async (_label, page, expectedState) => {
    // Kills a transition rule that fires on the STATE alone: waitlist_full → full is
    // only news when the queue actually has room in it.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, page);
    const spotId = await seedWatch(db.database, family, { lastState: 'waitlist_full' });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.sent).toBe(0);
    expect(summary.quiet).toBe(1);
    expect(test.sent).toHaveLength(0);
    const row = await readWatch(spotId);
    expect(row.lastState).toBe(expectedState);
    expect(row.pendingKind).toBeNull();
  });
});

describe('runWatchedSpotsSweep — a page nobody could read is never a state', () => {
  it('backs off on an unreadable read and leaves the state alone', async () => {
    // Kills the reader whose default branch is a state: an HTTP-200 error page or a
    // vendor redesign must never satisfy the `prev is full` precondition a text needs.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, new Error('ECONNRESET'));
    const spotId = await seedWatch(db.database, family, {
      lastState: 'full',
      pendingKind: null,
    });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.unreadable).toBe(1);
    expect(summary.sent).toBe(0);
    const row = await readWatch(spotId);
    expect(row.consecutiveFailures).toBe(1);
    expect(row.lastState).toBe('full');
    expect(row.pendingKind).toBeNull();
    expect(row.nextPollAt.getTime()).toBe(MIDDAY.getTime() + 1_200_000);
  });

  it('reads an HTTP-200 error page as unreadable rather than as an empty class', async () => {
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, ERROR_PAGE);
    const spotId = await seedWatch(db.database, family, { lastState: 'full' });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.unreadable).toBe(1);
    expect((await readWatch(spotId)).lastState).toBe('full');
  });

  it('ends a stuck watch loudly at the sixth failure', async () => {
    // Kills silent decay: a vendor field rename must become a released watch, a voided
    // promise and an audit row, not a watch that reports nothing for sixty days.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, ERROR_PAGE);
    const spotId = await seedWatch(db.database, family, { consecutiveFailures: 5 });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.released.unreadable_streak).toBe(1);
    expect((await readWatch(spotId)).releasedReason).toBe('unreadable_streak');
    expect((await commitment(family.familyId))?.cancelledReason).toBe('spot_watch_ended');
    expect((await auditVerbs(family.familyId)).map((r) => r.verb)).toEqual([
      'watched_spot_released',
    ]);
  });

  it('keeps the promise alive when the family still has another watch', async () => {
    // The positive control for the test above: the promise is "Hale is watching", not
    // "Hale is watching this page", so it is re-recorded against the surviving watch
    // rather than cancelled.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, ERROR_PAGE);
    await seedWatch(db.database, family, { consecutiveFailures: 5 });
    await seedWatch(db.database, family, {
      sourceUrl: URL_FOR('99999999-9999-4999-8999-999999999999'),
      nextPollAt: later(MIDDAY, TEN_MINUTES),
    });

    await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    const open = await db.database
      .select({ id: schema.agentCommitments.id })
      .from(schema.agentCommitments)
      .where(
        and(
          eq(schema.agentCommitments.familyId, family.familyId),
          eq(schema.agentCommitments.commitmentKind, 'spot_watch'),
        ),
      );
    expect(open.length).toBeGreaterThan(1);
  });
});

describe('runWatchedSpotsSweep — households and seasons that ended', () => {
  it.each([
    ['the parent pressed STOP', { enrolled: false }, 'parent_stopped', 'channel_revoked'],
    ['watch consent was withdrawn', { consented: false }, 'consent_withdrawn', 'channel_revoked'],
  ])('releases before a single fetch when %s', async (_label, gate, reason, cancelReason) => {
    // Kills a sweep that only learns of STOP from the gate AFTER the read: that costs a
    // municipality one GET every ten minutes for sixty days on behalf of a household
    // that left.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    Object.assign(test.gate, gate);
    const spotId = await seedWatch(db.database, family, { lastState: 'full' });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.released[reason as 'parent_stopped']).toBe(1);
    expect(test.fetched).toEqual([]);
    expect(test.sent).toEqual([]);
    expect((await readWatch(spotId)).releasedReason).toBe(reason);
    expect((await commitment(family.familyId))?.cancelledReason).toBe(cancelReason);
  });

  it('positive control: an enrolled, consented household IS fetched', async () => {
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, FULL_PAGE);
    await seedWatch(db.database, family, { lastState: 'full' });

    await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(test.fetched).toEqual([SOURCE_URL]);
  });

  it('ends the season honestly when registration closes behind the watch', async () => {
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, CLOSED_PAGE);
    const spotId = await seedWatch(db.database, family, { lastState: 'full' });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.released.registration_closed).toBe(1);
    expect(summary.sent).toBe(0);
    expect((await readWatch(spotId)).releasedReason).toBe('registration_closed');
    const [trail] = await auditVerbs(family.familyId);
    expect(trail?.verb).toBe('watched_spot_released');
    expect(trail?.after).toMatchObject({ reason: 'registration_closed', readingReason: 'closed' });
    // Rule #1: the trail names the portal, never the page or the parent's own label.
    expect(JSON.stringify(trail?.after)).not.toContain('Milliken');
    expect(JSON.stringify(trail?.after)).not.toContain('courseId');
  });

  it('releases a watch whose season outlived it', async () => {
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const spotId = await seedWatch(db.database, family, {
      expiresAt: later(MIDDAY, -1000),
    });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.released.expired).toBe(1);
    expect(test.fetched).toEqual([]);
    expect((await readWatch(spotId)).releasedReason).toBe('expired');
  });
});

describe('runWatchedSpotsSweep — bounded, spaced and source-respectful', () => {
  it('reads at most twenty spots a run, oldest wait first', async () => {
    // Kills a slice taken in insertion order, which would starve the spot that has been
    // waiting longest whenever the working set outgrows one run. Twenty-five households
    // on ONE page: the bound under test is the slice, and the page cache means the whole
    // run is a single request.
    const test = harness();
    test.pages.set(SOURCE_URL, FULL_PAGE);
    for (let index = 0; index < 25; index += 1) {
      const family = await seedFamily(db.database, `Family ${index}`);
      await seedWatch(db.database, family, {
        nextPollAt: later(MIDDAY, -(25 - index) * 60_000),
      });
    }

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.polled).toBe(20);
    expect(test.fetched).toEqual([SOURCE_URL]);
    const polled = await db.database
      .select({ waited: schema.watchedSpots.nextPollAt })
      .from(schema.watchedSpots)
      .where(isNotNull(schema.watchedSpots.lastPolledAt))
      .orderBy(asc(schema.watchedSpots.nextPollAt));
    expect(polled).toHaveLength(20);
    // The twenty that had waited longest; the five youngest keep their turn.
    expect(polled.at(-1)?.waited.getTime()).toBe(MIDDAY.getTime() - 6 * 60_000);
  });

  it('spends at most four requests on one municipality, and one per url', async () => {
    // Kills the removal of either bound: a household with ten watches on one town would
    // otherwise be ten GETs a tick, sixty an hour, from one IP.
    const family = await seedFamily(db.database);
    const test = harness();
    for (let index = 0; index < 10; index += 1) {
      const url = URL_FOR(`00000000-0000-4000-8000-00000000000${index}`);
      test.pages.set(url, FULL_PAGE);
      await seedWatch(db.database, family, { sourceUrl: url });
    }

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(test.fetched).toHaveLength(4);
    expect(summary.polled).toBe(4);
    expect(summary.skipped.hostBudget).toBe(6);
  });

  it('reads one url once however many families watch it', async () => {
    const one = await seedFamily(db.database, 'One');
    const two = await seedFamily(db.database, 'Two');
    const test = harness();
    test.pages.set(SOURCE_URL, FULL_PAGE);
    await seedWatch(db.database, one);
    await seedWatch(db.database, two);

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(test.fetched).toEqual([SOURCE_URL]);
    expect(summary.polled).toBe(2);
  });

  it.each([
    [0, 500],
    [0.999, 2498],
  ])('sleeps a jittered %s before every uncached request', async (roll, expected) => {
    const family = await seedFamily(db.database);
    const test = harness({ randomValue: roll });
    test.pages.set(SOURCE_URL, FULL_PAGE);
    await seedWatch(db.database, family);

    await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(test.slept).toEqual([expected]);
  });

  it('stamps last_polled_at on EVERY read, including the tick that sends', async () => {
    // `cron_heartbeats` says the sweep fired; `max(last_polled_at)` says a spot was
    // REACHED, and that is what the Radar reads as freshness. Kills the version where
    // only the quiet path stamps — the freshness signal would then go stale precisely
    // on the ticks where the sweep is doing the thing it exists for.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const spotId = await seedWatch(db.database, family, { lastState: 'full' });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.sent).toBe(1);
    expect((await readWatch(spotId)).lastPolledAt).toEqual(MIDDAY);
  });

  it('clears the failure streak the moment a page reads again', async () => {
    // Kills a streak that only ever grows: five flaky ticks followed by weeks of healthy
    // reads would release the watch as `unreadable_streak` on the sixth bad day.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, FULL_PAGE);
    const spotId = await seedWatch(db.database, family, { consecutiveFailures: 5 });

    await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    const row = await readWatch(spotId);
    expect(row.consecutiveFailures).toBe(0);
    expect(row.releasedAt).toBeNull();
  });

  it('leaves next_poll_at alone on a healthy read, so a late tick still reads everything', async () => {
    // Kills `next_poll_at = now + 540_000` on a healthy read: a tick that fires two
    // minutes late would then find the spot not yet due and halve its own cadence.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, FULL_PAGE);
    const spotId = await seedWatch(db.database, family);
    const due = (await readWatch(spotId)).nextPollAt;

    await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);
    expect((await readWatch(spotId)).nextPollAt).toEqual(due);

    const late = await runWatchedSpotsSweep(db.database, test.deps, later(MIDDAY, 12 * 60_000));
    expect(late.polled).toBe(1);
    expect(test.fetched).toHaveLength(2);
  });

  it('stops at the wall budget and leaves the unreached spots due', async () => {
    // Kills an unbounded loop inside maxDuration 300: a run that never returns never
    // stamps the heartbeat, and the dead-man switch pages the founder for a slow portal.
    const family = await seedFamily(db.database);
    const test = harness({ msPerFetch: 130_000 });
    for (let index = 0; index < 3; index += 1) {
      const url = URL_FOR(`00000000-0000-4000-8000-00000000000${index}`);
      test.pages.set(url, FULL_PAGE);
      await seedWatch(db.database, family, {
        sourceUrl: url,
        nextPollAt: later(MIDDAY, -(3 - index) * 60_000),
      });
    }

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.polled).toBe(2);
    expect(summary.skipped.wallBudget).toBe(1);
    expect(test.fetched).toHaveLength(2);
  });

  it('claims no slot when nothing is due', async () => {
    // A quiet hour must not spend the slot a real tick would have wanted.
    const test = harness();

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.polled).toBe(0);
    expect(summary.skipped.slotClaimed).toBe(false);
    const claims = await db.database.select({ id: schema.rateLimits.id }).from(schema.rateLimits);
    expect(claims).toEqual([]);
  });

  it('does nothing at all while WATCHED_SPOTS_ENABLED is off', async () => {
    // STRICT on the literal 'true': `vercel env add` from a piped echo stores 'true\n'.
    vi.stubEnv('WATCHED_SPOTS_ENABLED', 'true\n');
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    await seedWatch(db.database, family);

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.enabled).toBe(false);
    expect(test.fetched).toEqual([]);
  });

  it('counts a family that lost F14 arming and never reads its page', async () => {
    // Not released: re-arming the family resumes the watch, and it expires on its own
    // clock meanwhile.
    vi.stubEnv('F14_ENABLED', 'false');
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const spotId = await seedWatch(db.database, family);

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.skipped.f14Dark).toBe(1);
    expect(test.fetched).toEqual([]);
    expect((await readWatch(spotId)).releasedAt).toBeNull();
  });
});

describe('runWatchedSpotsSweep — every non-send is a named outcome', () => {
  it('counts a wire body the family ledger does not back, and spends no attempt', async () => {
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    test.refusals = ['unrecorded_promise'];
    const spotId = await seedWatch(db.database, family, { lastState: 'full' });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.refused).toBe(1);
    expect(summary.failed).toBe(0);
    expect(summary.sent).toBe(0);
    expect(test.sent).toEqual([]);
    // The opening survives at full strength: nothing was sent, so nothing was spent.
    expect((await readWatch(spotId)).sendAttempts).toBe(0);
  });

  it('isolates one broken portal from the household next to it', async () => {
    // Kills a sweep that lets one municipality's outage throw: the run would not return,
    // the heartbeat would not stamp, and the dead-man switch would page.
    const broken = await seedFamily(db.database, 'Broken');
    const working = await seedFamily(db.database, 'Working');
    const test = harness();
    const brokenUrl = URL_FOR('00000000-0000-4000-8000-000000000001');
    test.pages.set(brokenUrl, new Error('HTTP 503'));
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    await seedWatch(db.database, broken, {
      sourceUrl: brokenUrl,
      nextPollAt: later(MIDDAY, -TEN_MINUTES * 2),
    });
    await seedWatch(db.database, working, { lastState: 'full' });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.unreadable).toBe(1);
    expect(summary.sent).toBe(1);
    expect(test.sent).toHaveLength(1);
  });

  it('fails only the spot whose parent contradicts the gate', async () => {
    // resolveSendablePhone returning null after an ALLOWED verdict is a contradiction,
    // not a state to paper over — but it is one household's contradiction.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    test.phone = null;
    await seedWatch(db.database, family, { lastState: 'full' });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(0);
    expect(test.sent).toEqual([]);
  });

  it('holds under the frequency cap without touching the observation', async () => {
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    test.gate.recentSends = 4;
    const spotId = await seedWatch(db.database, family, { lastState: 'full' });

    const summary = await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(summary.held.frequency_cap).toBe(1);
    expect(summary.sent).toBe(0);
    expect((await readWatch(spotId)).pendingKind).toBe('seat_opened');
  });

  it('threads the COMPOSED sentence and puts the CASL line only on the wire', async () => {
    // Kills threading the wire body: the parent would read the unsubscribe line back in
    // the app, and the coach would re-read it as something Hale said.
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    await seedWatch(db.database, family, { lastState: 'full' });

    await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    expect(test.threaded).toHaveLength(1);
    expect(test.threaded[0]).not.toContain('STOP');
    expect(test.sent[0]?.body).toContain('STOP');
    expect(test.sent[0]?.body.startsWith(test.threaded[0] ?? 'x')).toBe(true);
  });

  it('records the send on the trail as provenance, never as content', async () => {
    const family = await seedFamily(db.database);
    const test = harness();
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    await seedWatch(db.database, family, { lastState: 'full', instant: true });

    await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);

    const [trail] = await auditVerbs(family.familyId);
    expect(trail?.verb).toBe('watched_spot_opened_sent');
    expect(trail?.after).toMatchObject({
      host: HOST,
      kind: 'seat_opened',
      openTransitions: 1,
      attempt: 1,
      instant: true,
    });
    expect(JSON.stringify(trail?.after)).not.toContain('Milliken');
    expect(JSON.stringify(trail?.after)).not.toContain('spots left');
  });

  it('logs enum-shaped facts only, never the class, the page or the portal record', async () => {
    // Rule #1 on the log line, which nothing else in this lane enforces: the mutation
    // this kills is one `console.info({ model: reading.model })` after the read — the
    // whole portal payload, for one identifiable family's class, in Vercel's log drain.
    const broken = await seedFamily(db.database, 'Broken');
    const reading = await seedFamily(db.database, 'Reading');
    const test = harness();
    const brokenUrl = URL_FOR('00000000-0000-4000-8000-000000000001');
    test.pages.set(brokenUrl, new Error(`fetch failed: ${brokenUrl}`));
    test.pages.set(SOURCE_URL, OPEN_PAGE);
    const brokenId = await seedWatch(db.database, broken, {
      sourceUrl: brokenUrl,
      nextPollAt: later(MIDDAY, -2 * TEN_MINUTES),
    });
    await seedWatch(db.database, reading, { lastState: 'full', label: 'Milliken swim' });

    const logged: unknown[] = [];
    const capture = (...args: unknown[]) => {
      logged.push(...args);
    };
    const spies = (['info', 'warn', 'error'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(capture),
    );
    try {
      await runWatchedSpotsSweep(db.database, test.deps, MIDDAY);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const text = JSON.stringify(logged);
    // Positive control: the spy caught the lines that DO fire, and they name a host.
    expect(text).toContain(brokenId);
    expect(text).toContain(HOST);
    expect(text).not.toContain('Milliken swim');
    expect(text).not.toContain('SpotsLeft');
    expect(text).not.toContain(COURSE_ID);
    expect(text).not.toContain(brokenUrl);
  });

  it('names the summary shape so a new fate cannot hide in an existing bucket', async () => {
    // The shape IS the contract (rule #11): a fate folded into a neighbour is a sweep
    // that looks healthy while a parent is never told.
    const test = harness();

    const summary: WatchedSpotsSweepSummary = await runWatchedSpotsSweep(
      db.database,
      test.deps,
      MIDDAY,
    );

    expect(summary).toEqual({
      enabled: true,
      polled: 0,
      transitions: 0,
      sent: 0,
      quiet: 0,
      unreadable: 0,
      raced: 0,
      healed: 0,
      closedBeforeSend: 0,
      awaitingReceipt: 0,
      refused: 0,
      failed: 0,
      held: { not_enrolled: 0, no_watch_consent: 0, frequency_cap: 0, quiet_hours: 0 },
      released: {
        notified: 0,
        expired: 0,
        parent_stopped: 0,
        consent_withdrawn: 0,
        unreadable_streak: 0,
        registration_closed: 0,
        delivery_failed: 0,
        send_unconfirmed: 0,
      },
      skipped: { wallBudget: 0, hostBudget: 0, f14Dark: 0, slotClaimed: false },
    });
  });
});
