import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { OutboundGatePorts, ProactiveSendKind } from '~/lib/channel/outbound-gate';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { fulfillCommitment } from '~/lib/commitments/ledger';
import { at } from '~/lib/testing/clock';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { WriterResult } from './compose';
import type { DecideResult, DeciderDecision } from './decide';
import { type CandidateDraft, type ChannelCategory, handOffProactive } from './queue';
import { type ProactiveReviewDeps, runProactiveReview } from './review';
import type { FamilySnapshot } from './snapshot';
import { PROACTIVE_WEEKLY_CAP_SENDS_ENV, WEEKLY_CAP_WINDOW_MS, weeklyCapSends } from './weekly-cap';

/**
 * VIL-722 · the weekly proactive cap over real Postgres, with the flag off, on with no
 * number, and on with a test number. The decider and the writer are ports, as in
 * review.pglite.test.ts: their judgment is graded against cached Claude in
 * apps/worker/evals. What this file owns is what the review DOES at send time once the
 * decider chose to send.
 *
 * `TEST_SENDS` is a number for these tests only. Barton decided on 2026-11-19 that no
 * number is set: the code has no default, and production leaves the number unset.
 */

const TEST_SENDS = '2';
const FLAG = 'PROACTIVE_WEEKLY_CAP_ENABLED';
const TZ = 'America/New_York';
/** Thursday 14:00 in the family's zone, outside every quiet window. */
const NOW = at('2026-11-19T19:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PHONE = '+15555550100';
const MESSAGE = 'Saturday afternoon is open: indoor climbing by the river.';

let db: TestDb;
let familyId: string;
let parentUserId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  await db.exec('truncate table families, users cascade');
  vi.unstubAllEnvs();
  // Every case names its own flag and number: the all-flags-on CI job sets the flag.
  vi.stubEnv(FLAG, undefined);
  vi.stubEnv(PROACTIVE_WEEKLY_CAP_SENDS_ENV, undefined);
  vi.stubEnv('PROACTIVE_CADENCE', 'live');
  const family = await seedFamily(db.database);
  familyId = family.familyId;
  parentUserId = family.parentUserId;
  await db.database
    .update(schema.users)
    .set({ timezone: TZ })
    .where(eq(schema.users.id, parentUserId));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A candidate the way a sweep queues one. */
async function enqueue(dedupeKey: string, over: Partial<CandidateDraft> = {}): Promise<string> {
  const mode = process.env.PROACTIVE_CADENCE;
  vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
  await handOffProactive(
    db.database,
    [
      {
        familyId,
        parentUserId,
        kind: 'nudge',
        category: 'nudge',
        templateKey: 'proactive_nudge:weather_swap',
        what: 'Indoor climbing by the river',
        why: 'weather_swap',
        sourceUrl: 'https://example.test/climb',
        worthlessAfter: null,
        parentRequested: false,
        dedupeKey,
        ...over,
      },
    ],
    'candidate',
  );
  vi.stubEnv('PROACTIVE_CADENCE', mode);
  const [row] = await db.database
    .select({ id: schema.proactiveCandidates.id })
    .from(schema.proactiveCandidates)
    .where(eq(schema.proactiveCandidates.dedupeKey, dedupeKey));
  return row?.id as string;
}

/** A row a past review already settled, as `mark` leaves it. */
async function settled(
  sentAt: Date,
  over: {
    kind?: ProactiveSendKind;
    category?: ChannelCategory;
    status?: 'sent' | 'held' | 'dropped' | 'shadowed';
    parentRequested?: boolean;
    family?: string;
    parent?: string;
  } = {},
): Promise<void> {
  await db.database.insert(schema.proactiveCandidates).values({
    familyId: over.family ?? familyId,
    parentUserId: over.parent ?? parentUserId,
    kind: over.kind ?? 'nudge',
    category: over.category ?? 'nudge',
    templateKey: 'proactive_nudge:weather_swap',
    what: '',
    why: 'weather_swap',
    parentRequested: over.parentRequested ?? false,
    dedupeKey: `settled:${crypto.randomUUID()}`,
    status: over.status ?? 'sent',
    decision: 'send_now',
    createdAt: new Date(sentAt.getTime() - HOUR),
    decidedAt: sentAt,
  });
}

const openGate = (): OutboundGatePorts => ({
  channelEnrolled: async () => true,
  watchConsentGranted: async () => true,
  countProactiveSends: async () => 0,
  proactiveSentSince: async () => true,
  parentTimeZone: async () => TZ,
});

interface Harness {
  deps: ProactiveReviewDeps;
  transport: FakeTransport;
  snapshots: FamilySnapshot[];
  composed: number;
}

function harness(): Harness {
  const transport = new FakeTransport();
  const state: Harness = { deps: {} as ProactiveReviewDeps, transport, snapshots: [], composed: 0 };
  state.deps = {
    client: null,
    transport,
    decide: async ({ snapshot }): Promise<DecideResult> => {
      state.snapshots.push(snapshot);
      const decision: DeciderDecision = {
        reason: 'it fits the afternoon',
        action: 'send_now',
        itemIds: snapshot.candidates.map((candidate) => candidate.id),
        holdUntil: null,
        frequencyPreference: null,
      };
      return { decision, skipped: null };
    },
    compose: async (): Promise<WriterResult> => {
      state.composed += 1;
      return { message: MESSAGE };
    },
    buildGate: openGate,
    resolveSendablePhone: async () => PHONE,
    lineHold: async () => null,
    loadRecipients: async () => [{ parentUserId, timeZone: TZ, role: 'primary_parent' }],
    outboundTarget: async () => ({ channel: 'legacy' }),
    threadMessage: threadProactiveMessage,
    fulfillCommitment,
    recheckOpenAsk: async () => ({ verdict: 'owed', timeZone: TZ }),
    page: async () => 'paged',
  };
  return state;
}

async function candidate(id: string) {
  const [row] = await db.database
    .select()
    .from(schema.proactiveCandidates)
    .where(eq(schema.proactiveCandidates.id, id));
  return row;
}

async function audits(action: string) {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, action)));
}

