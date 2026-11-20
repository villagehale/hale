import { describe, expect, it } from 'vitest';
import {
  SPLIT_DUTY_ACCURACY_FLOOR,
  SPLIT_DUTY_EVENTS,
  SPLIT_DUTY_FIXTURES,
  SPLIT_DUTY_PARENTS,
  estimateSplitDutyEvalCostUsd,
} from './split-fixtures';
import { splitDutyReadFromExtraction } from './split-read';

describe('split-duty reply eval (VIL-661)', () => {
  it('covers a split, one parent taking both, and no answer', () => {
    const ids = SPLIT_DUTY_FIXTURES.map((row) => row.id);
    expect(ids).toEqual(['split', 'takes-both', 'no-answer']);
  });

  it(`assignment accuracy is at least ${SPLIT_DUTY_ACCURACY_FLOOR}`, () => {
    const misses: string[] = [];
    let hit = 0;
    let total = 0;
    for (const row of SPLIT_DUTY_FIXTURES) {
      const read = splitDutyReadFromExtraction(
        {
          text: row.text,
          speakerUserId: 'ana',
          parents: SPLIT_DUTY_PARENTS,
          events: SPLIT_DUTY_EVENTS,
        },
        row.llm,
      );
      total += 1;
      const owners: Record<string, string | null> = { hockey: null, dance: null };
      for (const assignment of read.assignments) {
        owners[assignment.eventKey] = assignment.userId;
      }
      const ok =
        read.write === row.expect.write &&
        read.kind === row.expect.kind &&
        owners.hockey === row.expect.owners.hockey &&
        owners.dance === row.expect.owners.dance;
      if (ok) hit += 1;
      else {
        misses.push(
          `${row.id} write=${read.write} kind=${read.kind} owners=${JSON.stringify(owners)}`,
        );
      }
    }
    expect(misses, misses.join('\n')).toEqual([]);
    expect(hit / total).toBeGreaterThanOrEqual(SPLIT_DUTY_ACCURACY_FLOOR);
  });

  it('dry-run cost of the three cases stays under $5', () => {
    const estimate = estimateSplitDutyEvalCostUsd();
    expect(estimate.calls).toBe(6);
    expect(estimate.usd).toBeGreaterThan(0);
    expect(estimate.usd).toBeLessThan(estimate.ceilingUsd);
    expect(estimate.usd).toBeLessThan(0.5);
  });
});
