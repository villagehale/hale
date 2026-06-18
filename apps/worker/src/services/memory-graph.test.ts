import { describe, expect, it, vi } from 'vitest';
import { schema, type Database } from '@hale/db';
import {
  upsertMemoryFact,
  appendMemoryEpisode,
  retireMemoryFact,
  getMemorySlice,
  loadInferencerJob,
} from './memory-writer.js';

const familyId = '11111111-1111-4111-8111-111111111111';
const childId = '44444444-4444-4444-8444-444444444444';
const eventId = '33333333-3333-4333-8333-333333333333';
const existingFactId = '55555555-5555-4555-8555-555555555555';
const newFactId = '66666666-6666-4666-8666-666666666666';

/**
 * A chainable query-builder stub. Every terminal builder method resolves to the
 * rows configured for the call. A per-table queue lets one transaction return
 * different rows for the "find currently-valid fact" select vs the insert's
 * returning() — which is what the supersedence assertions hinge on.
 */
function builder(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'set',
    'where',
    'from',
    'values',
    'onConflictDoNothing',
    'onConflictDoUpdate',
    'returning',
    'orderBy',
    'limit',
  ]) {
    chain[m] = vi.fn(() => chain);
  }
  // biome-ignore lint/suspicious/noThenProperty: drizzle query builders are deliberately thenable; the mock must be awaitable
  (chain as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => resolve(rows);
  return chain;
}

interface UpdateCapture {
  table: unknown;
  set: Record<string, unknown>;
}

/**
 * Builds a fake Database/tx that captures inserts and updates so the
 * supersedence invariant can be asserted: the old row's validUntil + supersededBy
 * are set, then the new row is inserted.
 */
function stubDb(opts: {
  selectQueue?: unknown[][];
  insertReturning?: unknown[];
  /** Rows the supersede UPDATE's .returning() resolves to (drives `superseded`). */
  updateReturning?: unknown[];
}) {
  const inserts: { table: unknown; values: unknown }[] = [];
  const updates: UpdateCapture[] = [];
  const auditTables: string[] = [];
  const selectQueue = [...(opts.selectQueue ?? [])];

  const tx = {
    insert: vi.fn((table: unknown) => {
      if (table === schema.auditLog) auditTables.push('audit_log');
      const valuesChain = builder(opts.insertReturning ?? [{ id: newFactId }]);
      const originalValues = valuesChain.values as ReturnType<typeof vi.fn>;
      (valuesChain as Record<string, unknown>).values = vi.fn((v: unknown) => {
        inserts.push({ table, values: v });
        return originalValues(v);
      });
      return valuesChain;
    }),
    update: vi.fn((table: unknown) => {
      const chain = builder(opts.updateReturning ?? []);
      (chain as Record<string, unknown>).set = vi.fn((s: Record<string, unknown>) => {
        updates.push({ table, set: s });
        return chain;
      });
      return chain;
    }),
    select: vi.fn(() => builder(selectQueue.shift() ?? [])),
  };

  const database = {
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    select: vi.fn(() => builder(selectQueue.shift() ?? [])),
  } as unknown as Database;

  return {
    database,
    inserts: () => inserts,
    updates: () => updates,
    auditInserts: () => auditTables.length,
    factInserts: () => inserts.filter((i) => i.table === schema.familyMemoryFacts),
    episodeInserts: () => inserts.filter((i) => i.table === schema.familyMemoryEpisodes),
  };
}

