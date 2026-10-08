import { schema } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProactiveReview } from './review';

function fakeDb(held: Record<string, unknown>) {
  function builder(table: unknown) {
    const rows = table === schema.proactiveCandidates ? [held] : [];
    const result = Promise.resolve(rows);
    const self = {
      from(next: unknown) {
        return builder(next);
      },
      innerJoin() {
        return self;
      },
      where() {
        return Object.assign(Promise.resolve(rows), {
          limit: () => Promise.resolve(rows),
        });
      },
      limit() {
        return result;
      },
    };
    return self;
  }
  return { select: () => builder(null) };
}

describe('runProactiveReview cost guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not call the model for a held family with no new signal', async () => {
    vi.stubEnv('PROACTIVE_CADENCE', 'shadow');
    const create = vi.fn();
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args);
    });
    const summary = await runProactiveReview(
      fakeDb({
        id: 'cand-1',
        familyId: 'fam-1',
        what: 'Saturday farmers market',
        why: 'a nearby listing',
        sourceUrl: null,
        worthlessAfter: null,
        parentRequested: false,
        dedupeKey: 'market',
        status: 'held',
        reason: 'no window yet',
        holdUntil: null,
        decidedAt: new Date('2026-10-08T22:00:00.000Z'),
        createdAt: new Date('2026-10-08T21:00:00.000Z'),
      }) as never,
      {
        now: new Date('2026-10-08T23:00:00.000Z'),
        client: { messages: { create } } as never,
      },
    );
    spy.mockRestore();
    expect(create).not.toHaveBeenCalled();
    expect(summary.decided).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(errors.some((args) => args.some((arg) => String(arg).includes('family failed')))).toBe(
      false,
    );
  });
});
