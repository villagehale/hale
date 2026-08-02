import { describe, expect, it } from 'vitest';
import {
  type CivicSessionForFamily,
  formatMinuteOfDay,
  municipalityForCity,
  nextOccurrenceDay,
  selectCivicSessions,
} from './project';

/**
 * VIL-252 · M16 — the per-family selection rule, pure and clock-injected.
 *
 * The confidence gate is the load-bearing test in this file: a schedule Hale is
 * not sure of must never reach a parent, however plausible it looks. Silence is
 * a correct answer; a wrong morning is not.
 */

const TZ = 'America/Toronto';

const session = (over: Partial<CivicSessionForFamily> = {}): CivicSessionForFamily => ({
  id: 'sess-1',
  title: 'Family Storytime',
  summary: null,
  recurrence: 'occurrence',
  startsAt: new Date('2026-08-05T14:30:00Z'), // Wed 10:30 EDT
  dayOfWeek: null,
  startMinute: null,
  endMinute: null,
  ageMinMonths: 0,
  ageMaxMonths: 71,
  registrationRequired: false,
  isCancelled: false,
  confidence: 1,
  sourceUrl: 'https://tpl.bibliocommons.com/events/abc',
  venueName: 'Armour Heights',
  venueAddress: '2140 Avenue Road',
  venueCity: 'Toronto',
  venueUrl: 'https://tpl.ca/locations/AH',
  venueKind: 'library_branch',
  lat: 43.73,
  lng: -79.42,
  ...over,
});

// Monday 2026-08-03, 09:00 Toronto.
const NOW = new Date('2026-08-03T13:00:00Z');
const TODDLER = [30];

describe('selectCivicSessions — the confidence gate', () => {
  it('NEVER surfaces a session below the surfacing threshold', () => {
    const picks = selectCivicSessions([session({ confidence: 0.55 })], TODDLER, NOW, TZ);
    expect(picks).toEqual([]);
  });

  it('surfaces a session at the threshold', () => {
    const picks = selectCivicSessions([session({ confidence: 0.7 })], TODDLER, NOW, TZ);
    expect(picks).toHaveLength(1);
  });

  it('never surfaces a cancelled session', () => {
    expect(selectCivicSessions([session({ isCancelled: true })], TODDLER, NOW, TZ)).toEqual([]);
  });
});

describe('selectCivicSessions — who it is for', () => {
  it('drops a session no child in the household fits', () => {
    // Birth-to-five programming, a nine-year-old.
    expect(selectCivicSessions([session()], [108], NOW, TZ)).toEqual([]);
  });

  it('keeps a session when any one child fits', () => {
    expect(selectCivicSessions([session()], [108, 30], NOW, TZ)).toHaveLength(1);
  });

  it('keeps an all-ages session even for a family with no children on file', () => {
    const allAges = session({ ageMinMonths: null, ageMaxMonths: null });
    expect(selectCivicSessions([allAges], [], NOW, TZ)).toHaveLength(1);
  });

  it('drops an age-targeted session for a family with no children on file', () => {
    expect(selectCivicSessions([session()], [], NOW, TZ)).toEqual([]);
  });

  it('states the age band only when the source gave one', () => {
    expect(selectCivicSessions([session()], TODDLER, NOW, TZ)[0]!.ageRange).toBe('0–5 years');
    const allAges = session({ ageMinMonths: null, ageMaxMonths: null });
    expect(selectCivicSessions([allAges], TODDLER, NOW, TZ)[0]!.ageRange).toBeNull();
  });
});

describe('selectCivicSessions — dates and windows', () => {
  it('dates a library occurrence to its own day', () => {
    expect(selectCivicSessions([session()], TODDLER, NOW, TZ)[0]!.eventDate).toBe('2026-08-05');
  });

  it('drops an occurrence already in the past', () => {
    const past = session({ startsAt: new Date('2026-07-30T14:30:00Z') });
    expect(selectCivicSessions([past], TODDLER, NOW, TZ)).toEqual([]);
  });

  it('drops an occurrence beyond the forward window', () => {
    const far = session({ startsAt: new Date('2026-10-01T14:30:00Z') });
    expect(selectCivicSessions([far], TODDLER, NOW, TZ)).toEqual([]);
  });

  it('dates a weekly drop-in to its next real occurrence', () => {
    // Wednesday slot, 9:00–11:30, asked on Monday → this Wednesday.
    const weekly = session({
      recurrence: 'weekly',
      startsAt: null,
      dayOfWeek: 3,
      startMinute: 9 * 60,
      endMinute: 11 * 60 + 30,
      venueKind: 'earlyon_centre',
    });
    expect(selectCivicSessions([weekly], TODDLER, NOW, TZ)[0]!.eventDate).toBe('2026-08-05');
  });

  it('sorts soonest first', () => {
    const later = session({ id: 'b', title: 'Later', startsAt: new Date('2026-08-07T14:30:00Z') });
    const sooner = session({ id: 'a', title: 'Sooner', startsAt: new Date('2026-08-04T14:30:00Z') });
    expect(selectCivicSessions([later, sooner], TODDLER, NOW, TZ).map((p) => p.title)).toEqual([
      'Sooner',
      'Later',
    ]);
  });

  it('caps the shortlist', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      session({ id: `s${i}`, title: `S${i}`, startsAt: new Date('2026-08-05T14:30:00Z') }),
    );
    expect(selectCivicSessions(many, TODDLER, NOW, TZ).length).toBeLessThanOrEqual(8);
  });
});

