import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeActionHash } from './action-hash.js';

/**
 * action_hash is the idempotency key check_action_idempotency matches on
 * (actions.payload->>'action_hash'). The load-bearing property is DETERMINISM:
 * two independently-built drafts for the SAME activity+family MUST hash equal, so
 * a re-accept dedups; two different activities MUST hash apart, so distinct
 * activities never false-dedup. Expected values are derived from the documented
 * input shape (`familyId|actionType|identity`, sha256 hex), not copied from output.
 */
describe('computeActionHash', () => {
  const FAM = '11111111-1111-4111-8111-111111111111';
  const CAND = 'aaaaaaaa-0000-4000-8000-000000000011';

  it('hashes the pipe-joined identity as sha256 hex (matches the documented shape)', () => {
    const expected = createHash('sha256').update(`${FAM}|add_to_routine|${CAND}`).digest('hex');
    expect(computeActionHash(FAM, 'add_to_routine', CAND)).toBe(expected);
  });

  it('is deterministic — same activity+family re-accept yields the same hash (dedup works)', () => {
    expect(computeActionHash(FAM, 'add_to_routine', CAND)).toBe(
      computeActionHash(FAM, 'add_to_routine', CAND),
    );
  });

  it('separates on every input — different activity, type, or family never collide', () => {
    const base = computeActionHash(FAM, 'add_to_routine', CAND);
    const otherActivity = computeActionHash(FAM, 'add_to_routine', 'bbbbbbbb-0000-4000-8000-000000000012');
    const otherType = computeActionHash(FAM, 'add_to_digest_only', CAND);
    const otherFamily = computeActionHash('22222222-2222-4222-8222-222222222222', 'add_to_routine', CAND);
    expect(new Set([base, otherActivity, otherType, otherFamily]).size).toBe(4);
  });

  it('produces a 64-char hex digest', () => {
    expect(computeActionHash(FAM, 'add_to_routine', CAND)).toMatch(/^[0-9a-f]{64}$/);
  });
});
