import { describe, expect, it } from 'vitest';
import { parseAgeRange } from '~/lib/channel/intake/radar-decide';
import {
  type CivicSessionForFamily,
  MAX_CIVIC_CANDIDATES_PER_FAMILY,
  MAX_RADIUS_KM,
  PREFERRED_RADIUS_KM,
  formatMinuteOfDay,
  haversineKm,
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
    const picks = selectCivicSessions([session({ confidence: 0.55 })], TODDLER, null, NOW, TZ);
    expect(picks).toEqual([]);
  });

  it('surfaces a session at the threshold', () => {
    const picks = selectCivicSessions([session({ confidence: 0.7 })], TODDLER, null, NOW, TZ);
    expect(picks).toHaveLength(1);
  });

  it('never surfaces a cancelled session', () => {
    expect(selectCivicSessions([session({ isCancelled: true })], TODDLER, null, NOW, TZ)).toEqual([]);
  });
});

describe('selectCivicSessions — who it is for', () => {
  it('drops a session no child in the household fits', () => {
    // Birth-to-five programming, a nine-year-old.
    expect(selectCivicSessions([session()], [108], null, NOW, TZ)).toEqual([]);
  });

  it('keeps a session when any one child fits', () => {
    expect(selectCivicSessions([session()], [108, 30], null, NOW, TZ)).toHaveLength(1);
  });

  it('keeps an all-ages session even for a family with no children on file', () => {
    const allAges = session({ ageMinMonths: null, ageMaxMonths: null });
    expect(selectCivicSessions([allAges], [], null, NOW, TZ)).toHaveLength(1);
  });

  it('drops an age-targeted session for a family with no children on file', () => {
    expect(selectCivicSessions([session()], [], null, NOW, TZ)).toEqual([]);
  });

  it('states the age band only when the source gave one', () => {
    expect(selectCivicSessions([session()], TODDLER, null, NOW, TZ)[0]!.ageRange).toBe('0-5 years');
    const allAges = session({ ageMinMonths: null, ageMaxMonths: null });
    expect(selectCivicSessions([allAges], TODDLER, null, NOW, TZ)[0]!.ageRange).toBeNull();
  });

  it('states an INFANT band in months — "0-1 years" is not what a lap-bounce is', () => {
    // A band that closes before a child's second birthday is only legible in
    // months: a year label rounds "birth to 12 months" into a band that reads as
    // if a one-year-old were the point of it.
    const babytime = session({ ageMinMonths: 0, ageMaxMonths: 12 });
    expect(selectCivicSessions([babytime], [4], null, NOW, TZ)[0]!.ageRange).toBe('0-12 months');

    const toddlerTime = session({ ageMinMonths: 19, ageMaxMonths: 47 });
    expect(selectCivicSessions([toddlerTime], [30], null, NOW, TZ)[0]!.ageRange).toBe('1-3 years');
  });

  it('writes the band with ASCII punctuation, so an SMS never carries an en dash', () => {
    const label = selectCivicSessions([session()], TODDLER, null, NOW, TZ)[0]!.ageRange;
    expect(label).not.toMatch(/[‐-―]/);
  });

  it('writes a band the RADAR can read back, since the label is the only channel', () => {
    // village_candidates stores the age as this LABEL and nothing else, and the
    // radar re-parses it to decide which child a pick covers. So the two halves
    // have to agree: a label this layer writes but the radar reads as a different
    // band would put the infant lap-bounce back in front of a two-year-old by a
    // different route.
    const babytime = session({ ageMinMonths: 0, ageMaxMonths: 12 });
    const label = selectCivicSessions([babytime], [4], null, NOW, TZ)[0]!.ageRange;

    expect(parseAgeRange(label)).toEqual({ minMonths: 0, maxMonths: 12 });
    const preschool = selectCivicSessions([session()], TODDLER, null, NOW, TZ)[0]!.ageRange;
    expect(parseAgeRange(preschool)?.minMonths).toBe(0);
  });
});

