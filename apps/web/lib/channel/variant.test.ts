import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { localDaysBetween } from '~/lib/channel/checkin/cadence';
import {
  POOL_EPOCH,
  assertPoolSize,
  nightlyOccasion,
  pickVariant,
  weeklyOccasion,
} from './variant';

/**
 * THE SELECTOR, tested as the three properties it exists for rather than as its output.
 *
 * Every assertion below is derived from the argument in variant.ts — a repeat is
 * impossible by construction, two pools do not move together, and the same four arguments
 * give the same answer in every process — and the last test is the mutation that proves
 * the first one is measuring anything at all.
 */

/** The sizes the product actually ships: five for the two check-in pools, three for the
 * weekly and reminder folds. */
const SHIPPED_SIZES = [3, 5] as const;

const FAMILIES = Array.from({ length: 20 }, (_, i) => `fam-${i}-4d1e9f`);

function poolOf(size: number): readonly number[] {
  return Array.from({ length: size }, (_, i) => i);
}

describe('pickVariant is a rotation', () => {
  it('never hands the same family the same member two occasions running', () => {
    // 400 consecutive occasions is more than a year of evenings, and it starts before the
    // epoch so the negative branch of the modulo is covered rather than assumed.
    for (const size of SHIPPED_SIZES) {
      const pool = poolOf(size);
      for (const familyId of FAMILIES) {
        for (let day = -40; day < 360; day++) {
          const today = pickVariant(pool, 'checkin:later', familyId, day);
          const tomorrow = pickVariant(pool, 'checkin:later', familyId, day + 1);
          expect(tomorrow, `${familyId} size=${size} day=${day}`).not.toBe(today);
        }
      }
    }
  });

  it('walks the whole pool rather than favouring part of it', () => {
    // A rotation of N distinct members visits every one of them in N steps. A selector
    // that skipped one would satisfy "never repeats" and still be a smaller pool than the
    // one somebody wrote and reviewed.
    for (const size of SHIPPED_SIZES) {
      const seen = new Set(
        Array.from({ length: size }, (_, step) =>
          pickVariant(poolOf(size), 'checkin:later', 'fam-0-4d1e9f', 100 + step),
        ),
      );
      expect(seen.size, `size=${size}`).toBe(size);
    }
  });

  it('gives the same four arguments the same answer in every process', () => {
    // Pinned against the LITERAL digest rather than against another call of the same
    // function: a change of hash — or of the string the hash is taken over — silently
    // re-phases every household's rotation at once, and nothing else would catch it.
    const seed = 'checkin:later:fam-7';
    const digest = createHash('sha256').update(seed).digest('hex');
    expect(digest).toBe('f4483633facab6df804b9cfa1fcd87c598b04d3d52479404ae7aa50930abed31');

    const pool = poolOf(5);
    const offset = Number(BigInt(`0x${digest}`) % 5n);
    expect(offset).toBe(1);
    for (const occasion of [0, 1, 4, 5, 913, -3]) {
      expect(pickVariant(pool, 'checkin:later', 'fam-7', occasion)).toBe(
        (((occasion + offset) % 5) + 5) % 5,
      );
    }
  });

  it('does not move two pools in lockstep', () => {
    // The offset carries the POOL NAME, so tonight's ask and tonight's ack are not the
    // same pairing forever. Stated as a bound on a sample rather than as a golden value:
    // some families will coincide, and that is fine — most must not.
    const sample = Array.from({ length: 100 }, (_, i) => `lockstep-${i}`);
    const differ = sample.filter(
      (familyId) =>
        pickVariant(poolOf(5), 'checkin:later', familyId, 12) !==
        pickVariant(poolOf(5), 'checkin:ack', familyId, 12),
    );
    expect(differ.length).toBeGreaterThanOrEqual(60);
  });

  it('refuses a pool it cannot rotate, at the moment it is asked', () => {
    expect(() => pickVariant([], 'empty', 'fam-1', 0)).toThrow(/at least 3/);
    expect(() => pickVariant([1, 2], 'pair', 'fam-1', 0)).toThrow(/at least 3/);
    expect(() => pickVariant(poolOf(5), 'checkin:later', 'fam-1', 1.5)).toThrow(/not an integer/);
  });
});

