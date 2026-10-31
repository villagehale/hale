// 914: --dry projects compose (subject-model) calls instead of throwing on a cache miss,
// with compose/judge subtotals and a grand total; and a min-of-3 judge reports every
// draw's score and reason, not only the lowest one's.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CACHE_DIR,
  cacheKey,
  cachedToolCall,
  dryStandInText,
  formatDraws,
  makeCost,
  makeJudge,
  summarizeDryPlan,
} from './harness.mjs';

const argv = process.argv;
let fetchSpy;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('test: network call attempted');
  });
});
afterEach(() => {
  process.argv = argv;
  fetchSpy.mockRestore();
});

const noClient = () => {
  throw new Error('test: client built');
};

describe('--dry projects compose calls (914)', () => {
  it('an uncached compose call is planned, not thrown, and never builds a client', async () => {
    process.argv = ['node', 'x', '--dry'];
    const plan = [];
    const base = {
      model: 'claude-haiku-5-5',
      system: 'write the reminder',
      toolName: 'reminder_text',
      toolSchema: { type: 'object', properties: { text: { type: 'string' } } },
      maxTokens: 300,
      cachedOnly: false,
      getClient: noClient,
      cost: makeCost(),
      dryPlan: plan,
    };
    const tag = `dry-compose-${Math.random().toString(36).slice(2)}`;
    const a = await cachedToolCall({ ...base, tag: `${tag}:a`, userMessage: 'swim tomorrow' });
    const b = await cachedToolCall({ ...base, tag: `${tag}:b`, userMessage: 'soccer today' });
    expect(a.dry).toBe(true);
    expect(a.value.text).toBe(dryStandInText(300));
    expect(b.dry).toBe(true);
    expect(plan).toHaveLength(2);
    for (const p of plan) {
      expect(p.cached).toBe(false);
      expect(p.maxTokens).toBe(300);
      expect(p.inputTokens).toBeGreaterThan(0);
      expect(p.worstUsd).toBeGreaterThan(0);
    }
    // No cache_control on a plain string system: no discount on either call.
    expect(plan[0].cacheReadTokens).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still fails a cached-only miss in --dry', async () => {
    process.argv = ['node', 'x', '--dry'];
    await expect(
      cachedToolCall({
        tag: `dry-co-${Math.random().toString(36).slice(2)}`,
        model: 'claude-haiku-5-5',
        system: 's',
        userMessage: 'u',
        toolName: 't',
        toolSchema: { type: 'object' },
        cachedOnly: true,
        getClient: noClient,
        cost: makeCost(),
        dryPlan: [],
      }),
    ).rejects.toThrow();
  });

  it('summarizes compose and judge subtotals and a grand total', () => {
    const compose = [
      { cached: true },
      { cached: false, worstUsd: 0.01 },
      { cached: false, worstUsd: 0.002 },
    ];
    const judge = [
      { cached: false, worstUsd: 0.02 },
      { cached: true, score: 5 },
    ];
    const s = summarizeDryPlan({ compose, judge }, { spentUsd: 0.14597, capUsd: 0.33 });
    expect(s.compose).toEqual({ calls: 3, cached: 1, uncached: 2, worstUsd: 0.012 });
    expect(s.judge.uncached).toBe(1);
    expect(s.judge.worstUsd).toBeCloseTo(0.02, 10);
    expect(s.worstTotalUsd).toBeCloseTo(0.032, 10);
    expect(s.projectedLedgerUsd).toBeCloseTo(0.17797, 10);
    expect(s.fitsCap).toBe(true);
    expect(summarizeDryPlan({ compose, judge }, { spentUsd: 0.31, capUsd: 0.33 }).fitsCap).toBe(
      false,
    );
  });
});

describe('a min-of-3 judge reports every draw (914)', () => {
  it('returns the lowest verdict plus all 3 draws with scores and reasons, in order', async () => {
    process.argv = ['node', 'x'];
    const model = 'claude-haiku-5-5';
    const prefix = `draws-${Math.random().toString(36).slice(2)}`;
    const payload = { text: 'hi' };
    const verdicts = [
      { reason: 'reads fine', score: 5 },
      { reason: 'a calendar readout', score: 2 },
      { reason: 'mostly natural', score: 4 },
    ];
    const files = verdicts.map((v, i) => {
      const tag = i === 0 ? `${prefix}:judge:case` : `${prefix}:judge:case#${i}`;
      const file = join(
        CACHE_DIR,
        `${cacheKey(tag, `${model}\nscore it\n${JSON.stringify(payload)}`)}.json`,
      );
      writeFileSync(file, JSON.stringify({ parsed: v }));
      return file;
    });
    try {
      const judge = makeJudge(model, 'score it', prefix, true, noClient, makeCost(), {
        samples: 3,
        aggregate: 'min',
      });
      const v = await judge('case', payload);
      expect(v.score).toBe(2);
      expect(v.reason).toBe('a calendar readout');
      expect(v.samples).toEqual([5, 2, 4]);
      expect(v.draws).toEqual(verdicts.map(({ score, reason }) => ({ score, reason })));
      expect(formatDraws(v.draws)).toEqual([
        'draw 1: 5 - reads fine',
        'draw 2: 2 - a calendar readout',
        'draw 3: 4 - mostly natural',
      ]);
    } finally {
      for (const f of files) rmSync(f, { force: true });
    }
  });
});
