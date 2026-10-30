import { type Database, schema } from '@hale/db';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { softDeleteEpisode, updateEpisode } from './log-write.js';

/**
 * Edit + soft-delete of a quick-log episode. Both are family-scoped (rule #1: a
 * parent may only touch their OWN family's episode) and each writes an immutable
 * audit_log row with before/after inside the SAME transaction as the mutation
 * (rule #6). A foreign episode (id not in this family) matches no row → the
 * mutation returns false and NO audit row is written.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY_ID = '99999999-9999-4999-8999-999999999999';
const EPISODE_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-06-30T12:00:00Z');

const BEFORE_ROW = {
  id: EPISODE_ID,
  familyId: FAMILY_ID,
  childId: '33333333-3333-4333-8333-333333333333',
  occurredAt: new Date('2026-06-29T08:00:00Z'),
  episodeType: 'feed',
  summary: 'Fed 120 ml',
  payload: { amountMl: 120 },
};

interface Capture {
  updateValues: Record<string, unknown>[];
  audit: Record<string, unknown>[];
}

/**
 * Reads the equality constraints ({ id, family_id, ... }) off a Drizzle WHERE by
 * walking its SQL chunks: a column chunk (has a `.name` + `.table`) followed by the
 * bound Param carries one `col = value`. This lets the fake EVALUATE the lib's real
 * WHERE rather than stipulate a match — drop eq(family_id) and this stops seeing the
 * family constraint, so the foreign-family row matches and the scoping test fails.
 */
function eqConstraints(sql: SQL, out: Record<string, unknown> = {}): Record<string, unknown> {
  const chunks = (sql as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  let lastCol: string | null = null;
  for (const chunk of chunks) {
    const c = chunk as { constructor?: { name?: string }; name?: string; table?: unknown; value?: unknown };
    if (c?.constructor?.name === 'SQL') {
      eqConstraints(chunk as SQL, out);
      lastCol = null;
      continue;
    }
    if (typeof c?.name === 'string' && c.table) {
      lastCol = c.name;
      continue;
    }
    if (c?.constructor?.name === 'Param' && lastCol) {
      out[lastCol] = c.value;
      lastCol = null;
    }
  }
  return out;
}

/**
 * Fakes the chains a mutation touches inside a transaction, EVALUATING the real
 * family-scoped WHERE against the seeded BEFORE_ROW (id + family_id):
 *   tx.select().from(episodes).where(id AND family) → [beforeRow] | []
 *   tx.update(episodes).set(patch).where(...).returning({id}) → [{id}] | []
 *   tx.insert(auditLog).values(row) → void
 * A foreign family's id passed to the lib builds a WHERE whose family_id ≠ the
 * seeded row's, so the extractor-filtered match is empty — the whole point of the
 * scoping test, held by construction rather than a stipulated flag.
 */
function stubTxDb(capture: Capture) {
  const matches = (where: SQL): boolean => {
    const c = eqConstraints(where);
    return (
      (c.id === undefined || BEFORE_ROW.id === c.id) &&
      (c.family_id === undefined || BEFORE_ROW.familyId === c.family_id)
    );
  };
  const tx = {
    select: vi.fn(() => ({
      from: () => ({
        where: (where: SQL) => ({
          limit: async () => (matches(where) ? [BEFORE_ROW] : []),
        }),
      }),
    })),
    update: vi.fn(() => ({
      set: (patch: Record<string, unknown>) => ({
        where: (where: SQL) => ({
          returning: async () => {
            const ok = matches(where);
            if (ok) capture.updateValues.push(patch);
            return ok ? [{ id: EPISODE_ID }] : [];
          },
        }),
      }),
    })),
    insert: vi.fn((table: unknown) => {
      if (table !== schema.auditLog) throw new Error('unexpected insert target');
      return {
        values: async (row: Record<string, unknown>) => {
          capture.audit.push(row);
        },
      };
    }),
  };
  const database = {
    transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
  } as unknown as Database;
  return { database, tx };
}

describe('updateEpisode', () => {
  it('updates the episode and writes an audit row carrying before + after (rules #1, #6)', async () => {
    const capture: Capture = { updateValues: [], audit: [] };
    const { database } = stubTxDb(capture);

    const ok = await updateEpisode(
      database,
      EPISODE_ID,
      FAMILY_ID,
      { summary: 'Fed 150 ml', payload: { amountMl: 150 } },
      ACTOR,
    );

    expect(ok).toBe(true);
    expect(capture.updateValues).toHaveLength(1);
    expect(capture.updateValues[0]).toMatchObject({ summary: 'Fed 150 ml', payload: { amountMl: 150 } });

    expect(capture.audit).toHaveLength(1);
    const audit = capture.audit[0] as Record<string, unknown>;
    expect(audit.familyId).toBe(FAMILY_ID);
    expect(audit.actor).toBe(ACTOR);
    expect(audit.actionTaken).toBe('quick_log_edited');
    expect(audit.targetTable).toBe('family_memory_episodes');
    expect(audit.targetId).toBe(EPISODE_ID);
    expect(audit.before).toMatchObject({ summary: 'Fed 120 ml', payload: { amountMl: 120 } });
    expect(audit.after).toMatchObject({ summary: 'Fed 150 ml', payload: { amountMl: 150 } });
  });

  it("rejects a foreign episode (another family's id) — no write, no audit row (rule #1)", async () => {
    const capture: Capture = { updateValues: [], audit: [] };
    const { database } = stubTxDb(capture);

    const ok = await updateEpisode(
      database,
      EPISODE_ID,
      OTHER_FAMILY_ID,
      { summary: 'hijacked' },
      ACTOR,
    );

    expect(ok).toBe(false);
    expect(capture.updateValues).toEqual([]);
    expect(capture.audit).toEqual([]);
  });
});

describe('softDeleteEpisode', () => {
  it('stamps deleted_at and writes an audit row with the removed row as before (rules #6, #9)', async () => {
    const capture: Capture = { updateValues: [], audit: [] };
    const { database } = stubTxDb(capture);

    const ok = await softDeleteEpisode(database, EPISODE_ID, FAMILY_ID, ACTOR, NOW);

    expect(ok).toBe(true);
    // Soft, not hard: the mutation SETS deleted_at rather than issuing a DELETE.
    expect(capture.updateValues).toHaveLength(1);
    expect(capture.updateValues[0]?.deletedAt).toEqual(NOW);

    expect(capture.audit).toHaveLength(1);
    const audit = capture.audit[0] as Record<string, unknown>;
    expect(audit.actor).toBe(ACTOR);
    expect(audit.actionTaken).toBe('quick_log_deleted');
    expect(audit.targetId).toBe(EPISODE_ID);
    expect(audit.before).toMatchObject({ summary: 'Fed 120 ml' });
    expect(audit.after).toEqual({ deleted: true });
  });

  it("rejects a foreign episode — no delete, no audit row (rule #1)", async () => {
    const capture: Capture = { updateValues: [], audit: [] };
    const { database } = stubTxDb(capture);

    const ok = await softDeleteEpisode(database, EPISODE_ID, OTHER_FAMILY_ID, ACTOR, NOW);

    expect(ok).toBe(false);
    expect(capture.updateValues).toEqual([]);
    expect(capture.audit).toEqual([]);
  });
});
