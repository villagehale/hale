import { describe, expect, it } from 'vitest';
import { REQUIRED_CHECKS, coverageSatisfiedWithResults } from './index.js';

/**
 * FIX 3 — the structural enforcement of hard rules #3 + #7. Name coverage is
 * not enough: a reviewer that invokes check_spending_cap and receives
 * {ok:false} must NOT be allowed to mint. coverageSatisfiedWithResults requires
 * every REQUIRED_CHECK to be present AND ok===true. Expectations are derived
 * from the hard rules, not from runtime output.
 */
describe('coverageSatisfiedWithResults', () => {
  it('passes when every required check is present and ok:true', () => {
    const results = REQUIRED_CHECKS.place_supply_order.map((tool) => ({ tool, ok: true }));
    expect(coverageSatisfiedWithResults('place_supply_order', results)).toBe(true);
  });

  it('fails when a required check is present but returned ok:false (cap exceeded)', () => {
    const results = REQUIRED_CHECKS.place_supply_order.map((tool) => ({
      tool,
      // The spending-cap check came back failing — hard rule #7: cap exceeded → reject.
      ok: tool !== 'check_spending_cap',
    }));
    expect(coverageSatisfiedWithResults('place_supply_order', results)).toBe(false);
  });

  it('fails when a required check name is missing entirely', () => {
    const results = REQUIRED_CHECKS.place_supply_order
      .filter((tool) => tool !== 'check_spending_cap')
      .map((tool) => ({ tool, ok: true }));
    expect(coverageSatisfiedWithResults('place_supply_order', results)).toBe(false);
  });

  it('fails on an empty results list for every action type', () => {
    for (const actionType of Object.keys(REQUIRED_CHECKS) as (keyof typeof REQUIRED_CHECKS)[]) {
      expect(coverageSatisfiedWithResults(actionType, [])).toBe(false);
    }
  });

  it('ignores extra non-required ok:false results as long as required checks are ok', () => {
    const results = [
      ...REQUIRED_CHECKS.send_email.map((tool) => ({ tool, ok: true })),
      { tool: 'check_action_time_window', ok: false },
    ];
    expect(coverageSatisfiedWithResults('send_email', results)).toBe(true);
  });
});