describe('selectCivicSessions — dates and windows', () => {
  it('dates a library occurrence to its own day', () => {
    expect(selectCivicSessions([session()], TODDLER, null, NOW, TZ)[0]!.eventDate).toBe('2026-08-05');
  });

  it('drops an occurrence already in the past', () => {
    const past = session({ startsAt: new Date('2026-07-30T14:30:00Z') });
    expect(selectCivicSessions([past], TODDLER, null, NOW, TZ)).toEqual([]);
  });

  it('drops an occurrence beyond the forward window', () => {
    const far = session({ startsAt: new Date('2026-10-01T14:30:00Z') });
    expect(selectCivicSessions([far], TODDLER, null, NOW, TZ)).toEqual([]);
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
    expect(selectCivicSessions([weekly], TODDLER, null, NOW, TZ)[0]!.eventDate).toBe('2026-08-05');
  });

  it('sorts soonest first', () => {
    const later = session({ id: 'b', title: 'Later', startsAt: new Date('2026-08-07T14:30:00Z') });
    const sooner = session({ id: 'a', title: 'Sooner', startsAt: new Date('2026-08-04T14:30:00Z') });
    expect(selectCivicSessions([later, sooner], TODDLER, null, NOW, TZ).map((p) => p.title)).toEqual([
      'Sooner',
      'Later',
    ]);
  });

  it('caps the shortlist', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      session({ id: `s${i}`, title: `S${i}`, startsAt: new Date('2026-08-05T14:30:00Z') }),
    );
    expect(selectCivicSessions(many, TODDLER, null, NOW, TZ).length).toBeLessThanOrEqual(8);
  });
});

describe('haversineKm', () => {
  /**
   * Expected values are the sphere's own arithmetic, not this function's output:
   * a great circle on R = 6371 km is 2πR/360 = 111.195 km per degree, so one
   * degree of latitude anywhere, and one degree of longitude ON THE EQUATOR, are
   * both that. A flat-earth (equirectangular) shortcut passes the first and the
   * second; only the third — a degree of longitude at Toronto's latitude, which
   * shrinks by cos(43.7°) — separates a real haversine from the approximation.
   */
  it('measures a degree of latitude as the sphere says it is', () => {
    expect(haversineKm({ lat: 43, lng: -79 }, { lat: 44, lng: -79 })).toBeCloseTo(111.195, 1);
  });

  it('measures a degree of longitude at the equator, and its shrink at Toronto', () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111.195, 1);
    // 111.195 × cos(43.7°) = 80.39 km.
    expect(haversineKm({ lat: 43.7, lng: -79 }, { lat: 43.7, lng: -78 })).toBeCloseTo(80.39, 1);
  });

  it('is zero for a point against itself', () => {
    expect(haversineKm({ lat: 43.7735, lng: -79.2578 }, { lat: 43.7735, lng: -79.2578 })).toBe(0);
  });
});

/**
 * VIL-260 · WS5 — proximity. Every coordinate below is a real place: the family
 * sits at the Scarborough Civic Centre FSA centroid, and the branches are a
 * Scarborough one (~2 km), a midtown one (~10 km) and an Etobicoke one (~27 km).
 * The Etobicoke case is the defect this exists for — a Saturday storytime a
 * 35-minute drive across the city, offered because "Toronto" was one bucket.
 */
const SCARBOROUGH = { lat: 43.7735, lng: -79.2578 };
const near = (over: Partial<CivicSessionForFamily> = {}) =>
  session({ lat: 43.7574, lng: -79.2374, venueName: 'Cedarbrae', ...over });
const midway = (over: Partial<CivicSessionForFamily> = {}) =>
  session({ lat: 43.6835, lng: -79.2578, venueName: 'Main Street', ...over });
const acrossTown = (over: Partial<CivicSessionForFamily> = {}) =>
  session({ lat: 43.6205, lng: -79.5132, venueName: 'Richview', ...over });

