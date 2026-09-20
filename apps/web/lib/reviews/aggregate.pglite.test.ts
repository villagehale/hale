import { type ActivityReviewTag, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import {
  MIN_FAMILIES_FOR_AGGREGATE,
  nearbyClauseTarget,
  readSubjectVerdicts,
  renderVerdictClause,
  subjectKey,
} from './aggregate';

/**
 * THE K GATE, AND WHAT IT IS MADE OF.
 *
 * `count(*)` is the threshold, and it is only `count(distinct family_id)` because of the
 * unique index on (family, subject_source, subject_ref). The last case in the first block
 * drops that index and proves the number moves — without it every assertion here would be
 * a statement about a query rather than about how many households actually spoke.
 *
 * Erasure needs no recompute anywhere in this file, and that is the design rather than an
 * omission: nothing is materialised, so `DELETE FROM families` cascades and the next read
 * is already the new answer.
 */

const AREA = 'M4K';
const SUBJECT = { source: 'place', ref: 'places/riverdale-library' } as const;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  parentOf.clear();
  await db.exec('truncate table families, users cascade');
});

async function seedFamily(name: string): Promise<string> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON', areaCoarse: AREA })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${name}-${familyId}`, name })
    .returning({ id: schema.users.id });
  parentOf.set(familyId, user?.id as string);
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user?.id as string, role: 'primary_parent' });
  return familyId;
}

/** The parent whose inbound row each family's review hangs off. */
const parentOf = new Map<string, string>();

/** A message row to hang the review's provenance on — the FK is the erasure path both
 * ways, so a review cannot exist without the words that produced it. */
async function seedReview(
  familyId: string,
  verdict: 'worth_it' | 'not_worth_it' | 'did_not_attend',
  options: { tags?: ActivityReviewTag[]; areaKey?: string; ref?: string } = {},
): Promise<void> {
  const [message] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId: parentOf.get(familyId) as string,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'a reply',
    })
    .returning({ id: schema.channelMessages.id });
  await db.database.insert(schema.activityReviews).values({
    familyId,
    sourceMessageId: message?.id as string,
    subjectSource: 'place',
    subjectRef: options.ref ?? SUBJECT.ref,
    areaKey: options.areaKey ?? AREA,
    childAgeBand: 'toddler',
    verdict,
    tags: options.tags ?? [],
  });
}

/** The same upsert the capture pass writes with: a second answer from one household is
 * a correction, never a second voice. */
async function upsertReview(
  familyId: string,
  verdict: 'worth_it' | 'not_worth_it' | 'did_not_attend',
): Promise<void> {
  const [message] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId: parentOf.get(familyId) as string,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: 'a reply',
    })
    .returning({ id: schema.channelMessages.id });
  await db.database
    .insert(schema.activityReviews)
    .values({
      familyId,
      sourceMessageId: message?.id as string,
      subjectSource: 'place',
      subjectRef: SUBJECT.ref,
      areaKey: AREA,
      childAgeBand: 'toddler',
      verdict,
      tags: [],
    })
    .onConflictDoUpdate({
      target: [
        schema.activityReviews.familyId,
        schema.activityReviews.subjectSource,
        schema.activityReviews.subjectRef,
      ],
      set: { verdict },
    });
}

async function rowCount(): Promise<number> {
  return (await db.database.select().from(schema.activityReviews)).length;
}

async function verdictsFor(ref: string = SUBJECT.ref) {
  const map = await readSubjectVerdicts(db.database, [{ source: 'place', ref }], AREA);
  return map.get(subjectKey({ source: 'place', ref }));
}

