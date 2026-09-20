import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import { resolveReviewSubject } from './subject';

/**
 * WHICH VENUE A PLACEMENT WAS — and, far more often, why it is nothing this product may
 * pool an opinion on.
 *
 * Every refusal below is a named outcome rather than a null, because the counters by
 * reason are the only number that will say whether v1 captures anything at all: thin
 * `place_id` coverage and a civic column that is null on every pre-0122 row are two
 * structurally different problems with two different fixes.
 */

/** A real uuid: `village_candidates.civic_venue_id` is a uuid column, and the registry
 * ids the projection stamps on it are `civic_venues.id`. */
const CIVIC_VENUE_ID = '9f1c2b6a-7d31-4c2e-9a54-0a2b3c4d5e6f';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table families cascade');
});

async function seedFamily(name = 'Ana + kids'): Promise<string> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  return family?.id as string;
}

async function seedCandidate(
  familyId: string,
  values: { placeId?: string | null; civicVenueId?: string | null; supersededAt?: Date },
): Promise<string> {
  const [candidate] = await db.database
    .insert(schema.villageCandidates)
    .values({
      familyId,
      title: 'Saturday storytime',
      kind: 'class',
      summary: 'a warm local option',
      source: 'web_grounded',
      confidence: 0.9,
      placeId: values.placeId ?? null,
      civicVenueId: values.civicVenueId ?? null,
      supersededAt: values.supersededAt ?? null,
    })
    .returning({ id: schema.villageCandidates.id });
  return candidate?.id as string;
}

/** A placement and the action that placed it, in whichever provenance shape is asked
 * for: the typed `sourceRef` on the action (the Sunday loop and the texted add), the
 * legacy `candidate_id` on the event (the web dashboard), or neither. */
async function seedPlacement(
  familyId: string,
  provenance:
    | { shape: 'source_ref'; table: string; id: string }
    | { shape: 'legacy_candidate_id'; id: string }
    | { shape: 'none' }
    | { shape: 'unplaced' },
  options: { actionFamilyId?: string } = {},
): Promise<string> {
  const [event] = await db.database
    .insert(schema.events)
    .values({
      familyId: options.actionFamilyId ?? familyId,
      source: 'village',
      eventType: 'activity_signup_open',
      dedupHash: `subject-${Math.random()}`,
      payload:
        provenance.shape === 'legacy_candidate_id' ? { candidate_id: provenance.id } : {},
    })
    .returning({ id: schema.events.id });

  let actionId: string | null = null;
  if (provenance.shape !== 'unplaced') {
    const [action] = await db.database
      .insert(schema.actions)
      .values({
        eventId: event?.id as string,
        familyId: options.actionFamilyId ?? familyId,
        actionType: 'calendar_add',
        userVisibleState: 'autonomous',
        payload: {
          title: 'Saturday storytime',
          startsAt: '2026-09-12T14:00:00.000Z',
          ...(provenance.shape === 'source_ref'
            ? { sourceRef: { table: provenance.table, id: provenance.id } }
            : {}),
        },
      })
      .returning({ id: schema.actions.id });
    actionId = action?.id as string;
  }

  const [placement] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      title: 'Saturday storytime',
      startsAt: new Date('2026-09-12T14:00:00.000Z'),
      source: 'placement',
      placedByActionId: actionId,
    })
    .returning({ id: schema.familyEvents.id });
  return placement?.id as string;
}