describe('assertPoolSize', () => {
  it('throws for anything under three', () => {
    for (const size of [0, 1, 2]) {
      expect(() => assertPoolSize(poolOf(size), 'p'), `size=${size}`).toThrow(/at least 3/);
    }
  });

  it('throws for every multiple of seven, not just the first two', () => {
    // The rule names the CLASS: a nightly pool whose size is a multiple of 7 is locked to
    // the weekday forever when it is read on a weekly rhythm.
    for (const size of [7, 14, 21]) {
      expect(() => assertPoolSize(poolOf(size), 'p'), `size=${size}`).toThrow(/multiple of 7/);
    }
  });

  it('accepts the sizes the product ships, and its neighbours', () => {
    for (const size of [3, 4, 5, 6, 8, 9, 10]) {
      expect(() => assertPoolSize(poolOf(size), 'p'), `size=${size}`).not.toThrow();
    }
  });
});

describe('the two occasion formulas', () => {
  it('counts nightly occasions in whole family-local days', () => {
    const toronto = 'America/Toronto';
    const evening = new Date('2026-07-06T00:17:00.000Z'); // 20:17 on 2026-07-05 in Toronto
    expect(nightlyOccasion(evening, toronto)).toBe(localDaysBetween(POOL_EPOCH, evening, toronto));
    // One local day on is one occasion on — including across a spring-forward, which is
    // the case a millisecond rhythm gets wrong.
    const dstEve = new Date('2026-03-08T00:17:00.000Z'); // 19:17 Mar 7 in Toronto
    const dstNext = new Date('2026-03-09T00:17:00.000Z'); // 20:17 Mar 8, one hour shorter
    expect(nightlyOccasion(dstNext, toronto) - nightlyOccasion(dstEve, toronto)).toBe(1);
    // The family's zone decides, not the server's: the same instant is a different
    // calendar day in Vancouver.
    expect(nightlyOccasion(evening, 'America/Vancouver')).toBe(nightlyOccasion(evening, toronto));
    const justPastMidnight = new Date('2026-07-06T04:30:00.000Z'); // Jul 6 in Toronto, Jul 5 in Vancouver
    expect(nightlyOccasion(justPastMidnight, toronto)).toBe(
      nightlyOccasion(justPastMidnight, 'America/Vancouver') + 1,
    );
  });

  it('advances the weekly occasion by exactly one per Monday', () => {
    const mondays = ['2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20'];
    const occasions = mondays.map(weeklyOccasion);
    for (let i = 1; i < occasions.length; i++) {
      expect((occasions[i] as number) - (occasions[i - 1] as number), mondays[i]).toBe(1);
    }
    // Before the epoch it still steps by one rather than folding at zero.
    expect(weeklyOccasion('2025-12-29') + 1).toBe(weeklyOccasion('2026-01-05'));
    expect(() => weeklyOccasion('not-a-date')).toThrow(/week key/);
  });
});

describe('the mutation the rotation exists to survive', () => {
  it('goes red when the rotation is replaced by a hash of the day', () => {
    // A hash-mod-N of (seed, occasion) passes every determinism test above and repeats on
    // roughly one evening in N. This reproduces that selector and asserts it DOES repeat,
    // so the no-consecutive-repeat test is measuring the rotation rather than passing on
    // any deterministic function.
    const hashed = (poolName: string, familyId: string, occasion: number, size: number) => {
      const digest = createHash('sha256')
        .update(`${poolName}:${familyId}:${occasion}`)
        .digest('hex');
      return Number(BigInt(`0x${digest}`) % BigInt(size));
    };
    let repeats = 0;
    for (const familyId of FAMILIES) {
      for (let day = 0; day < 200; day++) {
        if (
          hashed('checkin:later', familyId, day, 5) ===
          hashed('checkin:later', familyId, day + 1, 5)
        ) {
          repeats += 1;
        }
      }
    }
    // ~1 in 5 of 4000 draws. The point is only that it is not zero: the real selector's
    // count is exactly zero, asserted above.
    expect(repeats).toBeGreaterThan(300);
  });
});