describe('what spends the weekly budget', () => {
  it('counts one send per review moment, however many items or parents it reached', async () => {
    const other = await seedFamily(db.database, 'Co-parent');
    const moment = new Date(NOW.getTime() - DAY);
    await settled(moment);
    await settled(moment, { kind: 'evening_check_in', category: 'evening_check_in' });
    await settled(moment, { parent: other.parentUserId });
    await settled(new Date(NOW.getTime() - 3 * DAY));

    expect(await weeklyCapSends(db.database, familyId, NOW)).toEqual([
      new Date(NOW.getTime() - 3 * DAY),
      moment,
    ]);
  });

  it('counts nothing that did not leave, nothing exempt, and nothing the parent asked for', async () => {
    const inWindow = new Date(NOW.getTime() - DAY);
    for (const status of ['held', 'dropped', 'shadowed'] as const) {
      await settled(inWindow, { status });
    }
    await settled(inWindow, { kind: 'spot_open', category: 'spot_open' });
    await settled(inWindow, { kind: 'activity_followup', category: 'activity_followup' });
    await settled(inWindow, { parentRequested: true });

    expect(await weeklyCapSends(db.database, familyId, NOW)).toEqual([]);
  });

  it('reads a rolling seven days of this family only', async () => {
    const other = await seedFamily(db.database, 'Other Family');
    await settled(new Date(NOW.getTime() - WEEKLY_CAP_WINDOW_MS));
    await settled(new Date(NOW.getTime() - WEEKLY_CAP_WINDOW_MS + 1000));
    await settled(new Date(NOW.getTime() + HOUR));
    await settled(new Date(NOW.getTime() - DAY), {
      family: other.familyId,
      parent: other.parentUserId,
    });

    expect(await weeklyCapSends(db.database, familyId, NOW)).toEqual([
      new Date(NOW.getTime() - WEEKLY_CAP_WINDOW_MS + 1000),
    ]);
  });
});

