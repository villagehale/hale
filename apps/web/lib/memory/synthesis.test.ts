import { schema } from '@hale/db';
import { STAGE_BOUNDARIES_MONTHS, TEENAGER_START_MONTHS } from '@hale/types';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { defaultInferenceCronDeps } from '~/lib/cron/inference';
import { loadSuppressedCheckpointRefs, recordCheckpointDone } from '~/lib/health/reply';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { writeFact } from './facts';
import {
  MAX_SYNTHESIS_ACTIONS_PER_FAMILY,
  MEMORY_SYNTHESIS_APPLY_ENV,
  MIN_STALE_FACT_AGE_DAYS,
  memorySynthesisApplies,
  runFamilySynthesis,
} from './synthesis';

/**
 * VIL-354 · the nightly memory-integrity pass, against the real DDL.
 *
 * Everything this pass is allowed to do is a database property: which rows the
 * candidate query can even see (the writer allowlist), which row an election picks
 * (the 0084 tiebreak order), and that a retirement is an UPDATE of `valid_until`
 * rather than a delete. A Drizzle chain fake hands back whatever it was given and
 * would pass with the allowlist deleted, so none of it is testable that way.
 *
 * Two disciplines run through every case. Absence is never asserted alone — a test
 * that only checks a health fact survived is green against a pass that does nothing,
 * so each one is PAIRED with a row the pass did act on. And no boundary month is
 * written down: Rule A's cases are generated from `STAGE_BOUNDARIES_MONTHS`, because
 * a test with 12/48/60/156 spelled out re-creates the positional-reader bug
 * `packages/types/src/stage.ts` exists to document.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Noon UTC so the run clock reads as the same calendar day in every zone a
 *  developer or CI box might sit in — `deriveStage` reads local calendar fields. */
const NOW = new Date('2026-09-15T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

/** A date-of-birth `months` before the run clock, anchored on the 15th so no month
 *  is too short to hold the anniversary day. */
function dobAged(months: number, extraDays = 0): string {
  const dob = new Date(Date.UTC(2026, 8, 15));
  dob.setUTCMonth(dob.getUTCMonth() - months);
  dob.setUTCDate(dob.getUTCDate() - extraDays);
  return dob.toISOString().slice(0, 10);
}

async function seedChildAged(familyId: string, name: string, dateOfBirth: string) {
  const [child] = await db.database
    .insert(schema.children)
    .values({ familyId, name, dateOfBirth })
    .returning({ id: schema.children.id });
  if (!child) throw new Error('seedChildAged: no row');
  return child.id;
}

interface FactSeed {
  childId?: string | null;
  factType?: schema.NewFamilyMemoryFact['factType'];
  factKey: string;
  confidence?: number;
  inferredBy?: string;
  validFrom?: Date;
}

async function seedFact(familyId: string, seed: FactSeed): Promise<string> {
  const { factId } = await writeFact(db.database, {
    familyId,
    childId: seed.childId ?? null,
    factType: seed.factType ?? 'routine',
    factKey: seed.factKey,
    factValue: { summary: seed.factKey },
    confidence: seed.confidence ?? 0.9,
    inferredBy: seed.inferredBy ?? 'chat_distiller',
    validFrom: seed.validFrom ?? daysBefore(120),
  });
  return factId;
}

async function factById(id: string) {
  const [row] = await db.database
    .select()
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.id, id));
  if (!row) throw new Error(`no fact ${id}`);
  return row;
}

async function auditRows(familyId: string) {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, familyId));
}

