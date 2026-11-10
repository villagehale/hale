import { GuardrailError, invokeTool } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCronGuardDeps } from '~/lib/cron/guards';
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

/** A save through the guarded invoker, as the inferencer runs it. A teen name is refused
 * on the child_content rail before the audit row (VIL-618). */
async function save(name: string, familyId: string, input: Record<string, unknown>) {
  try {
    return await invokeTool(
      tool(name),
      input,
      { familyId, actor: 'system' },
      buildCronGuardDeps(db.database),
    );
  } catch (err) {
    if (err instanceof GuardrailError && err.rail === 'child_content') {
      return { saved: false, reason: err.message.split(': ').at(-1) };
    }
    throw err;
  }
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
    const result = await save('save_memory', familyId, {
      childId: kidId,
      factType: 'routine',
      factKey: 'afternoon_nap',
      factValue: 'one nap after lunch',
      confidence: 0.9,
      ...CLASS,
    });
    expect(result).toMatchObject({ saved: true });
    expect(await facts(familyId)).toEqual([{ childId: kidId, factKey: 'afternoon_nap' }]);
  });

  it('refuses a fact filed under a younger child that names a 13+ child', async () => {
    const { familyId, kidId } = await seed();
    const result = await save('save_memory', familyId, {
      childId: kidId,
      factType: 'relationship',
      factKey: 'sibling_news',
      factValue: `${TEEN_NAME} has a secret boyfriend`,
      confidence: 0.9,
      ...CLASS,
    });
    expect(result).toEqual({ saved: false, reason: 'names_teen' });
    expect(await facts(familyId)).toEqual([]);
  });

  it('refuses a family-wide fact that names a 13+ child, and keeps one that does not', async () => {
    const { familyId } = await seed();
    const refused = await save('save_memory', familyId, {
      childId: null,
      factType: 'routine',
      factKey: 'saturday_debate',
      factValue: `${TEEN_NAME.toLowerCase()} has debate on Saturdays`,
      confidence: 0.9,
      ...CLASS,
    });
    expect(refused).toEqual({ saved: false, reason: 'names_teen' });

    const kept = await save('save_memory', familyId, {
      childId: null,
      factType: 'preference',
      factKey: 'sunday_library',
      factValue: 'library on Sundays',
      confidence: 0.9,
      ...CLASS,
    });
    expect(kept).toMatchObject({ saved: true });
    expect(await facts(familyId)).toEqual([{ childId: null, factKey: 'sunday_library' }]);
  });
});

describe('save_child_fact names its subject', () => {
  it('refuses a family-wide fact that names a 13+ child', async () => {
    const { familyId } = await seed();
    const result = await save('save_child_fact', familyId, {
      childId: null,
      category: 'concerns',
      factKey: 'school_worry',
      summary: `worried about ${TEEN_NAME} at school`,
      confidence: 0.9,
      ...CLASS,
    });
    expect(result).toEqual({ saved: false, reason: 'names_teen' });
    expect(await facts(familyId)).toEqual([]);
  });

  it('refuses a fact filed under a younger child that names a 13+ child', async () => {
    const { familyId, kidId } = await seed();
    const result = await save('save_child_fact', familyId, {
      childId: kidId,
      category: 'concerns',
      factKey: 'sibling_worry',
      summary: `Pip misses ${TEEN_NAME} since the breakup`,
      confidence: 0.9,
      ...CLASS,
    });
    expect(result).toEqual({ saved: false, reason: 'names_teen' });
    expect(await facts(familyId)).toEqual([]);
  });
});
