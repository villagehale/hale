import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedFamily, type TestDb } from '../testing/pglite.js';
import { addToCalendar } from './internal-writes.js';

/**
 * The calendar placement is an INSERT-AS-CLAIM (audit P1-4 seam 3): the row carries
 * `placed_by_action_id`, and the partial unique index from migration 0106 — not the
 * old SELECT of audit_log — decides which of two concurrent deliveries places it.
 * pglite is one session, so the true interleaving (both passing the read before either
 * inserts) cannot be staged here; instead these tests pin BOTH halves the race needs:
 * the function stamps the claim and loses it cleanly, and the DATABASE refuses a
 * second row for the same action regardless of what the application read first.
 *
 * Mutation proof: revert addToCalendar to select-then-insert without the claim stamp
 * and 'stamps the claim' fails (the column is null); drop the 0106 index and 'the
 * database itself refuses' fails (the direct second insert lands).
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

afterAll(async () => {
  await db.close();
});

function placement(familyId: string, actionId: string) {
  return {
    familyId,
    actionId,
    title: 'Skating registration',
    startsAt: new Date('2026-09-12T15:00:00.000Z'),
    endsAt: null,
    location: null,
    childId: null,
    sensitive: false,
  };
}

describe('addToCalendar placement claim', () => {
  it('stamps the claim, and a redelivery loses it cleanly to the SAME row', async () => {
    const fam = await seedFamily(db.database);
    const actionId = randomUUID();

    const first = await addToCalendar(placement(fam.familyId, actionId), db.database);
    expect(first.outcome).toBe('written');

    // The row itself carries the claim — the fact the unique index arbitrates on.
    const rows = await db.database
      .select({
        id: schema.familyEvents.id,
        placedByActionId: schema.familyEvents.placedByActionId,
      })
      .from(schema.familyEvents)
      .where(eq(schema.familyEvents.familyId, fam.familyId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.placedByActionId).toBe(actionId);

    const second = await addToCalendar(placement(fam.familyId, actionId), db.database);
    expect(second.outcome).toBe('already_written');
    // The loser recovers the WINNER'S row id — the reversal handle stays unique.
    expect(second.familyEventId).toBe(first.familyEventId);

    const after = await db.database
      .select({ id: schema.familyEvents.id })
      .from(schema.familyEvents)
      .where(eq(schema.familyEvents.familyId, fam.familyId));
    expect(after).toHaveLength(1);
  });

  it('the DATABASE refuses a second row for one action — concurrency is decided below the app', async () => {
    const fam = await seedFamily(db.database);
    const actionId = randomUUID();
    await addToCalendar(placement(fam.familyId, actionId), db.database);

    // A concurrent delivery that passed every application-level read lands here: the
    // bare insert a racing transaction would attempt. The index, not timing, refuses.
    const raced = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId: fam.familyId,
        title: 'Skating registration',
        startsAt: new Date('2026-09-12T15:00:00.000Z'),
        source: 'placement',
        placedByActionId: actionId,
      })
      .onConflictDoNothing()
      .returning({ id: schema.familyEvents.id });
    expect(raced).toHaveLength(0);
  });

  it('distinct actions place independently (the claim cannot fail closed)', async () => {
    const fam = await seedFamily(db.database);

    const a = await addToCalendar(placement(fam.familyId, randomUUID()), db.database);
    const b = await addToCalendar(placement(fam.familyId, randomUUID()), db.database);
    expect(a.outcome).toBe('written');
    expect(b.outcome).toBe('written');
    expect(a.familyEventId).not.toBe(b.familyEventId);
  });
});