describe('the writer allowlist', () => {
  it('never touches a control-plane record, and still elects among the beliefs beside it', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const child = await seedChildAged(familyId, 'Ella', dobAged(30));
    await recordCheckpointDone(db.database, {
      familyId,
      parentUserId,
      childId: child,
      checkpointId: 'cp-18mo',
      ref: '18mo-visit',
    });
    const winner = await seedFact(familyId, { factKey: 'bedtime_routine', confidence: 0.95 });
    const loser = await seedFact(familyId, { factKey: 'bedtime-routine', confidence: 0.8 });

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);

    // The far-side artifact, not a query of our own: the checkpoint a parent already
    // answered still suppresses its nudge. A close here would make Hale re-nag.
    expect(await loadSuppressedCheckpointRefs(db.database, familyId)).toEqual(
      new Set(['18mo-visit']),
    );
    expect(result.controlPlaneExcluded).toBe(1);
    // The positive control: the pass DID act this run, so the survival above is a
    // decision rather than an idle night.
    expect(result.mergedLosers).toBe(1);
    expect((await factById(loser)).validUntil).not.toBeNull();
    expect((await factById(winner)).validUntil).toBeNull();
  });

  it('excludes a writer it has never heard of, which is the whole point of naming three', async () => {
    // The health and registration writers both key their rows with a ':' namespace, so
    // today they are ALSO protected by the near-duplicate skip. This is the property
    // that only the allowlist provides: a mechanical writer added next quarter, with an
    // ordinary key, is out by DEFAULT — where a blocklist would leave it one merge away
    // from silently un-suppressing whatever it exists to record.
    const { familyId } = await seedFamily(db.database);
    const future = await seedFact(familyId, {
      factKey: 'bedtime_routine',
      confidence: 1,
      inferredBy: 'some-future-receipt-writer',
    });
    const winner = await seedFact(familyId, { factKey: 'bedtime-routine', confidence: 0.95 });
    const loser = await seedFact(familyId, { factKey: 'Bedtime Routine', confidence: 0.8 });

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);

    expect(result.controlPlaneExcluded).toBe(1);
    expect(result.candidates).toBe(2);
    // Highest confidence in the family, and it still neither wins nor loses.
    const untouched = await factById(future);
    expect(untouched.validUntil).toBeNull();
    expect(untouched.supersededBy).toBeNull();
    // Paired positive control: the two rows it was sitting between DID get elected.
    expect(result.mergedLosers).toBe(1);
    expect((await factById(loser)).supersededBy).toBe(winner);
  });

  it('counts a fact whose writer was never recorded, and leaves it alone', async () => {
    const { familyId } = await seedFamily(db.database);
    const [orphan] = await db.database
      .insert(schema.familyMemoryFacts)
      .values({
        familyId,
        factType: 'routine',
        factKey: 'bedtime_routine',
        factValue: { summary: 'from nowhere' },
        confidence: 1,
        inferredBy: null,
        validFrom: daysBefore(120),
      })
      .returning({ id: schema.familyMemoryFacts.id });
    if (!orphan) throw new Error('no orphan row');
    const winner = await seedFact(familyId, { factKey: 'bedtime-routine', confidence: 0.95 });
    const loser = await seedFact(familyId, { factKey: 'Bedtime Routine', confidence: 0.8 });

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);

    expect(result.unattributed).toBe(1);
    expect(result.candidates).toBe(2);
    expect((await factById(orphan.id)).validUntil).toBeNull();
    expect((await factById(loser)).supersededBy).toBe(winner);
  });
});

