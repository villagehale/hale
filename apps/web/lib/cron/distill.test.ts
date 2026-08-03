import { type Database, schema } from '@hale/db';
import { GuardrailError, invokeTool } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { buildCronGuardDeps } from './guards';
import { buildDistillTools, _internal } from './inference-tools';

/**
 * Chat → memory distillation. The infer-memory agent also reads recent
 * CONVERSATIONS and extracts durable, per-child, categorized facts. Two invariants
 * are asserted at the seam:
 *
 *  1. A non-teen child's turn reaches the model with its raw content (so a per-child
 *     fact can be derived) and `save_child_fact` writes it scoped to that child.
 *  2. Rule #1: a 13+ child's turn is reduced to category/summary BEFORE the model
 *     sees it — the raw chat content never enters the distiller's input, and the
 *     turn is family-scoped (childId null) so no teen-specific fact is written.
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const TOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TEEN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-06-17T06:00:00Z');

describe('redactTimelineForDistill (rule #1)', () => {
  it('keeps a non-teen turn raw and scoped to the child', () => {
    const out = _internal.redactTimelineForDistill(
      [{ childId: TOT, role: 'user', content: 'Mara naps twice a day now', topic: 'sleep' }],
      new Map([
        [TOT, 'toddler'],
        [TEEN, 'teenager'],
      ]),
    );
    expect(out).toEqual([
      { childId: TOT, role: 'user', content: 'Mara naps twice a day now', topic: 'sleep' },
    ]);
  });

  it('reduces a teen turn to category/summary only and drops the child scope', () => {
    const out = _internal.redactTimelineForDistill(
      [
        {
          childId: TEEN,
          role: 'user',
          content: 'my teen told me about a fight with their boyfriend at school',
          topic: 'behavior',
        },
      ],
      new Map([
        [TOT, 'toddler'],
        [TEEN, 'teenager'],
      ]),
    );
    expect(out).toHaveLength(1);
    const [turn] = out;
    if (!turn) throw new Error('expected one redacted turn');
    // Raw teen content is GONE — never surfaced to the model.
    expect(turn.content).not.toContain('boyfriend');
    expect(turn.content).not.toContain('fight');
    // Only the category (topic) + a redacted marker survive.
    expect(turn.redacted).toBe(true);
    expect(turn.topic).toBe('behavior');
    // Family-scoped — no teen-specific fact can be derived from a redacted turn.
    expect(turn.childId).toBeNull();
  });
});

describe('save_child_fact tool', () => {
  function fakeDb(capture: { factInserts: Record<string, unknown>[]; audit: unknown[] }) {
    const update = () => ({ set: () => ({ where: async () => {} }) });
    const insert = vi.fn().mockImplementation((table: unknown) => {
      if (table === schema.auditLog) {
        return { values: async (row: unknown) => capture.audit.push(row) };
      }
      if (table === schema.familyMemoryFacts) {
        return {
          values: (row: Record<string, unknown>) => ({
            returning: async () => {
              capture.factInserts.push(row);
              return [{ id: 'fact-1' }];
            },
          }),
        };
      }
      throw new Error('unexpected insert target');
    });
    return { insert, update } as never;
  }

  it('writes a per-child categorized fact through the guarded invoker', async () => {
    const capture = { factInserts: [] as Record<string, unknown>[], audit: [] as unknown[] };
    const tools = buildDistillTools(fakeDb(capture), NOW);
    const save = tools.find((t) => t.name === 'save_child_fact');
    expect(save).toBeDefined();

    const result = await save?.handler(
      {
        childId: TOT,
        category: 'routines',
        factKey: 'naps',
        summary: 'Naps twice a day',
        confidence: 0.9,
      },
      { familyId: FAMILY_ID, actor: 'system' },
    );

    expect(result).toMatchObject({ saved: true });
    expect(capture.factInserts).toHaveLength(1);
    const [fact] = capture.factInserts;
    if (!fact) throw new Error('expected one fact insert');
    expect(fact.familyId).toBe(FAMILY_ID);
    expect(fact.childId).toBe(TOT);
    // The spec category is preserved in the value even though the DB type is the
    // coarse enum bucket.
    expect((fact.factValue as Record<string, unknown>).category).toBe('routines');
    expect(fact.inferredBy).toBe('chat_distiller');
  });

  it('refuses a fact below the 0.7 confidence floor — no insert', async () => {
    const capture = { factInserts: [] as Record<string, unknown>[], audit: [] as unknown[] };
    const tools = buildDistillTools(fakeDb(capture), NOW);
    const save = tools.find((t) => t.name === 'save_child_fact');

    const result = await save?.handler(
      { childId: TOT, category: 'routines', factKey: 'naps', summary: 'maybe naps?', confidence: 0.4 },
      { familyId: FAMILY_ID, actor: 'system' },
    );

    expect(result).toMatchObject({ saved: false });
    expect(capture.factInserts).toEqual([]);
  });
});

/**
 * VIL-269: `save_child_fact` takes a `childId`, so it must be classified
 * `touchesChildContent` — otherwise the guarded invoker skips the teen check
 * entirely and a teen-scoped fact is written with no gate at all. These run the
 * tool through the REAL invokeTool + REAL cron GuardDeps, so they fail if the
 * flag is ever dropped again.
 */
