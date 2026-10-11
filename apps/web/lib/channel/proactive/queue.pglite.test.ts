import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { type CandidateDraft, handOffProactive, isQueuedForDecider } from './queue';

let db: TestDb;
let family: { familyId: string; parentUserId: string };

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec('truncate table families, users cascade');
  family = await seedFamily(db.database);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function draft(dedupeKey = 'nudge:weather:w41'): CandidateDraft {
  return {
    familyId: family.familyId,
    parentUserId: family.parentUserId,
    kind: 'nudge',
    category: 'nudge',
    templateKey: 'proactive_nudge:weather_swap',
    what: 'Rain on Saturday, so the indoor climbing gym by the river.',
    why: 'weather_swap',
    sourceUrl: 'https://example.test/climb',
    worthlessAfter: null,
    parentRequested: false,
    dedupeKey,
  };
}

async function rows() {
  return db.database
    .select()
    .from(schema.proactiveCandidates)
    .where(eq(schema.proactiveCandidates.familyId, family.familyId));
}

describe('handOffProactive', () => {
  it('sends and writes nothing while the flag is unset', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', undefined);
    await expect(handOffProactive(db.database, [draft()], 'candidate')).resolves.toBe('send');
    expect(await rows()).toEqual([]);
  });

  it('records the candidate in shadow and still lets the old path send', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await expect(handOffProactive(db.database, [draft()], 'candidate')).resolves.toBe('send');
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      status: 'queued',
      kind: 'nudge',
      category: 'nudge',
      templateKey: 'proactive_nudge:weather_swap',
      dedupeKey: 'nudge:weather:w41',
      sourceUrl: 'https://example.test/climb',
      parentRequested: false,
    });
  });

  it('queues instead of sending when live, once per dedupe key', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    await expect(handOffProactive(db.database, [draft()], 'candidate')).resolves.toBe('queued');
    await expect(handOffProactive(db.database, [draft()], 'candidate')).resolves.toBe('queued');
    expect(await rows()).toHaveLength(1);
  });

  it('lets an immediate item through in every mode without a row', async () => {
    for (const mode of ['shadow', 'live']) {
      vi.stubEnv('PROACTIVE_CADENCE', mode);
      await expect(handOffProactive(db.database, [draft()], 'immediate')).resolves.toBe('send');
    }
    expect(await rows()).toEqual([]);
  });
});

describe('isQueuedForDecider', () => {
  it('is false while not live, and true for a live-queued key whatever its status', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    await handOffProactive(db.database, [draft('k1')], 'candidate');
    expect(await isQueuedForDecider(db.database, family.familyId, 'k1')).toBe(false);

    vi.stubEnv('PROACTIVE_CADENCE', 'live');
    expect(await isQueuedForDecider(db.database, family.familyId, 'k1')).toBe(true);
    expect(await isQueuedForDecider(db.database, family.familyId, 'k2')).toBe(false);
    await db.database
      .update(schema.proactiveCandidates)
      .set({ status: 'dropped' })
      .where(eq(schema.proactiveCandidates.dedupeKey, 'k1'));
    expect(await isQueuedForDecider(db.database, family.familyId, 'k1')).toBe(true);
  });
});
