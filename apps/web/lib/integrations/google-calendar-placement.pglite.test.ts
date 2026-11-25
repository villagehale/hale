import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { createGoogleCalendarPlacement } from './google-calendar-placement';
import { CALENDAR_EVENTS_SCOPE } from './google-write-flag';

/**
 * VIL-719 · the production read behind the door's "whose calendar is this?": the real
 * connection rows, the real placed-event columns and the real write flag. Reads only, so
 * no token and no Google call is involved.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function connect(familyId: string, userId: string | null, scopes: string[]) {
  const id = await seedIntegration(db.database, familyId, userId);
  await db.database
    .update(schema.integrations)
    .set({ scopes })
    .where(eq(schema.integrations.id, id));
  return id;
}

async function placedEvent(familyId: string, integrationId: string) {
  const [row] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      title: 'Swim',
      startsAt: new Date('2026-12-05T15:00:00.000Z'),
      source: 'placement',
      placedGoogleEventId: 'google-event-1',
      placedGoogleIntegrationId: integrationId,
    })
    .returning({ id: schema.familyEvents.id });
  if (!row) throw new Error('seed: family_events insert returned no row');
  return row.id;
}

describe('createGoogleCalendarPlacement().writeTarget', () => {
  it("an add with no approver names the owner of the family's one scoped calendar", async () => {
    vi.stubEnv('GOOGLE_WRITE_SCOPES_ENABLED', 'true');
    const fam = await seedFamily(db.database);
    await connect(fam.familyId, fam.parentUserId, [CALENDAR_EVENTS_SCOPE]);
    await expect(
      createGoogleCalendarPlacement(db.database).writeTarget({
        familyId: fam.familyId,
        op: 'create',
        familyEventId: null,
        actorUserId: null,
      }),
    ).resolves.toEqual({ writes: true, ownerUserId: fam.parentUserId });
  });

  it('a move names the owner of the calendar that holds the event', async () => {
    vi.stubEnv('GOOGLE_WRITE_SCOPES_ENABLED', 'true');
    const fam = await seedFamily(db.database);
    const integrationId = await connect(fam.familyId, fam.parentUserId, [CALENDAR_EVENTS_SCOPE]);
    const familyEventId = await placedEvent(fam.familyId, integrationId);
    await expect(
      createGoogleCalendarPlacement(db.database).writeTarget({
        familyId: fam.familyId,
        op: 'update',
        familyEventId,
        actorUserId: null,
      }),
    ).resolves.toEqual({ writes: true, ownerUserId: fam.parentUserId });
  });

  it('writes nowhere while the write flag is off, with the same rows', async () => {
    vi.stubEnv('GOOGLE_WRITE_SCOPES_ENABLED', 'false');
    const fam = await seedFamily(db.database);
    await connect(fam.familyId, fam.parentUserId, [CALENDAR_EVENTS_SCOPE]);
    await expect(
      createGoogleCalendarPlacement(db.database).writeTarget({
        familyId: fam.familyId,
        op: 'create',
        familyEventId: null,
        actorUserId: null,
      }),
    ).resolves.toEqual({ writes: false });
  });

  it("never reads another family's connection", async () => {
    vi.stubEnv('GOOGLE_WRITE_SCOPES_ENABLED', 'true');
    const fam = await seedFamily(db.database);
    const other = await seedFamily(db.database, 'Other Family');
    await connect(other.familyId, other.parentUserId, [CALENDAR_EVENTS_SCOPE]);
    await expect(
      createGoogleCalendarPlacement(db.database).writeTarget({
        familyId: fam.familyId,
        op: 'create',
        familyEventId: null,
        actorUserId: null,
      }),
    ).resolves.toEqual({ writes: false });
  });
});
