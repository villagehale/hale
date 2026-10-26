import { describe, expect, it } from 'vitest';
import { runLongHistoryEval } from './long-history-eval';

describe('VIL-144 long-history context eval (free, no keys)', () => {
  it('a 7-month family still recalls month-one facts, with fewer tokens than today', () => {
    const results = runLongHistoryEval();
    for (const r of results) {
      expect(r, r.id).toMatchObject({ recalled: true, pass: true });
      expect(r.tokens, r.id).toBeLessThan(r.baselineTokens);
    }
  });

  it('--broken (pre-VIL-144 fixed slice) fails recall', () => {
    const results = runLongHistoryEval({ broken: true });
    expect(results.every((r) => r.pass)).toBe(false);
    expect(results.filter((r) => r.recalled)).toHaveLength(0);
  });
});
