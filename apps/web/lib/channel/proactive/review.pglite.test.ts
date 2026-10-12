import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEEKDAY_CARE_ASK_TEMPLATE_KEY } from '~/lib/care/weekday';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { weekdayFinderDedupeKey } from '~/lib/channel/weekday-care/key';
import { fulfillCommitment } from '~/lib/commitments/ledger';
import { assembleMemoryBrief } from '~/lib/memory/brief';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { WriterResult } from './compose';
import type { DecideResult, DeciderDecision } from './decide';
import { type CandidateDraft, handOffProactive } from './queue';
import {
  FAMILY_ROWS,
  type ProactiveReviewDeps,
  WAITING_ROWS,
  mark,
  runProactiveReview,
} from './review';
import {
  CALENDAR_ROWS,
  type FamilySnapshot,
  RECENT_PARENT_TEXTS,
  SNAPSHOT_DAYS,
  WITHHELD_LABEL,
} from './snapshot';
import { LINE_CHARS, type ToolCandidate, boundedLine } from './tools';

/**
 * `live` arms only once every proactive class is routed (flag.ts PROACTIVE_ROUTING). The
 * live path here is tested as it will run then; `routing.complete = false` is today's
 * table, where a requested live runs as shadow.
 */
const routing = vi.hoisted(() => ({ complete: true }));
vi.mock('~/lib/channel/proactive/flag', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/channel/proactive/flag')>();
  return {
    ...actual,
    proactiveCadence: () =>
      routing.complete ? actual.requestedCadence() : actual.proactiveCadence(),
  };
});

/**
 * The hourly review over real Postgres. The decider and the writer are ports here: their
 * judgment is graded against real cached Claude in apps/worker/evals
 * (run-proactive-decider-eval.mjs, run-proactive-writer-eval.mjs). What this file owns is
 * what the review DOES with a decision: which rows move, what is audited, what is sent,
 * and what the red lines still refuse at send time.
 */

const TZ = 'America/New_York';
/** Thursday 18:00 in the family's zone. */
const THURSDAY_EVENING = new Date('2026-10-08T22:00:00.000Z');
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
  await db.exec('truncate table families, users cascade');
  vi.unstubAllEnvs();
  const family = await seedFamily(db.database);
  familyId = family.familyId;
  parentUserId = family.parentUserId;
  await db.database
    .update(schema.users)
    .set({ timezone: TZ })
    .where(eq(schema.users.id, parentUserId));
});

afterEach(() => {
  routing.complete = true;
  vi.unstubAllEnvs();
});

async function enqueue(
  dedupeKey = 'nudge:weather:w41',
  over: Partial<CandidateDraft> = {},
): Promise<string> {
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
  written: ToolCandidate[][];
}

function harness(
  decision: (snapshot: FamilySnapshot) => DeciderDecision | null,
  over: Partial<ProactiveReviewDeps> = {},
): Harness {
  const transport = new FakeTransport();
  const state: Harness = {
    deps: {} as ProactiveReviewDeps,
    transport,
    snapshots: [],
    composed: 0,
    written: [],
  };
  state.deps = {
    client: null,
    transport,
    decide: async ({ snapshot }): Promise<DecideResult> => {
      state.snapshots.push(snapshot);
      const made = decision(snapshot);
      return made ? { decision: made, skipped: null } : { decision: null, skipped: 'unparsed' };
    },
    compose: async ({ items }): Promise<WriterResult> => {
      state.composed += 1;
      state.written.push([...items]);
      return { message: MESSAGE };
    },
    buildGate: openGate,
    resolveSendablePhone: async () => PHONE,
    linePaused: async () => false,
    loadRecipients: async () => [{ parentUserId, timeZone: TZ, role: 'primary_parent' }],
    outboundTarget: async () => ({ channel: 'legacy' }),
    threadMessage: threadProactiveMessage,
    fulfillCommitment,
    ...over,
  };
  return state;
}

const sendAll = (snapshot: FamilySnapshot): DeciderDecision => ({
  reason: 'Saturday fits and it is Thursday evening',
  action: 'send_now',
  itemIds: snapshot.candidates.map((candidate) => candidate.id),
  holdUntil: null,
  frequencyPreference: null,
});

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

