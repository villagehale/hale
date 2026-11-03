import { schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { loadClaimedWindowIds } from './claims.js';
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
      ...(courseOpensAt === null ? {} : { courseUrl: COURSE_URL, courseOpensAt }),
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

/**
 * VIL-423 · a watch on a link the parent sent, before any catalog window exists.
 *
 * The row says "this family is watching this URL" with no `registration_windows` parent,
 * no open date yet, and a link longer than the PerfectMind SMS bound. Its identity is
 * (family, course_url) among ACTIVE rows; the child is optional. All of that is DDL, so
 * only a real database can prove it.
 */
describe('registration_sequences · a URL-owned watch', () => {
  const LONG_URL = `https://registration.example.org/course?ref=${'a'.repeat(2048 - 44)}`;

  let familyA: string;
  let parentA: string;
  let familyB: string;
  let parentB: string;

  beforeAll(async () => {
    const a = await seedFamily(db.database, 'Watch Family A');
    familyA = a.familyId;
    parentA = a.parentUserId;
    const b = await seedFamily(db.database, 'Watch Family B');
    familyB = b.familyId;
    parentB = b.parentUserId;
  });

  function parentOf(family: string): string {
    return family === familyA ? parentA : family === familyB ? parentB : parentUserId;
  }

  /** window_id is omitted, so it is NULL: the row hangs off the link alone. */
  async function insertUrlWatch(
    family: string,
    courseUrl: string | null,
    extra: Record<string, string> = {},
  ) {
    const columns = ['family_id', 'parent_user_id', 'course_url', ...Object.keys(extra)];
    const values = [
      `'${family}'`,
      `'${parentOf(family)}'`,
      courseUrl === null ? 'NULL' : `'${courseUrl}'`,
      ...Object.values(extra).map((value) => `'${value}'`),
    ];
    return db.exec(
      `INSERT INTO registration_sequences (${columns.join(', ')}) VALUES (${values.join(', ')})`,
    );
  }

  it('holds a 2048-character link with no window and no open date, and nothing longer or empty', async () => {
    expect(LONG_URL.length).toBe(2048);

    // Through the table object, so the Drizzle mirror and the .sql must agree.
    const [watch] = await db.database
      .insert(schema.registrationSequences)
      .values({ familyId: familyA, windowId: null, parentUserId: parentA, courseUrl: LONG_URL })
      .returning({
        windowId: schema.registrationSequences.windowId,
        courseUrl: schema.registrationSequences.courseUrl,
        courseOpensAt: schema.registrationSequences.courseOpensAt,
      });
    expect(watch?.windowId).toBeNull();
    expect(watch?.courseOpensAt).toBeNull();
    expect(watch?.courseUrl?.length).toBe(2048);

    await expect(insertUrlWatch(familyA, `${LONG_URL}b`)).rejects.toThrow(
      /registration_sequences_course_url_length_check/,
    );
    await expect(insertUrlWatch(familyA, '')).rejects.toThrow(
      /registration_sequences_course_url_length_check/,
    );
  });

  it('bounds the link in bytes, so a raw multibyte link is refused by name, never by the index', async () => {
    const PREFIX = 'https://x.example.org/';
    // 2048 characters, three bytes each past the prefix: inside a character bound, over
    // the 2704-byte btree row limit of live_url_uniq. Varied, because Postgres compresses
    // a long index key and one repeated character would shrink under the limit.
    const WIDE = `${PREFIX}${Array.from({ length: 2048 - PREFIX.length }, (_, i) =>
      String.fromCodePoint(0x4e00 + ((i * 7919) % 20000)),
    ).join('')}`;
    // 2048 bytes exactly: the prefix plus two-byte characters.
    const FITS = `${PREFIX}${'\u00e9'.repeat((2048 - PREFIX.length) / 2)}`;
    expect([WIDE.length, Buffer.byteLength(WIDE)]).toEqual([2048, 6100]);
    expect(Buffer.byteLength(FITS)).toBe(2048);

    await expect(insertUrlWatch(familyA, WIDE)).rejects.toThrow(
      /registration_sequences_course_url_length_check/,
    );
    await expect(insertUrlWatch(familyA, `${FITS}\u00e9`)).rejects.toThrow(
      /registration_sequences_course_url_length_check/,
    );
    // Positive control: a multibyte link at the byte bound is stored.
    await expect(insertUrlWatch(familyA, FITS)).resolves.toBeDefined();
  });

  it('is one active watch per family and link', async () => {
    const URL_X = 'https://registration.example.org/c/identity';
    await insertUrlWatch(familyA, URL_X);

    await expect(insertUrlWatch(familyA, URL_X)).rejects.toThrow(
      /registration_sequences_live_url_uniq/,
    );

    // Another family watching the same link is its own watch.
    await expect(insertUrlWatch(familyB, URL_X)).resolves.toBeDefined();
    // A window-bound row on the same link is outside the partial index.
    const windowId = await seedWindow();
    await expect(
      db.exec(`
        INSERT INTO registration_sequences (family_id, window_id, parent_user_id, course_url, course_opens_at)
        VALUES ('${familyA}', '${windowId}', '${parentA}', '${URL_X}', '2026-08-12T10:30:00Z')
      `),
    ).resolves.toBeDefined();
    // Once the first watch is answered for, it is no longer active, so a new one may start.
    await db.exec(
      `UPDATE registration_sequences SET outcome = 'registered' WHERE family_id = '${familyA}' AND window_id IS NULL AND course_url = '${URL_X}'`,
    );
    await expect(insertUrlWatch(familyA, URL_X)).resolves.toBeDefined();

    // child_id is optional: every watch above was inserted without one.
    const [childless] = await rows(
      `SELECT count(*)::int AS n FROM registration_sequences WHERE course_url = '${URL_X}' AND window_id IS NULL AND child_id IS NULL`,
    );
    expect(childless).toEqual({ n: 3 });
  });

  it('must hang off a window or a link, and a date review needs the change it reviews', async () => {
    await expect(insertUrlWatch(familyA, null)).rejects.toThrow(
      /registration_sequences_target_check/,
    );
    // An anchor with no link on a URL-owned row: there is nothing to re-read it from.
    await expect(
      insertUrlWatch(familyA, null, { course_opens_at: '2026-08-12T10:30:00Z' }),
    ).rejects.toThrow(/registration_sequences_target_check/);
    await expect(
      insertUrlWatch(familyA, 'https://registration.example.org/c/1', {
        course_opens_at: '2026-08-12T10:30:00Z',
      }),
    ).resolves.toBeDefined();

    const [event] = await db.database
      .insert(schema.events)
      .values({
        familyId: familyA,
        source: 'test',
        eventType: 'registration_date_review',
        dedupHash: `watch-date-review-${Math.random()}`,
      })
      .returning({ id: schema.events.id });
    const [action] = await db.database
      .insert(schema.actions)
      .values({
        eventId: event?.id as string,
        familyId: familyA,
        actionType: 'send_message',
        payload: {},
        userVisibleState: 'drafted_for_approval',
        reviewerVerdict: 'approved',
        draftedAt: new Date('2026-09-08T10:00:00.000Z'),
      })
      .returning({ id: schema.actions.id });
    const actionId = action?.id as string;

    await expect(
      insertUrlWatch(familyA, 'https://registration.example.org/c/2', {
        date_review_action_id: actionId,
      }),
    ).rejects.toThrow(/registration_sequences_date_review_check/);
    await expect(
      insertUrlWatch(familyA, 'https://registration.example.org/c/2', {
        date_review_action_id: actionId,
        pending_change: '{"kind":"later"}',
      }),
    ).resolves.toBeDefined();
  });

  it('claims no catalog window for the link-owned watch', async () => {
    const family = await seedFamily(db.database, 'Watch Claims Family');
    const windowId = await seedWindow();
    await db.exec(`
      INSERT INTO registration_sequences (family_id, window_id, parent_user_id)
      VALUES ('${family.familyId}', '${windowId}', '${family.parentUserId}')
    `);
    await db.exec(`
      INSERT INTO registration_sequences (family_id, parent_user_id, course_url)
      VALUES ('${family.familyId}', '${family.parentUserId}', 'https://courses.example.net/claims')
    `);

    expect(await loadClaimedWindowIds(db.database, family.familyId)).toEqual(new Set([windowId]));
  });
});
