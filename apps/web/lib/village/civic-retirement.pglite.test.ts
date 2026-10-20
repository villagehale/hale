import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { createTestDb, seedFamily } from '~/lib/testing/pglite';
import { defaultIntroSweepDeps } from './intros/run';

it('drops civic catalogs without deleting introductions, watched sources or review identities', async () => {
  const db = await createTestDb('0174_activity_history_only.sql');
  try {
    const first = await seedFamily(db.database);
    const second = await seedFamily(db.database, 'Other fixture');
    const [familyAId, familyBId] = [first.familyId, second.familyId].sort();
    const venueId = randomUUID();
    const sessionId = randomUUID();
    const at = new Date('2026-10-20T14:00:00Z');
    await db.client.query(
      `insert into civic_venues (id, system, external_id, kind, name, source_url)
      values ($1, 'tpl', 'fixture', 'library_branch', 'Fixture branch', 'https://example.org/branch')`,
      [venueId],
    );
    await db.client.query(
      `insert into civic_sessions (id, venue_id, external_id, title, recurrence, starts_at, ends_at, extraction, confidence, source_url)
      values ($1, $2, 'fixture', 'Old storytime', 'occurrence', $3, $4, 'structured', 1, 'https://example.org/storytime')`,
      [sessionId, venueId, at.toISOString(), new Date(at.getTime() + 3_600_000).toISOString()],
    );
    const proposal = await db.client.query<{ id: string }>(
      `insert into village_intro_proposals (family_a_id, family_b_id, fsa, stage, status, civic_session_id, expires_at)
      values ($1, $2, 'M4K', 'toddler', 'proposed', $3, $4) returning id`,
      [familyAId, familyBId, sessionId, at.toISOString()],
    );
    const source = await db.client.query<{ id: string }>(
      `insert into watched_sources (platform, handle, display_name, profile_url, account_type, category, region, ingest_method, tos_risk, civic_venue_id)
      values ('web', 'fixture', 'Fixture venue', 'https://example.org/branch', 'business', 'T1', 'toronto', 'manual', 'official', $1) returning id`,
      [venueId],
    );
    const [receipt] = await db.database
      .insert(schema.familyActivityHistory)
      .values({
        familyId: first.familyId,
        title: 'Saved storytime',
        kind: 'activity',
        summary: 'Historical receipt',
        source: 'web',
        confidence: 1,
        civicVenueId: venueId,
        sourceUrl: 'https://example.org/branch',
      })
      .returning();
    const [message] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId: first.familyId,
        parentUserId: first.parentUserId,
        direction: 'in',
        channel: 'sms',
        category: 'reply',
        status: 'delivered',
        dedupeKey: randomUUID(),
      })
      .returning();
    const [review] = await db.database
      .insert(schema.activityReviews)
      .values({
        familyId: first.familyId,
        sourceMessageId: message!.id,
        subjectSource: 'civic_venue',
        subjectRef: venueId,
        areaKey: 'fsa:M4K',
        verdict: 'worth_it',
      })
      .returning();

    await db.applyMigration('0175_retire_civic_catalog.sql');
    await db.applyMigration('0175_retire_civic_catalog.sql');
    expect(
      (
        await db.client.query(
          "select to_regclass('civic_sessions') as sessions, to_regclass('civic_venues') as venues",
        )
      ).rows,
    ).toEqual([{ sessions: null, venues: null }]);
    const rows = await db.database
      .select()
      .from(schema.villageIntroProposals)
      .where(eq(schema.villageIntroProposals.id, proposal.rows[0]!.id));
    expect(rows[0]).toMatchObject({
      familyAId,
      familyBId,
      status: 'proposed',
      civicSessionId: sessionId,
    });
    expect(
      (
        await db.database
          .select()
          .from(schema.watchedSources)
          .where(eq(schema.watchedSources.id, source.rows[0]!.id))
      )[0]?.civicVenueId,
    ).toBe(venueId);
    expect(
      (
        await db.database
          .select()
          .from(schema.familyActivityHistory)
          .where(eq(schema.familyActivityHistory.id, receipt!.id))
      )[0]?.civicVenueId,
    ).toBe(venueId);
    expect(
      (
        await db.database
          .select()
          .from(schema.activityReviews)
          .where(eq(schema.activityReviews.id, review!.id))
      )[0],
    ).toMatchObject({ subjectRef: venueId, verdict: 'worth_it' });
    const live = await defaultIntroSweepDeps().loadLiveProposals(db.database, new Date());
    expect(live.find((row) => row.id === proposal.rows[0]!.id)).toMatchObject({
      anchorTitle: null,
      anchorStartsAt: null,
    });
    expect(
      await defaultIntroSweepDeps().loadAnchorSession(db.database, ['M4K'], new Date()),
    ).toBeNull();
  } finally {
    await db.close();
  }
}, 30_000);
