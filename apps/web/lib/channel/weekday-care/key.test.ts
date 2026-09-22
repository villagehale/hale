import { describe, expect, it } from 'vitest';
import {
  childIdFromWeekdayCareKey,
  parseWeekdayAskKey,
  weekdayCareDedupeKey,
  weekdayFinderDedupeKey,
} from './key';

/**
 * The ask names one child and the answer rarely does ("she's home with me"), so this
 * string is the only thing standing between a parent's reply and the wrong child's row.
 * Both directions live in one module and this pins the round trip.
 */
describe('the weekday-care dedupe key', () => {
  const KEY = weekdayCareDedupeKey('fam-1', 'child-mia', 'user-1');

  it('round-trips the child it asked about', () => {
    expect(KEY).toBe('nudge:fam-1:weekday_care:child-mia:user-1');
    expect(childIdFromWeekdayCareKey(KEY)).toBe('child-mia');
  });

  it('refuses every other lane’s key rather than guessing a segment', () => {
    // `channel_messages.dedupe_key` holds every lane's keys, and a parser that coerced
    // one of these would file an answer against a stranger.
    for (const other of [
      'nudge:fam-1:weather_swap:2026-08-03:user-1',
      'nudge:fam-1:registration:w-1:user-1',
      'followup:daycare:child-mia',
      'health:fam-1:immunization_18_months#user-1',
      'nudge:fam-1:weekday_care:child-mia',
      'nudge:fam-1:weekday_care:child-mia:user-1:extra',
      '',
      null,
    ]) {
      expect(childIdFromWeekdayCareKey(other), String(other)).toBeNull();
    }
  });

  it('treats a household ask as search intent, not a child', () => {
    const key = weekdayFinderDedupeKey('fam-1', { prompt: 'weekend_fallback' }, 'user-1');
    expect(key).toBe('nudge:fam-1:weekday_care:household:user-1');
    expect(childIdFromWeekdayCareKey(key)).toBeNull();
    expect(parseWeekdayAskKey(key)).toEqual({
      scope: 'search',
      prompt: 'weekend_fallback',
      eventKey: null,
    });
  });

  it('keeps a legacy child key answerable as a care fact', () => {
    expect(parseWeekdayAskKey(KEY)).toEqual({ scope: 'legacy_care', childId: 'child-mia' });
  });
});
