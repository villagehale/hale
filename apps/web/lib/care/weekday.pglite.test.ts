import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readCandidates } from '~/lib/channel/intake/radar';
import { CIVIC_SOURCE } from '~/lib/civic/project';
import { writeFact } from '~/lib/memory/facts';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  WEEKDAY_CARE_FACT_KEY,
  WEEKDAY_CARE_FACT_WRITER,
  loadWeekdayCare,
} from './weekday';

/**
 * The two READS the weekday legs rest on, against real Postgres and through the
 * production functions — because both are the kind of claim a hand-rolled Drizzle
 * fake cannot make.
 *
 * `loadWeekdayCare`'s whole safety property is a WHERE clause: `family_memory_facts`
 * is writable by the app coach's `save_memory` tool under any key a model likes, so a
 * reader that matched only the key would let one injected sentence change what Hale
 * offers a household for months. A fake returns whatever rows it was handed and would
 * pass with the pin removed.
 *
 * `readCandidates` is here for the sibling reason (the "pin production wiring" rule):
 * the weekday claim rests on `village_candidates.source`, and a column the reader does
 * not SELECT is a gate that silently always fails. The decide's own suite cannot see
 * that, because it is handed candidates directly.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  await db.exec('truncate table families, users cascade');
});

const NOW = new Date('2026-09-14T14:00:00.000Z');

async function seedFamily(): Promise<{ familyId: string; childId: string }> {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const familyId = family?.id as string;
  const [child] = await db.database
    .insert(schema.children)
    .values({ familyId, name: 'Mia', dateOfBirth: '2024-03-02' })
    .returning({ id: schema.children.id });
  return { familyId, childId: child?.id as string };
}

describe('loadWeekdayCare', () => {
  it('returns the live fact this feature wrote, with its care and its provider', async () => {
    const { familyId, childId } = await seedFamily();
    await writeFact(db.database, {
      familyId,
      childId,
      factType: 'logistic',
      factKey: WEEKDAY_CARE_FACT_KEY,
      factValue: { care: 'daycare', provider: 'Little Sprouts' },
      confidence: 1,
      inferredBy: WEEKDAY_CARE_FACT_WRITER,
      validFrom: NOW,
    });

    expect(await loadWeekdayCare(db.database, familyId)).toEqual([
      { childId, care: 'daycare', provider: 'Little Sprouts', validFrom: NOW },
    ]);
  });

  /**
   * THE WRITER PIN, with its decoy beside it. `ask-hale` is the app coach's memory
   * tool, which chooses its own `fact_key` from a model's output — so the decoy row
   * here is a row a single injected sentence could really produce.
   */
  it('is blind to a row written under the same key by the app coach', async () => {
    const { familyId, childId } = await seedFamily();
    const [other] = await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Leo', dateOfBirth: '2022-05-09' })
      .returning({ id: schema.children.id });
    // The decoy: same family, same key, a DIFFERENT child so the partial unique index
    // lets both live at once — exactly the state an injection would leave behind.
    await writeFact(db.database, {
      familyId,
      childId: other?.id as string,
      factType: 'logistic',
      factKey: WEEKDAY_CARE_FACT_KEY,
      factValue: { care: 'daycare', provider: null },
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: NOW,
    });
    await writeFact(db.database, {
      familyId,
      childId,
      factType: 'logistic',
      factKey: WEEKDAY_CARE_FACT_KEY,
      factValue: { care: 'home', provider: null },
      confidence: 1,
      inferredBy: WEEKDAY_CARE_FACT_WRITER,
      validFrom: NOW,
    });

    const live = await loadWeekdayCare(db.database, familyId);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ childId, care: 'home' });
  });

  it('is blind to a superseded fact — only what is true now', async () => {
    const { familyId, childId } = await seedFamily();
    const write = (care: string, validFrom: Date) =>
      writeFact(db.database, {
        familyId,
        childId,
        factType: 'logistic',
        factKey: WEEKDAY_CARE_FACT_KEY,
        factValue: { care, provider: null },
        confidence: 1,
        inferredBy: WEEKDAY_CARE_FACT_WRITER,
        validFrom,
      });
    await write('home', NOW);
    await write('daycare', new Date(NOW.getTime() + 86_400_000));

    const live = await loadWeekdayCare(db.database, familyId);
    expect(live).toHaveLength(1);
    expect(live[0]?.care).toBe('daycare');
  });

  it('has nothing to say about a household that has never answered', async () => {
    const { familyId } = await seedFamily();
    expect(await loadWeekdayCare(db.database, familyId)).toEqual([]);
  });
});

describe('readCandidates — the column the weekday claim rests on', () => {
  it('carries `source` through, so a civic row can be told from an LLM one', async () => {
    const { familyId } = await seedFamily();
    await db.database.insert(schema.villageCandidates).values([
      {
        familyId,
        title: 'EarlyON drop-in',
        kind: 'drop_in',
        summary: 'Free drop-in at Armour Heights - 9:30 a.m.-11:00 a.m.',
        source: CIVIC_SOURCE,
        runType: 'civic',
        eventDate: '2026-09-15',
        confidence: 0.9,
      },
      {
        familyId,
        title: 'Music circle',
        kind: 'class',
        summary: 'A weekly music circle nearby.',
        source: 'llm',
        runType: 'standing',
        eventDate: '2026-09-15',
        confidence: 0.9,
      },
    ]);

    const rows = await readCandidates(db.database, familyId);
    expect(rows.map((row) => row.source).sort()).toEqual([CIVIC_SOURCE, 'llm']);
  });
});
