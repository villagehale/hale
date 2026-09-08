import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { defaultIntroSweepDeps } from './run';

/**
 * VIL-340 · the class-key reader against the REAL DDL (migration 0109).
 *
 * Everything this reader is for lives in the WHERE clause and in one comparison the query
 * deliberately does not make: live rows only, armed by the consenting parent themself,
 * keyed on the course rather than on the url a parent happened to paste. None of that is
 * observable through a Drizzle chain fake — a fake returns whatever rows it was handed, so
 * it passes just as happily with no predicate at all.
 *
 * It drives `defaultIntroSweepDeps().loadClassKeys` rather than the private function, so
 * the thing under test is the one the sweep actually calls. Each test names the mutation
 * it exists to catch.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

const NOW = new Date('2026-09-04T14:00:00.000Z');
const MARKHAM = 'cityofmarkham.perfectmind.com';
const COURSE = '22222222-2222-2222-2222-222222222222';
const OTHER_COURSE = '33333333-3333-3333-3333-333333333333';

function courseUrl(
  courseId = COURSE,
  widgetId = '11111111-1111-1111-1111-111111111111',
  host = MARKHAM,
): string {
  return `https://${host}/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=${widgetId}&courseId=${courseId}`;
}

async function seedWatch(
  familyId: string,
  parentUserId: string,
  overrides: { sourceUrl?: string; expiresAt?: Date; releasedAt?: Date } = {},
): Promise<string> {
  const released = overrides.releasedAt ?? null;
  const [row] = await db.database
    .insert(schema.watchedSpots)
    .values({
      familyId,
      parentUserId,
      sourceUrl: overrides.sourceUrl ?? courseUrl(),
      // Never selected by the reader, and seeded distinctively so a query that took it
      // would show up in what the key is built from.
      label: 'Milliken preschool swim',
      expiresAt: overrides.expiresAt ?? new Date('2026-11-03T14:00:00.000Z'),
      releasedAt: released,
      releasedReason: released === null ? null : 'notified',
      createdFrom: 'CM-ack',
    })
    .returning({ id: schema.watchedSpots.id });
  if (!row) throw new Error('seedWatch: watched_spots insert returned no row');
  return row.id;
}

/** A second user on the same household — a co_parent holds full parent scope, so this is
 * a real person who can arm a watch, not a fixture convenience. */
async function seedCoParent(familyId: string): Promise<string> {
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `co-${familyId}@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('seedCoParent: users insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user.id, role: 'co_parent' });
  return user.id;
}

function loadClassKeys(families: Array<{ familyId: string; parentUserId: string }>) {
  return defaultIntroSweepDeps().loadClassKeys(db.database, families, NOW);
}

describe('loadClassKeys', () => {
  /** Catches a missing `released_at IS NULL` (a family that already got the seat is not
   * waiting on that class) and a missing `expires_at > now` (a 60-day-dead watch would
   * rank a pairing forever). */
  it('keeps only the watches that are still live', async () => {
    const home = await seedFamily(db.database, 'Live Family');
    await seedWatch(home.familyId, home.parentUserId, { sourceUrl: courseUrl(COURSE) });
    await seedWatch(home.familyId, home.parentUserId, {
      sourceUrl: courseUrl(OTHER_COURSE),
      releasedAt: NOW,
    });
    await seedWatch(home.familyId, home.parentUserId, {
      sourceUrl: courseUrl('44444444-4444-4444-4444-444444444444'),
      expiresAt: new Date('2026-09-03T14:00:00.000Z'),
    });

    const keys = await loadClassKeys([home]);

    expect(keys.get(home.familyId)).toEqual(new Set([`${MARKHAM}:${COURSE}`]));
  });

  /** Catches the armer comparison being dropped: a co-parent's registration intent would
   * then rank on the PRIMARY parent's discoverability consent, which is the cross-parent
   * case rule #5 forbids. */
  it('ignores a watch armed by anyone but the consenting parent', async () => {
    const home = await seedFamily(db.database, 'Co-parent Family');
    const coParent = await seedCoParent(home.familyId);
    await seedWatch(home.familyId, coParent, { sourceUrl: courseUrl(COURSE) });

    const keys = await loadClassKeys([home]);

    expect(keys.has(home.familyId)).toBe(false);
  });

  /** Catches a key built from `source_url`. Two parents reach one course through different
   * portal widgets, so a url-keyed signal would never fire for the pair it exists for. */
  it('keys on the course, not on the link the parent happened to paste', async () => {
    const one = await seedFamily(db.database, 'Widget One');
    const two = await seedFamily(db.database, 'Widget Two');
    await seedWatch(one.familyId, one.parentUserId, {
      sourceUrl: courseUrl(COURSE, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    });
    await seedWatch(two.familyId, two.parentUserId, {
      sourceUrl: courseUrl(COURSE, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
    });

    const keys = await loadClassKeys([one, two]);

    expect(keys.get(one.familyId)).toEqual(keys.get(two.familyId));
    expect(keys.get(one.familyId)).toEqual(new Set([`${MARKHAM}:${COURSE}`]));
  });

  /** Catches a read that is not scoped to the families it was asked about — the whole
   * point of a family-scoped query rather than a "who else watches this course" one — and
   * a reader that maps a watchless family to an empty set, which would make "holds
   * nothing" and "was not asked about" the same answer. */
  it('answers about the families it was asked about, and only those', async () => {
    const asked = await seedFamily(db.database, 'Asked Family');
    const stranger = await seedFamily(db.database, 'Stranger Family');
    await seedWatch(stranger.familyId, stranger.parentUserId);

    const keys = await loadClassKeys([asked]);

    expect(keys.has(stranger.familyId)).toBe(false);
    expect(keys.has(asked.familyId)).toBe(false);
  });

  /** Catches a host removed from SPOT_PORTAL_HOSTS becoming a silent drop, and catches the
   * url or its host reaching the log line (rule #1). Inserted straight into the table
   * because `armWatchedSpot` would have refused it — which is exactly the state a registry
   * edit leaves behind for rows armed before it. */
  it('drops a watch whose host has left the registry, loudly and without the url', async () => {
    const home = await seedFamily(db.database, 'Retired Portal Family');
    const spotId = await seedWatch(home.familyId, home.parentUserId, {
      sourceUrl: courseUrl(COURSE, '11111111-1111-1111-1111-111111111111', 'retired.example.com'),
    });
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args);
    });

    const keys = await loadClassKeys([home]);
    spy.mockRestore();

    expect(keys.has(home.familyId)).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toEqual({ watchedSpotId: spotId, reason: 'host_not_allowed' });
    const logged = JSON.stringify(errors);
    expect(logged).not.toContain('retired.example.com');
    expect(logged).not.toContain('Milliken');
  });
});
