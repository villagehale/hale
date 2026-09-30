import { describe, expect, it } from 'vitest';
import {
  gcalItemAlreadyEnded,
  gcalPastClassifySkipEnabled,
} from './gcal-classify.js';

const NOW = new Date('2026-09-30T15:00:00.000Z');

function hoursBefore(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString();
}

describe('gcalPastClassifySkipEnabled', () => {
  it('defaults on, and only the literal false turns it off', () => {
    expect(gcalPastClassifySkipEnabled({})).toBe(true);
    expect(gcalPastClassifySkipEnabled({ GCAL_PAST_CLASSIFY_SKIP: 'true' })).toBe(true);
    expect(gcalPastClassifySkipEnabled({ GCAL_PAST_CLASSIFY_SKIP: 'false' })).toBe(false);
    expect(gcalPastClassifySkipEnabled({ GCAL_PAST_CLASSIFY_SKIP: 'false\n' })).toBe(false);
  });
});

describe('gcalItemAlreadyEnded', () => {
  it('skips a timed item whose end is at least a day ago', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(
      gcalItemAlreadyEnded(
        {
          summary: 'Dentist',
          start: { dateTime: hoursBefore(day + 60 * 60 * 1000) },
          end: { dateTime: hoursBefore(day) },
        },
        NOW,
      ),
    ).toBe(true);
  });

  it('keeps a timed item that ended this afternoon', () => {
    expect(
      gcalItemAlreadyEnded(
        {
          summary: 'Swim registration',
          start: { dateTime: hoursBefore(3 * 60 * 60 * 1000) },
          end: { dateTime: hoursBefore(2 * 60 * 60 * 1000) },
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('keeps an item that is still in progress even when it started long ago', () => {
    expect(
      gcalItemAlreadyEnded(
        {
          summary: 'Camp week',
          start: { dateTime: hoursBefore(5 * 24 * 60 * 60 * 1000) },
          end: { dateTime: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString() },
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('keeps a future item', () => {
    expect(
      gcalItemAlreadyEnded(
        {
          summary: 'Pediatric checkup',
          start: { dateTime: '2026-10-02T15:00:00.000Z' },
          end: { dateTime: '2026-10-02T15:30:00.000Z' },
        },
        NOW,
      ),
    ).toBe(false);
  });

  it('skips an all-day item whose exclusive end is at least two UTC days behind', () => {
    // All-day on 2026-09-26 → exclusive end 2026-09-27. Today is 2026-09-30.
    expect(
      gcalItemAlreadyEnded(
        { summary: 'PD day', start: { date: '2026-09-26' }, end: { date: '2026-09-27' } },
        NOW,
      ),
    ).toBe(true);
  });

  it('keeps an all-day item from the last two UTC days', () => {
    expect(
      gcalItemAlreadyEnded(
        { summary: 'Picture day', start: { date: '2026-09-29' }, end: { date: '2026-09-30' } },
        NOW,
      ),
    ).toBe(false);
  });

  it('keeps an item with no readable time', () => {
    expect(gcalItemAlreadyEnded({ summary: 'Untitled' }, NOW)).toBe(false);
    expect(gcalItemAlreadyEnded({ end: { dateTime: 'not-a-date' } }, NOW)).toBe(false);
  });
});
