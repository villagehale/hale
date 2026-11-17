import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { parentSeasonClock, readParentClock } from './family-tz';

const FLAG = { FAMILY_TZ_RESOLVE_ENABLED: 'true' };
const BOUNDARY = new Date('2026-10-01T00:00:00.000Z');

describe('0258 family timezone backfill', () => {
  let db: TestDb;

  afterAll(async () => {
    await db?.close();
  });

  async function zoneOf(userId: string) {
    const { rows } = await db.client.query<{
      timezone: string;
      resolved_timezone: string | null;
      timezone_source: string | null;
    }>('select timezone, resolved_timezone, timezone_source from users where id = $1', [userId]);
    return rows[0];
  }

  it('fills resolved_timezone from a place, a metro, and a region, and leaves a set zone', async () => {
    db = await createTestDb('0257_family_signup_help_seasons.sql');
    const postal = await seedFamily(db.database, 'Postal');
    const metro = await seedFamily(db.database, 'Metro');
    const region = await seedFamily(db.database, 'Region');
    const kept = await seedFamily(db.database, 'Kept');
    const empty = await seedFamily(db.database, 'Empty');
    const zip = await seedFamily(db.database, 'Zip');

    await db.exec(`
      update families set country = 'Canada', country_code = 'CA',
        postal_code = 'M5V 2T6', area_coarse = 'M5V', city = null, province = null
        where id = '${postal.familyId}';
      update families set country = 'Canada', country_code = 'CA',
        postal_code = null, area_coarse = null, city = 'Toronto', province = 'Ontario'
        where id = '${metro.familyId}';
      update families set country = 'Canada', country_code = 'CA',
        postal_code = null, area_coarse = null, city = null, province = 'Alberta'
        where id = '${region.familyId}';
      update users set timezone = 'America/Chicago' where id = '${kept.parentUserId}';
      update families set country = 'United States', country_code = 'US',
        postal_code = '90210', area_coarse = '90210', city = null, province = 'California'
        where id = '${zip.familyId}';
    `);

    await db.applyMigration('0258_family_timezone_resolved.sql');
    await db.applyMigration('0258_family_timezone_resolved.sql');

    expect(await zoneOf(postal.parentUserId)).toMatchObject({
      timezone: 'UTC',
      resolved_timezone: 'America/Toronto',
      timezone_source: 'place',
    });
    expect(await zoneOf(metro.parentUserId)).toMatchObject({
      timezone: 'UTC',
      resolved_timezone: 'America/Toronto',
      timezone_source: 'metro',
    });
    expect(await zoneOf(region.parentUserId)).toMatchObject({
      timezone: 'UTC',
      resolved_timezone: 'America/Edmonton',
      timezone_source: 'stated',
    });
    expect(await zoneOf(zip.parentUserId)).toMatchObject({
      timezone: 'UTC',
      resolved_timezone: 'America/Los_Angeles',
      timezone_source: 'place',
    });
    expect(await zoneOf(kept.parentUserId)).toMatchObject({
      timezone: 'America/Chicago',
      resolved_timezone: null,
      timezone_source: null,
    });
    expect(await zoneOf(empty.parentUserId)).toMatchObject({
      timezone: 'UTC',
      resolved_timezone: null,
    });

    const stored = await parentSeasonClock(db.database, kept.parentUserId, BOUNDARY, FLAG);
    expect(stored).toMatchObject({
      outcome: 'season',
      timeZone: 'America/Chicago',
      key: '2026-fall',
    });

    const unset = await parentSeasonClock(db.database, empty.parentUserId, BOUNDARY, FLAG);
    expect(unset).toEqual({ outcome: 'timezone_unset' });

    const backfilled = await readParentClock(db.database, postal.parentUserId, FLAG);
    expect(backfilled).toMatchObject({ kind: 'zone', timeZone: 'America/Toronto' });

    const co = await db.client.query<{ id: string }>(
      `insert into users (email, name, timezone) values ('co-tz@example.test', 'Co', 'America/Chicago') returning id`,
    );
    const coId = co.rows[0]?.id;
    expect(coId).toBeTruthy();
    await db.database.insert(schema.familyMembers).values({
      familyId: empty.familyId,
      userId: coId as string,
      role: 'co_parent',
    });
    const household = await readParentClock(db.database, empty.parentUserId, FLAG);
    expect(household).toMatchObject({
      kind: 'zone',
      timeZone: 'America/Chicago',
      source: 'household',
    });
    expect(await zoneOf(empty.parentUserId)).toMatchObject({
      timezone: 'UTC',
      resolved_timezone: 'America/Chicago',
      timezone_source: 'household',
    });
    const audited = await db.database
      .select({ action: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, empty.familyId));
    expect(audited.map((row) => row.action)).toContain('timezone_resolved');
  }, 30_000);
});
