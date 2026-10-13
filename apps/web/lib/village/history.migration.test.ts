import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestDb, seedFamily } from '~/lib/testing/pglite';

describe('activity history migration', () => {
  it('preserves owned receipts, provenance and engagement IDs, discards the unused catalog', async () => {
    const db = await createTestDb('0162_drop_registration_catalog.sql');
    try {
      const { familyId, parentUserId } = await seedFamily(db.database);
      const other = await seedFamily(db.database, 'Other family');
      const [saved, endorsed, shared, placed, unused, foreign] = Array.from({ length: 6 }, () =>
        randomUUID(),
      );
      const saveId = randomUUID();
      const endorsementId = randomUUID();
      for (const id of [saved, endorsed, shared, placed, unused, foreign]) {
        await db.database.execute(sql`
          insert into village_candidates (id, family_id, title, kind, summary, source_url, source, confidence, share_token, event_date)
          values (${id}, ${familyId}, 'Earlier swim', 'class', 'Opens October 20 at 9 AM', 'https://example.org/swim', 'web_grounded', 0.9, ${id === shared ? 'shared-token' : null}, '2026-10-20')
        `);
      }
      await db.database.execute(
        sql`insert into village_saves (id, candidate_id, family_id, saved_by_user_id) values (${saveId}, ${saved}, ${familyId}, ${parentUserId})`,
      );
      await db.database.execute(
        sql`insert into village_endorsements (id, candidate_id, family_id, endorsed_by_user_id) values (${endorsementId}, ${endorsed}, ${familyId}, ${parentUserId})`,
      );
      for (const [owner, candidate] of [
        [familyId, placed],
        [other.familyId, foreign],
      ]) {
        const eventId = randomUUID();
        await db.database.execute(
          sql`insert into events (id, family_id, source, event_type, dedup_hash) values (${eventId}, ${owner}, 'coach', 'calendar_add', ${eventId})`,
        );
        const payload = JSON.stringify({
          sourceRef: { table: 'village_candidates', id: candidate },
        });
        await db.database.execute(
          sql`insert into actions (event_id, family_id, action_type, payload) values (${eventId}, ${owner}, 'calendar_add', ${payload}::jsonb)`,
        );
      }

      await db.applyMigration('0163_activity_history_only.sql');

      const receipts = await db.client.query<{
        id: string;
        offered_at: string | null;
        family_id: string;
      }>('select id, offered_at, family_id from family_activity_history');
      expect(receipts.rows.map((row) => row.id).sort()).toEqual(
        [saved, endorsed, shared, placed].sort(),
      );
      expect(
        receipts.rows.every((row) => row.offered_at === null && row.family_id === familyId),
      ).toBe(true);
      expect((await db.client.query('select id from village_saves')).rows).toEqual([
        { id: saveId },
      ]);
      expect((await db.client.query('select id from village_endorsements')).rows).toEqual([
        { id: endorsementId },
      ]);
      expect(
        (
          await db.client.query(
            'select share_token from family_activity_history where share_token is not null',
          )
        ).rows,
      ).toEqual([{ share_token: 'shared-token' }]);
      expect(
        (
          await db.client.query(
            "select to_regclass('village_candidates') as catalog, to_regclass('village_feed_rank') as rank",
          )
        ).rows,
      ).toEqual([{ catalog: null, rank: null }]);
      // Family erasure still cascades through the migrated history and saved state.
      await db.database.execute(sql`delete from families where id = ${familyId}`);
      expect((await db.client.query('select id from family_activity_history')).rows).toEqual([]);
      expect((await db.client.query('select id from village_saves')).rows).toEqual([]);
    } finally {
      await db.close();
    }
  }, 30_000);
});
