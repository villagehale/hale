import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { WriterResult } from './compose';
import type { DecideResult, DeciderDecision } from './decide';
import { CADENCE_FACT_KEY } from './preference';
import { handOffProactive } from './queue';
import { type ProactiveReviewDeps, runProactiveReview } from './review';
import type { FamilySnapshot } from './snapshot';

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
  vi.unstubAllEnvs();
});

async function enqueue(dedupeKey = 'nudge:weather:w41'): Promise<string> {
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
}

function harness(
  decision: (snapshot: FamilySnapshot) => DeciderDecision | null,
  over: Partial<ProactiveReviewDeps> = {},
): Harness {
  const transport = new FakeTransport();
  const state: Harness = { deps: {} as ProactiveReviewDeps, transport, snapshots: [], composed: 0 };
  state.deps = {
    client: null,
    transport,
    decide: async ({ snapshot }): Promise<DecideResult> => {
      state.snapshots.push(snapshot);
      const made = decision(snapshot);
      return made ? { decision: made, skipped: null } : { decision: null, skipped: 'unparsed' };
    },
    compose: async (): Promise<WriterResult> => {
      state.composed += 1;
      return { message: MESSAGE };
    },
    buildGate: openGate,
    resolveSendablePhone: async () => PHONE,
    linePaused: async () => false,
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
    const [sent] = await audits('proactive_cadence_sent');
    expect(sent?.after).toMatchObject({ itemIds: [id] });
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
    expect(held?.after).toMatchObject({ reason: 'no_watch_consent', itemIds: [id] });
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

  it('saves a cadence preference the decider heard in the parent’s own words', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await enqueue();
    const h = harness((snapshot) => ({
      reason: 'They asked to hear less',
      action: 'drop',
      itemIds: snapshot.candidates.map((c) => c.id),
      holdUntil: null,
      frequencyPreference: { direction: 'less', note: 'text me less' },
    }));
    await runProactiveReview(db.database, h.deps, THURSDAY_EVENING);
    const [fact] = await db.database
      .select()
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, familyId),
          eq(schema.familyMemoryFacts.factKey, CADENCE_FACT_KEY),
        ),
      );
    expect(fact?.factValue).toEqual({ schemaVersion: 1, direction: 'less', note: 'text me less' });
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
    expect(skipped?.after).toMatchObject({ reason: 'no_primary_parent' });
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
});