describe('upsertMemoryFact — valid_until supersedence', () => {
  it('invalidates the current valid row and inserts the new one in one transaction', async () => {
    const s = stubDb({
      insertReturning: [{ id: newFactId }],
      // The conditional UPDATE matched the prior valid row and returns its id.
      updateReturning: [{ id: existingFactId }],
    });

    const result = await upsertMemoryFact(
      {
        familyId,
        childId,
        factType: 'preference',
        factKey: 'preferred_appointment_window',
        factValue: { window: 'evening' },
        confidence: 0.9,
        sourceEventId: eventId,
        inferredBy: 'memory_inferencer',
      },
      s.database,
    );

    expect(s.database.transaction as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    expect(result.factId).toBe(newFactId);
    expect(result.superseded).toBe(true);

    // The old row was invalidated: validUntil set (a Date), supersededBy = new id.
    const supersedeUpdate = s
      .updates()
      .find((u) => u.table === schema.familyMemoryFacts && u.set.supersededBy === newFactId);
    expect(supersedeUpdate).toBeDefined();
    expect(supersedeUpdate?.set.validUntil).toBeInstanceOf(Date);

    // The new row was inserted as currently-valid (no validUntil set on insert).
    const newRow = s.factInserts()[0]?.values as Record<string, unknown>;
    expect(newRow.familyId).toBe(familyId);
    expect(newRow.factType).toBe('preference');
    expect(newRow.factKey).toBe('preferred_appointment_window');
    expect(newRow.confidence).toBe(0.9);
    expect(newRow.validUntil).toBeUndefined();

    expect(s.auditInserts()).toBe(1);
  });

  it('reports superseded=false and inserts a fresh row when no valid row existed', async () => {
    // The conditional UPDATE returns zero rows when nothing was currently valid;
    // superseded is derived from that returning() length, not from whether the
    // statement ran.
    const s = stubDb({ selectQueue: [], insertReturning: [{ id: newFactId }] });
    // The supersede UPDATE's .returning() must resolve to [] for this case; the
    // default stub returns [] for updates, so superseded=false.

    const result = await upsertMemoryFact(
      {
        familyId,
        factType: 'routine',
        factKey: 'bedtime',
        factValue: { time: '19:30' },
        confidence: 0.8,
        inferredBy: 'memory_inferencer',
      },
      s.database,
    );

    expect(result.superseded).toBe(false);
    expect(s.factInserts()).toHaveLength(1);
    expect(s.auditInserts()).toBe(1);
  });
});

describe('appendMemoryEpisode', () => {
  it('inserts one episode row and one audit row in one transaction', async () => {
    const s = stubDb({ insertReturning: [{ id: newFactId }] });

    await appendMemoryEpisode(
      {
        familyId,
        childId,
        occurredAt: new Date('2026-06-10T12:00:00Z'),
        episodeType: 'appointment_confirmed',
        summary: 'Confirmed the 6-month well-baby visit.',
        sourceEventId: eventId,
        sentimentScore: 0.4,
      },
      s.database,
    );

    expect(s.database.transaction as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
    const row = s.episodeInserts()[0]?.values as Record<string, unknown>;
    expect(row.familyId).toBe(familyId);
    expect(row.episodeType).toBe('appointment_confirmed');
    expect(row.summary).toBe('Confirmed the 6-month well-baby visit.');
    expect(row.sentimentScore).toBe(0.4);
    expect(s.auditInserts()).toBe(1);
  });
});

describe('retireMemoryFact', () => {
  it('sets validUntil on the currently-valid row and writes one audit row', async () => {
    const s = stubDb({ selectQueue: [[{ id: existingFactId }]] });

    await retireMemoryFact({ familyId, factType: 'preference', factKey: 'stale_key' }, s.database);

    const retireUpdate = s
      .updates()
      .find((u) => u.table === schema.familyMemoryFacts);
    expect(retireUpdate?.set.validUntil).toBeInstanceOf(Date);
    expect(s.auditInserts()).toBe(1);
  });

  it('is a no-op (no update, no audit) when there is no valid row to retire', async () => {
    const s = stubDb({ selectQueue: [[]] });

    await retireMemoryFact({ familyId, factType: 'preference', factKey: 'absent' }, s.database);

    expect(s.updates()).toHaveLength(0);
    expect(s.auditInserts()).toBe(0);
    expect(s.database.transaction as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe('getMemorySlice', () => {
  it('returns currently-valid facts and recent episodes', async () => {
    const facts = [{ id: existingFactId, factType: 'routine', factKey: 'bedtime' }];
    const episodes = [{ id: newFactId, episodeType: 'appointment_confirmed' }];
    const s = stubDb({ selectQueue: [facts, episodes] });

    const slice = await getMemorySlice(familyId, s.database);

    expect(slice.facts).toEqual(facts);
    expect(slice.episodes).toEqual(episodes);
  });
});

describe('loadInferencerJob', () => {
  it('assembles recent events, recent actions, and the memory snapshot for the window', async () => {
    const events = [{ eventType: 'pediatric_appointment_request', payload: {} }];
    const actions = [{ actionType: 'reply_to_email' }];
    const facts = [{ id: existingFactId, factType: 'routine', factKey: 'bedtime' }];
    const episodes = [{ id: newFactId, episodeType: 'appointment_confirmed' }];
    // Select order: recent events, recent actions, then getMemorySlice's facts + episodes.
    const s = stubDb({ selectQueue: [events, actions, facts, episodes] });

    const result = await loadInferencerJob({ familyId, windowDays: 7 }, s.database);

    expect(result.familyId).toBe(familyId);
    expect(result.windowDays).toBe(7);
    expect(result.recentEvents).toEqual(events);
    expect(result.recentActions).toEqual(actions);
    expect(result.currentMemorySnapshot.facts).toEqual(facts);
    expect(result.currentMemorySnapshot.episodes).toEqual(episodes);
  });
});
