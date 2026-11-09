import { schema } from '@hale/db';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  PROACTIVE_CANDIDATE_RETENTION_DAYS,
  REMOVED_EPISODE_RETENTION_DAYS,
  sweepRecordRetention,
} from './record-retention';

/**
 * Retention for two records that had no clock, against the real DDL: an episode the
 * parent removed keeps its date and type but loses its words after thirty days, and a
 * proactive candidate row goes after a year whatever it settled as.
 */

const NOW = new Date('2026-11-08T15:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function ago(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

let db: TestDb;
let households = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

async function seedFamily() {
  households += 1;
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: `Household ${households}`, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [parent] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `google_record_retention_${households}` })
    .returning({ id: schema.users.id });
  return { familyId: family?.id as string, parentUserId: parent?.id as string };
}

async function episode(familyId: string, deletedAt: Date | null, summary: string) {
  const [row] = await db.database
    .insert(schema.familyMemoryEpisodes)
    .values({
      familyId,
      occurredAt: ago(60),
      episodeType: 'feed',
      summary,
      payload: { amountMl: 120, note: summary },
      deletedAt,
    })
    .returning({ id: schema.familyMemoryEpisodes.id });
  return row?.id as string;
}

async function episodeRow(id: string) {
  const [row] = await db.database
    .select({
      summary: schema.familyMemoryEpisodes.summary,
      payload: schema.familyMemoryEpisodes.payload,
      occurredAt: schema.familyMemoryEpisodes.occurredAt,
      episodeType: schema.familyMemoryEpisodes.episodeType,
      deletedAt: schema.familyMemoryEpisodes.deletedAt,
    })
    .from(schema.familyMemoryEpisodes)
    .where(eq(schema.familyMemoryEpisodes.id, id));
  return row;
}

async function candidate(
  family: { familyId: string; parentUserId: string },
  input: {
    status: 'queued' | 'held' | 'dropped' | 'sent' | 'shadowed';
    createdAt: Date;
    key: string;
  },
) {
  const settled = input.status !== 'queued' && input.status !== 'held';
  await db.database.insert(schema.proactiveCandidates).values({
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    kind: 'travel_brief',
    category: 'activity_followup',
    templateKey: 'travel_brief',
    what: settled ? '' : 'the swim class moved',
    why: 'travel_brief',
    sourceUrl: 'https://example.org/program',
    dedupeKey: input.key,
    status: input.status,
    createdAt: input.createdAt,
    decidedAt: settled ? input.createdAt : null,
  });
}

async function candidateKeys(familyId: string) {
  const rows = await db.database
    .select({ key: schema.proactiveCandidates.dedupeKey })
    .from(schema.proactiveCandidates)
    .where(eq(schema.proactiveCandidates.familyId, familyId))
    .orderBy(asc(schema.proactiveCandidates.dedupeKey));
  return rows.map((row) => row.key);
}

describe('sweepRecordRetention: removed episodes', () => {
  it('blanks the words of an episode removed more than thirty days ago, keeping date and type', async () => {
    expect(REMOVED_EPISODE_RETENTION_DAYS).toBe(30);
    const { familyId } = await seedFamily();
    const stale = await episode(familyId, ago(31), 'Fed 120 ml after the clinic');
    const recent = await episode(familyId, ago(29), 'Fed 90 ml');
    const live = await episode(familyId, null, 'Fed 60 ml');

    const summary = await sweepRecordRetention(db.database, NOW);

    expect(summary.removedEpisodesBlanked).toBe(1);
    const blanked = await episodeRow(stale);
    expect(blanked).toEqual({
      summary: '',
      payload: {},
      occurredAt: ago(60),
      episodeType: 'feed',
      deletedAt: ago(31),
    });
    // Positive controls: inside the window, and never removed, keep every word.
    expect((await episodeRow(recent))?.summary).toBe('Fed 90 ml');
    expect((await episodeRow(recent))?.payload).toEqual({ amountMl: 120, note: 'Fed 90 ml' });
    expect((await episodeRow(live))?.summary).toBe('Fed 60 ml');

    expect((await sweepRecordRetention(db.database, NOW)).removedEpisodesBlanked).toBe(0);
  });

  it('stops at the batch cap and finishes on the next run', async () => {
    const { familyId } = await seedFamily();
    for (let i = 0; i < 3; i += 1) await episode(familyId, ago(40), `Napped ${i}`);
    expect(
      (await sweepRecordRetention(db.database, NOW, { batchSize: 2 })).removedEpisodesBlanked,
    ).toBe(2);
    expect(
      (await sweepRecordRetention(db.database, NOW, { batchSize: 2 })).removedEpisodesBlanked,
    ).toBe(1);
  });
});

describe('sweepRecordRetention: proactive candidates', () => {
  it('deletes a candidate row older than a year whatever it settled as, and keeps a younger one', async () => {
    expect(PROACTIVE_CANDIDATE_RETENTION_DAYS).toBe(365);
    const family = await seedFamily();
    for (const status of ['shadowed', 'dropped', 'sent', 'queued', 'held'] as const) {
      await candidate(family, { status, createdAt: ago(366), key: `old:${status}` });
      await candidate(family, { status, createdAt: ago(364), key: `young:${status}` });
    }

    const summary = await sweepRecordRetention(db.database, NOW);

    expect(summary.proactiveCandidatesDeleted).toBe(5);
    expect(await candidateKeys(family.familyId)).toEqual([
      'young:dropped',
      'young:held',
      'young:queued',
      'young:sent',
      'young:shadowed',
    ]);
    expect((await sweepRecordRetention(db.database, NOW)).proactiveCandidatesDeleted).toBe(0);
  });
});
