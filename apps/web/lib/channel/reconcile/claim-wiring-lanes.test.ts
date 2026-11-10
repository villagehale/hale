import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isRetryableClaimReadFailure } from './claim-enforce';

/**
 * VIL-581 · pin the production sweep callers that pass `lane` and `parentUserId`
 * into the claim gate, and the dispatch port binding.
 */

const webLib = fileURLToPath(new URL('..', import.meta.url));

function source(rel: string): string {
  return readFileSync(`${webLib}/${rel}`, 'utf8');
}

describe('VIL-581 · sweep callers name their lane and recipient', () => {
  it('activity follow-up', () => {
    const src = source('activity/deliver.ts');
    expect(src).toContain("lane: 'activity_followup'");
    expect(src).toContain('parentUserId: input.recipient.parentUserId');
  });

  it('follow-up ask', () => {
    const src = source('followup/run.ts');
    expect(src).toContain("lane: 'followup_ask'");
    expect(src).toContain('parentUserId: input.parentUserId');
  });

  it('watched spots', () => {
    const src = source('spots/sweep.ts');
    expect(src).toContain("lane: 'spot_open'");
    expect(src).toContain('parentUserId: spot.parentUserId');
  });

  it('registration sequence', () => {
    const src = source('../registration/sequence/run.ts');
    expect(src).toContain("lane: 'registration_sequence'");
    expect(src).toContain('parentUserId: recipient.parentUserId');
  });
});

describe('VIL-581 · dispatch ports bind both the shadow and the enforcer', () => {
  it('wiring.ts binds claimEnforce to this handle', () => {
    const src = source('wiring.ts');
    expect(src).toContain('claimEnforce: bindDispatchClaimEnforce(database)');
    expect(src).toContain('claimShadow:');
  });
});

describe('isRetryableClaimReadFailure', () => {
  it('retries a provider blip and not a missing zone or an oversize body', () => {
    expect(isRetryableClaimReadFailure('unreachable')).toBe(true);
    expect(isRetryableClaimReadFailure('rate_limited')).toBe(true);
    expect(isRetryableClaimReadFailure('no_time_zone')).toBe(false);
    expect(isRetryableClaimReadFailure('oversize')).toBe(false);
    expect(isRetryableClaimReadFailure('lane_unavailable')).toBe(false);
  });
});
