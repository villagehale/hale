import { randomUUID } from 'node:crypto';
import { registrationSourceState, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { legDedupeKey, loadLiveSequences } from './run';

describe('registration catalog retirement', () => {
  let db: TestDb;

  beforeAll(async () => {
    // Cold migration replay belongs under the existing database setup timeout.
    db = await createTestDb('0172_registration_live_watch_storage.sql');
  });

  it('preserves approved watch, outcome clock and delivered identity while dropping unused catalog rows', async () => {
    try {
      const family = await seedFamily(db.database, 'Imported watch');
      const ids = [randomUUID(), randomUUID()];
      const at = new Date('2026-10-20T04:00:00Z');
      for (const id of ids)
        await db.client.query(
          `INSERT INTO registration_windows (id, municipality, program_domain, cycle_label, open_at, source_url, verified_at, waitlist_response_hours)
         VALUES ($1, 'richmond_hill', 'swim', $3, $2, 'https://example.org/registration', $2, 36)`,
          [id, at.toISOString(), id],
        );
      const [event] = await db.database
        .insert(schema.events)
        .values({
          familyId: family.familyId,
          source: 'test',
          eventType: 'registration',
          dedupHash: randomUUID(),
        })
        .returning();
      const [action] = await db.database
        .insert(schema.actions)
        .values({
          familyId: family.familyId,
          eventId: event!.id,
          actionType: 'add_to_digest_only',
          payload: {},
          executedAt: at,
        })
        .returning();
      const watch = await db.client.query<{ id: string }>(
        `INSERT INTO registration_sequences (family_id, parent_user_id, window_id, action_id, outcome, waitlist_started_at, waitlist_position, readiness_ready)
         VALUES ($1, $2, $3, $4, 'waitlisted', $5, 12, true) RETURNING id`,
        [family.familyId, family.parentUserId, ids[0], action!.id, at.toISOString()],
      );
      const key = legDedupeKey(family.familyId, ids[0]!, 'go', family.parentUserId);
      await db.database.insert(schema.channelMessages).values({
        ...family,
        direction: 'out',
        channel: 'sms',
        category: 'registration_sequence',
        dedupeKey: key,
        status: 'sent',
        sentAt: at,
      });
      await db.applyMigration('0173_drop_registration_catalog.sql');
      const [stored] = await db.database
        .select()
        .from(schema.registrationSequences)
        .where(eq(schema.registrationSequences.id, watch.rows[0]!.id));
      expect(stored).toMatchObject({
        windowId: ids[0],
        actionId: action!.id,
        courseUrl: 'https://example.org/registration',
        outcome: 'waitlisted',
        waitlistStartedAt: at,
        waitlistPosition: 12,
        readinessReady: true,
      });
      expect(registrationSourceState(stored!.sourceContext)).toMatchObject({
        id: ids[0],
        openAt: at,
        waitlistResponseHours: 36,
      });
      expect((await loadLiveSequences(db.database, stored!.id))[0]).toMatchObject({
        optIn: 'opted_in',
        window: { id: ids[0], openAt: at },
      });
      const delivered = await db.database
        .select()
        .from(schema.channelMessages)
        .where(eq(schema.channelMessages.dedupeKey, key));
      expect(delivered).toHaveLength(1);
      expect(
        (await db.client.query("SELECT to_regclass('registration_windows') AS retired")).rows[0],
      ).toEqual({ retired: null });
    } finally {
      await db.close();
    }
  });
});
