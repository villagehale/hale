import { describe, expect, it } from 'vitest';
import { parseGroupExperienceReading } from './reading';

describe('parseGroupExperienceReading', () => {
  it('treats low confidence as none', () => {
    expect(
      parseGroupExperienceReading({
        kind: 'rsvp_open',
        confidence: 'low',
      }),
    ).toEqual({
      kind: 'none',
      title: null,
      response: null,
      optionKey: null,
      options: [],
      starts: [],
      confidence: 'low',
    });
  });

  it('pairs each time option with the instant the model placed, never a parsed label', () => {
    expect(
      parseGroupExperienceReading({
        kind: 'time_open',
        options: ['Saturday 10', 'Sunday 10', 'Monday'],
        starts: ['2026-11-14T10:00:00-05:00', 'Sunday 10', null],
        confidence: 'high',
      }),
    ).toMatchObject({
      options: ['Saturday 10', 'Sunday 10', 'Monday'],
      starts: ['2026-11-14T10:00:00-05:00', null, null],
    });
  });

  it('places nothing when the starts do not line up with the options', () => {
    expect(
      parseGroupExperienceReading({
        kind: 'time_open',
        options: ['Saturday 10', 'Sunday 10'],
        starts: ['2026-11-14T10:00:00-05:00'],
        confidence: 'high',
      }),
    ).toMatchObject({ starts: [null, null] });
  });

  it('keeps a high-confidence RSVP vote', () => {
    expect(
      parseGroupExperienceReading({
        kind: 'rsvp_vote',
        response: 'yes',
        confidence: 'high',
      }),
    ).toMatchObject({ kind: 'rsvp_vote', response: 'yes', confidence: 'high' });
  });

  it('rejects an unknown kind', () => {
    expect(parseGroupExperienceReading({ kind: 'carpool_open' })).toBeNull();
  });
});