describe('the k boundary', () => {
  it('says nothing at two families, and the clause is absent', async () => {
    await seedReview(await seedFamily('one'), 'worth_it');
    await seedReview(await seedFamily('two'), 'worth_it');

    expect(await verdictsFor()).toBeUndefined();
    expect(renderVerdictClause('the Riverdale storytime', await verdictsFor())).toBeNull();
  });

  it('speaks at three, and says only the positive count', async () => {
    await seedReview(await seedFamily('one'), 'worth_it');
    await seedReview(await seedFamily('two'), 'worth_it');
    await seedReview(await seedFamily('three'), 'worth_it');

    const verdicts = await verdictsFor();
    expect(verdicts).toEqual({
      families: 3,
      worthIt: 3,
      majorityNegative: false,
      topTags: [],
    });
    expect(renderVerdictClause('the Riverdale storytime', verdicts)).toBe(
      '3 families near you say the Riverdale storytime is worth it.',
    );
  });

  /** Erasure, with NO recompute call anywhere: one DELETE and the next read is the
   * answer. That is the whole reason nothing is materialised. */
  it('drops back below the floor when a family is erased', async () => {
    const erased = await seedFamily('one');
    await seedReview(erased, 'worth_it');
    await seedReview(await seedFamily('two'), 'worth_it');
    await seedReview(await seedFamily('three'), 'worth_it');
    expect(await verdictsFor()).toBeDefined();

    await db.database.delete(schema.families).where(eq(schema.families.id, erased));

    expect(await verdictsFor()).toBeUndefined();
  });

  it('does not count a family that did not go', async () => {
    await seedReview(await seedFamily('one'), 'worth_it');
    await seedReview(await seedFamily('two'), 'worth_it');
    await seedReview(await seedFamily('three'), 'did_not_attend');

    // Three rows, two opinions. A family that did not go has none, and counting them
    // would push the threshold with silence.
    expect(await verdictsFor()).toBeUndefined();
  });

  /**
   * THE INVARIANT, AND WHY IT IS AN INDEX RATHER THAN A QUERY CLAUSE.
   *
   * `count(*)` is only `count(distinct family_id)` because one household cannot hold two
   * rows for one subject. This asserts BOTH directions on the same data: with the index,
   * a household that answers three times is still one voice; with it dropped, the same
   * three answers read as three families and the aggregate speaks. The second half is
   * the mutation — it is what makes the first half a statement about households rather
   * than about a query.
   */
  it('counts households, not answers — and the unique index is what makes that true', async () => {
    const only = await seedFamily('one');
    await upsertReview(only, 'worth_it');
    await upsertReview(only, 'worth_it');
    await upsertReview(only, 'worth_it');

    expect(await rowCount()).toBe(1);
    expect(await verdictsFor()).toBeUndefined();

    // The mutation, run here rather than described in a comment. Note the first thing it
    // proves: with the index gone, the capture pass's own upsert cannot even be
    // expressed — postgres refuses an ON CONFLICT with no constraint behind it — so the
    // plain inserts below are what "one household, three rows" would actually look like.
    await db.exec('drop index "activity_reviews_family_subject_uniq"');
    try {
      await expect(upsertReview(only, 'worth_it')).rejects.toThrow(/ON CONFLICT/i);
      // A second and third row for ONE household, which only the missing index allows.
      await seedReview(only, 'worth_it');
      await seedReview(only, 'worth_it');
      expect(await rowCount()).toBe(3);
      expect(await verdictsFor()).toEqual({
        families: 3,
        worthIt: 3,
        majorityNegative: false,
        topTags: [],
      });
    } finally {
      await db.exec('delete from activity_reviews');
      await db.exec(
        'create unique index "activity_reviews_family_subject_uniq" on "activity_reviews" ("family_id","subject_source","subject_ref")',
      );
    }
  });
});

