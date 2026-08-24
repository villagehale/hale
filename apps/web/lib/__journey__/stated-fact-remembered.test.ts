import { schema } from '@hale/db';
import { ageInMonths } from '@hale/types';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadReconcileView } from '~/lib/channel/reconcile/view';
import { extractStateClaims } from '~/lib/channel/reconcile/claims';
import { reconcile } from '~/lib/channel/reconcile/reconcile';
import { recordStatedState } from '~/lib/channel/stated-state';
import { loadAgentContext } from '~/lib/coach/context';
import { HEALTH_CHECKPOINTS, checkpointById, checkpointRef } from '~/lib/health/checkpoints';
import { type HealthChild, matchHealthCheckpoints } from '~/lib/health/match';
import { defaultHealthReplyDeps, loadSuppressedCheckpointRefs } from '~/lib/health/reply';
import { checkpointToldKey } from '~/lib/health/told';
import { writeFact } from '~/lib/memory/facts';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';

/**
 * "YES WE BOOKED ALREADY" — the 2026-08-13 → 08-20 chain, replayed over real Postgres.
 *
 * WHAT HAPPENED, from the founder's own thread and channel ledger:
 *
 *   08-13 10:00:25  Hale texts the 18-month immunization checkpoint. The told-marker
 *                   lands on the outbound row, so the sweep knows it SAID it.
 *   08-13 10:01:09  "Yes we booked already". No closed vocabulary contains that
 *                   sentence, so the health handler declined and the turn fell to the
 *                   coach.
 *   08-13 10:01:14  "Glad it's locked in!" — an acknowledgement with no row behind it.
 *   08-20 10:17:52  the sweep raises `well_baby_18_months`: the OTHER Ontario row about
 *                   the SAME appointment, seven days after the parent said it was booked.
 *   08-20 10:20:06  "That one hasn't cleared my own checks" — a third state for one visit
 *                   inside forty-one minutes, because nothing was ever written down.
 *
 * WHAT THIS PINS, over the REAL production bindings and the REAL migrated schema:
 *
 *   THE WRITE. `recordStatedState` on `defaultHealthReplyDeps()` — the same binding
 *   wiring.ts hands the router — reads the sentence, resolves WHICH errand it answers
 *   from the family's own told-marker, and files it through the one audited transaction
 *   that files a checkpoint as handled. Nothing about the subject comes from the message.
 *
 *   THE SWEEP. `loadSuppressedCheckpointRefs` (the reader BOTH the nudge and the intake
 *   radar use) covers both 18-month rows, so `matchHealthCheckpoints` has nothing left to
 *   raise. The mutation at the bottom deletes the write and the sweep speaks again.
 *
 *   THE ACKNOWLEDGEMENT. VIL-293's gate refuses a booking claim nothing backs, and Hale
 *   holds no calendar row for a visit the parent booked themselves. Before the write, the
 *   honest gate DELETED the true sentence. After it, the same sentence is matched by the
 *   parent's own statement.
 *
 *   THE NEXT TURN. The fact is in the coach's context, so a week later Hale can answer
 *   from the row instead of from a transcript that has scrolled away.
 *
 * WHAT IS NOT DRIVEN HERE: `routeChannelMessage`'s call site. Its ordering — the write
 * lands before the coach composes and before flood control — is pinned in
 * lib/channel/router/route.test.ts, over the router's own harness.
 */

const TZ = 'America/Toronto';
/** Halton Hills. Ontario rows only; no Toronto programs, no municipal windows. */
const AREA = 'L7G';

/** 08-13 10:00:25 Toronto — the nudge lands. */
const TOLD_AT = new Date('2026-08-13T14:00:25.890Z');
/** 08-13 10:01:09 — 44 seconds later, the parent answers. */
const REPLY_AT = new Date('2026-08-13T14:01:09.906Z');
/** 08-20 10:17:52 — the sweep that repeated itself. */
const SWEEP_AT = new Date('2026-08-20T14:17:52.228Z');

/** Eighteen months old on 08-13 and still eighteen on 08-20: both Ontario 18-month rows
 * are in band on both days, which is what makes the repeat possible at all. */
const NOAH_DOB = '2025-02-01';
/** A second child, fifteen years old — the teen half of the same question (rule #1). */
const TEEN_DOB = '2011-02-01';

const THE_SENTENCE = 'Yes we booked already';

interface World {
  db: TestDb;
  familyId: string;
  parentUserId: string;
  noahId: string;
  teenId: string;
}

/**
 * ONE Postgres for the whole file, three households inside it. Booting PGlite applies
 * every committed migration, which is seconds each time — and the isolation that matters
 * is per-FAMILY, which every query here already scopes to.
 */
let postgres: TestDb;

