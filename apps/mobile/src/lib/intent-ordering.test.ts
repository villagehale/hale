import { describe, expect, it } from 'vitest';

import { ASK_SUGGESTIONS } from '../constants/ask-data';
import { ONBOARDING_INTENTS } from './onboarding-intents';
import { orderByIntents } from './intent-ordering';

/**
 * The deterministic Consumer-2 ordering: a family's stated intents float matching
 * rows up, otherwise the list is untouched (a stable partition — never an LLM
 * ranking or a "recommended for you" score). Expectations are derived from the spec,
 * not from the data under test.
 */

interface Row {
  id: string;
  intent?: string;
}

const ROWS: readonly Row[] = [
  { id: 'benefits' },
  { id: 'sleep', intent: 'sleep' },
  { id: 'solids', intent: 'feeding' },
  { id: 'childcare', intent: 'childcare' },
  { id: 'firstaid', intent: 'health' },
];

const intentOf = (row: Row) => row.intent;
const ids = (rows: readonly Row[]) => rows.map((r) => r.id);

describe('orderByIntents', () => {
  it('floats a sleep-intent family’s sleep row to the top', () => {
    expect(ids(orderByIntents(ROWS, intentOf, ['sleep']))).toEqual([
      'sleep',
      'benefits',
      'solids',
      'childcare',
      'firstaid',
    ]);
  });

  it('leaves the original order when the family has no intents', () => {
    expect(ids(orderByIntents(ROWS, intentOf, []))).toEqual(ids(ROWS));
  });

  it('ignores an intent that matches no row (has no effect)', () => {
    // 'potty' is a real intent but no row is tagged with it.
    expect(ids(orderByIntents(ROWS, intentOf, ['potty']))).toEqual(ids(ROWS));
  });

  it('keeps matched rows in their original relative order (stable)', () => {
    // feeding + childcare both match; solids precedes childcare in the source, so
    // it stays first among the floated rows.
    expect(ids(orderByIntents(ROWS, intentOf, ['childcare', 'feeding']))).toEqual([
      'solids',
      'childcare',
      'benefits',
      'sleep',
      'firstaid',
    ]);
  });

  it('never floats an untagged row', () => {
    const rows: Row[] = [{ id: 'a' }, { id: 'b', intent: 'sleep' }];
    expect(ids(orderByIntents(rows, intentOf, ['sleep']))).toEqual(['b', 'a']);
  });
});

describe('Ask suggestions — reordered where a mapping exists', () => {
  const suggestionIntentOf = (s: (typeof ASK_SUGGESTIONS)[number]) => s.intent;
  const titles = (rows: readonly (typeof ASK_SUGGESTIONS)[number][]) => rows.map((s) => s.title);

  it('floats the health-tagged suggestion up for a health-intent family', () => {
    const ordered = orderByIntents(ASK_SUGGESTIONS, suggestionIntentOf, ['health']);
    expect(ordered[0]?.title).toBe('Add the well-baby visit');
  });

  it('leaves the suggestions untouched for a family with no mapped intent', () => {
    // 'sleep' maps to no Ask suggestion, so the honest starter order is preserved.
    expect(titles(orderByIntents(ASK_SUGGESTIONS, suggestionIntentOf, ['sleep']))).toEqual(
      titles(ASK_SUGGESTIONS),
    );
  });

  it('only tags suggestions with canonical onboarding intent values', () => {
    const valid = new Set(ONBOARDING_INTENTS.map((i) => i.value));
    for (const s of ASK_SUGGESTIONS) {
      if (s.intent !== undefined) {
        expect(valid, `"${s.intent}" is not a known intent`).toContain(s.intent);
      }
    }
  });
});