describe('rule A — a routine the child has outgrown', () => {
  it.each(STAGE_BOUNDARIES_MONTHS)(
    'retires a routine written before the child crossed %i months',
    async (boundary) => {
      const { familyId } = await seedFamily(db.database);
      // Two months past the boundary now; the fact was written three months ago, when
      // the child was one month short of it — one band below, whatever the band is.
      const child = await seedChildAged(familyId, 'Sam', dobAged(boundary + 2));
      const stale = await seedFact(familyId, {
        childId: child,
        factKey: 'naps_after_lunch',
        validFrom: daysBefore(90),
      });

      const result = await runFamilySynthesis(db.database, familyId, NOW, true);

      expect(result.retired).toBe(1);
      expect((await factById(stale)).validUntil).toEqual(NOW);
      expect((await factById(stale)).supersededBy).toBeNull();
    },
  );

  it('leaves a routine written since the crossing, and the one from before it goes', async () => {
    const [boundary] = STAGE_BOUNDARIES_MONTHS;
    const { familyId } = await seedFamily(db.database);
    const child = await seedChildAged(familyId, 'Sam', dobAged(boundary + 2));
    const current = await seedFact(familyId, {
      childId: child,
      factKey: 'walks_to_daycare',
      validFrom: daysBefore(31),
    });
    const stale = await seedFact(familyId, {
      childId: child,
      factKey: 'naps_after_lunch',
      validFrom: daysBefore(90),
    });

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);

    expect(result.retired).toBe(1);
    expect((await factById(current)).validUntil).toBeNull();
    expect((await factById(stale)).validUntil).not.toBeNull();
  });

  it('holds a belief younger than the minimum age even though the child just crossed', async () => {
    const [boundary] = STAGE_BOUNDARIES_MONTHS;
    const { familyId } = await seedFamily(db.database);
    // Crossed five days ago, so a belief written ten days ago predates the crossing —
    // and is still far too new to call "the stage before this one".
    const child = await seedChildAged(familyId, 'Sam', dobAged(boundary, 5));
    const fresh = await seedFact(familyId, {
      childId: child,
      factKey: 'naps_after_lunch',
      validFrom: daysBefore(10),
    });

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);

    expect(result.tooYoungToRetire).toBe(1);
    expect(result.retired).toBe(0);
    expect((await factById(fresh)).validUntil).toBeNull();
    expect(MIN_STALE_FACT_AGE_DAYS).toBeGreaterThan(10);
  });

  it('retires a routine only — a preference and a medical note of the same age survive', async () => {
    const [boundary] = STAGE_BOUNDARIES_MONTHS;
    const { familyId } = await seedFamily(db.database);
    const child = await seedChildAged(familyId, 'Sam', dobAged(boundary + 2));
    const routine = await seedFact(familyId, { childId: child, factKey: 'naps_after_lunch' });
    const preference = await seedFact(familyId, {
      childId: child,
      factType: 'preference',
      factKey: 'hates_swimming',
    });
    const medical = await seedFact(familyId, {
      childId: child,
      factType: 'medical',
      factKey: 'peanut_allergy',
    });

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);

    expect(result.retired).toBe(1);
    expect((await factById(routine)).validUntil).not.toBeNull();
    expect((await factById(preference)).validUntil).toBeNull();
    expect((await factById(medical)).validUntil).toBeNull();
  });

  it('lets go of what Hale read for itself, and never of what the parent said', async () => {
    const [boundary] = STAGE_BOUNDARIES_MONTHS;
    const { familyId } = await seedFamily(db.database);
    const child = await seedChildAged(familyId, 'Sam', dobAged(boundary + 2));
    // Three identical situations — same child, same type, same age, all well past
    // MIN_STALE_FACT_AGE_DAYS and all one band below the child's stage. The ONLY thing
    // separating them is who wrote them, and distinct keys keep Rule B out of it.
    const distilled = await seedFact(familyId, {
      childId: child,
      factKey: 'naps_after_lunch',
      inferredBy: 'chat_distiller',
      validFrom: daysBefore(90),
    });
    const stated = await seedFact(familyId, {
      childId: child,
      factKey: 'quiet_time_before_bed',
      inferredBy: 'ask-hale',
      validFrom: daysBefore(90),
    });
    const observed = await seedFact(familyId, {
      childId: child,
      factKey: 'walks_the_long_way_home',
      inferredBy: 'memory_inferencer',
      validFrom: daysBefore(90),
    });

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);

    // The positive control, in the same run: the rule DID fire, so the two survivals
    // below are the writer narrowing and not a rule that has stopped working.
    expect(result.retired).toBe(1);
    expect((await factById(distilled)).validUntil).toEqual(NOW);
    // A parent's own words. Outgrowing a stage is not Hale's licence to forget them.
    expect((await factById(stated)).validUntil).toBeNull();
    expect((await factById(observed)).validUntil).toBeNull();
    // Not "held back as too new" either — they were never Rule A's to hold.
    expect(result.tooYoungToRetire).toBe(0);
    // Still in scope for the election, which discards no belief.
    expect(result.candidates).toBe(3);
  });

  it('never reaches a household-wide routine, which no boundary can outgrow', async () => {
    const [boundary] = STAGE_BOUNDARIES_MONTHS;
    const { familyId } = await seedFamily(db.database);
    await seedChildAged(familyId, 'Sam', dobAged(boundary + 2));
    const houseWide = await seedFact(familyId, { childId: null, factKey: 'bin_night_is_tuesday' });

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);

    expect(result.retired).toBe(0);
    expect((await factById(houseWide)).validUntil).toBeNull();
  });
});

