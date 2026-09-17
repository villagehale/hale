import { describe, expect, it } from 'vitest';
import { nextWatchedCycle } from './discovery-targets';

/**
 * The list is hand-maintained and the weekly sweep never prunes it, so a target whose
 * window has since landed stays on it forever. Deciding the next cycle by excluding the
 * ONE label that just went therefore hands a stale target straight back: once Winter
 * 2027 opens, "Fall 2026 dates are not posted yet" — a registration the parent missed
 * last autumn, named as the one still to come. The dataset's own rows are the answer.
 */
describe('nextWatchedCycle', () => {
  it('names the cycle the dataset has no row for', () => {
    expect(nextWatchedCycle('halton_hills', 'rec_program', new Set(['Fall 2026']))).toBe(
      'Winter 2027',
    );
  });

  it('is silent once the rows cover every cycle the list is waiting on', () => {
    expect(
      nextWatchedCycle('halton_hills', 'rec_program', new Set(['Fall 2026', 'Winter 2027'])),
    ).toBeNull();
  });

  it("is silent for Toronto, whose Fall 2026 targets closed the day the row landed", () => {
    expect(nextWatchedCycle('toronto', 'rec_program', new Set(['Fall 2026']))).toBeNull();
    expect(nextWatchedCycle('toronto', 'swim', new Set(['Fall 2026']))).toBeNull();
  });

  it('is silent for a town nobody registered a target for', () => {
    expect(nextWatchedCycle('markham', 'rec_program', new Set(['Fall 2026']))).toBeNull();
  });
});
