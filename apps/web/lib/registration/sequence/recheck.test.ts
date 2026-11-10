import { describe, expect, it } from 'vitest';
import type { LiveRegistrationReading } from '../live-reading';
import type { RegistrationReader } from '../read';
import { type RecheckSubject, nextRecheckAt, recheckWatchedDates } from './recheck';

const HOUR = 3_600_000;
const OPEN = new Date('2026-09-20T16:00:00.000Z');

describe('VIL-423 · nextRecheckAt: daily, then hourly as the opening nears', () => {
  it('reads daily while the opening is far off', () => {
    const now = new Date(OPEN.getTime() - 10 * 24 * HOUR);
    expect(nextRecheckAt(OPEN, now).getTime()).toBe(now.getTime() + 24 * HOUR);
  });

  it('never lets a daily read skip past the start of the hourly stretch', () => {
    const now = new Date(OPEN.getTime() - 3 * 24 * HOUR - 2 * HOUR);
    expect(nextRecheckAt(OPEN, now).getTime()).toBe(OPEN.getTime() - 3 * 24 * HOUR);
  });

  it('reads hourly inside the last three days', () => {
    const now = new Date(OPEN.getTime() - 30 * HOUR);
    expect(nextRecheckAt(OPEN, now).getTime()).toBe(now.getTime() + HOUR);
  });
});

describe('VIL-423 · recheckWatchedDates: a page that moves back owes no note', () => {
  it('clears the owed change when the page returns to the opening the household was told', async () => {
    const reading: LiveRegistrationReading = {
      sourceUrl: 'https://rec.example.org/fall',
      checkedAt: new Date('2026-09-10T16:00:00.000Z'),
      reader: 'ai',
      status: 'verified',
      timeZone: 'America/Edmonton',
      dates: [{ kind: 'general_open', date: '2026-09-20', time: '10:00', evidence: ['x'] }],
      partialDates: [],
    };
    const reader: RegistrationReader = async () => reading;
    const subject: RecheckSubject = {
      sequenceId: 'seq-1',
      window: {
        id: 'w-1',
        municipality: 'larchmere' as never,
        programDomain: 'rec_program',
        cycleLabel: 'Fall 2026',
        sourceUrl: 'https://rec.example.org/fall',
        district: null,
      },
      resident: false,
      // The ladder runs on the 18th, which the page showed last; the household was told the 20th.
      anchor: new Date('2026-09-18T16:00:00.000Z'),
      nextCheckAt: null,
      pendingChange: {
        from: OPEN.toISOString(),
        to: '2026-09-18T16:00:00.000Z',
        toTimePrinted: true,
      },
    };

    const { results } = await recheckWatchedDates(
      [subject],
      () => reader,
      'enforce',
      new Date('2026-09-10T16:00:00.000Z'),
    );

    expect(results[0]?.outcome).toBe('moved');
    expect(results[0]?.patch.pendingChange).toBeNull();
    expect(results[0]?.patch.lastReading?.openAt).toBe(OPEN.toISOString());
  });
});