function refFor(checkpointId: string, childId: string): string {
  const checkpoint = checkpointById(checkpointId);
  if (!checkpoint) throw new Error(`fixture drift: no checkpoint '${checkpointId}'`);
  return checkpointRef(checkpoint, childId, 0);
}

let seededFamilies = 0;

async function seed(): Promise<World> {
  const db = postgres;
  seededFamilies += 1;
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `founder+${seededFamilies}@example.com`, name: 'Sam', timezone: TZ } as never)
    .returning({ id: schema.users.id });
  const [family] = await db.database
    .insert(schema.families)
    .values({
      displayName: 'The Founder Family',
      areaCoarse: AREA,
      city: 'Halton Hills',
      province: 'ON',
      onboardingStage: 'sms_active',
    } as never)
    .returning({ id: schema.families.id });
  if (!user || !family) throw new Error('seed: insert returned no row');

  const children = await db.database
    .insert(schema.children)
    .values([
      { familyId: family.id, name: 'Noah', dateOfBirth: NOAH_DOB, dobPrecision: 'exact' },
      { familyId: family.id, name: 'Iris', dateOfBirth: TEEN_DOB, dobPrecision: 'exact' },
    ] as never)
    .returning({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth });
  const noah = children.find((c) => c.dateOfBirth === NOAH_DOB);
  const teen = children.find((c) => c.dateOfBirth === TEEN_DOB);
  if (!noah || !teen) throw new Error('seed: children insert returned no row');

  return {
    db,
    familyId: family.id,
    parentUserId: user.id,
    noahId: noah.id,
    teenId: teen.id,
  };
}

/** The outbound row the 08-13 nudge wrote, told-marker and all. */
async function tellCheckpoint(world: World, checkpointId: string, childId: string, at: Date) {
  await world.db.database.insert(schema.channelMessages).values({
    familyId: world.familyId,
    parentUserId: world.parentUserId,
    channel: 'sms',
    direction: 'out',
    category: 'nudge',
    status: 'delivered',
    dedupeKey: checkpointToldKey(world.familyId, refFor(checkpointId, childId)),
    createdAt: at,
  } as never);
}

/** The children as the sweep builds them (nudge/run.ts): every child, teens included,
 * because a legal obligation does not stop at thirteen. */
function healthChildren(world: World, now: Date): HealthChild[] {
  return [
    {
      id: world.noahId,
      name: 'Noah',
      ageMonths: ageInMonths(NOAH_DOB, now),
      dobPrecision: 'exact',
      isTeen: false,
    },
    {
      id: world.teenId,
      name: null,
      ageMonths: ageInMonths(TEEN_DOB, now),
      dobPrecision: 'exact',
      isTeen: true,
    },
  ];
}

/** What the 08-20 sweep would raise, through the real reader and the real matcher. */
async function whatTheSweepWouldRaise(world: World, now: Date): Promise<string[]> {
  const suppressedRefs = await loadSuppressedCheckpointRefs(world.db.database, world.familyId);
  return matchHealthCheckpoints({
    children: healthChildren(world, now),
    areaCoarse: AREA,
    suppressedRefs,
    now,
  }).map((match) => match.checkpoint.id);
}

let world: World;
/** Every checkpoint the sweep would have raised on 08-20 had nothing been written. */
let beforeTheWrite: string[];
let afterTheWrite: string[];

beforeAll(async () => {
  postgres = await createTestDb();
  world = await seed();
  await tellCheckpoint(world, 'immunization_18_months', world.noahId, TOLD_AT);
  beforeTheWrite = await whatTheSweepWouldRaise(world, SWEEP_AT);

  await recordStatedState(
    world.db.database,
    {
      familyId: world.familyId,
      parentUserId: world.parentUserId,
      body: THE_SENTENCE,
      now: REPLY_AT,
    },
    defaultHealthReplyDeps(),
  );
  afterTheWrite = await whatTheSweepWouldRaise(world, SWEEP_AT);
}, 60_000);

afterAll(async () => {
  await postgres?.close();
});

