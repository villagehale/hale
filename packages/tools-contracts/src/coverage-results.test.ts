import { describe, expect, it } from 'vitest';
import { REQUIRED_CHECKS, coverageSatisfiedWithResults, firstUnsatisfiedCheck } from './index.js';

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

  // Duplicate-fold guard: the Reviewer appends every tool result and the model
  // controls each input, so it can call the same tool twice. Hard rules #3 + #7
  // mean ANY failing result for a required tool must stick — a later ok:true can
  // never launder an earlier ok:false. Derived from the rule (any failure blocks),
  // not from runtime output.
  it('fails when a required check appears twice, first ok:false then ok:true (cap bypass)', () => {
    const results = [
      ...REQUIRED_CHECKS.place_supply_order
        .filter((tool) => tool !== 'check_spending_cap')
        .map((tool) => ({ tool, ok: true })),
      { tool: 'check_spending_cap', ok: false },
      { tool: 'check_spending_cap', ok: true },
    ];
    expect(coverageSatisfiedWithResults('place_supply_order', results)).toBe(false);
  });

  it('fails on failure-first ordering too (ok:true then ok:false for the same tool)', () => {
    const results = [
      ...REQUIRED_CHECKS.place_supply_order
        .filter((tool) => tool !== 'check_spending_cap')
        .map((tool) => ({ tool, ok: true })),
      { tool: 'check_spending_cap', ok: true },
      { tool: 'check_spending_cap', ok: false },
    ];
    expect(coverageSatisfiedWithResults('place_supply_order', results)).toBe(false);
  });

  it('still passes when a required check appears twice and every result is ok:true', () => {
    const results = [
      ...REQUIRED_CHECKS.place_supply_order.map((tool) => ({ tool, ok: true })),
      { tool: 'check_spending_cap', ok: true },
    ];
    expect(coverageSatisfiedWithResults('place_supply_order', results)).toBe(true);
  });
});

/**
 * firstUnsatisfiedCheck must name the required tool that blocked approval. The
 * duplicate-fold bug hid it: a required tool with one ok:false and one ok:true
 * result must still be reported as unsatisfied, so review.ts / reviewer.ts log
 * the real reason. Expectations derived from the rule (any failure blocks).
 */
describe('firstUnsatisfiedCheck', () => {
  it('returns null when every required check is present and ok:true', () => {
    const results = REQUIRED_CHECKS.place_supply_order.map((tool) => ({ tool, ok: true }));
    expect(firstUnsatisfiedCheck('place_supply_order', results)).toBe(null);
  });

  it('names the required check that appears twice with a failing result (cap bypass)', () => {
    const results = [
      ...REQUIRED_CHECKS.place_supply_order
        .filter((tool) => tool !== 'check_spending_cap')
        .map((tool) => ({ tool, ok: true })),
      { tool: 'check_spending_cap', ok: false },
      { tool: 'check_spending_cap', ok: true },
    ];
    expect(firstUnsatisfiedCheck('place_supply_order', results)).toBe('check_spending_cap');
  });

  it('names a required check that is missing entirely', () => {
    const results = REQUIRED_CHECKS.place_supply_order
      .filter((tool) => tool !== 'check_spending_cap')
      .map((tool) => ({ tool, ok: true }));
    expect(firstUnsatisfiedCheck('place_supply_order', results)).toBe('check_spending_cap');
  });
});
