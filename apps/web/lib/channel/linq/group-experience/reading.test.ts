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
      confidence: 'low',
    });
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