describe('rule B — the same belief filed twice', () => {
  it('elects one spelling and points the others at it, byte for byte unchanged', async () => {
    const { familyId } = await seedFamily(db.database);
    const winner = await seedFact(familyId, {
      factKey: 'bedtime_routine',
      confidence: 0.95,
      inferredBy: 'ask-hale',
    });
    const dash = await seedFact(familyId, { factKey: 'bedtime-routine', confidence: 0.9 });
    const spaced = await seedFact(familyId, {
      factKey: 'Bedtime Routine',
      confidence: 0.8,
      inferredBy: 'memory_inferencer',
    });

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);

    expect(result.mergedGroups).toBe(1);
    expect(result.mergedLosers).toBe(2);
    const survivor = await factById(winner);
    expect(survivor.validUntil).toBeNull();
    // The worker registry reads some facts by EXACT key and pins the writer; an
    // election that rewrote either would break those reads silently.
    expect(survivor.factKey).toBe('bedtime_routine');
    expect(survivor.inferredBy).toBe('ask-hale');
    expect(survivor.confidence).toBe(0.95);
    expect((await factById(dash)).supersededBy).toBe(winner);
    expect((await factById(spaced)).supersededBy).toBe(winner);
  });

  it('keeps a child’s belief separate from the household’s, however alike they read', async () => {
    const { familyId } = await seedFamily(db.database);
    const child = await seedChildAged(familyId, 'Sam', dobAged(30));
    const houseWide = await seedFact(familyId, { factKey: 'bedtime_routine', confidence: 0.95 });
    // Same type and the same normalized key — the ONLY thing separating these two is
    // the child scope, which is what this asserts.
    const childScoped = await seedFact(familyId, {
      childId: child,
      factKey: 'bedtime-routine',
      confidence: 0.8,
    });
    // The positive control: a real duplicate in the same run still merges, so the
    // separation above is a grouping rule and not an inert pass.
    const decoy = await seedFact(familyId, { factKey: 'Bedtime Routine', confidence: 0.7 });

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);

    expect(result.mergedGroups).toBe(1);
    expect(result.mergedLosers).toBe(1);
    expect((await factById(childScoped)).validUntil).toBeNull();
    expect((await factById(decoy)).supersededBy).toBe(houseWide);
  });

  it('skips a namespaced key, because an address is never a near-duplicate', async () => {
    const { familyId } = await seedFamily(db.database);
    const one = await seedFact(familyId, {
      factType: 'relationship',
      factKey: 'recipient:sitter@example.test',
      confidence: 0.95,
    });
    const two = await seedFact(familyId, {
      factType: 'relationship',
      factKey: 'recipient:sitter-example-test',
      confidence: 0.8,
    });
    const winner = await seedFact(familyId, { factKey: 'bedtime_routine', confidence: 0.95 });
    const loser = await seedFact(familyId, { factKey: 'bedtime-routine', confidence: 0.8 });

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);

    expect(result.namespacedSkipped).toBe(2);
    expect((await factById(one)).validUntil).toBeNull();
    expect((await factById(two)).validUntil).toBeNull();
    expect((await factById(loser)).supersededBy).toBe(winner);
  });
});

describe('the cap on one family in one night', () => {
  it('acts on ten and leaves the rest for tomorrow, then takes the next ten', async () => {
    const [boundary] = STAGE_BOUNDARIES_MONTHS;
    const { familyId } = await seedFamily(db.database);
    const child = await seedChildAged(familyId, 'Sam', dobAged(boundary + 2));
    const total = 25;
    for (let i = 0; i < total; i += 1) {
      await seedFact(familyId, { childId: child, factKey: `outgrown_${i}` });
    }

    const first = await runFamilySynthesis(db.database, familyId, NOW, true);
    expect(first.retired).toBe(MAX_SYNTHESIS_ACTIONS_PER_FAMILY);
    expect(first.deferredOverCap).toBe(total - MAX_SYNTHESIS_ACTIONS_PER_FAMILY);

    const second = await runFamilySynthesis(db.database, familyId, NOW, true);
    expect(second.retired).toBe(MAX_SYNTHESIS_ACTIONS_PER_FAMILY);
    expect(second.candidates).toBe(total - MAX_SYNTHESIS_ACTIONS_PER_FAMILY);
    expect(second.deferredOverCap).toBe(total - 2 * MAX_SYNTHESIS_ACTIONS_PER_FAMILY);
  });
});