describe('the turn that hears it writes it', () => {
  it('files the checkpoint Hale actually raised, from a sentence no vocabulary contains', async () => {
    const rows = await world.db.database
      .select()
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, world.familyId),
          isNull(schema.familyMemoryFacts.validUntil),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      childId: world.noahId,
      factType: 'logistic',
      factKey: `health_checkpoint:${refFor('immunization_18_months', world.noahId)}`,
      // The trust boundary the sweep reads on. A second door to the write, never a
      // second writer — the row still names the module that owns the transaction.
      inferredBy: 'health-nudge-reply',
      confidence: 1,
    });
    expect(rows[0]?.factValue).toEqual({
      checkpointId: 'immunization_18_months',
      status: 'done',
    });
  });

  it('leaves the audit row rule #6 requires, naming the checkpoint and never the child', async () => {
    const audits = await world.db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, world.familyId));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actionTaken: 'health_checkpoint_marked_done',
      targetTable: 'family_memory_facts',
      after: { checkpointId: 'immunization_18_months' },
    });
    expect(JSON.stringify(audits[0]?.after)).not.toContain(world.noahId);
  });

  it('writes nothing at all from an ordinary message', async () => {
    const outcome = await recordStatedState(
      world.db.database,
      {
        familyId: world.familyId,
        parentUserId: world.parentUserId,
        body: 'can you move Noah’s well-baby visit to next Thursday at half past four?',
        now: REPLY_AT,
      },
      defaultHealthReplyDeps(),
    );
    expect(outcome).toEqual({ status: 'nothing_stated' });
  });
});

describe('the sweep that repeated itself', () => {
  it('WOULD have raised the well-baby visit on 08-20 — the defect, reproduced', () => {
    expect(beforeTheWrite).toContain('well_baby_18_months');
  });

  it('raises nothing about that appointment once the parent has said it is booked', () => {
    expect(afterTheWrite).not.toContain('well_baby_18_months');
    expect(afterTheWrite).not.toContain('immunization_18_months');
  });

  it('is the WIDENING that does it: the row Hale raised was the other one', async () => {
    // The suppression row is keyed on `immunization_18_months`, which is the errand Hale
    // actually named. `well_baby_18_months` is silenced because the two rows describe one
    // appointment (checkpoints.ts `visit`), not because anything was written twice.
    const suppressed = await loadSuppressedCheckpointRefs(world.db.database, world.familyId);
    expect(suppressed).toContain(refFor('immunization_18_months', world.noahId));
    expect(suppressed).toContain(refFor('well_baby_18_months', world.noahId));
    const live = await world.db.database
      .select({ factKey: schema.familyMemoryFacts.factKey })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, world.familyId),
          isNull(schema.familyMemoryFacts.validUntil),
        ),
      );
    expect(live).toHaveLength(1);
  });

  it('still raises a checkpoint about a DIFFERENT appointment', () => {
    // The guard against a suppression that silences everything: the teen's own row is
    // untouched by a statement about Noah's visit.
    expect(afterTheWrite).toContain('immunization_14_to_16_years');
  });
});

describe('the acknowledgement Hale could not back', () => {
  const ACK = 'Your 18-month visit is booked.';

  it('MATCHES the parent’s own statement, with nothing on the calendar', async () => {
    const view = await loadReconcileView(world.db.database, {
      familyId: world.familyId,
      now: SWEEP_AT,
    });
    expect(view.scheduledTitles).toEqual([]);
    const verdict = reconcile(extractStateClaims(ACK), view);
    expect(verdict.refused).toEqual([]);
    expect(verdict.resolutions[0]).toMatchObject({
      status: 'matched',
      matchedBy: 'parent_stated',
    });
  });

  it('still refuses a booking claim about something nobody stated', async () => {
    const view = await loadReconcileView(world.db.database, {
      familyId: world.familyId,
      now: SWEEP_AT,
    });
    const verdict = reconcile(extractStateClaims('Your swim lesson is booked.'), view);
    expect(verdict.refused.map((r) => r.reason)).toEqual(['no_scheduled_row']);
  });
});

describe('the turn a week later', () => {
  it('reads the fact out of the coach’s own context, not out of the transcript', async () => {
    const context = await loadAgentContext(
      {
        familyId: world.familyId,
        question: 'what have we got on this week?',
        intent: null,
        focusedChildId: null,
        transcript: [],
        sourceNote: null,
      },
      world.db.database,
      SWEEP_AT,
    );
    expect(context.memoryFacts).toContainEqual(
      expect.objectContaining({
        factKey: `health_checkpoint:${refFor('immunization_18_months', world.noahId)}`,
        factValue: { checkpointId: 'immunization_18_months', status: 'done' },
      }),
    );
  });
});

/**
 * RULE #1. The suppression is age-blind on purpose — a fifteen-year-old's vaccine record
 * is still the parent's legal obligation, and a reminder they have already answered is
 * still noise. What must NOT happen is Hale telling a parent anything about that child's
 * appointment: the fact is written, the reminder stops, and the content stays withheld.
 */
