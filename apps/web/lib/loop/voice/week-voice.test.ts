import type { WeekPlanItem } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { parseWeekVoiceAnswer, weekVoiceFactSlots, weekVoiceStrings } from './week-voice';

/**
 * The pure week-voice parse/validate + slot seam (VIL-229). Quality lives in the
 * cached-real eval; here we prove the STRICT contract: a clean object parses, an
 * extra/unknown field is rejected (→ deterministic fallback), and the fact slots +
 * lint strings are the ones the guard needs.
 */

const item = (partial: Partial<WeekPlanItem>): WeekPlanItem => ({
  kind: 'village',
  title: 'Something',
  childIds: [],
  startsAt: null,
  endsAt: null,
  location: null,
  sourceRef: null,
  needs: 'none',
  privacySensitive: false,
  ...partial,
});

describe('parseWeekVoiceAnswer', () => {
  it('parses a clean voice object (voice fields only)', () => {
    const answer = JSON.stringify({
      greeting: 'hi there',
      weekFraming: 'a calm week',
      itemLines: { '0': 'a gentle outing' },
      signOff: 'reply any time',
    });
    expect(parseWeekVoiceAnswer(answer)).toEqual({
      greeting: 'hi there',
      weekFraming: 'a calm week',
      itemLines: { '0': 'a gentle outing' },
      signOff: 'reply any time',
    });
  });

  it('defaults itemLines to {} when the model omits it', () => {
    const answer = JSON.stringify({ greeting: 'hi', weekFraming: 'calm', signOff: 'bye' });
    expect(parseWeekVoiceAnswer(answer)?.itemLines).toEqual({});
  });

  it('rejects an unknown/extra top-level field (→ deterministic fallback)', () => {
    const answer = JSON.stringify({
      greeting: 'hi',
      weekFraming: 'calm',
      itemLines: {},
      signOff: 'bye',
      injectedFact: 'call 416-555-0000 now',
    });
    expect(parseWeekVoiceAnswer(answer)).toBeNull();
  });

  it('returns null for a missing required field, non-JSON, and empty answer', () => {
    expect(parseWeekVoiceAnswer(JSON.stringify({ greeting: 'hi', signOff: 'bye' }))).toBeNull();
    expect(parseWeekVoiceAnswer('no json here')).toBeNull();
    expect(parseWeekVoiceAnswer(null)).toBeNull();
  });
});

describe('weekVoiceFactSlots', () => {
  it('grounds on each item title, its date key, and its human time label', () => {
    const slots = weekVoiceFactSlots([
      item({ title: 'Swim class', startsAt: '2026-07-21T16:30' }),
      item({ title: "Liam's birthday", startsAt: '2026-07-22' }),
    ]);
    expect(slots).toContain('Swim class');
    expect(slots).toContain('2026-07-21T16:30');
    expect(slots).toContain('4:30'); // the human time label, so a voiced "4:30" is grounded
    expect(slots).toContain("Liam's birthday");
  });
});

describe('weekVoiceStrings', () => {
  it('is every user-facing string: greeting, framing, sign-off, and each item line', () => {
    expect(
      weekVoiceStrings({
        greeting: 'g',
        weekFraming: 'f',
        itemLines: { '0': 'a', '1': 'b' },
        signOff: 's',
      }),
    ).toEqual(['g', 'f', 's', 'a', 'b']);
  });
});
