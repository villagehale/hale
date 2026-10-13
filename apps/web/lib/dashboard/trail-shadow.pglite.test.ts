import { schema } from '@hale/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { loadTrailForFamily } from './trail-query';

/**
 * VIL-226 · while PROACTIVE_CADENCE is `shadow` the decider governs nothing that reaches
 * the phone, so the rows it writes there are not on the parent's receipts at all. The
 * audit rows themselves stay; the same verbs written live still read as their sentence.
 */

const SHADOW_VERBS = [
  'proactive_cadence_decision',
  'proactive_cadence_held',
  'proactive_cadence_skipped',
] as const;

let db: TestDb;
let familyId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec('truncate table families, users cascade');
  ({ familyId } = await seedFamily(db.database));
});

/** loadTrailForFamily reads the newest 50 rows. */
const TRAIL_WINDOW_ROWS = 50;

async function write(
  actionTaken: string,
  mode: 'shadow' | 'live',
  occurredAt = new Date(),
): Promise<void> {
  await db.database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken,
    targetTable: 'families',
    targetId: familyId,
    after: { mode },
    occurredAt,
  });
}

describe('the receipts trail · proactive cadence rows', () => {
  it('shows no row the decider wrote in shadow, and keeps the audit rows', async () => {
    for (const verb of SHADOW_VERBS) await write(verb, 'shadow');

    expect(await loadTrailForFamily(db.database, familyId)).toEqual([]);
    expect(await db.database.select().from(schema.auditLog)).toHaveLength(SHADOW_VERBS.length);
  });

  it('keeps a live row on the receipts behind more shadow rows than the trail reads', async () => {
    const start = Date.parse('2026-10-08T16:00:00.000Z');
    await write('proactive_cadence_held', 'live', new Date(start));
    for (let i = 1; i <= TRAIL_WINDOW_ROWS + 1; i += 1) {
      await write('proactive_cadence_decision', 'shadow', new Date(start + i * 60_000));
    }

    const summaries = (await loadTrailForFamily(db.database, familyId)).map((row) => row.summary);
    expect(summaries).toEqual(['Hale held a text for a better moment']);
  });

  it('still renders each of those verbs written live as its sentence', async () => {
    for (const verb of SHADOW_VERBS) await write(verb, 'live');

    const summaries = (await loadTrailForFamily(db.database, familyId)).map((row) => row.summary);
    expect(new Set(summaries)).toEqual(
      new Set([
        'Hale decided whether now was a good time to text you',
        'Hale held a text for a better moment',
        'Hale looked at what it had set aside and did not text you',
      ]),
    );
  });
});
