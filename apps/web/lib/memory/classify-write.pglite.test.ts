import { type RegisteredTool, compileToolSchema, invokeTool } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { buildCronGuardDeps } from '~/lib/cron/guards';
import { buildDistillTools, buildInferenceTools } from '~/lib/cron/inference-tools';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { renderMemoryBrief } from './brief';
import { loadRecommendationMemory } from './store';

/**
 * VIL-419 — the distiller and the nightly inferencer persist the model's class. A rejected
 * Oct 1 activity must not land as a confirmed Oct 4 fact, and one question is
 * not a preference.
 */

const OCT_4 = new Date('2026-10-04T15:00:00.000Z');
const OCT_1 = '2026-10-01T20:15:00.000Z';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

const ctx = (familyId: string) => ({ familyId, actor: 'system' });

function toolNamed(tools: ReturnType<typeof buildInferenceTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

async function rowsFor(familyId: string) {
  return db.database
    .select()
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, familyId));
}

describe('declined events and passing questions', () => {
  it('stores a rejected Oct 1 activity as a declined obligation, not a confirmed Oct 4 fact', async () => {
    const { familyId } = await seedFamily(db.database);
    const save = toolNamed(buildInferenceTools(db.database, OCT_4), 'save_memory');

    const saved = await save.handler(
      {
        factType: 'preference',
        factKey: 'gymnastics',
        factValue: { summary: 'Gymnastics' },
        confidence: 0.95,
        memoryClass: 'enduring',
        disposition: 'declined',
        observedAt: OCT_1,
      },
      ctx(familyId),
    );

    expect(saved).toMatchObject({ saved: true });
    const [row] = await rowsFor(familyId);
    expect(row?.memoryKind).toBe('temporary');
    expect(row?.memorySource).toBe('inferred');
    expect(row?.validFrom.toISOString()).toBe(OCT_1);
    expect(row?.expiresAt?.toISOString()).toBe(OCT_1);
    expect(row?.factValue).toMatchObject({
      disposition: 'declined',
      memoryClass: 'obligation',
    });
    expect(row?.confidence).toBe(0.95);

    const recommended = await loadRecommendationMemory(db.database, familyId, OCT_4, {});
    expect(recommended.map((fact) => fact.factKey)).not.toContain('gymnastics');

    const brief = renderMemoryBrief({
      now: OCT_4,
      timeZone: 'America/Toronto',
      facts: [
        {
          factType: row?.factType ?? 'preference',
          factKey: 'gymnastics',
          factValue: row?.factValue,
          confidence: row?.confidence ?? 0,
          validFrom: row?.validFrom ?? OCT_4,
          childId: null,
          memoryKind: row?.memoryKind,
          memorySource: row?.memorySource,
          expiresAt: row?.expiresAt,
        },
      ],
      teenChildIds: new Set(),
      workstreams: [],
      dayDigest: null,
      weekDigest: null,
      expectedDay: '2026-10-03',
      expectedWeek: '2026-09-28',
    });
    expect(brief.text).not.toContain('gymnastics');
    expect(brief.text).not.toContain('disposition=confirmed');
  });

  it('does not turn one question into a preference, and a later enduring save supersedes it', async () => {
    const { familyId } = await seedFamily(db.database);
    const save = toolNamed(buildDistillTools(db.database, OCT_4), 'save_child_fact');
    const asked = {
      category: 'preferences' as const,
      factKey: 'saturday_swim',
      summary: 'what about swimming this Saturday?',
      confidence: 0.85,
      memoryClass: 'curiosity' as const,
      disposition: 'asked' as const,
    };

    await save.handler(asked, ctx(familyId));
    await save.handler(asked, ctx(familyId));

    const afterQuestions = await rowsFor(familyId);
    const liveQuestion = afterQuestions.filter((row) => row.validUntil === null);
    expect(liveQuestion).toHaveLength(1);
    expect(liveQuestion[0]?.memoryKind).toBe('one_off');
    expect(liveQuestion[0]?.factValue).toMatchObject({
      disposition: 'asked',
      memoryClass: 'curiosity',
    });

    const recommended = await loadRecommendationMemory(db.database, familyId, OCT_4, {});
    expect(recommended.map((fact) => fact.factKey)).not.toContain('saturday_swim');

    await save.handler(
      {
        ...asked,
        summary: 'They love Saturday swimming',
        memoryClass: 'enduring',
        disposition: 'confirmed',
      },
      ctx(familyId),
    );

    const after = await rowsFor(familyId);
    const live = after.filter((row) => row.validUntil === null);
    const closed = after.filter((row) => row.validUntil !== null);
    expect(live).toHaveLength(1);
    expect(live[0]?.memoryKind).toBe('lasting');
    expect(live[0]?.factValue).toMatchObject({ summary: 'They love Saturday swimming' });
    expect(closed.some((row) => row.supersededBy === live[0]?.id)).toBe(true);
  });

  it('does not promote a curiosity filed under an identity-shaped key', async () => {
    const { familyId } = await seedFamily(db.database);
    const save = toolNamed(buildInferenceTools(db.database, OCT_4), 'save_memory');
    await save.handler(
      {
        factType: 'logistic',
        factKey: 'district',
        factValue: { area: 'midtown' },
        confidence: 0.9,
        memoryClass: 'curiosity',
        disposition: 'asked',
      },
      ctx(familyId),
    );
    const [row] = await rowsFor(familyId);
    expect(row?.memoryKind).toBe('one_off');
    expect(row?.factValue).toMatchObject({ disposition: 'asked', memoryClass: 'curiosity' });
  });
});

