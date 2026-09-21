import { type GuardDeps, invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_REVIEWS_SURFACE_ENV } from '~/lib/reviews/aggregate';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import { buildAskHaleTools } from './tools';

/**
 * NEGATIVES ARE NEVER SPOKEN, ONLY RANKED (founder decision 3), against real rows.
 *
 * What three households near a family said about a venue changes WHICH finds reach the
 * model, and nothing else: a pool that is mostly unfavourable at k>=3 drops that venue
 * from the offer set whenever there is anything else to offer, and no sentence about it
 * exists anywhere — not in the tool's answer, not in the reply. A warning would be an
 * unverified claim about a small business with no right of reply, and it would hand the
 * parent work; not being offered the thing is strictly better for them.
 *
 * EVERY ABSENCE HERE HAS A POSITIVE CONTROL on the same rows — the flag off, the same
 * pool one family short, and the case where every offer is in that state — because a
 * silent query bug and a working demotion look identical from the outside.
 */

const AREA = 'M4K';
const GOOD_PLACE = 'places/riverdale-library';
const POOR_PLACE = 'places/eastside-gym';
/** Far enough out that no test needs a fake clock next to pglite. */
const EVENT_DATE = '2030-07-13';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

async function seedFamily(name: string): Promise<{ familyId: string; parentUserId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON', areaCoarse: AREA })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${name}-${familyId}`, name })
    .returning({ id: schema.users.id });
  const parentUserId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentUserId, role: 'primary_parent' });
  return { familyId, parentUserId };
}

async function seedCandidate(
  familyId: string,
  title: string,
  placeId: string,
  confidence: number,
): Promise<void> {
  await db.database.insert(schema.villageCandidates).values({
    familyId,
    title,
    kind: 'class',
    summary: 'a warm local option',
    source: 'web_grounded',
    confidence,
    venueName: `${title} venue`,
    eventDate: EVENT_DATE,
    cadence: 'one-time',
    placeId,
  });
}

/** One household's answer about one venue, written the way the capture pass writes it. */
async function seedReview(
  who: string,
  placeId: string,
  verdict: 'worth_it' | 'not_worth_it',
): Promise<void> {
  const { familyId, parentUserId } = await seedFamily(who);
  const [message] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
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
    subjectRef: placeId,
    areaKey: AREA,
    childAgeBand: 'toddler',
    verdict,
    tags: [],
  });
}

interface VillageToolResult {
  candidates: Array<{ title: string; venue: string; when: string }>;
  inVerification: number;
  standingOption: { name: string; cadence: string } | null;
}

async function search(familyId: string): Promise<VillageToolResult> {
  const tool = buildAskHaleTools(db.database).find((t) => t.name === 'search_village');
  if (!tool) throw new Error('no search_village tool');
  const guardDeps: GuardDeps = { writeAudit: async () => {} };
  return (await invokeTool(
    tool,
    {},
    { familyId, actor: 'user-1' },
    guardDeps,
  )) as VillageToolResult;
}

/**
 * The household doing the asking, plus both finds in front of it. The one the pool will
 * turn against is the CONFIDENT one, so the ordinary ranking puts it first — a demotion
 * that only worked on the tail would look identical to one that worked.
 */
async function seedAsker(): Promise<string> {
  const { familyId } = await seedFamily('asker');
  await seedCandidate(familyId, 'Eastside tumbling', POOR_PLACE, 0.95);
  await seedCandidate(familyId, 'Riverdale storytime', GOOD_PLACE, 0.8);
  return familyId;
}

describe('a venue three families near you did not rate', () => {
  it('is not offered at all when there is an alternative, and is never mentioned', async () => {
    vi.stubEnv(ACTIVITY_REVIEWS_SURFACE_ENV, 'true');
    const familyId = await seedAsker();
    await seedReview('one', POOR_PLACE, 'not_worth_it');
    await seedReview('two', POOR_PLACE, 'not_worth_it');
    await seedReview('three', POOR_PLACE, 'worth_it');

    const result = await search(familyId);

    expect(result.candidates.map((c) => c.title)).toEqual(['Riverdale storytime']);
    // Ranked, never spoken: nothing in the answer says a word about what anyone said.
    expect(JSON.stringify(result)).not.toMatch(/worth|famil|said|review/i);
  });

  it('is offered while the surface flag is off — the control for the drop', async () => {
    const familyId = await seedAsker();
    await seedReview('one', POOR_PLACE, 'not_worth_it');
    await seedReview('two', POOR_PLACE, 'not_worth_it');
    await seedReview('three', POOR_PLACE, 'worth_it');

    const result = await search(familyId);

    expect(result.candidates.map((c) => c.title)).toEqual([
      'Eastside tumbling',
      'Riverdale storytime',
    ]);
  });

  it('is offered while only two households have answered — three is the floor', async () => {
    vi.stubEnv(ACTIVITY_REVIEWS_SURFACE_ENV, 'true');
    const familyId = await seedAsker();
    await seedReview('one', POOR_PLACE, 'not_worth_it');
    await seedReview('two', POOR_PLACE, 'not_worth_it');

    const result = await search(familyId);

    expect(result.candidates.map((c) => c.title)).toEqual([
      'Eastside tumbling',
      'Riverdale storytime',
    ]);
  });

  it('is offered when a majority liked it — a pool is not a demotion', async () => {
    vi.stubEnv(ACTIVITY_REVIEWS_SURFACE_ENV, 'true');
    const familyId = await seedAsker();
    await seedReview('one', POOR_PLACE, 'worth_it');
    await seedReview('two', POOR_PLACE, 'worth_it');
    await seedReview('three', POOR_PLACE, 'not_worth_it');

    const result = await search(familyId);

    expect(result.candidates.map((c) => c.title)).toEqual([
      'Eastside tumbling',
      'Riverdale storytime',
    ]);
  });

  it('still stands when every find is in that state — a parent is owed the honest list', async () => {
    vi.stubEnv(ACTIVITY_REVIEWS_SURFACE_ENV, 'true');
    const familyId = await seedAsker();
    for (const [who, place] of [
      ['one', POOR_PLACE],
      ['two', POOR_PLACE],
      ['three', POOR_PLACE],
      ['four', GOOD_PLACE],
      ['five', GOOD_PLACE],
      ['six', GOOD_PLACE],
    ] as const) {
      await seedReview(who, place, 'not_worth_it');
    }

    const result = await search(familyId);

    expect(result.candidates.map((c) => c.title)).toEqual([
      'Eastside tumbling',
      'Riverdale storytime',
    ]);
    expect(result.standingOption).toBeNull();
  });
});