describe('the audit row (rule #6)', () => {
  it('files one row per decision, pointed at the fact the parent would ask about', async () => {
    const [boundary] = STAGE_BOUNDARIES_MONTHS;
    const { familyId } = await seedFamily(db.database);
    const child = await seedChildAged(familyId, 'Sam', dobAged(boundary + 2));
    const stale = await seedFact(familyId, { childId: child, factKey: 'naps_after_lunch' });
    const winner = await seedFact(familyId, { factKey: 'bedtime_routine', confidence: 0.95 });
    await seedFact(familyId, { factKey: 'bedtime-routine', confidence: 0.8 });

    await runFamilySynthesis(db.database, familyId, NOW, true);

    const rows = await auditRows(familyId);
    expect(rows).toHaveLength(2);
    const retired = rows.find((row) => row.actionTaken === 'memory_fact_retired');
    const merged = rows.find((row) => row.actionTaken === 'memory_facts_merged');
    expect(retired?.actor).toBe('system');
    expect(retired?.targetTable).toBe('family_memory_facts');
    expect(retired?.targetId).toBe(stale);
    expect(merged?.targetId).toBe(winner);
  });

  it('says what it did without saying whose it was, or what it said', async () => {
    const [boundary] = STAGE_BOUNDARIES_MONTHS;
    const { familyId } = await seedFamily(db.database);
    const child = await seedChildAged(familyId, 'Sam', dobAged(boundary + 2));
    const stale = await seedFact(familyId, { childId: child, factKey: 'naps_after_lunch' });

    await runFamilySynthesis(db.database, familyId, NOW, true);

    const [row] = await auditRows(familyId);
    const payload = JSON.stringify(row?.after);
    // audit_log is immutable and PIPEDA-exportable, with none of the teen redaction
    // that guards a memory-fact read (rule #1).
    expect(payload).not.toContain(child);
    expect(payload).not.toContain('naps_after_lunch');
    // Paired positive control: an absence test is green against an empty payload.
    expect(row?.after).toEqual({
      factType: 'routine',
      reason: 'stage_crossed',
      factIds: [stale],
      applied: true,
    });
  });

  it('records the decision before it acts, and both inside one transaction', async () => {
    const [boundary] = STAGE_BOUNDARIES_MONTHS;
    const { familyId } = await seedFamily(db.database);
    const child = await seedChildAged(familyId, 'Sam', dobAged(boundary + 2));
    await seedFact(familyId, { childId: child, factKey: 'naps_after_lunch' });

    // The order is the property, and the only place it is observable is the statements
    // that ran on the TRANSACTION HANDLE: a crash between the two must leave neither,
    // and a fact that vanished with no audit line is the one shape PIPEDA
    // right-to-access cannot recover from.
    const opened: string[][] = [];
    const original = db.client.transaction.bind(db.client);
    db.client.transaction = (async (run: (tx: unknown) => unknown) => {
      const statements: string[] = [];
      opened.push(statements);
      return original(async (tx) => {
        const query = tx.query.bind(tx);
        tx.query = ((sql: string, ...rest: unknown[]) => {
          statements.push(sql);
          return (query as (...args: unknown[]) => unknown)(sql, ...rest);
        }) as typeof tx.query;
        return run(tx);
      });
    }) as typeof db.client.transaction;
    try {
      await runFamilySynthesis(db.database, familyId, NOW, true);
    } finally {
      db.client.transaction = original;
    }

    expect(opened).toHaveLength(1);
    const statements = opened[0] ?? [];
    const audit = statements.findIndex((sql) => /insert into "audit_log"/i.test(sql));
    const close = statements.findIndex((sql) => /update "family_memory_facts"/i.test(sql));
    expect(audit).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(audit);
  });
});

