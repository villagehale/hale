import { describe, expect, it } from 'vitest';
import { changeFromSource } from './change';
import { reminderFacts, type ReminderFactEvent } from './compose';

const TZ = 'America/Toronto';
const STORED = { startsAt: new Date('2026-10-26T19:00:00Z'), location: 'Georgetown library' }; // 3 PM

describe('VIL-474 · changeFromSource — only a provider value that differs records a change', () => {
  it('same day, new clock time from the source: a time change with the old start', () => {
    expect(
      changeFromSource({
        stored: STORED,
        source: { startsAt: new Date('2026-10-26T20:30:00Z'), location: 'Georgetown library' },
        timeZone: TZ,
      }),
    ).toEqual({ field: 'time', previousStartsAt: STORED.startsAt });
  });

  it('a start on another family-local day is a date change', () => {
    expect(
      changeFromSource({
        stored: STORED,
        source: { startsAt: new Date('2026-10-27T19:00:00Z'), location: null },
        timeZone: TZ,
      })?.field,
    ).toBe('date');
  });

  it('a different venue from the source is a venue change with the old venue', () => {
    expect(
      changeFromSource({
        stored: STORED,
        source: { startsAt: STORED.startsAt, location: 'Main St pool' },
        timeZone: TZ,
      }),
    ).toEqual({ field: 'venue', previousLocation: 'Georgetown library' });
  });

  it('nothing differs, or the source has no value: no change', () => {
    expect(
      changeFromSource({ stored: STORED, source: { ...STORED }, timeZone: TZ }),
    ).toBeNull();
    expect(
      changeFromSource({ stored: STORED, source: { startsAt: null, location: null }, timeZone: TZ }),
    ).toBeNull();
  });
});

function ev(over: Partial<ReminderFactEvent> = {}): ReminderFactEvent {
  return {
    eventRef: 'e1',
    title: 'Swim',
    startsAt: '2026-10-26T20:30:00Z',
    endsAt: null,
    childId: null,
    sensitive: false,
    location: 'Main St pool',
    ...over,
  };
}

function factsOf(event: ReminderFactEvent) {
  return reminderFacts({
    events: [event],
    children: [],
    level: 'first_name',
    timeZone: TZ,
    offset: '-P1D',
    now: new Date('2026-10-25T22:00:00Z'),
    planLink: null,
    language: 'en',
  }).events[0];
}

describe('VIL-474 · the changed fact the writer sees', () => {
  it('a time change carries its old clock time', () => {
    expect(
      factsOf(ev({ change: { field: 'time', previousStartsAt: STORED.startsAt } }))?.changed,
    ).toEqual({ field: 'time', from: '3:00 PM' });
  });

  it('a venue change carries its old venue', () => {
    expect(
      factsOf(ev({ change: { field: 'venue', previousLocation: 'Georgetown library' } }))?.changed,
    ).toEqual({ field: 'venue', from: 'Georgetown library' });
  });

  it('never inferred from wording: a title that says it moved records nothing', () => {
    expect(factsOf(ev({ title: 'RESCHEDULED: Swim moved to 4:30' }))?.changed).toBeNull();
  });

  it('a private event withholds its old venue as it withholds its venue', () => {
    expect(
      factsOf(
        ev({ sensitive: true, change: { field: 'venue', previousLocation: 'Clinic, 1 Main' } }),
      )?.changed,
    ).toBeNull();
  });
});