describe('what is spoken and what is only ranked', () => {
  it('renders nothing for a majority-negative subject, and names no negative word', async () => {
    await seedReview(await seedFamily('one'), 'not_worth_it');
    await seedReview(await seedFamily('two'), 'not_worth_it');
    await seedReview(await seedFamily('three'), 'worth_it');

    const verdicts = await verdictsFor();
    expect(verdicts?.majorityNegative).toBe(true);
    const clause = renderVerdictClause('the Riverdale storytime', verdicts);
    expect(clause).toBeNull();

    // The positive control, because an absence test alone fails open: the same shape
    // with the majority the other way DOES render.
    await seedReview(await seedFamily('four'), 'worth_it');
    await seedReview(await seedFamily('five'), 'worth_it');
    const positive = await verdictsFor();
    expect(positive?.majorityNegative).toBe(false);
    expect(renderVerdictClause('the Riverdale storytime', positive)).toBe(
      '3 families near you say the Riverdale storytime is worth it.',
    );
  });

  it('never states a denominator and uses no adjective', async () => {
    await seedReview(await seedFamily('one'), 'worth_it');
    await seedReview(await seedFamily('two'), 'worth_it');
    await seedReview(await seedFamily('three'), 'not_worth_it');

    const clause = renderVerdictClause('the Riverdale storytime', await verdictsFor());
    expect(clause).toBe('2 families near you say the Riverdale storytime is worth it.');
    // "2 of 3" at k=3 is a negative aggregate by arithmetic, and "loved" is a review the
    // parents did not write.
    expect(clause).not.toMatch(/\bof\b|loved|great|popular/i);
  });

  it('keeps a tag only when two families said it, and at most two tags', async () => {
    await seedReview(await seedFamily('one'), 'worth_it', {
      tags: ['hard_parking', 'well_run', 'pricey'],
    });
    await seedReview(await seedFamily('two'), 'worth_it', {
      tags: ['hard_parking', 'well_run'],
    });
    await seedReview(await seedFamily('three'), 'worth_it', { tags: ['too_crowded'] });

    const verdicts = await verdictsFor();
    expect(verdicts?.topTags.sort()).toEqual(['hard_parking', 'well_run']);
    // One family's tag is one family's morning, not something to tell a stranger.
    expect(verdicts?.topTags).not.toContain('pricey');
    expect(verdicts?.topTags).not.toContain('too_crowded');
  });

  it('pools per area — a verdict from another neighbourhood is not "near you"', async () => {
    await seedReview(await seedFamily('one'), 'worth_it');
    await seedReview(await seedFamily('two'), 'worth_it');
    await seedReview(await seedFamily('three'), 'worth_it', { areaKey: 'L7G' });

    expect(await verdictsFor()).toBeUndefined();
  });
});

describe('which offer the clause may be attached to', () => {
  const offer = (title: string, placeId: string | null, civicVenueId: string | null = null) => ({
    title,
    candidateId: `cand-${title}`,
    placeId,
    civicVenueId,
  });

  async function pooledFor(refs: readonly string[]) {
    for (const ref of refs) {
      await seedReview(await seedFamily(`${ref}-one`), 'worth_it', { ref });
      await seedReview(await seedFamily(`${ref}-two`), 'worth_it', { ref });
      await seedReview(await seedFamily(`${ref}-three`), 'worth_it', { ref });
    }
    return readSubjectVerdicts(
      db.database,
      refs.map((ref) => ({ source: 'place' as const, ref })),
      AREA,
    );
  }

  it('attaches to the one offer that has a pooled answer', async () => {
    const verdicts = await pooledFor(['places/a']);
    const target = nearbyClauseTarget(
      [offer('Saturday storytime', 'places/a'), offer('Tuesday swim', 'places/b')],
      verdicts,
    );

    expect(target).toEqual({
      title: 'Saturday storytime',
      clause: '3 families near you say Saturday storytime is worth it.',
      otherTitles: ['Tuesday swim'],
    });
  });

  it('says nothing when TWO offers have one — a count cannot say which', async () => {
    const verdicts = await pooledFor(['places/a', 'places/b']);

    expect(
      nearbyClauseTarget(
        [offer('Saturday storytime', 'places/a'), offer('Tuesday swim', 'places/b')],
        verdicts,
      ),
    ).toBeNull();
  });

  it('says nothing when an offer carries no shared identity at all', async () => {
    expect(nearbyClauseTarget([offer('Saturday storytime', null)], new Map())).toBeNull();
  });
});

describe('the floor itself', () => {
  it('is three, and the reader and the renderer read the same constant', () => {
    expect(MIN_FAMILIES_FOR_AGGREGATE).toBe(3);
    expect(
      renderVerdictClause('a place', {
        families: MIN_FAMILIES_FOR_AGGREGATE - 1,
        worthIt: 2,
        majorityNegative: false,
        topTags: [],
      }),
    ).toBeNull();
  });
});