describe('the dark flag', () => {
  it('reads only the exact literal, so a piped env value fails closed', () => {
    vi.stubEnv(MEMORY_SYNTHESIS_APPLY_ENV, 'true');
    expect(memorySynthesisApplies()).toBe(true);
    vi.stubEnv(MEMORY_SYNTHESIS_APPLY_ENV, 'true\n');
    expect(memorySynthesisApplies()).toBe(false);
    vi.stubEnv(MEMORY_SYNTHESIS_APPLY_ENV, 'True');
    expect(memorySynthesisApplies()).toBe(false);
    vi.stubEnv(MEMORY_SYNTHESIS_APPLY_ENV, '');
    expect(memorySynthesisApplies()).toBe(false);
  });

  it('off is observe-only: every decision is on the record, nothing has moved', async () => {
    const [boundary] = STAGE_BOUNDARIES_MONTHS;
    const { familyId } = await seedFamily(db.database);
    const child = await seedChildAged(familyId, 'Sam', dobAged(boundary + 2));
    const stale = await seedFact(familyId, { childId: child, factKey: 'naps_after_lunch' });
    const winner = await seedFact(familyId, { factKey: 'bedtime_routine', confidence: 0.95 });
    const loser = await seedFact(familyId, { factKey: 'bedtime-routine', confidence: 0.8 });

    const result = await runFamilySynthesis(db.database, familyId, NOW, false);

    expect(result.applied).toBe(false);
    expect(result.retired).toBe(1);
    expect(result.mergedLosers).toBe(1);
    const rows = await auditRows(familyId);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => (row.after as { applied: boolean }).applied === false)).toBe(true);
    for (const id of [stale, winner, loser]) {
      expect((await factById(id)).validUntil).toBeNull();
    }
  });

  it('the cron reaches the pass with the flag unset: decided, recorded, nothing moved', async () => {
    // The PRODUCTION path. Every other case in this file calls `runFamilySynthesis`
    // with a literal boolean, so the only place the env is actually read —
    // `runMemorySynthesis` — and the cron binding that reaches it had no coverage at
    // all: replacing `const applied = memorySynthesisApplies()` with `const applied =
    // true` left the whole apps/web suite green, which is to say the dark flag was
    // untested in the one function that consults it.
    vi.stubEnv(MEMORY_SYNTHESIS_APPLY_ENV, undefined);
    // `defaultInferenceCronDeps` builds the AGENT leg's client eagerly and that
    // constructor throws on a missing key. Nothing calls it here: the synthesis leg
    // makes no model call, which is why it runs outside the provider pre-flight.
    vi.stubEnv('ANTHROPIC_API_KEY', 'unused-this-leg-calls-no-model');
    const [boundary] = STAGE_BOUNDARIES_MONTHS;
    const { familyId } = await seedFamily(db.database);
    const child = await seedChildAged(familyId, 'Sam', dobAged(boundary + 2));
    const stale = await seedFact(familyId, { childId: child, factKey: 'naps_after_lunch' });

    const { synthesize } = defaultInferenceCronDeps();
    const run = await synthesize(db.database, [familyId], NOW);

    expect(run.applied).toBe(false);
    expect(run.families).toBe(1);
    // It decided — the positive control. "Nothing moved" is green against a binding
    // that points at nothing and a pass that never ran.
    expect(run.results).toEqual([
      { familyId, result: expect.objectContaining({ applied: false, retired: 1 }) },
    ]);
    // It wrote down what it would have done.
    const rows = await auditRows(familyId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actionTaken).toBe('memory_fact_retired');
    expect(rows[0]?.after).toEqual({
      factType: 'routine',
      reason: 'stage_crossed',
      factIds: [stale],
      applied: false,
    });
    // And it moved nothing.
    expect((await factById(stale)).validUntil).toBeNull();
  });
});

describe('a teenager’s own rows', () => {
  it('retires what they have outgrown, counts it apart, and names no child', async () => {
    const { familyId } = await seedFamily(db.database);
    const teen = await seedChildAged(familyId, 'Noa', dobAged(TEENAGER_START_MONTHS + 2));
    // Two months past a boundary each, so the pass has a non-teen retirement to put
    // beside the teen one — teenScoped must be a slice of the night, not all of it.
    const preschooler = await seedChildAged(familyId, 'Mia', dobAged(50));
    const teenFact = await seedFact(familyId, { childId: teen, factKey: 'bath_before_dinner' });
    const preschoolFact = await seedFact(familyId, {
      childId: preschooler,
      factKey: 'naps_after_lunch',
      validFrom: daysBefore(90),
    });

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);

    expect(result.retired).toBe(2);
    expect(result.teenScoped).toBe(1);
    expect((await factById(teenFact)).validUntil).toEqual(NOW);
    expect((await factById(preschoolFact)).validUntil).toEqual(NOW);
    const payload = JSON.stringify(await auditRows(familyId));
    expect(payload).not.toContain(teen);
    expect(payload).toContain(teenFact);
  });
});

describe('a quiet family', () => {
  it('names every outcome of a night where nothing was wrong', async () => {
    const { familyId } = await seedFamily(db.database);
    await seedFact(familyId, { factKey: 'bin_night_is_tuesday' });

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);

    expect(result).toEqual({
      applied: true,
      candidates: 1,
      unattributed: 0,
      controlPlaneExcluded: 0,
      retired: 0,
      tooYoungToRetire: 0,
      mergedGroups: 0,
      mergedLosers: 0,
      teenScoped: 0,
      namespacedSkipped: 0,
      deferredOverCap: 0,
      alreadyClosed: 0,
    });
    expect(await auditRows(familyId)).toEqual([]);
  });
});