describe('selectCivicSessions — proximity', () => {
  it('the three fixtures really are near / midway / across town', () => {
    expect(haversineKm(SCARBOROUGH, { lat: 43.7574, lng: -79.2374 })).toBeLessThan(
      PREFERRED_RADIUS_KM,
    );
    const mid = haversineKm(SCARBOROUGH, { lat: 43.6835, lng: -79.2578 });
    expect(mid).toBeGreaterThan(PREFERRED_RADIUS_KM);
    expect(mid).toBeLessThan(MAX_RADIUS_KM);
    expect(haversineKm(SCARBOROUGH, { lat: 43.6205, lng: -79.5132 })).toBeGreaterThan(
      MAX_RADIUS_KM,
    );
  });

  it('NEVER surfaces a session across the city, however good the session is', () => {
    const picks = selectCivicSessions([acrossTown()], TODDLER, SCARBOROUGH, NOW, TZ);
    expect(picks).toEqual([]);
  });

  it('fills the shortlist with nearby sessions before reaching for a further one', () => {
    // The midway session is the SOONEST — first thing tomorrow — and still loses
    // to a full slate of nearby ones later in the week. Distance outranks the day.
    const sooner = midway({ id: 'mid', title: 'Midway', startsAt: new Date('2026-08-04T14:30:00Z') });
    const nearby = Array.from({ length: MAX_CIVIC_CANDIDATES_PER_FAMILY }, (_, i) =>
      near({ id: `n${i}`, title: `Nearby ${i}`, startsAt: new Date('2026-08-06T14:30:00Z') }),
    );

    const titles = selectCivicSessions([sooner, ...nearby], TODDLER, SCARBOROUGH, NOW, TZ).map(
      (p) => p.title,
    );
    expect(titles).toHaveLength(MAX_CIVIC_CANDIDATES_PER_FAMILY);
    expect(titles).not.toContain('Midway');
  });

  it('does reach for the further session when there are not enough nearby ones', () => {
    const picks = selectCivicSessions([midway(), near()], TODDLER, SCARBOROUGH, NOW, TZ);
    expect(picks.map((p) => p.venueName)).toEqual(['Cedarbrae', 'Main Street']);
  });

  it('carries the distance, so nothing downstream has to re-derive it', () => {
    const [pick] = selectCivicSessions([near()], TODDLER, SCARBOROUGH, NOW, TZ);
    expect(pick?.distanceKm).toBeCloseTo(haversineKm(SCARBOROUGH, { lat: 43.7574, lng: -79.2374 }), 3);
  });

  it('drops a venue with no coordinates when the family CAN be placed', () => {
    // Not punishment — arithmetic. With a centroid in hand, "within 15 km" is a
    // claim about this venue, and an unplaceable venue cannot support it.
    const unplaceable = near({ lat: null, lng: null });
    expect(selectCivicSessions([unplaceable], TODDLER, SCARBOROUGH, NOW, TZ)).toEqual([]);
  });

  it('degrades to the municipality-only behaviour when the area cannot be geocoded', () => {
    // A Places outage must cost a family precision, never their whole feed.
    const picks = selectCivicSessions(
      [acrossTown(), near({ lat: null, lng: null })],
      TODDLER,
      null,
      NOW,
      TZ,
    );
    expect(picks).toHaveLength(2);
    expect(picks.every((p) => p.distanceKm === null)).toBe(true);
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
    expect(selectCivicSessions([session()], TODDLER, null, NOW, TZ)[0]!.kind).toBe('library');
    const centre = session({ venueKind: 'earlyon_centre' });
    expect(selectCivicSessions([centre], TODDLER, null, NOW, TZ)[0]!.kind).toBe('drop_in');
  });

  it('says whether a parent can just turn up, and where', () => {
    const summary = selectCivicSessions([session()], TODDLER, null, NOW, TZ)[0]!.summary;
    expect(summary).toContain('Free drop-in');
    expect(summary).toContain('Armour Heights, Toronto');
  });

  it('says registration is required when it is', () => {
    const registered = session({ registrationRequired: true });
    expect(selectCivicSessions([registered], TODDLER, null, NOW, TZ)[0]!.summary).toContain(
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
    expect(selectCivicSessions([weekly], TODDLER, null, NOW, TZ)[0]!.summary).toContain(
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
