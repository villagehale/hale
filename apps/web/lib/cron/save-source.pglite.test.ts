import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildInferenceTools } from '~/lib/cron/inference-tools';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * VIL-429. The inferencer sees each recent event's id and names the one a fact rests on,
 * so a later read can say where Hale saw it. An id that is not this family's event is
 * refused rather than stored as provenance.
 */

const NOW = new Date('2026-11-08T06:00:00.000Z');
const CLASS = { memoryClass: 'enduring', disposition: 'confirmed' } as const;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

function tool(name: string) {
  const found = buildInferenceTools(db.database, NOW).find((t) => t.name === name);
  if (!found) throw new Error(`no ${name} tool`);
  return found;
}

async function seedMail(familyId: string): Promise<string> {
  const [row] = await db.database
    .insert(schema.events)
    .values({
      familyId,
      source: 'gmail',
      eventType: 'activity_signup_open',
      payload: { sender: 'Northside Rec <programs@northside-rec.example>' },
      dedupHash: `mail-${familyId}`,
      receivedAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
    })
    .returning({ id: schema.events.id });
  if (!row) throw new Error('event insert returned no row');
  return row.id;
}

function save(familyId: string, sourceEventId: string | null) {
  return tool('save_memory').handler(
    {
      childId: null,
      factType: 'routine',
      factKey: 'soccer_day',
      factValue: 'Thursdays',
      confidence: 0.9,
      sourceEventId,
      ...CLASS,
    },
    { familyId, actor: 'system' },
  );
}

async function storedSource(familyId: string) {
  return db.database
    .select({ sourceEventId: schema.familyMemoryFacts.sourceEventId })
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, familyId));
}

describe('save_memory records the event a fact rests on', () => {
  it('shows each recent event id, and stores the one the save names', async () => {
    const { familyId } = await seedFamily(db.database);
    const mail = await seedMail(familyId);
    const snapshot = (await tool('read_recent_memory').handler(
      {},
      { familyId, actor: 'system' },
    )) as {
      recentEvents: Array<{ eventId: string | null }>;
    };
    expect(snapshot.recentEvents.map((event) => event.eventId)).toEqual([mail]);

    expect(await save(familyId, mail)).toMatchObject({ saved: true });
    expect(await storedSource(familyId)).toEqual([{ sourceEventId: mail }]);
  });

  it('stores no source when the save names none', async () => {
    const { familyId } = await seedFamily(db.database);
    expect(await save(familyId, null)).toMatchObject({ saved: true });
    expect(await storedSource(familyId)).toEqual([{ sourceEventId: null }]);
  });

  it("refuses another family's event as the source", async () => {
    const mine = await seedFamily(db.database);
    const theirs = await seedFamily(db.database);
    const theirMail = await seedMail(theirs.familyId);
    expect(await save(mine.familyId, theirMail)).toEqual({
      saved: false,
      reason: 'unknown_source_event',
    });
    expect(await storedSource(mine.familyId)).toEqual([]);
  });
});