const WRITERS: Array<{
  writer: string;
  tool: (database: Database) => RegisteredTool;
  unclassified: Record<string, unknown>;
}> = [
  {
    writer: 'nightly save_memory',
    tool: (database) => toolNamed(buildInferenceTools(database, OCT_4), 'save_memory'),
    unclassified: {
      factType: 'preference',
      factKey: 'winter_hockey',
      factValue: { summary: 'Hockey this winter' },
      confidence: 0.95,
    },
  },
  {
    writer: 'nightly save_child_fact',
    tool: (database) => toolNamed(buildDistillTools(database, OCT_4), 'save_child_fact'),
    unclassified: {
      category: 'preferences',
      factKey: 'winter_hockey',
      summary: 'Hockey this winter',
      confidence: 0.95,
    },
  },
];

async function auditsFor(familyId: string) {
  return db.database.select().from(schema.auditLog).where(eq(schema.auditLog.familyId, familyId));
}

describe.each(WRITERS)('$writer — every save is classified', ({ tool, unclassified }) => {
  it('sends memoryClass and disposition as required in the schema on the wire', () => {
    const { schema: wire } = compileToolSchema(tool(db.database).inputSchema);

    expect(wire.required).toEqual(expect.arrayContaining(['memoryClass', 'disposition']));
    expect(wire.required).not.toContain('expiresAt');
    expect(wire.required).not.toContain('correctsKey');
  });

  it('shows one example per class, each valid against its own schema', () => {
    const save = tool(db.database);
    const examples = save.inputExamples ?? [];

    for (const example of examples) save.inputSchema.parse(example);
    expect(examples.map((e) => `${e.memoryClass}/${e.disposition}`)).toEqual([
      'enduring/confirmed',
      'obligation/declined',
      'curiosity/asked',
    ]);
    const declined = examples.find((e) => e.disposition === 'declined');
    expect(typeof declined?.observedAt).toBe('string');
  });

  it('refuses an unclassified save before anything is audited or written', async () => {
    const { familyId } = await seedFamily(db.database);

    const refused = invokeTool(
      tool(db.database),
      unclassified,
      ctx(familyId),
      buildCronGuardDeps(db.database),
    );

    await expect(refused).rejects.toBeInstanceOf(ZodError);
    await expect(refused).rejects.toThrow(/memoryClass[\s\S]*disposition/);
    expect(await auditsFor(familyId)).toEqual([]);
    expect(await rowsFor(familyId)).toEqual([]);
  });

  it('stores a labelled decline as declined, audited, never confirmed', async () => {
    const { familyId } = await seedFamily(db.database);

    await invokeTool(
      tool(db.database),
      { ...unclassified, memoryClass: 'obligation', disposition: 'declined', observedAt: OCT_1 },
      ctx(familyId),
      buildCronGuardDeps(db.database),
    );

    const [row] = await rowsFor(familyId);
    expect(row?.memoryKind).toBe('temporary');
    expect(row?.factValue).toMatchObject({ disposition: 'declined', memoryClass: 'obligation' });
    expect(await auditsFor(familyId)).toHaveLength(1);
  });
});
