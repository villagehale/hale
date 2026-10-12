import { schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEEKDAY_CARE_ASK_TEMPLATE_KEY } from '~/lib/care/weekday';
import { departCoParent } from '~/lib/channel/coparent/depart';
import { FakeTransport } from '~/lib/channel/intake/transport';
import { LinqSendError } from '~/lib/channel/linq/transport';
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
  readLineHold,
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
    lineHold: async () => null,
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

  it('drops on the decider’s word, with an audit row', async () => {
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
    expect(await candidate(id)).toMatchObject({ status: 'dropped', decision: 'drop' });
    const decisions = await audits('proactive_cadence_decision');
    expect(decisions.map((row) => row.after)).toEqual([
      { action: 'drop', itemIds: [id], unchosen: [], holdUntil: null, mode: 'live' },
    ]);
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
    expect(await candidate(other)).toMatchObject({ status: 'dropped', decision: 'drop' });
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

  describe('a drop of something the parent asked for', () => {
    const REQUESTED_DROP = 'requested_drop_after_parent_text';
    const dropAll = (snapshot: FamilySnapshot): DeciderDecision => ({
      reason: 'They said it is handled',
      action: 'drop',
      itemIds: snapshot.candidates.map((c) => c.id),
      holdUntil: null,
      frequencyPreference: null,
    });
    const REFUSED = {
      status: 'held',
      reason: 'drop_refused_parent_requested',
      decision: 'drop',
      what: 'Indoor climbing by the river',
    };

    it('stands, under its own name, when this review read a new text from the parent who asked', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const asked = await enqueue('nudge:asked:w41', { parentRequested: true });
      const other = await enqueue('nudge:weather:w41');
      await parentText('all sorted, we booked it ourselves', HOUR_BEFORE);
      const h = harness(dropAll);

      const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      expect(h.snapshots[0]?.recentParentTexts).toEqual(['all sorted, we booked it ourselves']);
      expect(summary).toMatchObject({ dropped: 1, requestedDropped: 1, dropRefused: 0, held: 0 });
      expect(await candidate(asked)).toMatchObject({
        status: 'dropped',
        reason: REQUESTED_DROP,
        decision: 'drop',
        what: '',
      });
      expect(await candidate(other)).toMatchObject({
        status: 'dropped',
        reason: null,
        decision: 'drop',
      });
      const skipped = await audits('proactive_cadence_skipped');
      expect(skipped.map((row) => row.after)).toEqual([
        { reason: REQUESTED_DROP, itemIds: [asked], mode: 'live' },
      ]);
      expect(await audits('proactive_cadence_held')).toEqual([]);
    });

    it('is still refused by name when the only new text is the other parent’s', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const coParentId = await addCoParent();
      const asked = await enqueue('nudge:asked:w41', { parentRequested: true });
      await parentText('all sorted, we booked it ourselves', HOUR_BEFORE, coParentId);
      const h = harness(dropAll);

      const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      expect(h.snapshots[0]?.recentParentTexts).toEqual([]);
      expect(summary).toMatchObject({ dropped: 0, requestedDropped: 0, dropRefused: 1 });
      expect(await candidate(asked)).toMatchObject(REFUSED);
      expect(await audits('proactive_cadence_skipped')).toEqual([]);
    });

    it('is still refused by name when the parent’s text was read by an earlier review', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const asked = await enqueue('nudge:asked:w41', { parentRequested: true });
      await parentText('all sorted, we booked it ourselves', HOUR_BEFORE);
      const holds = harness((snapshot) => ({ ...dropAll(snapshot), action: 'hold' }));
      await runProactiveReview(db.database, holds.deps, THURSDAY_EVENING);
      expect(holds.snapshots[0]?.recentParentTexts).toHaveLength(1);
      const h = harness(dropAll);

      const summary = await runProactiveReview(
        db.database,
        h.deps,
        new Date(THURSDAY_EVENING.getTime() + 24 * 60 * 60_000),
      );

      expect(h.snapshots[0]?.recentParentTexts).toEqual([]);
      expect(summary).toMatchObject({ dropped: 0, requestedDropped: 0, dropRefused: 1 });
      expect(await candidate(asked)).toMatchObject(REFUSED);
      const held = await audits('proactive_cadence_held');
      expect(held.map((row) => row.after)).toEqual([
        { reason: 'drop_refused_parent_requested', itemIds: [asked], mode: 'live' },
      ]);
    });
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

  describe('a candidate whose parent no longer holds a seat in its family', () => {
    const GONE = 'parent_not_in_family';
    const CO_PHONE = '+15555550101';

    /** A co-parent with their own open row, and a number the gate and the door would take. */
    async function coParentWithARow() {
      const coParentId = await addCoParent();
      const theirs = await enqueue('nudge:dropin:w41', {
        parentUserId: coParentId,
        templateKey: 'proactive_nudge:weekday_dropin',
        what: 'Story hour for Pip at the east branch',
        why: 'weekday_dropin',
      });
      const resolveSendablePhone: ProactiveReviewDeps['resolveSendablePhone'] = async (_db, id) =>
        id === coParentId ? CO_PHONE : PHONE;
      return { coParentId, theirs, resolveSendablePhone };
    }

    it('is dropped by name before the review, never offered or sent, and a current member’s row still goes', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const mine = await enqueue();
      const { coParentId, theirs, resolveSendablePhone } = await coParentWithARow();
      const departure = await departCoParent(db.database, {
        familyId,
        actorUserId: coParentId,
        now: HOUR_BEFORE,
      });
      expect(departure.outcome).toBe('departed');
      const h = harness(sendAll, { resolveSendablePhone });

      const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      expect(summary).toMatchObject({ parentNotInFamily: 1, sent: 1, dropped: 0 });
      expect(h.snapshots[0]?.candidates.map((c) => c.id)).toEqual([mine]);
      expect(h.transport.sent.map((sent) => sent.to)).toEqual([PHONE]);
      expect(h.written.flat().map((item) => item.id)).toEqual([mine]);
      expect(await candidate(theirs)).toMatchObject({
        status: 'dropped',
        reason: GONE,
        decision: null,
        what: '',
      });
      expect(await candidate(mine)).toMatchObject({ status: 'sent' });
      const skipped = await audits('proactive_cadence_skipped');
      expect(skipped.map((row) => row.after)).toEqual([
        { reason: GONE, itemId: theirs, mode: 'live' },
      ]);
    });

    it('is refused by name at send time when the seat goes after the decision', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const mine = await enqueue();
      const { coParentId, theirs, resolveSendablePhone } = await coParentWithARow();
      const h = harness(sendAll, {
        resolveSendablePhone,
        decide: async ({ snapshot }) => {
          await departCoParent(db.database, {
            familyId,
            actorUserId: coParentId,
            now: THURSDAY_EVENING,
          });
          return { decision: sendAll(snapshot), skipped: null };
        },
      });

      const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      expect(summary).toMatchObject({ parentNotInFamily: 1, sent: 1 });
      expect(h.transport.sent.map((sent) => sent.to)).toEqual([PHONE]);
      expect(h.written.flat().map((item) => item.id)).toEqual([mine]);
      expect(await candidate(theirs)).toMatchObject({
        status: 'dropped',
        reason: GONE,
        decision: 'send_now',
        what: '',
      });
      expect(await candidate(mine)).toMatchObject({ status: 'sent' });
      const skipped = await audits('proactive_cadence_skipped');
      expect(skipped.map((row) => row.after)).toEqual([
        { reason: GONE, itemIds: [theirs], mode: 'live' },
      ]);
    });
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
    const h = harness(sendAll, { lineHold: async () => 'line_health' });
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

  it('holds an undelivered text by the provider’s code, and by `other` when that is not a short code', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const refusedWith = (code: string) =>
      harness(sendAll, {
        transport: {
          send: async () => {
            throw new LinqSendError(code, 400, true);
          },
        },
      });

    const coded = await enqueue('nudge:weather:w41');
    await runProactiveReview(db.database, refusedWith('3001').deps, THURSDAY_EVENING);
    expect(await candidate(coded)).toMatchObject({ status: 'held', reason: 'delivery_3001' });

    const worded = await enqueue('nudge:weather:w42');
    const echoed = `rejected: "${MESSAGE}" ${'x'.repeat(400)}`;
    await runProactiveReview(db.database, refusedWith(echoed).deps, HOUR_AFTER);
    expect(await candidate(worded)).toMatchObject({ status: 'held', reason: 'delivery_other' });

    // Each bound on its own: a code-shaped string that is too long, and a short one that
    // is not code-shaped. Both reviews still fall before quiet hours.
    const minutesAfter = (minutes: number) =>
      new Date(THURSDAY_EVENING.getTime() + minutes * 60_000);
    const overlong = await enqueue('nudge:weather:w43');
    await runProactiveReview(db.database, refusedWith('a'.repeat(33)).deps, minutesAfter(80));
    expect(await candidate(overlong)).toMatchObject({ status: 'held', reason: 'delivery_other' });

    const spaced = await enqueue('nudge:weather:w44');
    await runProactiveReview(db.database, refusedWith('rate limited').deps, minutesAfter(100));
    expect(await candidate(spaced)).toMatchObject({ status: 'held', reason: 'delivery_other' });

    const held = await audits('proactive_cadence_held');
    expect(held.map((row) => row.after)).toEqual([
      { reason: 'delivery_3001', itemIds: [coded], mode: 'live' },
      { reason: 'delivery_other', itemIds: [coded, worded], mode: 'live' },
      { reason: 'delivery_other', itemIds: [coded, worded, overlong], mode: 'live' },
      { reason: 'delivery_other', itemIds: [coded, worded, overlong, spaced], mode: 'live' },
    ]);
  });

  it('names a family with no primary parent instead of guessing its zone', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await enqueue();
    // The row's own parent still holds a seat, so the row is reviewed; nobody is primary.
    await db.database
      .update(schema.familyMembers)
      .set({ role: 'co_parent' })
      .where(eq(schema.familyMembers.familyId, familyId));
    const h = harness(sendAll);
    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(summary).toMatchObject({ decided: 0, skipped: 1, parentNotInFamily: 0 });
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

    it('holds the bubble, by name, while no sending line is configured to read a pause for', async () => {
      vi.stubEnv('LINQ_FROM_E164', '');
      const id = await enqueue();
      const h = harness(sendAll, {
        outboundTarget: async () => ({ channel: 'group', chatId: CHAT, familyId }),
        lineHold: readLineHold,
        fetch: linqFetch,
      });

      const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      expect(summary).toMatchObject({ sent: 0, held: 1 });
      expect(linqCalls).toBe(0);
      expect(await candidate(id)).toMatchObject({
        status: 'held',
        reason: 'no_sending_line',
        decision: 'send_now',
      });
      const [held] = await audits('proactive_cadence_held');
      expect(held?.after).toMatchObject({ reason: 'no_sending_line', itemIds: [id], mode: 'live' });

      // Positive control: the same bubble leaves once the line is configured and clear.
      vi.stubEnv('LINQ_FROM_E164', '+15555550199');
      await parentText('any news?', new Date(THURSDAY_EVENING.getTime() + 30 * 60_000));
      const after = await runProactiveReview(db.database, h.deps, HOUR_AFTER);
      expect(after).toMatchObject({ sent: 1, held: 0 });
      expect(linqCalls).toBe(1);
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
  /** A text's stamp as the read mark carries it: UTC, to the microsecond. */
  const stamp = (at: Date): string => at.toISOString().replace('Z', '000Z');

  const lessPlease = (snapshot: FamilySnapshot): DeciderDecision => ({
    reason: 'They asked to hear less',
    action: 'drop',
    itemIds: snapshot.candidates.map((c) => c.id),
    holdUntil: null,
    frequencyPreference: { direction: 'less', note: 'text me less' },
  });

  /** A decider that hears a pace only in a text it was actually shown. */
  const hearsWhatItReads = (snapshot: FamilySnapshot): DeciderDecision => ({
    ...lessPlease(snapshot),
    frequencyPreference: snapshot.recentParentTexts.includes('text me less')
      ? { direction: 'less', note: 'text me less' }
      : null,
  });

  async function decisionFields(
    field: 'cadencePreference' | 'parentTextsRead' | 'parentTextsWithheld' | 'parentTextsCut',
  ) {
    const decisions = await audits('proactive_cadence_decision');
    return decisions
      .map((row) => (row.after as Record<string, unknown>)[field])
      .filter((value) => value !== undefined);
  }

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
      cadencePreference: { schemaVersion: 1, parentUserId, direction: 'less' },
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
    expect(h.snapshots[2]?.frequencyPreference).toEqual({ direction: 'less' });
  });

  function observeReturnedRows(): { returned: unknown[]; restore: () => void } {
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
    return {
      returned,
      restore: () => {
        db.client.query = query;
      },
    };
  }

  it('reads only the owner’s texts for a batch that is wholly theirs, and keeps the pace as theirs', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const coParentId = await addCoParent();
    await parentText('text me less', HOUR_BEFORE);
    await parentText('we love the weekend ideas', HOUR_BEFORE, coParentId);
    await enqueue();
    const h = harness(lessPlease);

    const observed = observeReturnedRows();
    try {
      await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    } finally {
      observed.restore();
    }

    expect(h.snapshots[0]?.recentParentTexts).toEqual(['text me less']);
    expect(h.snapshots[0]?.parentTextsWithheld).toBeUndefined();
    const read = JSON.stringify(observed.returned);
    expect(read).toContain('text me less');
    expect(read).not.toContain('we love the weekend ideas');
    const [decision] = await audits('proactive_cadence_decision');
    expect(decision?.after).toMatchObject({
      cadencePreference: { schemaVersion: 1, parentUserId, direction: 'less' },
    });
    expect(await memoryFacts()).toEqual([]);
  });

  it('reads no parent text for a batch two parents own, and names the withhold', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const coParentId = await addCoParent();
    await parentText('text me less', HOUR_BEFORE);
    await parentText('we love the weekend ideas', HOUR_BEFORE, coParentId);
    await enqueue('nudge:weather:w41');
    await enqueue('nudge:dropin:w41', { parentUserId: coParentId, why: 'weekday_dropin' });
    const h = harness(lessPlease);

    const observed = observeReturnedRows();
    try {
      await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    } finally {
      observed.restore();
    }

    expect(h.snapshots[0]?.candidates).toHaveLength(2);
    expect(h.snapshots[0]?.recentParentTexts).toEqual([]);
    expect(h.snapshots[0]?.parentTextsWithheld).toBe('mixed_batch');
    const read = JSON.stringify(observed.returned);
    expect(read).not.toContain('text me less');
    expect(read).not.toContain('we love the weekend ideas');
    const [decision] = await audits('proactive_cadence_decision');
    expect(decision?.after).toMatchObject({ cadencePreference: 'not_written_mixed_batch' });
  });

  it('when live, never keeps a pace the decider restated with no new text from the owner, by name', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const coParentId = await addCoParent();
    const stored = { schemaVersion: 1, parentUserId, direction: 'less' };
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

    expect(h.snapshots[0]?.frequencyPreference).toEqual({ direction: 'less' });
    expect(h.snapshots[0]?.recentParentTexts).toEqual([]);
    const decisions = await audits('proactive_cadence_decision');
    const reviewed = decisions.find((row) => 'action' in (row.after as object));
    expect(reviewed?.after).toMatchObject({ cadencePreference: 'not_written_no_new_text' });
    const kept = decisions
      .map((row) => (row.after as { cadencePreference?: unknown }).cadencePreference)
      .filter((pace) => typeof pace === 'object');
    expect(kept).toEqual([stored]);
  });

  const HOUR_AFTER = new Date(THURSDAY_EVENING.getTime() + 60 * 60_000);
  const TWO_HOURS_AFTER = new Date(THURSDAY_EVENING.getTime() + 2 * 60 * 60_000);

  it('when live, hands the decider a parent text once, at the first review of that parent’s batch', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await parentText('weekends are best for us', HOUR_BEFORE);
    // Stamped after the first review's clock: that review leaves it for the next.
    await parentText('mornings too', new Date(THURSDAY_EVENING.getTime() + 30 * 60_000));
    await enqueue('nudge:weather:w41');
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(h.snapshots[0]?.recentParentTexts).toEqual(['weekends are best for us']);
    expect(await decisionFields('parentTextsRead')).toEqual([
      { parentUserId, through: stamp(HOUR_BEFORE) },
    ]);

    await enqueue('nudge:weather:w42');
    await runProactiveReview(db.database, h.deps, HOUR_AFTER);
    expect(h.snapshots[1]?.recentParentTexts).toEqual(['mornings too']);

    await enqueue('nudge:weather:w43');
    await runProactiveReview(db.database, h.deps, TWO_HOURS_AFTER);
    expect(h.snapshots).toHaveLength(3);
    expect(h.snapshots[2]?.recentParentTexts).toEqual([]);
    // A review that read no text says nothing about having read any.
    expect(await decisionFields('parentTextsRead')).toHaveLength(2);
  });

  it('when live, marks a read at the newest text it read, so one stored late under an earlier stamp is still read', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await parentText('saturdays work', new Date(HOUR_BEFORE.getTime() - 60 * 60_000));
    await parentText('weekends are best for us', HOUR_BEFORE);
    // The database stamps to the microsecond: a mark cut to the millisecond reads this again.
    await db.database.execute(
      sql`update channel_messages set created_at = created_at + interval '456 microseconds'`,
    );
    await enqueue('nudge:weather:w41');
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(h.snapshots[0]?.recentParentTexts).toEqual([
      'saturdays work',
      'weekends are best for us',
    ]);
    expect(await decisionFields('parentTextsRead')).toEqual([
      { parentUserId, through: '2026-10-08T21:00:00.000456Z' },
    ]);

    // Stamped a minute inside the first review's clock, stored after it ran.
    await parentText('mornings too', new Date(THURSDAY_EVENING.getTime() - 60_000));
    await enqueue('nudge:weather:w42');
    await runProactiveReview(db.database, h.deps, HOUR_AFTER);
    expect(h.snapshots[1]?.recentParentTexts).toEqual(['mornings too']);
  });

  it('reads a parent’s pace request at their own next review, after the other parent’s batch was reviewed in between', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const coParentId = await addCoParent();
    await parentText('text me less', HOUR_BEFORE);
    await parentText('we love the weekend ideas', HOUR_BEFORE, coParentId);
    await enqueue('nudge:dropin:w41', { parentUserId: coParentId, why: 'weekday_dropin' });
    const h = harness(hearsWhatItReads);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(h.snapshots[0]?.recentParentTexts).toEqual(['we love the weekend ideas']);
    expect(await decisionFields('parentTextsRead')).toEqual([
      { parentUserId: coParentId, through: stamp(HOUR_BEFORE) },
    ]);

    await enqueue('nudge:weather:w41');
    await runProactiveReview(db.database, h.deps, HOUR_AFTER);

    expect(h.snapshots[1]?.recentParentTexts).toEqual(['text me less']);
    expect(await decisionFields('cadencePreference')).toEqual([
      { schemaVersion: 1, parentUserId, direction: 'less' },
    ]);
    expect(await decisionFields('parentTextsRead')).toContainEqual({
      parentUserId,
      through: stamp(HOUR_BEFORE),
    });
  });

  it('reads a parent’s pace request at their own next review, after a batch two parents own was reviewed in between', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const coParentId = await addCoParent();
    await parentText('text me less', HOUR_BEFORE);
    await enqueue('nudge:weather:w41');
    await enqueue('nudge:dropin:w41', { parentUserId: coParentId, why: 'weekday_dropin' });
    const h = harness(hearsWhatItReads);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(h.snapshots[0]?.parentTextsWithheld).toBe('mixed_batch');
    expect(h.snapshots[0]?.recentParentTexts).toEqual([]);
    expect(await decisionFields('parentTextsRead')).toEqual([]);
    expect(await decisionFields('cadencePreference')).toEqual([]);
    expect(await decisionFields('parentTextsWithheld')).toEqual(['mixed_batch']);

    await enqueue('nudge:weather:w42');
    await runProactiveReview(db.database, h.deps, HOUR_AFTER);

    expect(h.snapshots[1]?.recentParentTexts).toEqual(['text me less']);
    expect(await decisionFields('cadencePreference')).toEqual([
      { schemaVersion: 1, parentUserId, direction: 'less' },
    ]);
    expect(await audits('proactive_cadence_decision')).toHaveLength(2);
    expect(await decisionFields('parentTextsWithheld')).toEqual(['mixed_batch']);
  });

  it('in shadow, names a batch two parents own on the decision row', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const coParentId = await addCoParent();
    await parentText('text me less', HOUR_BEFORE);
    await enqueue('nudge:weather:w41');
    await enqueue('nudge:dropin:w41', { parentUserId: coParentId, why: 'weekday_dropin' });
    const h = harness(hearsWhatItReads);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    const [decision] = await audits('proactive_cadence_decision');
    expect(decision?.after).toMatchObject({ mode: 'shadow', parentTextsWithheld: 'mixed_batch' });
  });

  it('in shadow, hands the decider a parent text once', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await parentText('text me less', HOUR_BEFORE);
    await enqueue('nudge:weather:w41');
    const h = harness(hearsWhatItReads);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(h.snapshots[0]?.recentParentTexts).toEqual(['text me less']);
    const [first] = await audits('proactive_cadence_decision');
    expect(first?.after).toMatchObject({
      mode: 'shadow',
      cadencePreference: 'not_written_shadow',
      parentTextsRead: { parentUserId, through: stamp(HOUR_BEFORE) },
    });

    await enqueue('nudge:weather:w42');
    await runProactiveReview(db.database, h.deps, HOUR_AFTER);
    expect(h.snapshots).toHaveLength(2);
    expect(h.snapshots[1]?.recentParentTexts).toEqual([]);
  });

  it('reads a text first seen in shadow once more when live arms, and keeps the pace then', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await parentText('text me less', HOUR_BEFORE);
    await enqueue('nudge:weather:w41');
    const h = harness(hearsWhatItReads);
    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(h.snapshots[0]?.recentParentTexts).toEqual(['text me less']);

    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await enqueue('nudge:weather:w42');
    await runProactiveReview(db.database, h.deps, HOUR_AFTER);

    expect(h.snapshots[1]?.recentParentTexts).toEqual(['text me less']);
    expect(await decisionFields('cadencePreference')).toEqual([
      'not_written_shadow',
      { schemaVersion: 1, parentUserId, direction: 'less' },
    ]);

    await enqueue('nudge:weather:w43');
    await runProactiveReview(db.database, h.deps, TWO_HOURS_AFTER);
    expect(h.snapshots).toHaveLength(3);
    expect(h.snapshots[2]?.recentParentTexts).toEqual([]);
  });

  it('in shadow, never re-reads a text a live review already read', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await parentText('text me less', HOUR_BEFORE);
    await enqueue('nudge:weather:w41');
    const h = harness(hearsWhatItReads);
    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    expect(h.snapshots[0]?.recentParentTexts).toEqual(['text me less']);

    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await enqueue('nudge:weather:w42');
    await runProactiveReview(db.database, h.deps, HOUR_AFTER);
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
    expect(h.snapshots[0]?.parentTextsWithheld).toBe('teen_household');
    expect(await decisionFields('parentTextsWithheld')).toEqual(['teen_household']);
    expect(await decisionFields('parentTextsRead')).toEqual([]);
  });

  it('when live, keeps no pace in a household with a teenager, by name, whoever owns the batch', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Older', dateOfBirth: '2011-03-01' });
    const coParentId = await addCoParent();
    await parentText('text me less', HOUR_BEFORE);
    await enqueue('nudge:weather:w41');
    const h = harness(lessPlease);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    await enqueue('nudge:weather:w42');
    await enqueue('nudge:dropin:w42', { parentUserId: coParentId, why: 'weekday_dropin' });
    await runProactiveReview(db.database, h.deps, HOUR_AFTER);

    expect(h.snapshots.map((snapshot) => snapshot.recentParentTexts)).toEqual([[], []]);
    expect(await decisionFields('cadencePreference')).toEqual([
      'not_written_teen_household',
      'not_written_teen_household',
    ]);
    expect(await decisionFields('parentTextsWithheld')).toEqual([
      'teen_household',
      'teen_household',
    ]);
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
  async function storedPaceAndPriorHold(): Promise<{ why: string }> {
    const why = 'They said the weekend is already full with the tournament';
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'proactive_cadence_decision',
      targetTable: 'families',
      targetId: familyId,
      after: {
        cadencePreference: { schemaVersion: 1, parentUserId, direction: 'less' },
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
    return { why };
  }

  it('never replays a prior hold’s reason in a household with a teenager, and still shows a kept pace', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Older', dateOfBirth: '2011-03-01' });
    const { why } = await storedPaceAndPriorHold();
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    const snapshot = h.snapshots[0];
    expect(snapshot?.frequencyPreference).toEqual({ direction: 'less' });
    expect(snapshot?.priorDecisions.map((prior) => prior.reason)).toEqual([WITHHELD_LABEL]);
    expect(JSON.stringify(snapshot)).not.toContain(why);
  });

  it('replays a kept pace and a prior hold’s reason where no child is a teenager', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const { why } = await storedPaceAndPriorHold();
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    const snapshot = h.snapshots[0];
    expect(snapshot?.frequencyPreference).toEqual({ direction: 'less' });
    expect(snapshot?.priorDecisions.map((prior) => prior.reason)).toEqual([why]);
  });

  it('hands the writer the chosen items and nothing a parent said about pace', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await storedPaceAndPriorHold();
    const handed: string[][] = [];
    const h = harness(sendAll, {
      compose: async (input): Promise<WriterResult> => {
        handed.push(Object.keys(input).sort());
        return { message: MESSAGE };
      },
    });

    const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(summary).toMatchObject({ sent: 1 });
    expect(h.snapshots[0]?.frequencyPreference).toEqual({ direction: 'less' });
    expect(handed).toEqual([['client', 'items']]);
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
    // The three past the newest are behind the read mark for good: named, not silent.
    expect(h.snapshots[0]?.parentTextsCut).toBe(3);
    expect(await decisionFields('parentTextsCut')).toEqual([3]);
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
    expect(h.snapshots[0]?.parentTextsCut).toBeUndefined();
    expect(await decisionFields('parentTextsCut')).toEqual([]);
  });

  it('reads no parent text from before the days the decider can see', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const edge = THURSDAY_EVENING.getTime() - SNAPSHOT_DAYS * 24 * 60 * 60_000;
    await parentText('an old text outside the window', new Date(edge - 60 * 60_000));
    await parentText('a text inside the window', new Date(edge + 60 * 60_000));
    await enqueue('nudge:weather:w41');
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(h.snapshots[0]?.recentParentTexts).toEqual(['a text inside the window']);
  });

  it('reads a parent’s texts past this family’s own read mark, never another family’s', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    const other = await seedFamily(db.database, 'Other Family');
    await db.database.insert(schema.auditLog).values({
      familyId: other.familyId,
      actor: 'system',
      actionTaken: 'proactive_cadence_decision',
      targetTable: 'families',
      targetId: other.familyId,
      after: {
        parentTextsRead: { parentUserId, through: stamp(THURSDAY_EVENING) },
        mode: 'live',
      },
      occurredAt: HOUR_BEFORE,
    });
    await parentText('weekends are best for us', HOUR_BEFORE);
    await enqueue('nudge:weather:w41');
    const h = harness(sendAll);

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(h.snapshots[0]?.recentParentTexts).toEqual(['weekends are best for us']);
  });

  it('reads no outbound body and no parent text from before the last look', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
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
    // A drop, so the one outbound row stays the only send the second look counts.
    const h = harness((snapshot) => ({ ...lessPlease(snapshot), frequencyPreference: null }));
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

  /** A parent's own connected calendar, with one event whose title the alert still holds. */
  async function ownCalendarEvent(
    userId: string | null,
    title: string,
    startAt: Date,
  ): Promise<void> {
    const [integration] = await db.database
      .insert(schema.integrations)
      .values({ familyId, userId, provider: 'gcal', status: 'active' })
      .returning({ id: schema.integrations.id });
    await db.database.insert(schema.calendarEventSnapshots).values({
      integrationId: integration?.id as string,
      eventId: `event-${userId}`,
      startAt,
      endAt: new Date(startAt.getTime() + 60 * 60_000),
      updatedStamp: 'stamp-1',
      status: 'confirmed',
      pendingSince: THURSDAY_EVENING,
      heldTitle: title,
    });
  }

  it('shows a title from a parent’s own calendar only in a batch that is wholly theirs', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const coParentId = await addCoParent();
    const friday = (hour: number) => new Date(`2026-10-09T${hour}:00:00.000Z`);
    await ownCalendarEvent(parentUserId, 'Physio appointment', friday(15));
    await ownCalendarEvent(coParentId, 'Interview at the bank', friday(18));
    // A connection that names no user is no one parent's to read.
    await ownCalendarEvent(null, 'Dentist for the twins', friday(20));
    await enqueue('nudge:weather:w41');
    const h = harness((snapshot) => ({ ...sendAll(snapshot), action: 'hold' }));

    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    expect(h.snapshots[0]?.calendar).toEqual([
      {
        day: '2026-10-09',
        label: 'Physio appointment',
        allDay: false,
        start: '11:00',
        end: '12:00',
      },
      { day: '2026-10-09', label: 'busy', allDay: false, start: '14:00', end: '15:00' },
      { day: '2026-10-09', label: 'busy', allDay: false, start: '16:00', end: '17:00' },
    ]);
    expect(JSON.stringify(h.snapshots[0])).not.toContain('Interview at the bank');
    expect(JSON.stringify(h.snapshots[0])).not.toContain('Dentist for the twins');

    // A batch two parents own is no one parent's: neither title is shown.
    await enqueue('nudge:dropin:w41', { parentUserId: coParentId, why: 'weekday_dropin' });
    await runProactiveReview(db.database, h.deps, HOUR_AFTER);

    expect(h.snapshots[1]?.parentTextsWithheld).toBe('mixed_batch');
    expect(h.snapshots[1]?.calendar.map((entry) => entry.label)).toEqual(['busy', 'busy', 'busy']);
  });

  it('shows a prior hold’s reason only in a batch that is wholly its owner’s', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const coParentId = await addCoParent();
    const TOMORROW = '2026-10-09T21:00:00.000Z';
    const hoursAfter = (hours: number) =>
      new Date(THURSDAY_EVENING.getTime() + hours * 60 * 60_000);
    const MINE = 'Physio appointment; they said: the tournament fills our weekend';
    const THEIRS = 'Interview at the bank is that morning';
    let reason = MINE;
    const h = harness((snapshot) => ({
      ...sendAll(snapshot),
      reason,
      action: 'hold',
      holdUntil: TOMORROW,
    }));
    const reasons = (snapshot: FamilySnapshot | undefined) =>
      Object.fromEntries((snapshot?.priorDecisions ?? []).map((prior) => [prior.id, prior.reason]));
    const coParentItem = (dedupeKey: string) =>
      enqueue(dedupeKey, { parentUserId: coParentId, why: 'weekday_dropin' });

    const mine = await enqueue('nudge:weather:w41');
    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

    // The other parent's batch: the hold is still shown, its words are not.
    reason = THEIRS;
    const theirs = await coParentItem('nudge:dropin:w41');
    await runProactiveReview(db.database, h.deps, hoursAfter(1));
    expect(h.snapshots[1]?.candidates.map((item) => item.id)).toEqual([theirs]);
    expect(h.snapshots[1]?.parentTextsWithheld).toBeUndefined();
    expect(h.snapshots[1]?.priorDecisions).toEqual([
      {
        id: mine,
        action: 'held',
        at: THURSDAY_EVENING.toISOString(),
        reason: WITHHELD_LABEL,
        holdUntil: TOMORROW,
      },
    ]);

    // The owner's own next batch still reads what the decider wrote in theirs.
    reason = MINE;
    const mineAgain = await enqueue('nudge:weather:w42');
    await runProactiveReview(db.database, h.deps, hoursAfter(2));
    expect(h.snapshots[2]?.candidates.map((item) => item.id)).toEqual([mineAgain]);
    expect(reasons(h.snapshots[2])).toEqual({ [mine]: MINE, [theirs]: WITHHELD_LABEL });

    // A batch two parents own is no one parent's: no hold's words are shown.
    await enqueue('nudge:weather:w43');
    await coParentItem('nudge:dropin:w43');
    await runProactiveReview(db.database, h.deps, hoursAfter(3));
    expect(h.snapshots[3]?.parentTextsWithheld).toBe('mixed_batch');
    expect(reasons(h.snapshots[3])).toEqual({
      [mine]: WITHHELD_LABEL,
      [theirs]: WITHHELD_LABEL,
      [mineAgain]: WITHHELD_LABEL,
    });

    // Whose row a hold is on is read by the code and never handed to the model.
    expect(h.snapshots).toHaveLength(4);
    const shown = JSON.stringify(h.snapshots);
    expect(shown).not.toContain(parentUserId);
    expect(shown).not.toContain(coParentId);
  });

  it('stores a bounded one-line reason on a held row, whatever the decider wrote, and none in the audit trail', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const id = await enqueue();
    const long = `No window fits\nand the weekend is\tfull ${'x'.repeat(400)}`;
    const h = harness((snapshot) => ({
      reason: long,
      action: 'hold',
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
    expect(decision?.after).toEqual({
      action: 'hold',
      itemIds: [id],
      unchosen: [],
      holdUntil: null,
      mode: 'shadow',
    });
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
      reason: 'expired',
      decision: 'drop',
      holdUntil: null,
      now: THURSDAY_EVENING,
    });

    expect(await candidate(own)).toMatchObject({ status: 'dropped', reason: 'expired' });
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
    // Spelled as an env var may be: the stored row below is the same line.
    vi.stubEnv('LINQ_FROM_E164', ' +1 (555) 555-0199 ');
    const id = await enqueue();
    const h = harness(sendAll, { lineHold: async () => 'line_health' });
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

  describe('a candidate past the moment it stops being worth sending', () => {
    const HOUR = 60 * 60_000;

    it('is dropped by name before the review, never offered, and a fresh one still is', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const fresh = await enqueue('nudge:weather:w41', {
        worthlessAfter: new Date(THURSDAY_EVENING.getTime() + 24 * HOUR),
      });
      const stale = await enqueue('nudge:weather:w42', {
        worthlessAfter: new Date(THURSDAY_EVENING.getTime() - HOUR),
      });
      const h = harness(sendAll);

      const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      expect(summary).toMatchObject({ expired: 1, sent: 1 });
      expect(h.snapshots[0]?.candidates.map((c) => c.id)).toEqual([fresh]);
      expect(await candidate(fresh)).toMatchObject({ status: 'sent' });
      expect(await candidate(stale)).toMatchObject({
        status: 'dropped',
        reason: 'expired',
        decision: null,
        what: '',
      });
      const skipped = await audits('proactive_cadence_skipped');
      expect(skipped.map((row) => row.after)).toEqual([
        { reason: 'expired', itemId: stale, mode: 'live' },
      ]);
    });

    it('drops by name a code hold that waits on a signal once it has expired', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const id = await enqueue('nudge:weather:w41', {
        worthlessAfter: new Date(THURSDAY_EVENING.getTime() + 2 * HOUR),
      });
      const h = harness(sendAll, {
        buildGate: () => ({ ...openGate(), watchConsentGranted: async () => false }),
      });

      await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
      expect(await candidate(id)).toMatchObject({
        status: 'held',
        reason: 'no_watch_consent',
        holdUntil: null,
        what: 'Indoor climbing by the river',
      });

      const summary = await runProactiveReview(
        db.database,
        h.deps,
        new Date(THURSDAY_EVENING.getTime() + 3 * HOUR),
      );

      expect(summary).toMatchObject({ expired: 1, decided: 0 });
      expect(h.snapshots).toHaveLength(1);
      expect(await candidate(id)).toMatchObject({ status: 'dropped', reason: 'expired', what: '' });
    });

    it('expires an item the parent asked for the same way, by name', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const id = await enqueue('nudge:weather:w41', {
        parentRequested: true,
        worthlessAfter: new Date(THURSDAY_EVENING.getTime() - HOUR),
      });
      const h = harness(sendAll);

      const summary = await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      expect(summary).toMatchObject({ expired: 1, decided: 0, sent: 0 });
      expect(h.snapshots).toEqual([]);
      expect(h.transport.sent).toEqual([]);
      expect(await candidate(id)).toMatchObject({ status: 'dropped', reason: 'expired', what: '' });
    });
  });

  describe('the composed text on a candidate row', () => {
    const WHAT = 'Pip and Juno would love indoor climbing at Riverside Rocks';

    it('keeps it once the row is sent: the record of what Hale sent for this item', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const id = await enqueue('nudge:weather:w41', { what: WHAT });
      const h = harness(sendAll);

      await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      expect(await candidate(id)).toMatchObject({ status: 'sent', what: WHAT, reason: null });
      const thread = await db.database
        .select({ content: schema.messages.content })
        .from(schema.messages);
      expect(thread.map((row) => row.content)).toEqual([MESSAGE]);
    });

    it('keeps none once the row is shadowed, dropped or expired', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
      const shadowed = await enqueue('nudge:weather:w41', { what: WHAT });
      await runProactiveReview(db.database, harness(sendAll).deps, THURSDAY_EVENING);
      expect(await candidate(shadowed)).toMatchObject({ status: 'shadowed', what: '' });

      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const dropped = await enqueue('nudge:weather:w42', { what: WHAT });
      const expired = await enqueue('nudge:weather:w43', {
        what: WHAT,
        worthlessAfter: THURSDAY_EVENING,
      });
      const h = harness((snapshot) => ({ ...sendAll(snapshot), action: 'drop' }));
      await runProactiveReview(
        db.database,
        h.deps,
        new Date(THURSDAY_EVENING.getTime() + 60 * 60_000),
      );
      expect(await candidate(dropped)).toMatchObject({ status: 'dropped', what: '' });
      expect(await candidate(expired)).toMatchObject({
        status: 'dropped',
        reason: 'expired',
        what: '',
      });
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

  describe('the decider’s own words', () => {
    const WORDS = 'They said the weekend is already full with the tournament';
    const PACE_WORDS = 'fewer texts on school nights please';
    const heardAPace =
      (action: DeciderDecision['action']) =>
      (snapshot: FamilySnapshot): DeciderDecision => ({
        reason: WORDS,
        action,
        itemIds: snapshot.candidates.map((c) => c.id),
        holdUntil: null,
        frequencyPreference: { direction: 'less', note: PACE_WORDS },
      });

    async function auditTrail(): Promise<string> {
      const rows = await db.database
        .select({ actionTaken: schema.auditLog.actionTaken, after: schema.auditLog.after })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.familyId, familyId));
      return JSON.stringify(rows);
    }

    it('in shadow, keeps none of them on the decision row', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
      const id = await enqueue();
      const h = harness(heardAPace('drop'));

      await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      const [decision] = await audits('proactive_cadence_decision');
      expect(decision?.after).toEqual({
        action: 'drop',
        itemIds: [id],
        unchosen: [],
        holdUntil: null,
        cadencePreference: 'not_written_shadow',
        mode: 'shadow',
      });
      expect(await auditTrail()).not.toContain(WORDS);
    });

    it('when live, keeps none of them on any audit row: a pace is its direction and whose it is', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      await parentText(PACE_WORDS, HOUR_BEFORE);
      const id = await enqueue();
      const h = harness(heardAPace('send_now'));

      await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);

      const [decision] = await audits('proactive_cadence_decision');
      expect(decision?.after).toEqual({
        action: 'send_now',
        itemIds: [id],
        unchosen: [],
        holdUntil: null,
        cadencePreference: { schemaVersion: 1, parentUserId, direction: 'less' },
        parentTextsRead: { parentUserId, through: stamp(HOUR_BEFORE) },
        mode: 'live',
      });
      expect(await audits('proactive_nudge_sent')).toHaveLength(1);
      const trail = await auditTrail();
      expect(trail).not.toContain(WORDS);
      expect(trail).not.toContain(PACE_WORDS);

      // The direction is still the owner's pace at their next review.
      await enqueue('nudge:weather:w42');
      await runProactiveReview(db.database, h.deps, HOUR_AFTER);
      expect(h.snapshots[1]?.frequencyPreference).toEqual({ direction: 'less' });
    });

    it('keeps the reason on a held row for the next review to read, and none once the row settles', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const held = await enqueue('nudge:weather:w41');
      let action: DeciderDecision['action'] = 'hold';
      const h = harness((snapshot) => ({ ...sendAll(snapshot), reason: WORDS, action }));

      await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
      expect(await candidate(held)).toMatchObject({
        status: 'held',
        decision: 'hold',
        reason: WORDS,
      });

      const fresh = await enqueue('nudge:weather:w42');
      action = 'send_now';
      await runProactiveReview(db.database, h.deps, HOUR_AFTER);

      expect(h.snapshots[1]?.priorDecisions).toEqual([
        {
          id: held,
          action: 'held',
          at: THURSDAY_EVENING.toISOString(),
          reason: WORDS,
          holdUntil: null,
        },
      ]);
      expect(await candidate(held)).toMatchObject({
        status: 'sent',
        decision: 'send_now',
        reason: null,
      });
      expect(await candidate(fresh)).toMatchObject({ status: 'sent', reason: null });
    });

    it('keeps none on a row the decider shadowed or dropped', async () => {
      vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
      const shadowed = await enqueue('nudge:weather:w41');
      await runProactiveReview(db.database, harness(heardAPace('send_now')).deps, THURSDAY_EVENING);
      expect(await candidate(shadowed)).toMatchObject({
        status: 'shadowed',
        decision: 'send_now',
        reason: null,
      });

      vi.stubEnv('PROACTIVE_CADENCE', 'live');
      const dropped = await enqueue('nudge:weather:w42');
      await runProactiveReview(db.database, harness(heardAPace('drop')).deps, HOUR_AFTER);
      expect(await candidate(dropped)).toMatchObject({
        status: 'dropped',
        decision: 'drop',
        reason: null,
      });
    });
  });
});
