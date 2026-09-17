import { describe, expect, it } from 'vitest';
import { DISCOVERY_TARGETS, nextWatchedCycle } from './discovery-targets';
import { REGISTRATION_WINDOWS } from './registration-windows-data';

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

  it('names Winter 2027 for a Toronto family whose Fall 2026 cycle has gone', () => {
    expect(nextWatchedCycle('toronto', 'rec_program', new Set(['Fall 2026']))).toBe('Winter 2027');
    expect(nextWatchedCycle('toronto', 'swim', new Set(['Fall 2026']))).toBe('Winter 2027');
  });

  it('is silent for a town nobody registered a target for', () => {
    expect(nextWatchedCycle('markham', 'rec_program', new Set(['Fall 2026']))).toBeNull();
  });
});

/**
 * A target whose row has landed is a closed gap the hand-kept list has not noticed, and
 * runVerifySweep never prunes one: it walks every target unconditionally, so the weekly
 * digest would report "new window published — add?" for a cycle already seeded, every
 * Monday, forever. The dataset is the arbiter here exactly as it is in nextWatchedCycle.
 */
describe('DISCOVERY_TARGETS against the dataset', () => {
  it('names no cycle the dataset already holds a row for', () => {
    const seeded = new Set(
      REGISTRATION_WINDOWS.map(
        (row) => `${row.municipality}/${row.programDomain}/${row.cycleLabel}`,
      ),
    );

    const closed = DISCOVERY_TARGETS.filter((target) =>
      seeded.has(`${target.municipality}/${target.programDomain}/${target.cycleLabel}`),
    ).map((target) => `${target.municipality}/${target.programDomain}/${target.cycleLabel}`);

    expect(closed).toEqual([]);
  });
});
