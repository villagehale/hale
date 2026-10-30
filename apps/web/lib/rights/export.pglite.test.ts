import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { assembleFamilyExport } from './export';

/**
 * The access copy against real Postgres, for the one block nothing else can see.
 *
 * export.test.ts fakes the database and routes each select by call order, which means it
 * can prove the document's SHAPE and nothing about the queries behind it — a note read
 * that was scoped to the wrong column, or to the whole family, would pass it. Day notes
 * are a parent's own unedited words and the one thing in this product deliberately kept
 * off every shared surface (rule #1), so the scoping is the part that has to be true.
 */

const TZ = 'America/Toronto';
const NOTED_AT = new Date('2026-07-06T01:40:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function seedParent(familyId: string, suffix: string, role: 'primary_parent' | 'co_parent') {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${familyId}:${suffix}`, name: suffix, timezone: TZ })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({ familyId, userId, role });
  return userId;
}

async function seedNote(input: {
  familyId: string;
  parentUserId: string;
  notedOn: string;
  note: string;
}) {
  const [inbound] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: input.note,
    })
    .returning({ id: schema.channelMessages.id });
  await db.database.insert(schema.familyCheckInNotes).values({
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    sourceMessageId: inbound?.id as string,
    notedOn: input.notedOn,
    note: input.note,
    expiresAt: new Date(NOTED_AT.getTime() + 30 * 24 * 3_600_000),
  });
}

describe('the evening check-in in a right-to-access copy', () => {
  it("gives a parent their own day notes and never their co-parent's", async () => {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    const familyId = family?.id as string;
    const anaId = await seedParent(familyId, 'ana', 'primary_parent');
    const samId = await seedParent(familyId, 'sam', 'co_parent');

    await db.database.insert(schema.familyCheckInPrefs).values({
      familyId,
      cadence: 'weekly',
      lastAskedAt: new Date('2026-07-06T00:17:00.000Z'),
      lastAnsweredAt: NOTED_AT,
    });
    await seedNote({
      familyId,
      parentUserId: anaId,
      notedOn: '2026-07-05',
      note: 'Park after daycare and both asleep by 7',
    });
    await seedNote({
      familyId,
      parentUserId: samId,
      notedOn: '2026-07-04',
      note: 'Long one, I was at the office until eight',
    });

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: anaId,
      loadTrail: async () => [],
    });

    expect(doc.eveningCheckIn.cadence).toBe('weekly');
    expect(doc.eveningCheckIn.lastAnsweredAt).toBe(NOTED_AT.toISOString());
    expect(doc.eveningCheckIn.notes.map((entry) => entry.note)).toEqual([
      'Park after daycare and both asleep by 7',
    ]);
    expect(JSON.stringify(doc)).not.toContain('until eight');
  });

  /**
   * ONE PARENT'S TRIP MUST NOT REACH THE OTHER, and the export is the only surface where
   * it could. Every other fact about a trip says it belongs to one parent — detected from
   * ONE mailbox, texted to THAT phone, cascading on THAT user's row — and this file is the
   * one durable copy that leaves the app. Hale supports separated co-parents, so a solo
   * travel date is exactly the disclosure the privacy moat exists to prevent.
   *
   * THE POSITIVE CONTROL IS THE TEST. `trips: []` passes just as happily on a block that
   * is always empty, so the same trip is read back as its own parent in the same `it`.
   */
  it("serves a trip only to the parent whose mailbox it came from", async () => {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Ana + Sam', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    const familyId = family?.id as string;
    const anaId = await seedParent(familyId, 'ana', 'primary_parent');
    const samId = await seedParent(familyId, 'sam', 'co_parent');

    await db.database.insert(schema.familyTrips).values({
      familyId,
      parentUserId: anaId,
      integrationId: '99999999-9999-4999-8999-999999999999',
      messageId: 'gmail-trip-1',
      destinationCity: 'New York',
      destinationRegion: 'NY',
      startsOn: '2026-09-12',
      endsOn: '2026-09-15',
      childEvidence: 'named_traveller',
    });

    const sams = await assembleFamilyExport(db.database, familyId, {
      actorUserId: samId,
      loadTrail: async () => [],
    });
    expect(sams.trips).toEqual([]);
    // Not just the block: nowhere in Sam's whole copy.
    expect(JSON.stringify(sams)).not.toContain('New York');

    const anas = await assembleFamilyExport(db.database, familyId, {
      actorUserId: anaId,
      loadTrail: async () => [],
    });
    expect(anas.trips).toEqual([
      {
        destinationCity: 'New York',
        destinationRegion: 'NY',
        startsOn: '2026-09-12',
        endsOn: '2026-09-15',
        childEvidence: 'named_traveller',
        closedAt: null,
        closedReason: null,
      },
    ]);
  });
});
