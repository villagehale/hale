// 914: the reminder --dry listing names every compose and judge call and totals both.
import { describe, expect, it } from 'vitest';
import { dryPlanLines } from './run-reminder-eval.mjs';

describe('reminder --dry listing', () => {
  it('lists compose and judge rows, subtotals and a grand total', () => {
    const lines = dryPlanLines(
      {
        compose: [
          {
            tag: 'reminder:a',
            cached: false,
            inputTokens: 900,
            cacheReadTokens: 0,
            maxTokens: 300,
            worstUsd: 0.003,
          },
          { tag: 'reminder:b', cached: true },
        ],
        judge: [
          {
            tag: 'reminder:judge:a',
            cached: false,
            inputTokens: 4000,
            cacheReadTokens: 0,
            maxTokens: 512,
            worstUsd: 0.02,
          },
        ],
      },
      { spentUsd: 0.14597, capUsd: 0.33 },
    );
    expect(lines[0]).toMatch(
      /^DRY {2}compose uncached {2}reminder:a .*300 max out {2}worst \$0\.00300/,
    );
    expect(lines[1]).toMatch(/compose cached {4}reminder:b/);
    expect(lines[2]).toMatch(/judge {3}uncached {2}reminder:judge:a/);
    expect(lines).toContain('DRY compose | calls 2 (cached 1, uncached 1) | worst $0.00300');
    expect(lines).toContain('DRY judge   | calls 1 (cached 0, uncached 1) | worst $0.02000');
    expect(lines.find((l) => l.startsWith('DRY total'))).toBe(
      'DRY total | worst $0.02300 | ledger $0.14597 -> projected $0.16897 vs cap $0.33 | FITS',
    );
  });
});