describe('save_child_fact — teen gate at the tool boundary (rule #1/#5)', () => {
  const TEEN_DOB = '2010-06-01'; // 13+ at NOW regardless of exact run date
  const TODDLER_DOB = '2024-06-01';

  function guardedDb(childDob: string | null, capture: { facts: unknown[]; audits: unknown[] }) {
    const childRows = childDob === null ? [] : [{ dateOfBirth: childDob }];
    return {
      select: () => ({
        from: () => ({
          where: () =>
            Object.assign(Promise.resolve(childRows), { limit: async () => childRows }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (row: unknown) => {
          if (table === schema.auditLog) {
            capture.audits.push(row);
            return Promise.resolve(undefined);
          }
          capture.facts.push(row);
          return { returning: async () => [{ id: 'fact-1' }] };
        },
      }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
    } as unknown as Database;
  }

  function saveTool(database: Database) {
    const tool = buildDistillTools(database, NOW).find((t) => t.name === 'save_child_fact');
    if (!tool) throw new Error('no save_child_fact tool');
    return tool;
  }

  const fact = {
    category: 'concerns' as const,
    factKey: 'school-stress',
    summary: 'Struggling with exam pressure',
    confidence: 0.9,
  };

  it('REFUSES a fact scoped to a 13+ child — nothing written, nothing audited', async () => {
    const capture = { facts: [] as unknown[], audits: [] as unknown[] };
    const database = guardedDb(TEEN_DOB, capture);

    await expect(
      invokeTool(
        saveTool(database),
        { childId: TEEN, ...fact },
        { familyId: FAMILY_ID, actor: 'system' },
        buildCronGuardDeps(database),
      ),
    ).rejects.toBeInstanceOf(GuardrailError);

    // The cron path has no viewer, so it can never hold a teen grant — fail closed.
    expect(capture.facts).toEqual([]);
    expect(capture.audits).toEqual([]);
  });

  it('REFUSES a childId outside the caller family — a hallucinated uuid cannot be persisted', async () => {
    const capture = { facts: [] as unknown[], audits: [] as unknown[] };
    const database = guardedDb(null, capture);

    await expect(
      invokeTool(
        saveTool(database),
        { childId: TEEN, ...fact },
        { familyId: FAMILY_ID, actor: 'system' },
        buildCronGuardDeps(database),
      ),
    ).rejects.toThrow(/not found in this family/);

    expect(capture.facts).toEqual([]);
  });

  it('still writes a non-teen child fact — the gate refuses teens, not distillation', async () => {
    const capture = { facts: [] as unknown[], audits: [] as unknown[] };
    const database = guardedDb(TODDLER_DOB, capture);

    const result = await invokeTool(
      saveTool(database),
      { childId: TOT, ...fact },
      { familyId: FAMILY_ID, actor: 'system' },
      buildCronGuardDeps(database),
    );

    expect(result).toMatchObject({ saved: true });
    expect(capture.facts).toHaveLength(1);
    expect((capture.facts[0] as { childId: string }).childId).toBe(TOT);
    expect(capture.audits).toHaveLength(1);
  });
});
