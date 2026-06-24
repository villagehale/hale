import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
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
