import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveRegistrationReading } from '~/lib/registration/live-reading';
import { assembleFamilyExport } from '~/lib/rights/export';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { registrationSourceFixture } from '~/lib/testing/registration-source';
import { loadClaimedWindowIds } from './claims';
import { claimRegistrationWatch, recordRegistrationRead } from './watch-storage';

const MIGRATION = '0172_registration_live_watch_storage.sql';
const NOW = new Date('2026-10-10T12:00:00Z');
let db: TestDb;
let familyId: string;
let parentUserId: string;
let childId: string;
let legacyId: string;
let legacyWindowId: string;
let legacyActionId: string;

beforeAll(async () => {
  db = await createTestDb('0160_kid_interests.sql');
  ({ familyId, parentUserId } = await seedFamily(db.database, 'Registration watch family'));
  const child = await db.client.query<{ id: string }>(
    'INSERT INTO children (family_id, name, date_of_birth) VALUES ($1, $2, $3) RETURNING id',
    [familyId, 'Maya', '2022-05-01'],
  );
  childId = child.rows[0]?.id ?? '';
  const window = await db.client.query<{ id: string }>(
    `INSERT INTO registration_windows (municipality, program_domain, cycle_label, open_at, source_url, verified_at)
     VALUES ('markham', 'swim', 'Fall 2026', $1, 'https://example.test/legacy', $1) RETURNING id`,
    [NOW.toISOString()],
  );
  legacyWindowId = window.rows[0]?.id ?? '';
  const event = await db.client.query<{ id: string }>(
    `INSERT INTO events (family_id, source, event_type, dedup_hash)
     VALUES ($1, 'test', 'registration_shortlist', 'legacy-registration-watch') RETURNING id`,
    [familyId],
  );
  const action = await db.client.query<{ id: string }>(
    `INSERT INTO actions (family_id, event_id, action_type, payload, executed_at)
     VALUES ($1, $2, 'send_message', '{}', $3) RETURNING id`,
    [familyId, event.rows[0]?.id, NOW.toISOString()],
  );
  legacyActionId = action.rows[0]?.id ?? '';
  const legacy = await db.client.query<{ id: string }>(
    `INSERT INTO registration_sequences (family_id, parent_user_id, window_id, action_id, outcome, readiness_ready)
     VALUES ($1, $2, $3, $4, 'registered', true) RETURNING id`,
    [familyId, parentUserId, legacyWindowId, legacyActionId],
  );
  legacyId = legacy.rows[0]?.id ?? '';
  await db.applyMigration(MIGRATION);
  await db.applyMigration('0173_drop_registration_catalog.sql');
});

afterAll(async () => {
  await db.close();
});

function claim(sourceUrl: string) {
  return claimRegistrationWatch(db.database, {
    familyId,
    parentUserId,
    childId,
    sourceUrl,
    now: NOW,
  });
}

function reading(sourceUrl: string, checkedAt = NOW): LiveRegistrationReading {
  return {
    sourceUrl,
    checkedAt,
    timeZone: 'Europe/London',
    reader: 'ai',
    status: 'verified',
    dates: [
      {
        kind: 'general_open',
        date: '2026-10-20',
        time: null,
        evidence: ['Registration opens 20 October 2026'],
      },
    ],
  };
}

async function sequence(id: string) {
  const [row] = await db.database
    .select()
    .from(schema.registrationSequences)
    .where(eq(schema.registrationSequences.id, id));
  if (!row) throw new Error('expected watch row');
  return row;
}

