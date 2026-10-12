import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { WEEKDAY_CARE_ASK_TEMPLATE_KEY } from '~/lib/care/weekday';
import { FakeTransport } from '~/lib/channel/intake/transport';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import { threadProactiveMessage } from '~/lib/channel/thread';
import { weekdayFinderDedupeKey } from '~/lib/channel/weekday-care/key';
import { fulfillCommitment } from '~/lib/commitments/ledger';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import type { WriterResult } from './compose';
import type { DecideResult, DeciderDecision } from './decide';
import { CADENCE_FACT_KEY } from './preference';
import { type CandidateDraft, handOffProactive } from './queue';
import { type ProactiveReviewDeps, runProactiveReview } from './review';
import type { FamilySnapshot } from './snapshot';
import { LINE_CHARS, type ToolCandidate } from './tools';

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
    expect(sent?.after).toMatchObject({ kind: 'weather_swap', itemIds: [id] });
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
    expect(skipped?.after).toMatchObject({ reason: 'already_sent', itemIds: [already] });
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

  async function parentText(body: string, at: Date): Promise<void> {
    await db.database.insert(schema.channelMessages).values({
      familyId,
      parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body,
      createdAt: at,
    });
  }

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

  it('keeps a clock-less code hold from the model until something new arrives', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
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

    await db.database.insert(schema.linqLineHealth).values({
      phoneNumber: '+15555550199',
      status: 'active',
      paused: false,
      updatedAt: nextEvening,
    });
    await runProactiveReview(db.database, h.deps, hourAfter);
    expect(h.snapshots).toHaveLength(2);
  });
});