describe('VIL-722 weekly proactive cap in the hourly review', () => {
  it('flag off: a family past the test number is texted as before', async () => {
    vi.stubEnv(PROACTIVE_WEEKLY_CAP_SENDS_ENV, TEST_SENDS);
    for (const days of [1, 2, 3]) await settled(new Date(NOW.getTime() - days * DAY));
    for (const value of [undefined, 'true\n', 'TRUE']) {
      vi.stubEnv(FLAG, value);
      const id = await enqueue(`nudge:off:${value ?? 'unset'}`);
      const h = harness();

      const summary = await runProactiveReview(db.database, h.deps, NOW);

      expect({ value, summary }).toMatchObject({
        value,
        summary: { sent: 1, weeklyCapHeld: 0, weeklyCapUnarmed: 0 },
      });
      expect(h.transport.bodies()).toHaveLength(1);
      expect(await candidate(id)).toMatchObject({ status: 'sent' });
    }
  });

  it.each([
    ['unset', undefined],
    ['invalid', '0'],
  ])('flag on with the number %s: caps nothing, and names it once', async (reason, raw) => {
    vi.stubEnv(FLAG, 'true');
    vi.stubEnv(PROACTIVE_WEEKLY_CAP_SENDS_ENV, raw);
    for (const days of [1, 2, 3]) await settled(new Date(NOW.getTime() - days * DAY));
    const id = await enqueue('nudge:no-number');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness();

    const summary = await runProactiveReview(db.database, h.deps, NOW);

    expect(summary).toMatchObject({ sent: 1, weeklyCapHeld: 0, weeklyCapUnarmed: 1 });
    expect(await candidate(id)).toMatchObject({ status: 'sent' });
    const named = warn.mock.calls.filter(([, line]) =>
      String(line).includes('PROACTIVE_WEEKLY_CAP_SENDS has no number'),
    );
    expect(named).toEqual([[{ reason }, expect.any(String)]]);
  });

  it('flag on with a test number: sends until the week is full, then holds by name and says nothing', async () => {
    vi.stubEnv(FLAG, 'true');
    vi.stubEnv(PROACTIVE_WEEKLY_CAP_SENDS_ENV, TEST_SENDS);
    // Older than seven days: spent nothing this week.
    await settled(new Date(NOW.getTime() - 8 * DAY));

    // One text that carries two items is one send.
    await enqueue('nudge:one');
    await enqueue('nudge:two', { why: 'empty_saturday', what: 'Saturday story time' });
    const first = harness();
    expect(await runProactiveReview(db.database, first.deps, NOW)).toMatchObject({
      sent: 1,
      weeklyCapHeld: 0,
    });
    expect(first.transport.bodies()).toHaveLength(1);

    const second = harness();
    await enqueue('nudge:three');
    const later = new Date(NOW.getTime() + HOUR);
    expect(await runProactiveReview(db.database, second.deps, later)).toMatchObject({
      sent: 1,
      weeklyCapHeld: 0,
    });

    // Two sends in seven days against a test number of two: the next one waits.
    const third = harness();
    const heldId = await enqueue('nudge:four');
    const full = new Date(NOW.getTime() + 2 * HOUR);
    const summary = await runProactiveReview(db.database, third.deps, full);

    expect(summary).toMatchObject({ decided: 1, sent: 0, weeklyCapHeld: 1 });
    expect(third.transport.bodies()).toEqual([]);
    expect(third.composed).toBe(0);
    expect(await candidate(heldId)).toMatchObject({
      status: 'held',
      reason: 'weekly_cap',
      decision: 'send_now',
      holdUntil: new Date(NOW.getTime() + WEEKLY_CAP_WINDOW_MS),
    });
    const held = await audits('proactive_cadence_held');
    expect(held.map((row) => row.after)).toEqual([
      { reason: 'weekly_cap', itemIds: [heldId], mode: 'live' },
    ]);
    const outbound = await db.database
      .select({ id: schema.channelMessages.id })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.familyId, familyId),
          eq(schema.channelMessages.direction, 'out'),
          eq(schema.channelMessages.dedupeKey, 'nudge:four'),
        ),
      );
    expect(outbound).toEqual([]);
  });

  it('hands a held text back to the decider once the budget frees, and it goes then', async () => {
    vi.stubEnv(FLAG, 'true');
    vi.stubEnv(PROACTIVE_WEEKLY_CAP_SENDS_ENV, TEST_SENDS);
    const oldest = new Date(NOW.getTime() - 6 * DAY);
    await settled(oldest);
    await settled(new Date(NOW.getTime() - DAY));
    const id = await enqueue('nudge:waits');
    await runProactiveReview(db.database, harness().deps, NOW);
    const reopensAt = new Date(oldest.getTime() + WEEKLY_CAP_WINDOW_MS);
    expect(await candidate(id)).toMatchObject({ status: 'held', holdUntil: reopensAt });

    // Before the clock, the decider is not asked again.
    const early = harness();
    await runProactiveReview(db.database, early.deps, new Date(reopensAt.getTime() - HOUR));
    expect(early.snapshots.flatMap((snapshot) => snapshot.candidates)).toEqual([]);

    const freed = harness();
    const after = new Date(reopensAt.getTime() + 60_000);
    vi.setSystemTime(after);
    const summary = await runProactiveReview(db.database, freed.deps, after);

    expect(freed.snapshots.flatMap((snapshot) => snapshot.candidates.map((c) => c.id))).toEqual([
      id,
    ]);
    expect(summary).toMatchObject({ sent: 1, weeklyCapHeld: 0 });
    expect(freed.transport.bodies()).toHaveLength(1);
    expect(await candidate(id)).toMatchObject({ status: 'sent' });
  });

  it('lets what the parent asked for, and the exempt classes, through a full week', async () => {
    vi.stubEnv(FLAG, 'true');
    vi.stubEnv(PROACTIVE_WEEKLY_CAP_SENDS_ENV, TEST_SENDS);
    // Exempt sends do not fill the week.
    for (const days of [1, 2, 3]) {
      await settled(new Date(NOW.getTime() - days * DAY), {
        kind: 'spot_open',
        category: 'spot_open',
      });
    }
    const counted = await enqueue('nudge:counted-under');
    await runProactiveReview(db.database, harness().deps, NOW);
    expect(await candidate(counted)).toMatchObject({ status: 'sent' });

    // Now full: the counted item waits, the asked-for and exempt ones in the same text go.
    await settled(new Date(NOW.getTime() - 4 * DAY));
    const later = new Date(NOW.getTime() + HOUR);
    const nudge = await enqueue('nudge:counted-full');
    const asked = await enqueue('nudge:asked', { parentRequested: true, what: 'Remind me' });
    const spot = await enqueue('spot:open', {
      kind: 'spot_open',
      category: 'spot_open',
      templateKey: 'spot_open',
      what: 'A Saturday swim seat opened up.',
      why: 'spot_open',
      sourceUrl: null,
    });
    const h = harness();

    const summary = await runProactiveReview(db.database, h.deps, later);

    expect(summary).toMatchObject({ weeklyCapHeld: 1 });
    expect(await candidate(nudge)).toMatchObject({ status: 'held', reason: 'weekly_cap' });
    expect(await candidate(asked)).toMatchObject({ status: 'sent' });
    expect(await candidate(spot)).toMatchObject({ status: 'sent' });
    expect(h.transport.bodies().length).toBeGreaterThan(0);
  });
});
