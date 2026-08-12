import { describe, expect, it } from 'vitest';
import { CONSUMED_SEND_STATUSES } from './ledger';

/**
 * Launch-day review P0 (2026-08-11): with 'failed' missing from the consumed
 * set, an undelivered receipt (real since #396) un-consumed the dedupe key for
 * every reader while the DB unique index still held it — re-send, 23505 crash,
 * no audit row, repeating every slot. The fake-db convention here evaluates no
 * WHERE clauses, so this test pins the PREDICATE itself: the one list both
 * dedupeActive and the told-marker reader filter on.
 */
describe('CONSUMED_SEND_STATUSES — a provider attempt consumes idempotency forever', () => {
  it("counts 'failed' as consumed — a lost delivery must never re-arm its own key", () => {
    expect(CONSUMED_SEND_STATUSES).toContain('failed');
  });

  it('covers every status a provider attempt can land in', () => {
    expect([...CONSUMED_SEND_STATUSES].sort()).toEqual(
      ['delivered', 'failed', 'queued', 'sent'].sort(),
    );
  });
});
