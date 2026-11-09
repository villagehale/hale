import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDistillTools, buildInferenceTools } from '~/lib/cron/inference-tools';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * VIL-597 G3. A save names its subject: a child from the family's roster, or the whole
 * family. A family-wide save whose text names a 13+ child is refused, because a text
 * turn carries no child id and that fact would otherwise reach every later prompt as
 * the family's (rule #1).
 */

const NOW = new Date('2026-11-08T06:00:00.000Z');
const TEEN_NAME = 'Tamsin';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function seed() {
  const { familyId } = await seedFamily(db.database);
  const [kid] = await db.database
    .insert(schema.children)
    .values([
      { familyId, name: 'Pip', dateOfBirth: '2023-01-10' },
      { familyId, name: TEEN_NAME, dateOfBirth: '2012-02-01' },
    ])
    .returning({ id: schema.children.id });
  return { familyId, kidId: kid?.id as string };
}

function tool(name: string) {
  const all = [...buildInferenceTools(db.database, NOW), ...buildDistillTools(db.database, NOW)];
  const found = all.find((t) => t.name === name);
  if (!found) throw new Error(`no ${name} tool`);
  return found;
}

async function facts(familyId: string) {
  return db.database
    .select({
      childId: schema.familyMemoryFacts.childId,
      factKey: schema.familyMemoryFacts.factKey,
    })
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, familyId));
}

const CLASS = { memoryClass: 'enduring', disposition: 'confirmed' } as const;

describe('save_memory names its subject', () => {
  it('stores a fact about a younger child under that child', async () => {
    const { familyId, kidId } = await seed();
    const result = await tool('save_memory').handler(
      {
        childId: kidId,
        factType: 'routine',
        factKey: 'afternoon_nap',
        factValue: 'one nap after lunch',
        confidence: 0.9,
        ...CLASS,
      },
      { familyId, actor: 'system' },
    );
    expect(result).toMatchObject({ saved: true });
    expect(await facts(familyId)).toEqual([{ childId: kidId, factKey: 'afternoon_nap' }]);
  });

  it('refuses a family-wide fact that names a 13+ child, and keeps one that does not', async () => {
    const { familyId } = await seed();
    const refused = await tool('save_memory').handler(
      {
        childId: null,
        factType: 'routine',
        factKey: 'saturday_debate',
        factValue: `${TEEN_NAME.toLowerCase()} has debate on Saturdays`,
        confidence: 0.9,
        ...CLASS,
      },
      { familyId, actor: 'system' },
    );
    expect(refused).toEqual({ saved: false, reason: 'names_teen' });

    const kept = await tool('save_memory').handler(
      {
        childId: null,
        factType: 'preference',
        factKey: 'sunday_library',
        factValue: 'library on Sundays',
        confidence: 0.9,
        ...CLASS,
      },
      { familyId, actor: 'system' },
    );
    expect(kept).toMatchObject({ saved: true });
    expect(await facts(familyId)).toEqual([{ childId: null, factKey: 'sunday_library' }]);
  });
});

describe('save_child_fact names its subject', () => {
  it('refuses a family-wide fact that names a 13+ child', async () => {
    const { familyId } = await seed();
    const result = await tool('save_child_fact').handler(
      {
        childId: null,
        category: 'concerns',
        factKey: 'school_worry',
        summary: `worried about ${TEEN_NAME} at school`,
        confidence: 0.9,
        ...CLASS,
      },
      { familyId, actor: 'system' },
    );
    expect(result).toEqual({ saved: false, reason: 'names_teen' });
    expect(await facts(familyId)).toEqual([]);
  });
});