describe('nextOccurrenceDay', () => {
  it('returns today when the slot has not ended yet', () => {
    // Monday 09:00 local; a Monday slot ending 11:30 is still ahead.
    expect(nextOccurrenceDay(1, 11 * 60 + 30, NOW, TZ)).toBe('2026-08-03');
  });

  it('rolls to next week when today’s slot has already ended', () => {
    // Monday 09:00 local; a Monday slot that ended at 08:30 is gone.
    expect(nextOccurrenceDay(1, 8 * 60 + 30, NOW, TZ)).toBe('2026-08-10');
  });

  it('finds the next occurrence later in the same week', () => {
    expect(nextOccurrenceDay(6, 12 * 60, NOW, TZ)).toBe('2026-08-08');
  });

  it('wraps to the following week for a day already passed', () => {
    // Sunday, from a Monday.
    expect(nextOccurrenceDay(0, 12 * 60, NOW, TZ)).toBe('2026-08-09');
  });
});

describe('kind, copy and coverage', () => {
  it('labels a library session `library` and a centre session `drop_in`', () => {
    expect(selectCivicSessions([session()], TODDLER, NOW, TZ)[0]!.kind).toBe('library');
    const centre = session({ venueKind: 'earlyon_centre' });
    expect(selectCivicSessions([centre], TODDLER, NOW, TZ)[0]!.kind).toBe('drop_in');
  });

  it('says whether a parent can just turn up, and where', () => {
    const summary = selectCivicSessions([session()], TODDLER, NOW, TZ)[0]!.summary;
    expect(summary).toContain('Free drop-in');
    expect(summary).toContain('Armour Heights, Toronto');
  });

  it('says registration is required when it is', () => {
    const registered = session({ registrationRequired: true });
    expect(selectCivicSessions([registered], TODDLER, NOW, TZ)[0]!.summary).toContain(
      'Registration required',
    );
  });

  it('carries the real time into the copy for a weekly slot', () => {
    const weekly = session({
      recurrence: 'weekly',
      startsAt: null,
      dayOfWeek: 3,
      startMinute: 10 * 60,
      endMinute: 12 * 60,
    });
    expect(selectCivicSessions([weekly], TODDLER, NOW, TZ)[0]!.summary).toContain(
      '10:00 a.m.–noon',
    );
  });
});

describe('formatMinuteOfDay', () => {
  it('writes midday as noon, matching how these sources say it', () => {
    expect(formatMinuteOfDay(12 * 60)).toBe('noon');
  });

  it('writes morning and afternoon in the municipal spelling', () => {
    expect(formatMinuteOfDay(9 * 60 + 30)).toBe('9:30 a.m.');
    expect(formatMinuteOfDay(16 * 60 + 30)).toBe('4:30 p.m.');
    expect(formatMinuteOfDay(12 * 60 + 30)).toBe('12:30 p.m.');
    expect(formatMinuteOfDay(0)).toBe('12:00 a.m.');
  });
});

describe('municipalityForCity', () => {
  it('maps Toronto’s pre-amalgamation names to Toronto', () => {
    // The City's own EarlyON feed still files centres under these.
    for (const city of ['Toronto', 'East York', 'Scarborough', 'North York', 'Etobicoke', 'York']) {
      expect(municipalityForCity(city)).toBe('toronto');
    }
  });

  it('maps the library systems’ own postal cities', () => {
    expect(municipalityForCity('Markham')).toBe('markham');
    expect(municipalityForCity('Thornhill')).toBe('markham');
    expect(municipalityForCity('Richmond Hill')).toBe('richmond_hill');
  });

  it('returns null for a city it does not cover, rather than the nearest guess', () => {
    expect(municipalityForCity('Kingston')).toBeNull();
    expect(municipalityForCity(null)).toBeNull();
  });
});
