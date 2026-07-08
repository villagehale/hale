import { describe, expect, it } from 'vitest';
import type { LogView } from './api-types';
import { computeNapsTrend, MIN_DAYS_WITH_DATA } from './naps-trend';

/**
 * The naps trend sums the last 7 local days' nap minutes per day, drawn client-side
 * from the widened logs. Expected values are derived from the spec (sum durationMin
 * per local day; only 'nap' rows with a numeric durationMin count; below
 * MIN_DAYS_WITH_DATA distinct days → the empty state), not copied from output.
 * `now` is injected so the 7-day window is deterministic (UTC noon anchors avoid
 * a local-midnight day flip in CI).
 */

const NOW = new Date('2026-07-07T12:00:00Z');

function nap(id: string, occurredAt: string, durationMin: number): LogView {
  return { id, childId: 'c1', episodeType: 'nap', summary: `Napped ${durationMin} min`, occurredAt, durationMin };
}

describe('computeNapsTrend', () => {
  it('returns 7 days oldest→newest ending on today', () => {
    const { days } = computeNapsTrend([], NOW);
    expect(days).toHaveLength(7);
    expect(days[6]?.dayKey).toBe('2026-07-07');
    expect(days[0]?.dayKey).toBe('2026-07-01');
  });

  it("sums a day's nap minutes and tracks the peak", () => {
    const logs = [
      nap('a', '2026-07-07T09:00:00Z', 40),
      nap('b', '2026-07-07T14:00:00Z', 50),
      nap('c', '2026-07-06T10:00:00Z', 30),
      nap('d', '2026-07-05T10:00:00Z', 20),
    ];
    const { days, peakMin } = computeNapsTrend(logs, NOW);
    const today = days.find((d) => d.dayKey === '2026-07-07');
    expect(today?.totalMin).toBe(90);
    expect(today?.hasData).toBe(true);
    expect(peakMin).toBe(90);
  });

  it('marks a day with no naps as a gap (hasData false, not a fabricated bar)', () => {
    const logs = [nap('a', '2026-07-07T09:00:00Z', 40)];
    const { days } = computeNapsTrend(logs, NOW);
    const emptyDay = days.find((d) => d.dayKey === '2026-07-04');
    expect(emptyDay?.hasData).toBe(false);
    expect(emptyDay?.totalMin).toBe(0);
  });

  it('ignores non-nap rows and naps missing a numeric durationMin', () => {
    const logs: LogView[] = [
      { id: 'f', childId: 'c1', episodeType: 'feed', summary: 'Fed 120 ml', occurredAt: '2026-07-07T09:00:00Z', amountMl: 120 },
      { id: 'n', childId: 'c1', episodeType: 'nap', summary: 'Napped', occurredAt: '2026-07-07T10:00:00Z' },
      nap('good', '2026-07-07T11:00:00Z', 25),
    ];
    const { days } = computeNapsTrend(logs, NOW);
    const today = days.find((d) => d.dayKey === '2026-07-07');
    expect(today?.totalMin).toBe(25);
  });

  it('drops naps older than the 7-day window', () => {
    const logs = [nap('old', '2026-06-20T09:00:00Z', 60), nap('new', '2026-07-07T09:00:00Z', 30)];
    const { days } = computeNapsTrend(logs, NOW);
    const total = days.reduce((s, d) => s + d.totalMin, 0);
    expect(total).toBe(30);
  });

  it(`is "enough" only at ${MIN_DAYS_WITH_DATA}+ distinct days with data`, () => {
    const twoDays = [nap('a', '2026-07-07T09:00:00Z', 40), nap('b', '2026-07-06T09:00:00Z', 30)];
    expect(computeNapsTrend(twoDays, NOW).enough).toBe(false);

    const threeDays = [...twoDays, nap('c', '2026-07-05T09:00:00Z', 20)];
    expect(computeNapsTrend(threeDays, NOW).enough).toBe(true);
  });

  it('marks days older than the fetched coverage as "not loaded", never "no naps"', () => {
    // A heavy-logging family: page 1 only reaches back to Jul 5 (its oldest row),
    // so Jul 1–4 were never READ. Those days must read "not loaded" (loaded false,
    // hasData false, totalMin 0) — NOT a known-zero "no naps" gap.
    const logs = [
      nap('a', '2026-07-07T09:00:00Z', 40),
      nap('b', '2026-07-06T09:00:00Z', 30),
      nap('c', '2026-07-05T09:00:00Z', 20),
    ];
    const coveredSince = new Date('2026-07-05T09:00:00Z');
    const { days, partial } = computeNapsTrend(logs, NOW, coveredSince);

    expect(partial).toBe(true);
    const uncovered = days.find((d) => d.dayKey === '2026-07-03');
    expect(uncovered).toMatchObject({ loaded: false, hasData: false, totalMin: 0 });
    // The boundary day itself is NOT loaded — the page may have ended mid-day,
    // so its sum could be partial. Only days strictly after it are trusted.
    const boundary = days.find((d) => d.dayKey === '2026-07-05');
    expect(boundary).toMatchObject({ loaded: false, hasData: false, totalMin: 0 });
    const covered = days.find((d) => d.dayKey === '2026-07-06');
    expect(covered).toMatchObject({ loaded: true, hasData: true, totalMin: 30 });
  });

  it('never renders a partial-sum bar for a boundary day split by the page edge', () => {
    // Two naps on Jul 5; the page's oldest row is the 14:00 one, so the 09:00 nap
    // was never read. A bar of 25 (half the real 60) would be a trend drawn from
    // less data than claimed — the day must read "not loaded" instead.
    const logs = [
      nap('a', '2026-07-07T09:00:00Z', 40),
      nap('b', '2026-07-06T09:00:00Z', 30),
      nap('c', '2026-07-05T14:00:00Z', 25),
    ];
    const coveredSince = new Date('2026-07-05T14:00:00Z');
    const { days } = computeNapsTrend(logs, NOW, coveredSince);
    expect(days.find((d) => d.dayKey === '2026-07-05')).toMatchObject({
      loaded: false,
      hasData: false,
      totalMin: 0,
    });
  });

  it('does not count a "not loaded" day toward the MIN_DAYS_WITH_DATA gate', () => {
    // Boundary at Jul 6 → Jul 6 itself untrusted (page edge), so only Jul 7 has
    // loaded data. One day < MIN_DAYS_WITH_DATA → not enough (no phantom days
    // fabricated from unread buckets).
    const logs = [nap('a', '2026-07-07T09:00:00Z', 40), nap('b', '2026-07-06T09:00:00Z', 30)];
    const coveredSince = new Date('2026-07-06T09:00:00Z');
    expect(computeNapsTrend(logs, NOW, coveredSince).enough).toBe(false);
  });

  it('is not partial when the whole history was fetched (no coverage boundary)', () => {
    const logs = [nap('a', '2026-07-07T09:00:00Z', 40)];
    const { partial, days } = computeNapsTrend(logs, NOW);
    expect(partial).toBe(false);
    expect(days.every((d) => d.loaded)).toBe(true);
  });
});