describe('runProactiveReview', () => {
  it('does nothing at all while the flag is unset', async () => {
    await enqueue();
    const h = harness(sendAll);
    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(summary).toMatchObject({ mode: 'off', families: 0, decided: 0, sent: 0 });
    expect(h.snapshots).toEqual([]);
  });

  it('in shadow, records the decision and marks the item shadowed without sending', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const id = await enqueue();
    const h = harness(sendAll);

    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(summary).toMatchObject({
      mode: 'shadow',
      families: 1,
      decided: 1,
      shadowed: 1,
      sent: 0,
    });
    expect(h.transport.sent).toEqual([]);
    expect(h.composed).toBe(0);
    expect(await candidate(id)).toMatchObject({ status: 'shadowed', decision: 'send_now' });
    const [decision] = await audits('proactive_cadence_decision');
    expect(decision?.after).toMatchObject({ action: 'send_now', itemIds: [id], mode: 'shadow' });
    expect(decision).toMatchObject({ targetTable: 'families', targetId: familyId });
  });

  it('runs a requested live as shadow while any class is unrouted, and says so', async () => {
    routing.complete = false;
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const id = await enqueue();
    const h = harness(sendAll);

    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(summary).toMatchObject({ requested: 'live', mode: 'shadow', shadowed: 1, sent: 0 });
    expect(h.transport.sent).toEqual([]);
    expect(await candidate(id)).toMatchObject({ status: 'shadowed' });
  });

  it('hands the decider the wall clock and the family zone, never a default', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await enqueue();
    const h = harness(sendAll);
    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(h.snapshots[0]?.timeZone).toBe(TZ);
    expect(h.snapshots[0]?.localNow).toBe('Thursday 6:00 PM America/New_York');
    expect(JSON.stringify(h.snapshots[0])).not.toContain('nudge:weather');
  });

  it('when live, sends the batch, writes the ledger row the sweep would have, and audits it', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const id = await enqueue();
    const h = harness(sendAll);

    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(summary).toMatchObject({ mode: 'live', sent: 1 });
    expect(h.transport.bodies()).toEqual([MESSAGE]);
    expect(h.transport.sent[0]?.to).toBe(PHONE);
    expect(await candidate(id)).toMatchObject({ status: 'sent' });
    const ledger = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, familyId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      parentUserId,
      direction: 'out',
      category: 'nudge',
      templateKey: 'proactive_nudge:weather_swap',
      dedupeKey: 'nudge:weather:w41',
      providerMessageId: 'fake-out-1',
    });
    const [sent] = await audits('proactive_nudge_sent');
    expect(sent).toMatchObject({ targetTable: 'channel_messages', targetId: ledger[0]?.id });
    expect(sent?.after).toMatchObject({ kind: 'weather_swap', itemIds: [id], mode: 'live' });
  });

  it('writes each parent their own text when their items differ and there is no group', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const [coParent] = await db.database
      .insert(schema.users)
      .values({ name: 'Second Parent', timezone: TZ })
      .returning({ id: schema.users.id });
    const coParentId = coParent?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: coParentId, role: 'co_parent' });
    await enqueue();
    await handOffProactive(
      db.database,
      [
        {
          familyId,
          parentUserId: coParentId,
          kind: 'nudge',
          category: 'nudge',
          templateKey: 'proactive_nudge:weekday_dropin',
          what: 'Story hour at the east branch',
          why: 'weekday_dropin',
          sourceUrl: null,
          worthlessAfter: null,
          parentRequested: false,
          dedupeKey: 'nudge:dropin:w41',
        },
      ],
      'candidate',
    );
    const phones: Record<string, string> = {
      [parentUserId]: PHONE,
      [coParentId]: '+15555550101',
    };
    const asked: string[][] = [];
    const h = harness(sendAll, {
      resolveSendablePhone: async (_db, id) => phones[id] ?? null,
      compose: async ({ items }) => {
        asked.push(items.map((item) => item.what));
        return { message: items.map((item) => item.what).join(' / ') };
      },
    });

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(asked.sort()).toEqual([
      ['Indoor climbing by the river'],
      ['Story hour at the east branch'],
    ]);
    const byPhone = Object.fromEntries(h.transport.sent.map((sent) => [sent.to, sent.body]));
    expect(byPhone[PHONE]).toBe('Indoor climbing by the river');
    expect(byPhone['+15555550101']).toBe('Story hour at the east branch');
  });

  it('holds with the decider’s clock and does not ask again before it', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const id = await enqueue();
    const h = harness((snapshot) => ({
      reason: 'Too early for a weekend find',
      action: 'hold',
      itemIds: snapshot.candidates.map((c) => c.id),
      holdUntil: '2026-10-09T21:00:00.000Z',
      frequencyPreference: null,
    }));

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(await candidate(id)).toMatchObject({
      status: 'held',
      decision: 'hold',
      reason: 'Too early for a weekend find',
    });
    expect((await candidate(id))?.holdUntil?.toISOString()).toBe('2026-10-09T21:00:00.000Z');

    const later = await runProactiveReview(
      db.database,
      h.deps,
      new Date(THURSDAY_EVENING.getTime() + 60 * 60_000),
    );
    expect(later).toMatchObject({ decided: 0, skipped: 1 });
    expect(h.snapshots).toHaveLength(1);
    expect(h.transport.sent).toEqual([]);
  });

  it('drops with a named reason and an audit row', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const id = await enqueue();
    const h = harness((snapshot) => ({
      reason: 'No free window fits it',
      action: 'drop',
      itemIds: snapshot.candidates.map((c) => c.id),
      holdUntil: null,
      frequencyPreference: null,
    }));
    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(summary.dropped).toBe(1);
    expect(await candidate(id)).toMatchObject({
      status: 'dropped',
      reason: 'No free window fits it',
    });
    expect(await audits('proactive_cadence_decision')).toHaveLength(1);
  });

  it('refuses, by name, a drop of something the parent asked for, and still drops the rest', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const asked = await enqueue('nudge:asked:w41', { parentRequested: true });
    const other = await enqueue('nudge:weather:w41');
    const h = harness((snapshot) => ({
      reason: 'No free window fits it',
      action: 'drop',
      itemIds: snapshot.candidates.map((c) => c.id),
      holdUntil: null,
      frequencyPreference: null,
    }));

    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(summary).toMatchObject({ dropped: 1, dropRefused: 1, held: 0 });
    expect(await candidate(asked)).toMatchObject({
      status: 'held',
      reason: 'drop_refused_parent_requested',
      decision: 'drop',
    });
    expect(await candidate(other)).toMatchObject({
      status: 'dropped',
      reason: 'No free window fits it',
    });
    const held = await audits('proactive_cadence_held');
    expect(held.map((row) => row.after)).toEqual([
      { reason: 'drop_refused_parent_requested', itemIds: [asked], mode: 'live' },
    ]);
  });

  it('drops a batch the parent asked for none of, with no refusal', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const id = await enqueue();
    const h = harness((snapshot) => ({
      reason: 'No free window fits it',
      action: 'drop',
      itemIds: snapshot.candidates.map((c) => c.id),
      holdUntil: null,
      frequencyPreference: null,
    }));
    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(summary).toMatchObject({ dropped: 1, dropRefused: 0 });
    expect(await candidate(id)).toMatchObject({ status: 'dropped' });
    expect(await audits('proactive_cadence_held')).toEqual([]);
  });

  it('never holds past the moment an item stops being worth sending, and names the clamp', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const worthless = new Date('2026-10-10T16:00:00.000Z');
    const id = await enqueue('nudge:weather:w41', { worthlessAfter: worthless });
    const asked = '2027-06-01T12:00:00.000Z';
    const h = harness((snapshot) => ({
      reason: 'Too early for a weekend find',
      action: 'hold',
      itemIds: snapshot.candidates.map((c) => c.id),
      holdUntil: asked,
      frequencyPreference: null,
    }));

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect((await candidate(id))?.holdUntil?.toISOString()).toBe(worthless.toISOString());
    const [decision] = await audits('proactive_cadence_decision');
    expect(decision?.after).toMatchObject({
      holdUntil: worthless.toISOString(),
      holdClamped: 'worthless_after',
      askedHoldUntil: asked,
    });
  });

  it('keeps a hold inside the item’s window as the decider set it', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const id = await enqueue('nudge:weather:w41', {
      worthlessAfter: new Date('2026-10-10T16:00:00.000Z'),
    });
    const asked = '2026-10-09T21:00:00.000Z';
    const h = harness((snapshot) => ({
      reason: 'Too early for a weekend find',
      action: 'hold',
      itemIds: snapshot.candidates.map((c) => c.id),
      holdUntil: asked,
      frequencyPreference: null,
    }));

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect((await candidate(id))?.holdUntil?.toISOString()).toBe(asked);
    const [decision] = await audits('proactive_cadence_decision');
    expect(decision?.after).toMatchObject({ holdUntil: asked });
    expect(decision?.after).not.toHaveProperty('holdClamped');
  });

  it('never parks an item with no window past the days the decider can see, and names the clamp', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const id = await enqueue();
    const asked = '2027-06-01T12:00:00.000Z';
    const h = harness((snapshot) => ({
      reason: 'Too early for a weekend find',
      action: 'hold',
      itemIds: snapshot.candidates.map((c) => c.id),
      holdUntil: asked,
      frequencyPreference: null,
    }));

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    const edge = new Date(THURSDAY_EVENING.getTime() + SNAPSHOT_DAYS * 24 * 60 * 60_000);
    expect((await candidate(id))?.holdUntil?.toISOString()).toBe(edge.toISOString());
    const [decision] = await audits('proactive_cadence_decision');
    expect(decision?.after).toMatchObject({
      holdUntil: edge.toISOString(),
      holdClamped: 'snapshot_window',
      askedHoldUntil: asked,
    });
  });

  it('keeps a hold inside the days the decider can see on an item with no window', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const id = await enqueue();
    const asked = '2026-10-10T16:00:00.000Z';
    const h = harness((snapshot) => ({
      reason: 'Saturday morning is the moment',
      action: 'hold',
      itemIds: snapshot.candidates.map((c) => c.id),
      holdUntil: asked,
      frequencyPreference: null,
    }));

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect((await candidate(id))?.holdUntil?.toISOString()).toBe(asked);
    const [decision] = await audits('proactive_cadence_decision');
    expect(decision?.after).toMatchObject({ holdUntil: asked });
    expect(decision?.after).not.toHaveProperty('holdClamped');
  });

  it('refuses, by name, a hold with no bound over something the parent asked for', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const asked = await enqueue('nudge:asked:w41', { parentRequested: true });
    const other = await enqueue('nudge:weather:w41');
    const far = '2027-06-01T12:00:00.000Z';
    const h = harness((snapshot) => ({
      reason: 'Too early for a weekend find',
      action: 'hold',
      itemIds: snapshot.candidates.map((c) => c.id),
      holdUntil: far,
      frequencyPreference: null,
    }));

    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(summary).toMatchObject({ held: 1, holdRefused: 1 });
    expect(await candidate(asked)).toMatchObject({
      status: 'held',
      reason: 'hold_refused_parent_requested_unbounded',
      decision: 'hold',
      holdUntil: null,
    });
    expect(await candidate(other)).toMatchObject({
      status: 'held',
      reason: 'Too early for a weekend find',
    });
    expect((await candidate(other))?.holdUntil?.toISOString()).toBe(
      new Date(THURSDAY_EVENING.getTime() + SNAPSHOT_DAYS * 24 * 60 * 60_000).toISOString(),
    );
    const held = await audits('proactive_cadence_held');
    expect(held.map((row) => row.after)).toEqual([
      { reason: 'hold_refused_parent_requested_unbounded', itemIds: [asked], mode: 'live' },
    ]);

    await runProactiveReview(
      db.database,
      h.deps,
      new Date(THURSDAY_EVENING.getTime() + 60 * 60_000),
    );
    expect(h.snapshots[1]?.candidates.map((c) => c.id)).toEqual([asked]);
  });

  it('keeps a hold over something the parent asked for when its window bounds the hold', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const asked = await enqueue('nudge:asked:w41', {
      parentRequested: true,
      worthlessAfter: new Date('2026-10-10T16:00:00.000Z'),
    });
    const until = '2026-10-09T21:00:00.000Z';
    const h = harness((snapshot) => ({
      reason: 'Friday evening is the moment',
      action: 'hold',
      itemIds: snapshot.candidates.map((c) => c.id),
      holdUntil: until,
      frequencyPreference: null,
    }));

    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(summary).toMatchObject({ held: 1, holdRefused: 0 });
    expect(await candidate(asked)).toMatchObject({
      status: 'held',
      reason: 'Friday evening is the moment',
    });
    expect((await candidate(asked))?.holdUntil?.toISOString()).toBe(until);
    expect(await audits('proactive_cadence_held')).toEqual([]);
  });

  it('skips, by name, a row whose kind the gate does not know, and reviews the rest', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const known = await enqueue();
    const [stray] = await db.database
      .insert(schema.proactiveCandidates)
      .values({
        familyId,
        parentUserId,
        kind: 'carrier_pigeon',
        category: 'nudge',
        templateKey: 'proactive_nudge:weather_swap',
        what: 'Indoor climbing by the river',
        why: 'weather_swap',
        dedupeKey: 'nudge:pigeon:w41',
      })
      .returning({ id: schema.proactiveCandidates.id });
    const strayId = stray?.id as string;
    const h = harness(sendAll);

    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(summary).toMatchObject({ failed: 0, unknownKind: 1, sent: 1 });
    expect(h.snapshots[0]?.candidates.map((c) => c.id)).toEqual([known]);
    expect(await candidate(known)).toMatchObject({ status: 'sent' });
    expect(await candidate(strayId)).toMatchObject({ status: 'dropped', reason: 'unknown_kind' });
    const skipped = await audits('proactive_cadence_skipped');
    expect(skipped.map((row) => row.after)).toEqual([
      { reason: 'unknown_kind', itemId: strayId, kind: 'carrier_pigeon', mode: 'live' },
    ]);
  });

  it('logs a family that failed by its error name and code, never the message', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await enqueue();
    const failure = Object.assign(
      new Error('duplicate key value violates unique constraint: Key (dedupe_key)=(leaked-key)'),
      { name: 'PostgresError', code: '23505' },
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = harness(sendAll, {
      decide: async () => {
        throw failure;
      },
    });

    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(summary.failed).toBe(1);
    const logged = errors.mock.calls.find(([, line]) => line === 'proactive review: family failed');
    expect(logged?.[0]).toEqual({ err: 'PostgresError:23505', familyId });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('leaked-key');
    errors.mockRestore();
  });

  it('still refuses a send the gate refuses at send time, by name', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const id = await enqueue();
    const h = harness(sendAll, {
      buildGate: () => ({ ...openGate(), watchConsentGranted: async () => false }),
    });
    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(summary).toMatchObject({ sent: 0, held: 1 });
    expect(h.transport.sent).toEqual([]);
    expect(await candidate(id)).toMatchObject({ status: 'held', reason: 'no_watch_consent' });
    const [held] = await audits('proactive_cadence_held');
    expect(held?.after).toMatchObject({ reason: 'no_watch_consent', itemIds: [id], mode: 'live' });
  });

  it('holds unrequested items while the sending line is flagged', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const id = await enqueue();
    const h = harness(sendAll, { linePaused: async () => true });
    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(h.transport.sent).toEqual([]);
    expect(await candidate(id)).toMatchObject({ status: 'held', reason: 'line_health' });
    expect(await audits('proactive_cadence_held')).toHaveLength(1);
  });

  it('sends nothing when the writer has nothing, and says so', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const id = await enqueue();
    const h = harness(sendAll, { compose: async () => ({ skipped: 'no_client' }) });
    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(h.transport.sent).toEqual([]);
    expect(await candidate(id)).toMatchObject({ status: 'held', reason: 'unvoiced:no_client' });
  });

  it('names a family with no primary parent instead of guessing its zone', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await enqueue();
    await db.database
      .delete(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, familyId));
    const h = harness(sendAll);
    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(summary).toMatchObject({ decided: 0, skipped: 1 });
    expect(h.snapshots).toEqual([]);
    const [skipped] = await audits('proactive_cadence_skipped');
    expect(skipped?.after).toMatchObject({ reason: 'no_primary_parent', mode: 'shadow' });
  });

  it('holds, by name, a queued item the decision did not choose', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const id = await enqueue();
    const h = harness(() => ({
      reason: 'Nothing here',
      action: 'send_now',
      itemIds: ['not-a-candidate'],
      holdUntil: null,
      frequencyPreference: null,
    }));
    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(await candidate(id)).toMatchObject({ status: 'held', reason: 'not_chosen' });
    const [decision] = await audits('proactive_cadence_decision');
    expect(decision?.after).toMatchObject({ itemIds: [], unchosen: [id] });
  });

  it('drops, by name, a candidate the old path already sent, and still sends a fresh one', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const already = await enqueue('nudge:weather:w41');
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'nudge',
      templateKey: 'proactive_nudge:weather_swap',
      dedupeKey: 'nudge:weather:w41',
      status: 'delivered',
      sentAt: THURSDAY_EVENING,
    });
    const fresh = await enqueue('nudge:weather:w42');
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(h.transport.sent).toHaveLength(1);
    expect(await candidate(already)).toMatchObject({ status: 'dropped', reason: 'already_sent' });
    expect(await candidate(fresh)).toMatchObject({ status: 'sent' });
    const [skipped] = await audits('proactive_cadence_skipped');
    expect(skipped?.after).toMatchObject({
      reason: 'already_sent',
      itemIds: [already],
      mode: 'live',
    });
  });

  it('drops a weekday-care ask the household was already asked, and sends nothing', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    // A legacy care ask to this household: same template, a different key.
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'nudge',
      templateKey: WEEKDAY_CARE_ASK_TEMPLATE_KEY,
      dedupeKey: `nudge:${familyId}:weekday_care:legacy-child:${parentUserId}`,
      status: 'delivered',
      sentAt: THURSDAY_EVENING,
    });
    const ask = await enqueue(
      weekdayFinderDedupeKey(familyId, { prompt: 'weekend_fallback' }, parentUserId),
      { templateKey: WEEKDAY_CARE_ASK_TEMPLATE_KEY, why: 'weekday_care', sourceUrl: null },
    );
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(h.transport.sent).toEqual([]);
    expect(h.composed).toBe(0);
    expect(await candidate(ask)).toMatchObject({ status: 'dropped', reason: 'already_asked' });
    const [skipped] = await audits('proactive_cadence_skipped');
    expect(skipped?.after).toMatchObject({ reason: 'already_asked', itemIds: [ask] });
  });

  describe('a claimed group', () => {
    const CHAT = 'chat-household';
    let coParentId: string;
    let linqCalls: number;
    const linqFetch = (async () => {
      linqCalls += 1;
      return Response.json({ message: { id: 'msg-group-1' } }, { status: 201 });
    }) as unknown as typeof fetch;

    beforeEach(async () => {
      linqCalls = 0;
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
      const [coParent] = await db.database
        .insert(schema.users)
        .values({ name: 'Second Parent', timezone: TZ })
        .returning({ id: schema.users.id });
      coParentId = coParent?.id as string;
      await db.database
        .insert(schema.familyMembers)
        .values({ familyId, userId: coParentId, role: 'co_parent' });
    });

    function groupHarness(gate: () => OutboundGatePorts) {
      return harness(sendAll, {
        outboundTarget: async () => ({ channel: 'group', chatId: CHAT, familyId }),
        loadRecipients: async () => [
          { parentUserId, timeZone: TZ, role: 'primary_parent' },
          { parentUserId: coParentId, timeZone: TZ, role: 'co_parent' },
        ],
        buildGate: gate,
        fetch: linqFetch,
      });
    }

    it('holds the whole copy, by that member’s reason, when one member may not be texted', async () => {
      const id = await enqueue();
      const h = groupHarness(() => ({
        ...openGate(),
        channelEnrolled: async (userId) => userId !== coParentId,
      }));

      const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      expect(summary).toMatchObject({ sent: 0, held: 1 });
      expect(linqCalls).toBe(0);
      expect(h.composed).toBe(0);
      expect(await candidate(id)).toMatchObject({ status: 'held', reason: 'not_enrolled' });
      const [held] = await audits('proactive_cadence_held');
      expect(held?.after).toMatchObject({
        reason: 'not_enrolled',
        parentUserId: coParentId,
        itemIds: [id],
      });
    });

    it('sends the one copy when every member may be texted', async () => {
      const id = await enqueue();
      const gated: string[] = [];
      const h = groupHarness(() => ({
        ...openGate(),
        channelEnrolled: async (userId) => {
          gated.push(userId);
          return true;
        },
      }));

      const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      expect(summary).toMatchObject({ sent: 1, held: 0 });
      expect(linqCalls).toBe(1);
      expect(new Set(gated)).toEqual(new Set([parentUserId, coParentId]));
      expect(await candidate(id)).toMatchObject({ status: 'sent' });
    });

    it('gates a parent still in the chat whose own 1:1 line was stopped', async () => {
      const id = await enqueue();
      const [roster] = await db.database
        .insert(schema.linqGroupRosters)
        .values({ chatId: CHAT, familyId, source: 'new_group', status: 'confirmed' })
        .returning({ id: schema.linqGroupRosters.id });
      const rosterId = roster?.id as string;
      await db.database.insert(schema.linqGroupRosterMembers).values([
        {
          rosterId,
          chatId: CHAT,
          phoneE164Hash: 'hash-primary',
          knownUserId: parentUserId,
          status: 'known_parent',
        },
        {
          rosterId,
          chatId: CHAT,
          phoneE164Hash: 'hash-co-parent',
          userId: coParentId,
          status: 'confirmed',
          confirmedRole: 'co_parent',
        },
      ]);
      // A 1:1 STOP revokes the co-parent's channel, so the recipient list no longer
      // carries them; the chat still does.
      const h = harness(sendAll, {
        outboundTarget: async () => ({ channel: 'group', chatId: CHAT, familyId }),
        loadRecipients: async () => [{ parentUserId, timeZone: TZ, role: 'primary_parent' }],
        buildGate: () => ({
          ...openGate(),
          channelEnrolled: async (userId) => userId !== coParentId,
        }),
        fetch: linqFetch,
      });

      const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      expect(summary).toMatchObject({ sent: 0, held: 1 });
      expect(linqCalls).toBe(0);
      expect(await candidate(id)).toMatchObject({ status: 'held', reason: 'not_enrolled' });
      const [held] = await audits('proactive_cadence_held');
      expect(held?.after).toMatchObject({ reason: 'not_enrolled', parentUserId: coParentId });
    });
  });

  it('shows the decider a candidate by kind and label, and only the writer its text', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const id = await enqueue('nudge:weather:w41', {
      what: 'Pip and Juno would love indoor climbing at Riverside Rocks',
    });
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    const seen = JSON.stringify(h.snapshots[0]);
    expect(seen).not.toContain('Pip');
    expect(seen).not.toContain('Riverside Rocks');
    expect(h.snapshots[0]?.candidates).toEqual([
      {
        id,
        kind: 'nudge',
        why: 'weather_swap',
        sourceUrl: 'https://example.test/climb',
        worthlessAfter: null,
        parentRequested: false,
      },
    ]);
    // The writer is the one reader of the composed text.
    expect(h.written[0]?.[0]?.what).toBe(
      'Pip and Juno would love indoor climbing at Riverside Rocks',
    );
  });

  async function parentText(body: string | null, at: Date, from = parentUserId): Promise<void> {
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId: from,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body,
      createdAt: at,
    });
  }

  const HOUR_BEFORE = new Date(THURSDAY_EVENING.getTime() - 60 * 60_000);

  const lessPlease = (snapshot: FamilySnapshot): DeciderDecision => ({
    reason: 'They asked to hear less',
    action: 'drop',
    itemIds: snapshot.candidates.map((c) => c.id),
    holdUntil: null,
    frequencyPreference: { direction: 'less', note: 'text me less' },
  });

  async function memoryFacts() {
    return db.database
      .select()
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, familyId));
  }

  async function addCoParent(): Promise<string> {
    const [coParent] = await db.database
      .insert(schema.users)
      .values({ name: 'Second Parent', timezone: TZ })
      .returning({ id: schema.users.id });
    const coParentId = coParent?.id as string;
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: coParentId, role: 'co_parent' });
    return coParentId;
  }

  it('in shadow, keeps no cadence preference anywhere, and names that on the decision', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await parentText('text me less', HOUR_BEFORE);
    await enqueue();
    const h = harness(lessPlease);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(await memoryFacts()).toEqual([]);
    const [decision] = await audits('proactive_cadence_decision');
    expect(decision?.after).toMatchObject({
      mode: 'shadow',
      cadencePreference: 'not_written_shadow',
    });
  });

  it('when live, keeps a cadence preference as one parent’s, and never steers the other with it', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const coParentId = await addCoParent();
    await parentText('text me less', HOUR_BEFORE);
    await enqueue('nudge:weather:w41');
    let first = true;
    const h = harness((snapshot) => {
      const made = first
        ? lessPlease(snapshot)
        : { ...lessPlease(snapshot), frequencyPreference: null };
      first = false;
      return made;
    });

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    const [decision] = await audits('proactive_cadence_decision');
    expect(decision?.after).toMatchObject({
      cadencePreference: {
        schemaVersion: 1,
        parentUserId,
        direction: 'less',
        note: 'text me less',
      },
    });
    expect(await memoryFacts()).toEqual([]);
    expect((await assembleMemoryBrief(db.database, familyId, THURSDAY_EVENING)).text).not.toContain(
      'text me less',
    );

    await handOffProactive(
      db.database,
      [
        {
          familyId,
          parentUserId: coParentId,
          kind: 'nudge',
          category: 'nudge',
          templateKey: 'proactive_nudge:weekday_dropin',
          what: 'Story hour at the east branch',
          why: 'weekday_dropin',
          sourceUrl: null,
          worthlessAfter: null,
          parentRequested: false,
          dedupeKey: 'nudge:dropin:w41',
        },
      ],
      'candidate',
    );
    await runProactiveReview(
      db.database,
      h.deps,
      new Date(THURSDAY_EVENING.getTime() + 60 * 60_000),
    );
    expect(h.snapshots[1]?.frequencyPreference).toBeNull();

    await enqueue('nudge:weather:w42');
    await runProactiveReview(
      db.database,
      h.deps,
      new Date(THURSDAY_EVENING.getTime() + 2 * 60 * 60_000),
    );
    expect(h.snapshots[2]?.frequencyPreference).toEqual({
      direction: 'less',
      note: 'text me less',
    });
  });

  it('when live, keeps no cadence preference it cannot pin on one parent, and names that', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const coParentId = await addCoParent();
    await parentText('text me less', HOUR_BEFORE);
    await parentText('we love the weekend ideas', HOUR_BEFORE, coParentId);
    await enqueue();
    const h = harness(lessPlease);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    const [decision] = await audits('proactive_cadence_decision');
    expect(decision?.after).toMatchObject({ cadencePreference: 'not_written_no_single_author' });
    expect(await memoryFacts()).toEqual([]);
  });

  it('when live, never keeps a pace for a parent who texted about a batch that is not theirs', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const coParentId = await addCoParent();
    const stored = { schemaVersion: 1, parentUserId, direction: 'less', note: 'fewer please' };
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'proactive_cadence_decision',
      targetTable: 'families',
      targetId: familyId,
      after: { cadencePreference: stored, mode: 'live' },
      occurredAt: new Date(THURSDAY_EVENING.getTime() - 24 * 60 * 60_000),
    });
    await parentText('we love the weekend ideas', HOUR_BEFORE, coParentId);
    await enqueue();
    const h = harness((snapshot) => ({
      ...lessPlease(snapshot),
      frequencyPreference: { direction: 'less', note: 'fewer please' },
    }));

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(h.snapshots[0]?.frequencyPreference).toEqual({
      direction: 'less',
      note: 'fewer please',
    });
    const decisions = await audits('proactive_cadence_decision');
    const reviewed = decisions.find((row) => 'action' in (row.after as object));
    expect(reviewed?.after).toMatchObject({ cadencePreference: 'not_written_author_not_owner' });
    const kept = decisions
      .map((row) => (row.after as { cadencePreference?: unknown }).cadencePreference)
      .filter((pace) => typeof pace === 'object');
    expect(kept).toEqual([stored]);
  });

  it('hands the decider only the parent texts that arrived since its last look', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await parentText(
      'weekends are best for us',
      new Date(THURSDAY_EVENING.getTime() - 60 * 60_000),
    );
    await enqueue('nudge:weather:w41');
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(h.snapshots[0]?.recentParentTexts).toEqual(['weekends are best for us']);

    await enqueue('nudge:weather:w42');
    await runProactiveReview(
      db.database,
      h.deps,
      new Date(THURSDAY_EVENING.getTime() + 60 * 60_000),
    );
    expect(h.snapshots).toHaveLength(2);
    expect(h.snapshots[1]?.recentParentTexts).toEqual([]);
  });

  it('never hands the decider a parent text from a household with a teenager', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Older', dateOfBirth: '2011-03-01' });
    await parentText(
      'weekends are best for us',
      new Date(THURSDAY_EVENING.getTime() - 60 * 60_000),
    );
    await enqueue();
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(h.snapshots[0]?.recentParentTexts).toEqual([]);
  });

  async function offer(
    title: string,
    messageId: string,
    resolution: 'declined' | null = null,
  ): Promise<Date> {
    const [carried] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'reply',
        status: 'delivered',
        body: 'offer',
        createdAt: new Date(THURSDAY_EVENING.getTime() - 2 * 60 * 60_000),
      })
      .returning({ id: schema.channelMessages.id });
    const startsAt = new Date(THURSDAY_EVENING.getTime() + 3 * 24 * 60 * 60_000);
    await db.database.insert(schema.emailAlertOffers).values({
      familyId,
      parentUserId,
      integrationId: '00000000-0000-4000-8000-000000000001',
      messageId,
      kind: 'deadline',
      title,
      startsAt,
      channelMessageId: carried?.id as string,
      expiresAt: new Date(THURSDAY_EVENING.getTime() + 7 * 24 * 60 * 60_000),
      ...(resolution
        ? { resolution, resolvedAt: THURSDAY_EVENING, resolvedChannelMessageId: carried?.id }
        : {}),
    });
    return startsAt;
  }

  it('never hands the decider an offer title, a decline or a watch label from a household with a teenager', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Older', dateOfBirth: '2011-03-01' });
    const startsAt = await offer('Swim tryouts sign-up', 'msg-open');
    await offer('Hockey camp', 'msg-declined', 'declined');
    await db.database.insert(schema.watchedSpots).values({
      familyId,
      parentUserId,
      sourceUrl: 'https://example.test/class',
      label: 'Teen art studio',
      expiresAt: new Date(THURSDAY_EVENING.getTime() + 30 * 24 * 60 * 60_000),
      createdFrom: 'msg-watch',
    });
    await enqueue();
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    const snapshot = h.snapshots[0];
    expect(snapshot?.deadlines).toEqual([{ what: WITHHELD_LABEL, at: startsAt.toISOString() }]);
    expect(snapshot?.declines).toEqual([WITHHELD_LABEL]);
    expect(snapshot?.watches).toEqual([{ what: WITHHELD_LABEL }]);
    const seen = JSON.stringify(snapshot);
    for (const title of ['Swim tryouts', 'Hockey camp', 'Teen art studio']) {
      expect(seen).not.toContain(title);
    }
  });

  /** A pace kept from an earlier review, and a hold the decider made yesterday with its words. */
  async function storedPaceAndPriorHold(): Promise<{ pace: string; why: string }> {
    const pace = 'fewer texts on school nights';
    const why = 'They said the weekend is already full with the tournament';
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'proactive_cadence_decision',
      targetTable: 'families',
      targetId: familyId,
      after: {
        cadencePreference: { schemaVersion: 1, parentUserId, direction: 'less', note: pace },
        mode: 'live',
      },
      occurredAt: new Date(THURSDAY_EVENING.getTime() - 24 * 60 * 60_000),
    });
    const heldId = await enqueue('nudge:weather:w40');
    await db.database
      .update(schema.proactiveCandidates)
      .set({
        status: 'held',
        decision: 'hold',
        reason: why,
        decidedAt: new Date(THURSDAY_EVENING.getTime() - 24 * 60 * 60_000),
      })
      .where(eq(schema.proactiveCandidates.id, heldId));
    await enqueue('nudge:weather:w41');
    return { pace, why };
  }

  function harnessHearingTheWriterNote(
    over: Partial<ProactiveReviewDeps> = {},
  ): Harness & { notes: (string | null)[] } {
    const notes: (string | null)[] = [];
    const h = harness(sendAll, {
      compose: async ({ cadenceNote }): Promise<WriterResult> => {
        notes.push(cadenceNote);
        return { message: MESSAGE };
      },
      ...over,
    });
    return Object.assign(h, { notes });
  }

  it('never replays a kept pace’s words or a prior hold’s reason in a household with a teenager', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Older', dateOfBirth: '2011-03-01' });
    const { pace, why } = await storedPaceAndPriorHold();
    const h = harnessHearingTheWriterNote();

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    const snapshot = h.snapshots[0];
    expect(snapshot?.frequencyPreference).toEqual({ direction: 'less', note: WITHHELD_LABEL });
    expect(snapshot?.priorDecisions.map((prior) => prior.reason)).toEqual([WITHHELD_LABEL]);
    const seen = JSON.stringify(snapshot);
    expect(seen).not.toContain(pace);
    expect(seen).not.toContain(why);
    expect(h.notes).toEqual([null]);
  });

  it('replays a kept pace’s words and a prior hold’s reason where no child is a teenager', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const { pace, why } = await storedPaceAndPriorHold();
    const h = harnessHearingTheWriterNote();

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    const snapshot = h.snapshots[0];
    expect(snapshot?.frequencyPreference).toEqual({ direction: 'less', note: pace });
    expect(snapshot?.priorDecisions.map((prior) => prior.reason)).toEqual([why]);
    expect(h.notes).toEqual([pace]);
  });

  it('composes a claimed group’s one bubble without one parent’s own pace words, and names the withhold', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    vi.stubEnv('LINQ_API_KEY', 'linq_test_key_not_a_secret');
    const coParentId = await addCoParent();
    const { pace } = await storedPaceAndPriorHold();
    const h = harnessHearingTheWriterNote({
      outboundTarget: async () => ({ channel: 'group', chatId: 'chat-household', familyId }),
      loadRecipients: async () => [
        { parentUserId, timeZone: TZ, role: 'primary_parent' },
        { parentUserId: coParentId, timeZone: TZ, role: 'co_parent' },
      ],
      fetch: (async () =>
        Response.json(
          { message: { id: 'msg-group-1' } },
          { status: 201 },
        )) as unknown as typeof fetch,
    });

    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(summary).toMatchObject({ sent: 1 });
    expect(h.snapshots[0]?.frequencyPreference).toEqual({ direction: 'less', note: pace });
    expect(h.notes).toEqual([null]);
    const [sent] = await audits('proactive_nudge_sent');
    expect(sent?.after).toMatchObject({ cadenceNote: 'withheld_group', mode: 'live' });
  });

  it('reads only the newest parent texts the decider is shown on its first look', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const texts = Array.from({ length: RECENT_PARENT_TEXTS + 3 }, (_, i) => `parent text ${i}`);
    for (const [i, text] of texts.entries()) {
      await parentText(text, new Date(THURSDAY_EVENING.getTime() - (texts.length - i) * 60_000));
    }
    await enqueue('nudge:weather:w41');
    const h = harness(sendAll);

    const returned: unknown[] = [];
    const query = db.client.query.bind(db.client);
    db.client.query = (async (text: string, ...rest: unknown[]) => {
      const result = await (query as (...a: unknown[]) => Promise<{ rows: unknown[] }>)(
        text,
        ...rest,
      );
      returned.push(result.rows);
      return result;
    }) as typeof db.client.query;
    try {
      await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    } finally {
      db.client.query = query;
    }

    const newest = texts.slice(-RECENT_PARENT_TEXTS);
    expect(h.snapshots[0]?.recentParentTexts).toEqual(newest);
    const read = JSON.stringify(returned);
    for (const older of texts.slice(0, -RECENT_PARENT_TEXTS)) {
      expect(read).not.toContain(`"${older}"`);
    }
    for (const shown of newest) expect(read).toContain(`"${shown}"`);
  });

  it('shows the decider the newest texts that still have a body, past any redacted ones', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const texts = Array.from({ length: RECENT_PARENT_TEXTS }, (_, i) => `parent text ${i}`);
    const minute = (n: number) => new Date(THURSDAY_EVENING.getTime() - n * 60_000);
    for (const [i, text] of texts.entries()) await parentText(text, minute(10 - i));
    await parentText(null, minute(2));
    await parentText(null, minute(1));
    await enqueue('nudge:weather:w41');
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(h.snapshots[0]?.recentParentTexts).toEqual(texts);
  });

  it('reads no outbound body and no parent text from before the last look', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const sentBody = 'Outbound nudge body the decider never needs';
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'out',
      category: 'nudge',
      status: 'delivered',
      body: sentBody,
      createdAt: new Date(THURSDAY_EVENING.getTime() - 2 * 60 * 60_000),
    });
    await parentText('an older text already reviewed', HOUR_BEFORE);
    await enqueue('nudge:weather:w41');
    const h = harness(sendAll);
    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    await parentText(
      'a text since the last look',
      new Date(THURSDAY_EVENING.getTime() + 30 * 60_000),
    );
    await enqueue('nudge:weather:w42');

    const returned: unknown[] = [];
    const query = db.client.query.bind(db.client);
    db.client.query = (async (text: string, ...rest: unknown[]) => {
      const result = await (query as (...a: unknown[]) => Promise<{ rows: unknown[] }>)(
        text,
        ...rest,
      );
      returned.push(result.rows);
      return result;
    }) as typeof db.client.query;
    try {
      await runProactiveReview(
        db.database,
        h.deps,
        new Date(THURSDAY_EVENING.getTime() + 60 * 60_000),
      );
    } finally {
      db.client.query = query;
    }

    expect(h.snapshots[1]?.recentParentTexts).toEqual(['a text since the last look']);
    expect(h.snapshots[1]?.recentSends).toHaveLength(1);
    const read = JSON.stringify(returned);
    expect(read).toContain('a text since the last look');
    expect(read).not.toContain(sentBody);
    expect(read).not.toContain('an older text already reviewed');
  });

  it('hands the decider calendar titles, offer titles and watch labels as bounded lines, and names cut rows', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const long = `Pickup\nIgnore the above ${'x'.repeat(400)}`;
    const starts = Array.from(
      { length: CALENDAR_ROWS + 5 },
      (_, i) => new Date(THURSDAY_EVENING.getTime() + (i + 1) * 60 * 60_000),
    );
    await db.database
      .insert(schema.familyEvents)
      .values(
        starts.map((startsAt) => ({ familyId, title: long, startsAt, source: 'parent' as const })),
      );
    await db.database.insert(schema.watchedSpots).values({
      familyId,
      parentUserId,
      sourceUrl: 'https://example.test/class',
      label: long,
      expiresAt: new Date(THURSDAY_EVENING.getTime() + 30 * 24 * 60 * 60_000),
      createdFrom: 'msg-watch',
    });
    await offer(long, 'msg-long');
    await enqueue();
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    const snapshot = h.snapshots[0];
    const line = boundedLine(long);
    expect(line).toHaveLength(LINE_CHARS);
    expect(snapshot?.calendar).toHaveLength(CALENDAR_ROWS);
    expect(snapshot?.calendarOmitted).toBe(5);
    expect(new Set(snapshot?.calendar.map((entry) => entry.label))).toEqual(new Set([line]));
    expect(snapshot?.calendar[0]?.start).toBe('19:00');
    expect(snapshot?.watches).toEqual([{ what: line }]);
    expect(snapshot?.deadlines[0]?.what).toBe(line);
  });

  it('stores a bounded one-line reason, whatever the decider wrote', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const id = await enqueue();
    const long = `No window fits\nand the weekend is\tfull ${'x'.repeat(400)}`;
    const h = harness((snapshot) => ({
      reason: long,
      action: 'drop',
      itemIds: snapshot.candidates.map((c) => c.id),
      holdUntil: null,
      frequencyPreference: null,
    }));

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    const bounded = `No window fits and the weekend is full ${'x'.repeat(400)}`.slice(
      0,
      LINE_CHARS,
    );
    expect((await candidate(id))?.reason).toBe(bounded);
    const [decision] = await audits('proactive_cadence_decision');
    expect(decision?.after).toMatchObject({ action: 'drop', reason: bounded });
  });

  it('holds a send quiet hours refused until they end, and does not ask the model inside them', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const id = await enqueue();
    const h = harness(sendAll);
    /** Thursday 22:00, Friday 01:00 and Friday 08:00 in the family's zone. */
    const late = new Date('2026-10-09T02:00:00.000Z');
    const night = new Date('2026-10-09T05:00:00.000Z');
    const morning = new Date('2026-10-09T12:00:00.000Z');

    await runProactiveReview(db.database, h.deps, late);
    expect(await candidate(id)).toMatchObject({ status: 'held', reason: 'quiet_hours' });
    expect((await candidate(id))?.holdUntil?.toISOString()).toBe(morning.toISOString());

    await runProactiveReview(db.database, h.deps, night);
    expect(h.snapshots).toHaveLength(1);

    await runProactiveReview(db.database, h.deps, morning);
    expect(h.snapshots).toHaveLength(2);
    expect(await candidate(id)).toMatchObject({ status: 'sent' });
  });

  it('moves only the family’s own candidate rows, whatever ids it is handed', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const own = await enqueue();
    const other = await seedFamily(db.database, 'Other Family');
    await handOffProactive(
      db.database,
      [
        {
          familyId: other.familyId,
          parentUserId: other.parentUserId,
          kind: 'nudge',
          category: 'nudge',
          templateKey: 'proactive_nudge:weather_swap',
          what: 'Indoor climbing by the river',
          why: 'weather_swap',
          sourceUrl: null,
          worthlessAfter: null,
          parentRequested: false,
          dedupeKey: 'nudge:weather:other',
        },
      ],
      'candidate',
    );
    const [theirs] = await db.database
      .select({ id: schema.proactiveCandidates.id })
      .from(schema.proactiveCandidates)
      .where(eq(schema.proactiveCandidates.familyId, other.familyId));
    const theirId = theirs?.id as string;

    await mark(db.database, familyId, [own, theirId], {
      status: 'dropped',
      reason: 'test_drop',
      decision: 'drop',
      holdUntil: null,
      now: THURSDAY_EVENING,
    });

    expect(await candidate(own)).toMatchObject({ status: 'dropped', reason: 'test_drop' });
    expect(await candidate(theirId)).toMatchObject({ status: 'queued', reason: null });
  });

  it('reads at most the bound of one family’s open rows, oldest first, names the cut, and still reviews the rest', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const ids: string[] = [];
    for (let i = 0; i < FAMILY_ROWS + 3; i += 1) ids.push(await enqueue(`nudge:runaway:${i}`));
    for (const [i, id] of ids.entries()) {
      await db.database
        .update(schema.proactiveCandidates)
        .set({ createdAt: new Date(THURSDAY_EVENING.getTime() - (ids.length - i) * 60_000) })
        .where(eq(schema.proactiveCandidates.id, id));
    }
    const other = await seedFamily(db.database, 'Other Family');
    await db.database
      .update(schema.users)
      .set({ timezone: TZ })
      .where(eq(schema.users.id, other.parentUserId));
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await handOffProactive(
      db.database,
      [
        {
          familyId: other.familyId,
          parentUserId: other.parentUserId,
          kind: 'nudge',
          category: 'nudge',
          templateKey: 'proactive_nudge:weather_swap',
          what: 'Indoor climbing by the river',
          why: 'weather_swap',
          sourceUrl: null,
          worthlessAfter: null,
          parentRequested: false,
          dedupeKey: 'nudge:weather:other',
        },
      ],
      'candidate',
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness(sendAll);

    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(summary).toMatchObject({ families: 2, decided: 2, familiesCut: 1 });
    const runaway = h.snapshots.find((snapshot) => snapshot.candidates.length > 1);
    expect(runaway?.candidates.map((c) => c.id)).toEqual(ids.slice(0, FAMILY_ROWS));
    expect(h.snapshots.filter((snapshot) => snapshot.candidates.length === 1)).toHaveLength(1);
    for (const id of ids.slice(FAMILY_ROWS)) {
      expect(await candidate(id)).toMatchObject({ status: 'queued' });
    }
    const cut = warn.mock.calls.find(([, line]) => line === 'proactive review: family rows cut');
    expect(cut?.[0]).toEqual({ familyId, bound: FAMILY_ROWS });
    warn.mockRestore();
  });

  it('always reviews a fresh row, however many holds are still waiting on their clock', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const waiting: string[] = [];
    for (let i = 0; i < WAITING_ROWS + 1; i += 1) waiting.push(await enqueue(`nudge:waiting:${i}`));
    for (const [i, id] of waiting.entries()) {
      await db.database
        .update(schema.proactiveCandidates)
        .set({
          status: 'held',
          decision: 'hold',
          reason: 'later',
          holdUntil: new Date(THURSDAY_EVENING.getTime() + 2 * 24 * 60 * 60_000),
          decidedAt: new Date(THURSDAY_EVENING.getTime() - (waiting.length - i) * 60_000),
          createdAt: new Date(THURSDAY_EVENING.getTime() - (waiting.length - i) * 60 * 60_000),
        })
        .where(eq(schema.proactiveCandidates.id, id));
    }
    const fresh = await enqueue('nudge:weather:fresh');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const h = harness(sendAll);

    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(summary).toMatchObject({ families: 1, decided: 1, familiesCut: 0, waitingCut: 1 });
    expect(h.snapshots[0]?.candidates.map((c) => c.id)).toEqual([fresh]);
    expect(h.snapshots[0]?.priorDecisions.map((prior) => prior.id)).toEqual(
      waiting.slice(1).reverse(),
    );
    expect(await candidate(fresh)).toMatchObject({ status: 'shadowed' });
    const cut = warn.mock.calls.find(([, line]) => line === 'proactive review: waiting holds cut');
    expect(cut?.[0]).toEqual({ familyId, bound: WAITING_ROWS });
    warn.mockRestore();
  });

  it('keeps a clock-less code hold from the model until something new arrives', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    vi.stubEnv('LINQ_FROM_E164', '+15555550199');
    const id = await enqueue();
    const h = harness(sendAll, { linePaused: async () => true });
    const nextEvening = new Date(THURSDAY_EVENING.getTime() + 24 * 60 * 60_000);
    const hourAfter = new Date(nextEvening.getTime() + 60 * 60_000);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(await candidate(id)).toMatchObject({
      status: 'held',
      reason: 'line_health',
      decision: 'send_now',
      holdUntil: null,
    });

    await runProactiveReview(db.database, h.deps, nextEvening);
    expect(h.snapshots).toHaveLength(1);

    // A status for another number on the account is no signal for this family's hold.
    await db.database.insert(schema.linqLineHealth).values({
      phoneNumber: '+15555550188',
      status: 'active',
      paused: false,
      updatedAt: nextEvening,
    });
    await runProactiveReview(db.database, h.deps, new Date(nextEvening.getTime() + 30 * 60_000));
    expect(h.snapshots).toHaveLength(1);

    await db.database.insert(schema.linqLineHealth).values({
      phoneNumber: '+15555550199',
      status: 'active',
      paused: false,
      updatedAt: nextEvening,
    });
    await runProactiveReview(db.database, h.deps, hourAfter);
    expect(h.snapshots).toHaveLength(2);
  });

  describe('the composed text on a candidate row', () => {
    const WHAT = 'Pip and Juno would love indoor climbing at Riverside Rocks';

    it('keeps none once the row is sent, and the parent’s thread still carries what was said', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const id = await enqueue('nudge:weather:w41', { what: WHAT });
      const h = harness(sendAll);

      await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      expect(await candidate(id)).toMatchObject({ status: 'sent', what: '' });
      const thread = await db.database
        .select({ content: schema.messages.content })
        .from(schema.messages);
      expect(thread.map((row) => row.content)).toEqual([MESSAGE]);
    });

    it('keeps none once the row is shadowed or dropped', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
      const shadowed = await enqueue('nudge:weather:w41', { what: WHAT });
      await runProactiveReview(db.database, harness(sendAll).deps, THURSDAY_EVENING);
      expect(await candidate(shadowed)).toMatchObject({ status: 'shadowed', what: '' });

      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const dropped = await enqueue('nudge:weather:w42', { what: WHAT });
      const h = harness((snapshot) => ({ ...sendAll(snapshot), action: 'drop' }));
      await runProactiveReview(
        db.database,
        h.deps,
        new Date(THURSDAY_EVENING.getTime() + 60 * 60_000),
      );
      expect(await candidate(dropped)).toMatchObject({ status: 'dropped', what: '' });
    });

    it('keeps it while the row is queued or held, for the writer that may still need it', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const chosen = await enqueue('nudge:weather:w41', { what: WHAT });
      const unchosen = await enqueue('nudge:weather:w42', { what: WHAT });
      const h = harness((snapshot) => ({
        ...sendAll(snapshot),
        action: 'hold',
        itemIds: [chosen],
        holdUntil: '2026-10-09T21:00:00.000Z',
      }));

      await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      expect(await candidate(chosen)).toMatchObject({ status: 'held', what: WHAT });
      expect(await candidate(unchosen)).toMatchObject({
        status: 'held',
        reason: 'not_chosen',
        what: WHAT,
      });
      const queued = await enqueue('nudge:weather:w43', { what: WHAT });
      expect(await candidate(queued)).toMatchObject({ status: 'queued', what: WHAT });
    });
  });
});