describe('registration watch storage migration', () => {
  it('preserves watch identity, opt-in and outcome while dropping the global catalog', async () => {
    const row = await sequence(legacyId);
    expect(row).toMatchObject({
      windowId: legacyWindowId,
      outcome: 'registered',
      readinessReady: true,
      actionId: legacyActionId,
    });
    expect(row.lastReading).toBeNull();
    expect(row.nextCheckAt).toBeInstanceOf(Date);
    expect(row.courseUrl).toBe('https://example.test/legacy');
    expect(row.sourceContext).toMatchObject({
      id: legacyWindowId,
      municipality: 'markham',
      sourceUrl: 'https://example.test/legacy',
    });
    expect(
      (await db.client.query("SELECT to_regclass('registration_windows') AS retired")).rows[0],
    ).toEqual({ retired: null });
    expect(row.dateReviewActionId).toBeNull();
  });

  it('stores a long public URL with no window, date or implicit approval', async () => {
    const sourceUrl = `https://classes.example.test/uk-swim?course=${'a'.repeat(240)}`;
    const watch = await claim(sourceUrl);
    expect(watch.created).toBe(true);
    expect(await sequence(watch.sequenceId)).toMatchObject({
      familyId,
      parentUserId,
      childId,
      courseUrl: sourceUrl,
      windowId: null,
      courseOpensAt: null,
      actionId: null,
      nextCheckAt: NOW,
    });
    expect(await loadClaimedWindowIds(db.database, familyId)).toEqual(new Set([legacyWindowId]));
  });

  it('reuses a live URL for repeat and concurrent requests without changing approval', async () => {
    const url = 'https://classes.example.test/repeat';
    const watches = await Promise.all([claim(url), claim(url)]);
    expect(new Set(watches.map((watch) => watch.sequenceId)).size).toBe(1);
    expect(watches.filter((watch) => watch.created)).toHaveLength(1);
    expect((await claim(url)).created).toBe(false);
    expect((await sequence(watches[0]?.sequenceId ?? '')).actionId).toBeNull();
  });

  it('keeps ended watches in history when the same URL is watched again', async () => {
    const url = 'https://classes.example.test/next-season';
    const first = await claim(url);
    await db.database
      .update(schema.registrationSequences)
      .set({ outcome: 'registered' })
      .where(eq(schema.registrationSequences.id, first.sequenceId));
    const second = await claim(url);
    expect(second.created).toBe(true);
    expect(second.sequenceId).not.toBe(first.sequenceId);
    expect((await sequence(first.sequenceId)).outcome).toBe('registered');
  });

  it('reuses a legacy bound sequence without changing its original opt-in', async () => {
    const sourceUrl = 'https://classes.example.test/legacy-bound';
    const window = registrationSourceFixture({
      municipality: 'markham',
      programDomain: 'swim',
      cycleLabel: 'Legacy bound cycle',
      openAt: NOW,
      sourceUrl,
      verifiedAt: NOW,
    });
    const [existing] = await db.database
      .insert(schema.registrationSequences)
      .values({
        familyId,
        parentUserId,
        windowId: window.id,
        sourceContext: window,
        courseUrl: sourceUrl,
        courseOpensAt: NOW,
        actionId: legacyActionId,
      })
      .returning({ id: schema.registrationSequences.id });
    const watch = await claim(sourceUrl);
    expect(watch).toEqual({ sequenceId: existing?.id, created: false });
    expect((await sequence(watch.sequenceId)).actionId).toBe(legacyActionId);
  });

  it('enforces live URL uniqueness in SQL, including waitlisted watches', async () => {
    const sourceUrl = 'https://classes.example.test/waitlisted';
    const watch = await claim(sourceUrl);
    await db.database
      .update(schema.registrationSequences)
      .set({ outcome: 'waitlisted' })
      .where(eq(schema.registrationSequences.id, watch.sequenceId));
    await expect(
      db.database
        .insert(schema.registrationSequences)
        .values({ familyId, parentUserId, courseUrl: sourceUrl }),
    ).rejects.toThrow(/registration_sequences_live_url_uniq/);
    expect((await claim(sourceUrl)).sequenceId).toBe(watch.sequenceId);
  });

  it('keeps the same URL independent across families', async () => {
    const sourceUrl = 'https://classes.example.test/shared-source';
    const first = await claim(sourceUrl);
    const other = await seedFamily(db.database, 'Independent watch family');
    const second = await claimRegistrationWatch(db.database, {
      ...other,
      sourceUrl,
      now: NOW,
    });
    expect(second.created).toBe(true);
    expect(second.sequenceId).not.toBe(first.sequenceId);
  });

  it('does not merge different classes identified by a hash route', async () => {
    const swim = 'https://classes.example.test/#/classes/swim';
    const chess = 'https://classes.example.test/#/classes/chess';
    const first = await claim(swim);
    const second = await claim(chess);
    expect(second.sequenceId).not.toBe(first.sequenceId);
    expect((await sequence(first.sequenceId)).courseUrl).toBe(swim);
  });

  it('refuses another family’s parent or child before creating a watch', async () => {
    const other = await seedFamily(db.database, 'Unrelated registration family');
    const input = {
      familyId,
      parentUserId,
      childId,
      sourceUrl: 'https://classes.example.test/private',
      now: NOW,
    };
    await expect(
      claimRegistrationWatch(db.database, { ...input, parentUserId: other.parentUserId }),
    ).rejects.toThrow(/parent outside family/);
    await expect(
      claimRegistrationWatch(db.database, {
        ...input,
        familyId: other.familyId,
        parentUserId: other.parentUserId,
      }),
    ).rejects.toThrow(/child outside family/);
  });

  it('refuses credentials, insecure URLs and URLs over the storage bound', async () => {
    await expect(claim('https://name:password@classes.example.test/course')).rejects.toThrow(
      /credential-free HTTPS/,
    );
    await expect(claim('http://classes.example.test/course')).rejects.toThrow(
      /credential-free HTTPS/,
    );
    await expect(claim(`https://classes.example.test/${'a'.repeat(2048)}`)).rejects.toThrow(
      /URL too long/,
    );
  });

  it('round-trips the unified reading without inventing a date-only timestamp', async () => {
    const sourceUrl = 'https://classes.example.test/reading';
    const watch = await claim(sourceUrl);
    const result = await recordRegistrationRead(db.database, {
      familyId,
      sequenceId: watch.sequenceId,
      reading: reading(sourceUrl),
      nextCheckAt: new Date('2026-10-11T12:00:00Z'),
    });
    expect(result).toBe(true);
    expect(await sequence(watch.sequenceId)).toMatchObject({
      lastReading: { ...reading(sourceUrl), checkedAt: NOW.toISOString() },
      lastReadAt: NOW,
      nextCheckAt: new Date('2026-10-11T12:00:00Z'),
      courseOpensAt: null,
    });
  });

  it('cannot overwrite a read for another family, another URL or with older bytes', async () => {
    const sourceUrl = 'https://classes.example.test/guards';
    const watch = await claim(sourceUrl);
    const other = await seedFamily(db.database, 'Other watch family');
    const input = {
      familyId,
      sequenceId: watch.sequenceId,
      reading: reading(sourceUrl),
      nextCheckAt: NOW,
    };
    expect(await recordRegistrationRead(db.database, input)).toBe(true);
    expect(await recordRegistrationRead(db.database, { ...input, familyId: other.familyId })).toBe(
      false,
    );
    expect(
      await recordRegistrationRead(db.database, {
        ...input,
        reading: reading('https://classes.example.test/different'),
      }),
    ).toBe(false);
    expect(
      await recordRegistrationRead(db.database, {
        ...input,
        reading: reading(sourceUrl, new Date('2026-10-09T12:00:00Z')),
      }),
    ).toBe(false);
    expect((await sequence(watch.sequenceId)).lastReadAt).toEqual(NOW);
  });

  it('records an unreadable result without erasing the schedule or pending change', async () => {
    const sourceUrl = 'https://classes.example.test/held-change';
    const watch = await claim(sourceUrl);
    const pendingChange = {
      kind: 'later',
      previousDate: '2026-10-20',
      candidate: { ...reading(sourceUrl), checkedAt: NOW.toISOString() },
    };
    await db.database
      .update(schema.registrationSequences)
      .set({
        courseOpensAt: new Date('2026-10-20T08:00:00Z'),
        pausedAt: NOW,
        pendingChange,
      })
      .where(eq(schema.registrationSequences.id, watch.sequenceId));
    await recordRegistrationRead(db.database, {
      familyId,
      sequenceId: watch.sequenceId,
      reading: {
        sourceUrl,
        checkedAt: NOW,
        timeZone: null,
        reader: 'ai',
        status: 'unreadable',
        reason: 'fetch_failed',
      },
      nextCheckAt: new Date('2026-10-10T13:00:00Z'),
    });
    expect(await sequence(watch.sequenceId)).toMatchObject({
      courseOpensAt: new Date('2026-10-20T08:00:00Z'),
      pausedAt: NOW,
      pendingChange,
      lastReading: { status: 'unreadable', reason: 'fetch_failed' },
    });
  });

  it('rejects a watch with neither URL nor window, or an anchor without a URL', async () => {
    await expect(
      db.database.insert(schema.registrationSequences).values({ familyId, parentUserId }),
    ).rejects.toThrow(/registration_sequences_target_check/);
    await expect(
      db.database
        .insert(schema.registrationSequences)
        .values({ familyId, parentUserId, windowId: legacyWindowId, courseOpensAt: NOW }),
    ).rejects.toThrow(/registration_sequences_course_check/);
  });

  it('keeps date-review approval separate from the original subscription', async () => {
    const sourceUrl = 'https://classes.example.test/date-review';
    const watch = await claim(sourceUrl);
    await expect(
      db.database
        .update(schema.registrationSequences)
        .set({ dateReviewActionId: legacyActionId })
        .where(eq(schema.registrationSequences.id, watch.sequenceId)),
    ).rejects.toThrow(/registration_sequences_date_review_check/);
    await db.database
      .update(schema.registrationSequences)
      .set({
        pendingChange: { kind: 'later', candidateDate: '2026-10-23' },
        dateReviewActionId: legacyActionId,
      })
      .where(eq(schema.registrationSequences.id, watch.sequenceId));
    expect(await sequence(watch.sequenceId)).toMatchObject({
      actionId: null,
      dateReviewActionId: legacyActionId,
    });
  });

  it('exports a URL-only watch without omitting it or disclosing the link or quote', async () => {
    const sourceUrl = 'https://exports.example.test/course?child-class=private';
    const watch = await claim(sourceUrl);
    await recordRegistrationRead(db.database, {
      familyId,
      sequenceId: watch.sequenceId,
      reading: reading(sourceUrl),
      nextCheckAt: NOW,
    });
    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentUserId,
      loadTrail: async () => [],
      now: NOW,
    });
    expect(doc.registrationPreparation).toContainEqual({
      municipality: null,
      cycleLabel: null,
      courseHost: 'exports.example.test',
      courseOpensAt: null,
      readinessReady: null,
      lastReadAt: NOW.toISOString(),
      nextCheckAt: NOW.toISOString(),
      pausedAt: null,
      hasPendingChange: false,
      updatedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(doc)).not.toContain('child-class=private');
    expect(JSON.stringify(doc)).not.toContain('Registration opens 20 October');
  });

  it('keeps RLS and an atomic audit for each created watch and persisted read', async () => {
    const rows = await db.client.query<{ relrowsecurity: boolean }>(
      "SELECT relrowsecurity FROM pg_class WHERE relname = 'registration_sequences'",
    );
    expect(rows.rows[0]?.relrowsecurity).toBe(true);
    const audits = await db.database
      .select({ action: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, familyId),
          eq(schema.auditLog.targetTable, 'registration_sequences'),
        ),
      );
    expect(audits.some((row) => row.action === 'registration_watch_created')).toBe(true);
    expect(audits.some((row) => row.action === 'registration_watch_read')).toBe(true);
  });
});
