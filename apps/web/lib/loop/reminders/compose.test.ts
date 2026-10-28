import { describe, expect, it } from 'vitest';
import type { ReminderChild } from '~/lib/loop/templates/reminder/payload';
import {
  type ReminderFactEvent,
  isAllDay,
  localClockFact,
  reminderFacts,
  reminderRefusals,
  reminderUserMessage,
} from './compose';

const TZ = 'America/Toronto';
const NOW = new Date('2026-10-25T22:00:00Z'); // Sun Oct 25, 6:00 PM EDT
const TEEN: ReminderChild = {
  id: 'c-teen',
  name: 'Rowan',
  dateOfBirth: '2011-03-01',
  gender: null,
};
const KID: ReminderChild = { id: 'c-kid', name: 'Mia', dateOfBirth: '2019-03-01', gender: 'girl' };

function ev(over: Partial<ReminderFactEvent> = {}): ReminderFactEvent {
  return {
    eventRef: 'e1',
    title: 'Jour de congé',
    startsAt: '2026-10-26T19:00:00Z', // 3:00 PM EDT
    endsAt: '2026-10-26T20:00:00Z', // 4:00 PM EDT
    childId: null,
    sensitive: false,
    location: 'Georgetown library',
    ...over,
  };
}

function facts(events: ReminderFactEvent[], children: ReminderChild[] = [], language = 'fr') {
  return reminderFacts({
    events,
    children,
    level: 'first_name',
    timeZone: TZ,
    offset: '-P1D',
    now: NOW,
    planLink: null,
    language,
  });
}

describe('reminderFacts — the facts the model writes the whole text from', () => {
  it('a timed event carries its date, start AND end with AM/PM, place and the language', () => {
    expect(facts([ev()])).toEqual({
      offset: '-P1D',
      now: { date: 'Sunday, October 25, 2026', time: '6:00 PM' },
      events: [
        {
          what: 'Jour de congé',
          date: 'Monday, October 26, 2026',
          allDay: false,
          start: '3:00 PM',
          end: '4:00 PM',
          location: 'Georgetown library',
        },
      ],
      planLink: null,
      language: 'fr',
    });
  });

  it('keeps AM distinct from PM', () => {
    expect(localClockFact(new Date('2026-10-26T13:30:00Z'), TZ)).toBe('9:30 AM');
    expect(localClockFact(new Date('2026-10-27T01:30:00Z'), TZ)).toBe('9:30 PM');
  });

  it('an all-day event carries no clock time', () => {
    const allDay = ev({
      title: 'PD Day',
      startsAt: '2026-10-26T04:00:00Z',
      endsAt: '2026-10-27T04:00:00Z',
      location: null,
    });
    expect(facts([allDay], [], 'en').events[0]).toEqual({
      what: 'PD Day',
      date: 'Monday, October 26, 2026',
      allDay: true,
      start: null,
      end: null,
      location: null,
    });
  });

  it('a private (teen) event is the bare generic with no place', () => {
    const f = facts([ev({ title: 'therapy', childId: 'c-teen', location: '1 Clinic Rd' })], [TEEN]);
    expect(f.events[0]).toMatchObject({ what: 'an appointment', location: null });
    expect(reminderUserMessage(f)).not.toMatch(/Rowan|therapy|Clinic/);
  });

  it('attributes a younger child at the parent name level', () => {
    expect(facts([ev({ title: 'Swim', childId: 'c-kid' })], [KID]).events[0]?.what).toBe(
      'Mia — Swim',
    );
  });
});

describe('isAllDay', () => {
  it('midnight to midnight is all-day; a 3-4 PM event is not', () => {
    expect(isAllDay(new Date('2026-10-26T04:00:00Z'), new Date('2026-10-27T04:00:00Z'), TZ)).toBe(
      true,
    );
    expect(isAllDay(new Date('2026-10-26T04:00:00Z'), null, TZ)).toBe(true);
    expect(isAllDay(new Date('2026-10-26T19:00:00Z'), new Date('2026-10-26T20:00:00Z'), TZ)).toBe(
      false,
    );
    expect(isAllDay(new Date('2026-10-26T04:00:00Z'), new Date('2026-10-26T05:00:00Z'), TZ)).toBe(
      false,
    );
  });
});

describe('reminderRefusals — structure only, never wording', () => {
  const f = facts([ev()]);
  it('refuses empty, too long, and any link not handed', () => {
    expect(reminderRefusals('  ', f)).toEqual(['empty']);
    expect(reminderRefusals('x'.repeat(481), f)).toEqual(['over_char_cap']);
    expect(reminderRefusals('Voir https://evil.example', f)).toEqual(['other_link']);
    expect(reminderRefusals('Demain à 15 h, bingo à la bibliothèque.', f)).toEqual([]);
  });
  it('allows the handed plan link', () => {
    const withLink = { ...f, planLink: 'https://app.villagehale.com/plan' };
    expect(reminderRefusals('Plan: https://app.villagehale.com/plan', withLink)).toEqual([]);
  });
});

describe('reminderFacts — parking and what to bring (VIL-468)', () => {
  it('passes stated parking and bring facts through as written', () => {
    const [event] = facts([
      ev({ notes: { parking: 'Lot B behind the rink', bring: 'skates and a helmet' } }),
    ]).events;
    expect(event).toMatchObject({ parking: 'Lot B behind the rink', bring: 'skates and a helmet' });
  });

  it('adds no key when nothing was stated, so the request is unchanged', () => {
    const plain = reminderUserMessage(facts([ev()]));
    expect(reminderUserMessage(facts([ev({ notes: null })]))).toBe(plain);
    expect(reminderUserMessage(facts([ev({ notes: { parking: '  ' } })]))).toBe(plain);
    expect(facts([ev()]).events[0]).not.toHaveProperty('parking');
    expect(facts([ev()]).events[0]).not.toHaveProperty('bring');
  });

  it('a private event carries no logistics, like its place', () => {
    const [event] = facts([
      ev({ sensitive: true, notes: { parking: 'Lot B', bring: 'health card' } }),
    ]).events;
    expect(event?.location).toBeNull();
    expect(event).not.toHaveProperty('parking');
    expect(event).not.toHaveProperty('bring');
  });
});
