import { schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { loadAwaitingSequence } from './reply.js';
import { defaultSequenceRunDeps } from './run.js';

/**
 * VIL-338 · the prepared-registration columns against the REAL DDL (migration 0110).
 *
 * Everything this migration is for lives in the database and nowhere else: three
 * nullable columns whose nullability IS the semantics (NULL = unasked, not false), a
 * paired CHECK that makes "bound to a course with no clock to anchor on" unrepresentable,
 * and RLS. A Drizzle chain fake can observe none of it — it returns whatever rows it was
 * handed and would pass just as happily against a table that never grew the columns.
 *
 * Each test names the mutation it exists to catch.
 */

let db: TestDb;
let familyId: string;
let parentUserId: string;

beforeAll(async () => {
  db = await createTestDb();
  const seeded = await seedFamily(db.database, 'Prepared Registration Family');
  familyId = seeded.familyId;
  parentUserId = seeded.parentUserId;
});

afterAll(async () => {
  await db.close();
});

/** A fresh window per case — (family_id, window_id) is unique, so one row per window. */
let windowSeq = 0;
async function seedWindow(): Promise<string> {
  windowSeq += 1;
  const [row] = await db.database
    .insert(schema.registrationWindows)
    .values({
      municipality: 'markham',
      programDomain: 'rec_program',
      cycleLabel: `Fall 2026 #${windowSeq}`,
      openAt: new Date('2026-08-11T10:30:00.000Z'),
      sourceUrl: 'https://example.test/window',
      verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
    })
    .returning({ id: schema.registrationWindows.id });
  if (!row) throw new Error('seedWindow: insert returned no row');
  return row.id;
}

const COURSE_URL =
  'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=11111111-1111-1111-1111-111111111111&courseId=22222222-2222-2222-2222-222222222222';

async function insertSequence(courseUrl: string | null, courseOpensAt: string | null) {
  const windowId = await seedWindow();
  return db.exec(`
    INSERT INTO registration_sequences (family_id, window_id, parent_user_id, course_url, course_opens_at)
    VALUES (
      '${familyId}',
      '${windowId}',
      '${parentUserId}',
      ${courseUrl === null ? 'NULL' : `'${courseUrl}'`},
      ${courseOpensAt === null ? 'NULL' : `'${courseOpensAt}'`}
    )
  `);
}

async function rows(query: string): Promise<Record<string, unknown>[]> {
  const result = (await db.database.execute(sql.raw(query))) as unknown as {
    rows: Record<string, unknown>[];
  };
  return result.rows;
}

describe('registration_sequences · the prepared-registration columns', () => {
  it('carries all three columns nullable, with the types the ladder reads', async () => {
    const found = await rows(`
      SELECT column_name, data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'registration_sequences'
        AND column_name IN ('course_url', 'course_opens_at', 'readiness_ready')
      ORDER BY column_name
    `);

    // Kills: shipping any of the three NOT NULL (every existing row would refuse the
    // migration, and readiness_ready NOT NULL would collapse "unasked" into "said no"),
    // and shipping course_opens_at as a naive timestamp — the anchor is an instant, and
    // a wall-clock column would fire the go leg an offset away from the municipality's.
    expect(found).toEqual([
      { column_name: 'course_opens_at', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      { column_name: 'course_url', data_type: 'text', is_nullable: 'YES' },
      { column_name: 'readiness_ready', data_type: 'boolean', is_nullable: 'YES' },
    ]);
  });

  it('refuses a bound course with no clock, and a clock with no bound course', async () => {
    // Kills: dropping the paired CHECK. A course_url without course_opens_at is a
    // sequence the scheduler believes is bound and has nothing to anchor its legs on;
    // a clock without a URL is an anchor no send-time read can re-verify.
    await expect(insertSequence(COURSE_URL, null)).rejects.toThrow(
      /registration_sequences_course_check/,
    );
    await expect(insertSequence(null, '2026-08-12T10:30:00Z')).rejects.toThrow(
      /registration_sequences_course_check/,
    );
  });

  it('accepts the unbound row, and round-trips a bound one through the Drizzle columns', async () => {
    // The positive control the pair of refusals above needs: the CHECK must not be
    // refusing everything. Kills a CHECK written as `IS NOT NULL AND IS NOT NULL`,
    // which would make today's unbound sequences uninsertable.
    await expect(insertSequence(null, null)).resolves.toBeDefined();

    // The bound row goes in through the table object rather than raw SQL, because the
    // .sql and the Drizzle table are two spellings of one table and only a write that
    // names the column OBJECTS can catch them disagreeing. Kills renaming, mistyping or
    // deleting any of the three columns on the TypeScript side while 0110 ships as it
    // is — a schema that names a column production does not have, which every other
    // gate in the repo (tsc, the drift check, the ratchet, a chain fake) reads as green.
    const windowId = await seedWindow();
    const [bound] = await db.database
      .insert(schema.registrationSequences)
      .values({
        familyId,
        windowId,
        parentUserId,
        courseUrl: COURSE_URL,
        courseOpensAt: new Date('2026-08-12T10:30:00.000Z'),
        readinessReady: true,
      })
      .returning({
        courseUrl: schema.registrationSequences.courseUrl,
        courseOpensAt: schema.registrationSequences.courseOpensAt,
        readinessReady: schema.registrationSequences.readinessReady,
      });

    expect(bound).toEqual({
      courseUrl: COURSE_URL,
      courseOpensAt: new Date('2026-08-12T10:30:00.000Z'),
      readinessReady: true,
    });
  });

  it('has row level security on', async () => {
    // Kills: deleting the table's line from KNOWN_UNPROTECTED in the ratchet without
    // the ALTER TABLE that earns it. The ratchet reads the .sql text; only a real
    // database can say the statement took.
    const [row] = await rows(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'registration_sequences'`,
    );

    expect(row).toEqual({ relrowsecurity: true });
  });
});

/**
 * VIL-338 · the guarded anchor refresh, against the REAL table.
 *
 * The battle-plan read's one write. Its whole job is in the WHERE clause — which row,
 * which page, and only when the clock actually differs — and a Drizzle chain fake
 * returns whatever it was handed, so the guard can only be proven here.
 */
describe('defaultSequenceRunDeps().refreshCourseAnchor · the guard', () => {
  const AT = new Date('2026-08-11T10:30:00.000Z');
  const MOVED = new Date('2026-08-12T10:30:00.000Z');

  async function seedBound(): Promise<string> {
    const windowId = await seedWindow();
    const [row] = await db.database
      .insert(schema.registrationSequences)
      .values({ familyId, windowId, parentUserId, courseUrl: COURSE_URL, courseOpensAt: AT })
      .returning({ id: schema.registrationSequences.id });
    if (!row) throw new Error('seedBound: insert returned no row');
    return row.id;
  }

  async function anchorOf(sequenceId: string): Promise<unknown> {
    const [row] = await rows(
      `SELECT course_opens_at FROM registration_sequences WHERE id = '${sequenceId}'`,
    );
    return row?.course_opens_at;
  }

  it('moves the clock once, and says so only the first time', async () => {
    const { refreshCourseAnchor } = defaultSequenceRunDeps();
    const sequenceId = await seedBound();

    const first = await refreshCourseAnchor(db.database, {
      sequenceId,
      courseUrl: COURSE_URL,
      courseOpensAt: MOVED,
      now: new Date(),
    });
    const second = await refreshCourseAnchor(db.database, {
      sequenceId,
      courseUrl: COURSE_URL,
      courseOpensAt: MOVED,
      now: new Date(),
    });

    // Kills dropping `IS DISTINCT FROM`: every one of the battle plan's ticks would
    // report a move, and `anchorMovedMinutes` would be a receipt for nothing.
    expect([first, second]).toEqual([true, false]);
    expect(new Date(String(await anchorOf(sequenceId))).toISOString()).toBe(MOVED.toISOString());
  });

  it('refuses to move a row that now holds a DIFFERENT course', async () => {
    const { refreshCourseAnchor } = defaultSequenceRunDeps();
    const sequenceId = await seedBound();
    // The parent pasted a second link while the six-second read was in flight: the row
    // is a different class now, with its own clock. Kills a guard on the id alone, which
    // would overwrite the new page's morning with the old page's.
    const rebound = `${COURSE_URL.slice(0, -1)}9`;
    await db.exec(
      `UPDATE registration_sequences SET course_url = '${rebound}' WHERE id = '${sequenceId}'`,
    );

    const moved = await refreshCourseAnchor(db.database, {
      sequenceId,
      courseUrl: COURSE_URL,
      courseOpensAt: MOVED,
      now: new Date(),
    });

    expect(moved).toBe(false);
    expect(new Date(String(await anchorOf(sequenceId))).toISOString()).toBe(AT.toISOString());
  });

  it('says nothing moved for a sequence that is gone', async () => {
    const { refreshCourseAnchor } = defaultSequenceRunDeps();
    // Kills returning true unconditionally: a deleted household would be audited as
    // having had its morning moved.
    const moved = await refreshCourseAnchor(db.database, {
      sequenceId: '00000000-0000-0000-0000-000000000000',
      courseUrl: COURSE_URL,
      courseOpensAt: MOVED,
      now: new Date(),
    });

    expect(moved).toBe(false);
  });
});


/**
 * VIL-338 · the check-in listens for as long after the BOUND course's morning as it
 * does after an unbound one, and answers about the morning that just ran.
 *
 * `runLegForSequence` anchors the ladder on `course_opens_at`, so the check-in goes out
 * four hours after the COURSE's morning — but this loader's horizon and ordering are
 * SQL, and a chain fake returns whatever rows it was handed however the WHERE reads. A
 * course bound days away from the M1 row is exactly the shape an M1 anchor loses.
 */
describe('loadAwaitingSequence · the horizon and the ordering', () => {
  let horizonFamilyId: string;
  let horizonParentUserId: string;

  beforeAll(async () => {
    const seeded = await seedFamily(db.database, 'Awaiting Horizon Family');
    horizonFamilyId = seeded.familyId;
    horizonParentUserId = seeded.parentUserId;
    await db.database
      .insert(schema.children)
      .values({ familyId: horizonFamilyId, name: 'Maya', dateOfBirth: '2022-05-01' });
  });

  async function seedSequenceOn(openAt: Date, courseOpensAt: Date | null): Promise<void> {
    windowSeq += 1;
    const [window] = await db.database
      .insert(schema.registrationWindows)
      .values({
        municipality: 'markham',
        programDomain: 'rec_program',
        cycleLabel: `Fall 2026 horizon #${windowSeq}`,
        openAt,
        ageMinMonths: 36,
        ageMaxMonths: 84,
        sourceUrl: 'https://example.test/window',
        verifiedAt: new Date('2026-09-01T00:00:00.000Z'),
      })
      .returning({ id: schema.registrationWindows.id });
    if (!window) throw new Error('seedSequenceOn: insert returned no window');
    await db.database.insert(schema.registrationSequences).values({
      familyId: horizonFamilyId,
      windowId: window.id,
      parentUserId: horizonParentUserId,
      ...(courseOpensAt === null
        ? {}
        : { courseUrl: COURSE_URL, courseOpensAt }),
    });
  }

  it('still hears a reply five hours after a course bound four days past the row', async () => {
    const courseOpensAt = new Date('2026-09-19T10:30:00.000Z');
    await seedSequenceOn(new Date('2026-09-15T10:30:00.000Z'), courseOpensAt);

    // Five hours after the COURSE's morning — an hour after the check-in went out, well
    // inside the 72-hour reply window. Kills a horizon measured from
    // `registration_windows.open_at`: the M1 row is 101 hours back by then, past the
    // 76-hour filter, so the loader answers null, the parent's "we got in" is never
    // recorded, no outcome is filed and no waitlist guard starts.
    const awaiting = await loadAwaitingSequence(
      db.database,
      horizonFamilyId,
      new Date('2026-09-19T15:30:00.000Z'),
    );

    expect(awaiting?.state.openAt).toEqual(courseOpensAt);
  });

  it('answers about the morning that just ran, not the newest M1 row', async () => {
    const courseOpensAt = new Date('2026-09-24T10:30:00.000Z');
    // Two live sequences inside the horizon: an unbound one whose row opens FIRST, and
    // the bound one whose course actually ran this morning. Kills an ordering left on
    // `open_at` — the reply would be judged against, and its outcome filed on, the
    // wrong registration morning.
    await seedSequenceOn(new Date('2026-09-23T10:30:00.000Z'), null);
    await seedSequenceOn(new Date('2026-09-22T10:30:00.000Z'), courseOpensAt);

    const awaiting = await loadAwaitingSequence(
      db.database,
      horizonFamilyId,
      new Date('2026-09-24T15:30:00.000Z'),
    );

    expect(awaiting?.state.openAt).toEqual(courseOpensAt);
  });
});