describe('resolveReviewSubject', () => {
  it("reads the Sunday loop's and the texted add's typed sourceRef", async () => {
    const familyId = await seedFamily();
    const candidateId = await seedCandidate(familyId, { placeId: 'places/abc' });
    const familyEventId = await seedPlacement(familyId, {
      shape: 'source_ref',
      table: 'village_candidates',
      id: candidateId,
    });

    expect(await resolveReviewSubject(db.database, { familyId, familyEventId })).toEqual({
      source: 'place',
      ref: 'places/abc',
    });
  });

  it("reads the web dashboard's legacy candidate_id off the event", async () => {
    const familyId = await seedFamily();
    const candidateId = await seedCandidate(familyId, { placeId: 'places/abc' });
    const familyEventId = await seedPlacement(familyId, {
      shape: 'legacy_candidate_id',
      id: candidateId,
    });

    expect(await resolveReviewSubject(db.database, { familyId, familyEventId })).toEqual({
      source: 'place',
      ref: 'places/abc',
    });
  });

  it('resolves a civic candidate to its registry venue', async () => {
    const familyId = await seedFamily();
    const candidateId = await seedCandidate(familyId, {
      placeId: null,
      civicVenueId: CIVIC_VENUE_ID,
    });
    const familyEventId = await seedPlacement(familyId, {
      shape: 'source_ref',
      table: 'village_candidates',
      id: candidateId,
    });

    expect(await resolveReviewSubject(db.database, { familyId, familyEventId })).toEqual({
      source: 'civic_venue',
      ref: CIVIC_VENUE_ID,
    });
  });

  it('refuses a sourceRef pointing at a table that is not a candidate', async () => {
    const familyId = await seedFamily();
    const candidateId = await seedCandidate(familyId, { placeId: 'places/abc' });
    // The week-plan composer writes `children` and `family_events` refs too, and reading
    // one of those as a venue would pool an opinion about a child.
    const foreign = await seedPlacement(familyId, {
      shape: 'source_ref',
      table: 'children',
      id: candidateId,
    });
    expect(await resolveReviewSubject(db.database, { familyId, familyEventId: foreign })).toEqual(
      { unresolved: 'foreign_source_table' },
    );

    // The positive control: the same id, named as what it actually is, resolves.
    const ours = await seedPlacement(familyId, {
      shape: 'source_ref',
      table: 'village_candidates',
      id: candidateId,
    });
    expect(await resolveReviewSubject(db.database, { familyId, familyEventId: ours })).toEqual({
      source: 'place',
      ref: 'places/abc',
    });
  });

  it('refuses a candidate with neither a place id nor a venue id', async () => {
    const familyId = await seedFamily();
    const bare = await seedCandidate(familyId, { placeId: null, civicVenueId: null });
    const bareEvent = await seedPlacement(familyId, {
      shape: 'source_ref',
      table: 'village_candidates',
      id: bare,
    });
    expect(
      await resolveReviewSubject(db.database, { familyId, familyEventId: bareEvent }),
    ).toEqual({ unresolved: 'no_shared_identity' });

    // The positive control: the same row with a place id resolves.
    await db.database
      .update(schema.villageCandidates)
      .set({ placeId: 'places/abc' })
      .where(eq(schema.villageCandidates.id, bare));
    expect(
      await resolveReviewSubject(db.database, { familyId, familyEventId: bareEvent }),
    ).toEqual({ source: 'place', ref: 'places/abc' });
  });

  it('refuses a placement nothing placed', async () => {
    const familyId = await seedFamily();
    const familyEventId = await seedPlacement(familyId, { shape: 'unplaced' });

    expect(await resolveReviewSubject(db.database, { familyId, familyEventId })).toEqual({
      unresolved: 'no_placing_action',
    });
  });

  it('refuses an action carrying no provenance at all', async () => {
    const familyId = await seedFamily();
    const familyEventId = await seedPlacement(familyId, { shape: 'none' });

    expect(await resolveReviewSubject(db.database, { familyId, familyEventId })).toEqual({
      unresolved: 'no_provenance_in_payload',
    });
  });

  /**
   * STILL RESOLVES, and the mutation is adding `superseded_at IS NULL` to the resolver.
   * The ask fires one to four days after the activity; by then the next discovery run has
   * routinely retired the row the parent was actually offered.
   */
  it('still resolves a candidate the next discovery run superseded', async () => {
    const familyId = await seedFamily();
    const candidateId = await seedCandidate(familyId, {
      placeId: 'places/abc',
      supersededAt: new Date('2026-09-14T00:00:00.000Z'),
    });
    const familyEventId = await seedPlacement(familyId, {
      shape: 'source_ref',
      table: 'village_candidates',
      id: candidateId,
    });

    expect(await resolveReviewSubject(db.database, { familyId, familyEventId })).toEqual({
      source: 'place',
      ref: 'places/abc',
    });
  });

  /** Family scoping at every hop. `placed_by_action_id` is FK-less by design, so nothing
   * in the schema stops it naming another household's action — this join is the refusal. */
  it("refuses another family's action, and another family's candidate", async () => {
    const familyId = await seedFamily();
    const otherFamilyId = await seedFamily('Other household');
    const theirCandidate = await seedCandidate(otherFamilyId, { placeId: 'places/theirs' });

    const crossAction = await seedPlacement(
      familyId,
      { shape: 'source_ref', table: 'village_candidates', id: theirCandidate },
      { actionFamilyId: otherFamilyId },
    );
    expect(
      await resolveReviewSubject(db.database, { familyId, familyEventId: crossAction }),
    ).toEqual({ unresolved: 'no_placing_action' });

    // Our own action, naming their candidate: refused one hop later.
    const crossCandidate = await seedPlacement(familyId, {
      shape: 'source_ref',
      table: 'village_candidates',
      id: theirCandidate,
    });
    expect(
      await resolveReviewSubject(db.database, { familyId, familyEventId: crossCandidate }),
    ).toEqual({ unresolved: 'candidate_gone' });
  });

  /** A placement read from the wrong household's point of view is nothing at all. */
  it("refuses another family's placement", async () => {
    const familyId = await seedFamily();
    const otherFamilyId = await seedFamily('Other household');
    const candidateId = await seedCandidate(familyId, { placeId: 'places/abc' });
    const familyEventId = await seedPlacement(familyId, {
      shape: 'source_ref',
      table: 'village_candidates',
      id: candidateId,
    });

    expect(
      await resolveReviewSubject(db.database, { familyId: otherFamilyId, familyEventId }),
    ).toEqual({ unresolved: 'no_placing_action' });
  });
});
