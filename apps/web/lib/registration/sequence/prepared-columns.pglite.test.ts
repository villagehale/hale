import { schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

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

  it('accepts the unbound row and the fully bound row', async () => {
    // The positive control the pair of refusals above needs: the CHECK must not be
    // refusing everything. Kills a CHECK written as `IS NOT NULL AND IS NOT NULL`,
    // which would make today's unbound sequences uninsertable.
    await expect(insertSequence(null, null)).resolves.toBeDefined();
    await expect(insertSequence(COURSE_URL, '2026-08-12T10:30:00Z')).resolves.toBeDefined();
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
