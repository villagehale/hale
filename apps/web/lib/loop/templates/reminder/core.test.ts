import { describe, expect, it } from 'vitest';
import { eventDescriptor, eventLine, localTimeLabel, whenLead } from './core';
import type { ReminderChild, ReminderEventView } from './payload';

/**
 * VIL-223 · D1 reminder core — the pure copy helpers. Expectations derive from the
 * spec (the teen age gate, the name-level dial, the family-local clock), never output.
 * deriveStage boundary is 156 months; NOW anchors every age.
 */

const NOW = new Date('2026-07-25T12:00:00Z');
const TZ = 'America/Toronto';

const maya: ReminderChild = { id: 'c-maya', name: 'Maya', dateOfBirth: '2019-03-10', gender: 'girl' };
// 2011 DOB is ~15y at NOW → deriveStage 'teenager' → forced generic.
const teen: ReminderChild = { id: 'c-teen', name: 'Sam', dateOfBirth: '2011-01-01', gender: 'boy' };

function ev(over: Partial<ReminderEventView> = {}): ReminderEventView {
  return { eventRef: 'e1', title: 'Swim class', startsAt: '2026-07-25T14:00:00Z', childId: null, ...over };
}

describe('whenLead — the opening from the offset', () => {
  it('T-24h reads Tomorrow, T-1h reads In an hour', () => {
    expect(whenLead('-P1D')).toBe('Tomorrow');
    expect(whenLead('-PT1H')).toBe('In an hour');
  });
});

describe('localTimeLabel — family-local clock, no meridiem', () => {
  it('renders the start instant in the family timezone', () => {
    // 14:00Z = 10:00 EDT; 20:30Z = 4:30 EDT.
    expect(localTimeLabel('2026-07-25T14:00:00Z', TZ)).toBe('10:00');
    expect(localTimeLabel('2026-07-25T20:30:00Z', TZ)).toBe('4:30');
  });
});

describe('eventDescriptor — teen gate + name-level dial', () => {
  it('attributes a non-teen child down to the parent level', () => {
    expect(eventDescriptor(ev({ childId: 'c-maya' }), [maya], 'first_name', NOW)).toBe(
      'Maya — Swim class',
    );
    expect(eventDescriptor(ev({ childId: 'c-maya' }), [maya], 'relation', NOW)).toBe(
      'your daughter — Swim class',
    );
  });

  it('generic level shows the title alone (no attribution)', () => {
    expect(eventDescriptor(ev({ childId: 'c-maya' }), [maya], 'generic', NOW)).toBe('Swim class');
  });

  it('never double-attributes a title that already names the child', () => {
    const titled = ev({ childId: 'c-maya', title: "Maya's dentist" });
    expect(eventDescriptor(titled, [maya], 'first_name', NOW)).toBe("Maya's dentist");
  });

  it('a teen event is generic at EVERY level — never the name or the title', () => {
    for (const level of ['first_name', 'relation', 'generic'] as const) {
      const out = eventDescriptor(ev({ childId: 'c-teen', title: 'Therapy' }), [teen], level, NOW);
      expect(out).toBe('an appointment');
      expect(out).not.toContain('Sam');
      expect(out).not.toContain('Therapy');
    }
  });

  it('a flagged-sensitive event is generic even for a non-teen', () => {
    const sensitive = ev({ childId: 'c-maya', title: 'Blood test', sensitive: true });
    expect(eventDescriptor(sensitive, [maya], 'first_name', NOW)).toBe('an appointment');
  });

  it('a childless event shows its title as placed', () => {
    expect(eventDescriptor(ev({ title: 'Parent-teacher night' }), [], 'first_name', NOW)).toBe(
      'Parent-teacher night',
    );
  });
});

describe('eventLine — descriptor + family-local time', () => {
  it('joins the descriptor and the clock label', () => {
    expect(eventLine(ev({ childId: 'c-maya' }), [maya], 'first_name', NOW, TZ)).toBe(
      'Maya — Swim class at 10:00',
    );
  });
});
