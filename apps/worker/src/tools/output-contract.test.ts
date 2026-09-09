import { describe, expect, it } from 'vitest';
import { throughOutputContract } from './registry.js';

/**
 * VIL-270 · the contract is the wire.
 *
 * Whatever a reviewer check returns is JSON-stringified straight into a third-party
 * model's turn (reviewer.ts:267). Before this, the declared output schema was decorative
 * on that path — the registry's own SELECT decided which columns left Postgres, and a
 * tool could re-grow a column the contract had deliberately dropped without a single
 * test going red. The door parses now, so the shape the package declares is the shape
 * Anthropic is handed, for every reviewer tool rather than the one that was audited.
 */

const TEEN_TITLE = 'Dr. Patel — eating-disorder therapy';

describe('throughOutputContract — the declared shape is the sent shape', () => {
  it('drops a field the contract does not declare', () => {
    const out = throughOutputContract('check_calendar_conflict', false, {
      hasConflict: true,
      conflictingEvents: [
        {
          id: '2c8f0f3a-6f4a-4b7e-9f4a-1c2d3e4f5a6b',
          startsAt: '2026-07-30T20:15:00.000Z',
          endsAt: '2026-07-30T21:15:00.000Z',
          title: TEEN_TITLE,
        },
      ],
    });

    const events = (out.result as { conflictingEvents: Record<string, unknown>[] })
      .conflictingEvents;
    expect(Object.keys(events[0] ?? {}).sort()).toEqual(['endsAt', 'id', 'startsAt']);
    expect(JSON.stringify(out)).not.toContain(TEEN_TITLE);
    expect(out.ok).toBe(false);
  });

  it('refuses a result that cannot satisfy its own contract, and sends none of it', () => {
    const out = throughOutputContract('check_calendar_conflict', true, {
      conflictingEvents: [{ id: 'x', notes: TEEN_TITLE }],
    });

    expect(out).toEqual({
      tool: 'check_calendar_conflict',
      ok: false,
      result: { error: 'tool output failed its output contract' },
    });
    expect(JSON.stringify(out)).not.toContain(TEEN_TITLE);
  });

  it('leaves a conforming result and its verdict alone', () => {
    const out = throughOutputContract('check_spending_cap', true, {
      withinLimits: true,
      limitUsd: 50,
      rationale: 'amount 12 within per-action cap of 50',
    });

    expect(out).toEqual({
      tool: 'check_spending_cap',
      ok: true,
      result: { withinLimits: true, limitUsd: 50, rationale: 'amount 12 within per-action cap of 50' },
    });
  });
});