describe('a 13+ child’s appointment', () => {
  let teenWorld: World;

  beforeAll(async () => {
    teenWorld = await seed();
    await tellCheckpoint(
      teenWorld,
      'immunization_14_to_16_years',
      teenWorld.teenId,
      new Date('2026-08-13T14:00:25.890Z'),
    );
    await recordStatedState(
      teenWorld.db.database,
      {
        familyId: teenWorld.familyId,
        parentUserId: teenWorld.parentUserId,
        body: THE_SENTENCE,
        now: REPLY_AT,
      },
      defaultHealthReplyDeps(),
    );
  }, 60_000);

  it('stops the reminder, because the errand is answered whatever the age', async () => {
    // Asserted on the ROW rather than on the sweep's silence: the told-marker alone
    // already quiets this checkpoint, so "the sweep said nothing" would pass with no
    // write at all. The durable suppression is the fact, scoped to the teen.
    const rows = await teenWorld.db.database
      .select()
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, teenWorld.familyId),
          isNull(schema.familyMemoryFacts.validUntil),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      childId: teenWorld.teenId,
      factKey: `health_checkpoint:${refFor('immunization_14_to_16_years', teenWorld.teenId)}`,
      inferredBy: 'health-nudge-reply',
    });
    expect(await whatTheSweepWouldRaise(teenWorld, SWEEP_AT)).not.toContain(
      'immunization_14_to_16_years',
    );
  });

  it('never lets Hale assert the teen’s visit is booked (fail-closed, not redacted)', async () => {
    const view = await loadReconcileView(teenWorld.db.database, {
      familyId: teenWorld.familyId,
      now: SWEEP_AT,
    });
    expect(view.statedBookings).toEqual([]);
    const verdict = reconcile(extractStateClaims('Your routine vaccine visit is booked.'), view);
    expect(verdict.refused.map((r) => r.reason)).toEqual(['no_scheduled_row']);
  });

  it('withholds the fact’s key and value from the coach entirely', async () => {
    const context = await loadAgentContext(
      {
        familyId: teenWorld.familyId,
        question: 'anything outstanding?',
        intent: null,
        focusedChildId: null,
        transcript: [],
        sourceNote: null,
      },
      teenWorld.db.database,
      SWEEP_AT,
    );
    const serialized = JSON.stringify(context.memoryFacts);
    expect(serialized).not.toContain('immunization_14_to_16_years');
    expect(serialized).not.toContain(teenWorld.teenId);
    expect(serialized).toContain('teen content');
  });
});

/**
 * CORRECTIONS OVERRIDE. `family_memory_facts` is bi-temporal with a partial unique index
 * permitting ONE live row per (family, child, type, key) — so a parent restating a fact
 * cannot leave Hale holding two contradictory truths. This drives the general recall
 * space, where a parent's stated preference is what the coach reads back next turn.
 */
describe('a parent correcting a fact Hale already holds', () => {
  let corrected: World;

  beforeAll(async () => {
    corrected = await seed();
    await writeFact(corrected.db.database, {
      familyId: corrected.familyId,
      childId: null,
      factType: 'routine',
      factKey: 'bedtime',
      factValue: '7:30pm, bath then two books',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: TOLD_AT,
    });
    await writeFact(corrected.db.database, {
      familyId: corrected.familyId,
      childId: null,
      factType: 'routine',
      factKey: 'bedtime',
      factValue: '8pm now that he naps later',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: SWEEP_AT,
    });
  }, 60_000);

  it('leaves exactly one live row, with the old one closed and back-pointed', async () => {
    const rows = await corrected.db.database
      .select()
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, corrected.familyId));
    expect(rows).toHaveLength(2);

    const live = rows.filter((row) => row.validUntil === null);
    const closed = rows.filter((row) => row.validUntil !== null);
    expect(live).toHaveLength(1);
    expect(live[0]?.factValue).toBe('8pm now that he naps later');
    expect(closed[0]?.validUntil?.toISOString()).toBe(SWEEP_AT.toISOString());
    expect(closed[0]?.supersededBy).toBe(live[0]?.id);
  });

  it('answers the next turn from the correction, never from the stale value', async () => {
    const context = await loadAgentContext(
      {
        familyId: corrected.familyId,
        question: 'what time does he go down?',
        intent: null,
        focusedChildId: null,
        transcript: [],
        sourceNote: null,
      },
      corrected.db.database,
      SWEEP_AT,
    );
    const bedtimes = context.memoryFacts.filter((fact) => fact.factKey === 'bedtime');
    expect(bedtimes).toHaveLength(1);
    expect(bedtimes[0]?.factValue).toBe('8pm now that he naps later');
  });
});

/** The table this journey rests on: two Ontario rows, one appointment. */
describe('the fixture is the shipped table', () => {
  it('still ships both 18-month rows under one visit', () => {
    const rows = HEALTH_CHECKPOINTS.filter((c) => c.visit === 'well_child_18_months');
    expect(rows.map((c) => c.id).sort()).toEqual(['immunization_18_months', 'well_baby_18_months']);
  });
});
