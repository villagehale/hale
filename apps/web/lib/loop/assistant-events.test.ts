import { describe, expect, it } from 'vitest';
import { toTeenSafeAssistantEvent } from './assistant-events';

const NOW = new Date('2026-07-22T12:00:00.000Z');

describe('toTeenSafeAssistantEvent', () => {
  it('drops teen event detail and location using the deterministic age gate', () => {
    const result = toTeenSafeAssistantEvent(
      {
        id: 'event-1',
        title: 'Therapy with Dr. Reed',
        startsAt: new Date('2026-07-23T14:00:00.000Z'),
        endsAt: null,
        location: 'Private clinic',
        sensitive: false,
        childDob: '2010-01-01',
      },
      NOW,
    );
    expect(result).toEqual({
      id: 'event-1',
      title: 'A private calendar item',
      startsAt: '2026-07-23T14:00:00.000Z',
      endsAt: null,
      location: null,
    });
  });

  it('genericizes sensitive events even for a non-teen child', () => {
    const result = toTeenSafeAssistantEvent(
      {
        id: 'event-2',
        title: 'Specialist appointment',
        startsAt: new Date('2026-07-24T14:00:00.000Z'),
        endsAt: null,
        location: 'Clinic',
        sensitive: true,
        childDob: '2022-01-01',
      },
      NOW,
    );
    expect(result.title).toBe('A private calendar item');
    expect(result.location).toBeNull();
  });

  it('keeps a non-sensitive, non-teen event', () => {
    const result = toTeenSafeAssistantEvent(
      {
        id: 'event-3',
        title: 'Leo swim meet',
        startsAt: new Date('2026-07-25T14:00:00.000Z'),
        endsAt: new Date('2026-07-25T15:00:00.000Z'),
        location: 'Community pool',
        sensitive: false,
        childDob: '2020-01-01',
      },
      NOW,
    );
    expect(result.title).toBe('Leo swim meet');
    expect(result.location).toBe('Community pool');
  });
});
