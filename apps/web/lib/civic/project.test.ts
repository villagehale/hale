import { describe, expect, it } from 'vitest';
import { type RadarCandidate, parseAgeRange } from '~/lib/channel/intake/radar-decide';
import { decideNudge } from '~/lib/channel/nudge/nudge-decide';
import { isPrintableGsm7Basic } from '~/lib/channel/sms-segments';
import { emptyHouseholdFindBias } from '~/lib/reviews/household-bias';
import {
  CIVIC_SOURCE,
  type CivicSessionForFamily,
  type ProjectedCivicCandidate,
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
  venueId: 'venue-armour-heights',
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
    expect(selectCivicSessions(many, TODDLER, null, NOW, TZ).length).toBeLessThanOrEqual(
      MAX_CIVIC_CANDIDATES_PER_FAMILY,
    );
  });
});

/**
 * VIL-365 · the Monday rebuild used to spend the whole cap on Monday and Tuesday.
 * The empty-Saturday ask reads civic rows dated the coming Saturday, and a feed
 * with none of those goes quiet for the rest of the week.
 */
describe('selectCivicSessions — spread across the window', () => {
  const at = (day: string) => new Date(`${day}T14:30:00Z`);

  function dayKey(offset: number): string {
    const date = new Date('2026-08-03T00:00:00Z');
    date.setUTCDate(date.getUTCDate() + offset);
    return date.toISOString().slice(0, 10);
  }

  function isWeekend(day: string): boolean {
    const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
    return dow === 0 || dow === 6;
  }

  it('still gives a family with a full Monday and Tuesday a Saturday and a Sunday', () => {
    const monday = Array.from({ length: 12 }, (_, i) =>
      near({ id: `mon-${i}`, title: `Monday ${i}`, startsAt: at('2026-08-03') }),
    );
    const tuesday = Array.from({ length: 12 }, (_, i) =>
      near({ id: `tue-${i}`, title: `Tuesday ${i}`, startsAt: at('2026-08-04') }),
    );
    const saturday = near({
      id: 'sat',
      title: 'Saturday storytime',
      startsAt: at('2026-08-08'),
    });
    const sunday = near({ id: 'sun', title: 'Sunday storytime', startsAt: at('2026-08-09') });

    const picks = selectCivicSessions(
      [...monday, ...tuesday, saturday, sunday],
      TODDLER,
      SCARBOROUGH,
      NOW,
      TZ,
    );
    const dates = new Set(picks.map((pick) => pick.eventDate));

    expect(picks.length).toBeLessThanOrEqual(MAX_CIVIC_CANDIDATES_PER_FAMILY);
    expect(dates.has('2026-08-08')).toBe(true);
    expect(dates.has('2026-08-09')).toBe(true);
    expect(picks.every((pick) => pick.eventDate === '2026-08-03' || pick.eventDate === '2026-08-04')).toBe(
      false,
    );
  });

  it('keeps every Saturday and Sunday in the window, and ranks distance inside the day', () => {
    // One nearby session on every day of the forward window, plus a second Saturday
    // session that is still local but farther. The cap cannot hold every day, so
    // the spread has to reach the later weekends, and the Saturday slot has to be
    // the nearer of the two.
    const days = Array.from({ length: 22 }, (_, offset) => dayKey(offset));
    const sessions = days.map((day) =>
      near({
        id: day,
        title: day === '2026-08-08' ? 'Near Saturday' : `Day ${day}`,
        startsAt: at(day),
        lat: SCARBOROUGH.lat + 0.004,
        lng: SCARBOROUGH.lng,
      }),
    );
    sessions.push(
      near({
        id: 'far-sat',
        title: 'Far Saturday',
        startsAt: at('2026-08-08'),
        lat: SCARBOROUGH.lat + 0.05,
        lng: SCARBOROUGH.lng,
      }),
    );

    const nearKm = haversineKm(SCARBOROUGH, { lat: SCARBOROUGH.lat + 0.004, lng: SCARBOROUGH.lng });
    const farKm = haversineKm(SCARBOROUGH, { lat: SCARBOROUGH.lat + 0.05, lng: SCARBOROUGH.lng });
    expect(nearKm).toBeLessThan(farKm);
    expect(farKm).toBeLessThan(PREFERRED_RADIUS_KM);

    const picks = selectCivicSessions(sessions, TODDLER, SCARBOROUGH, NOW, TZ);
    const dates = new Set(picks.map((pick) => pick.eventDate));
    const weekends = days.filter((day) => isWeekend(day) && day <= '2026-08-24');

    expect(picks.length).toBeLessThanOrEqual(MAX_CIVIC_CANDIDATES_PER_FAMILY);
    for (const weekend of weekends) expect(dates.has(weekend)).toBe(true);
    expect([...dates].some((day) => !isWeekend(day))).toBe(true);
    const latest = [...dates].sort().at(-1);
    expect(latest !== undefined && latest > '2026-08-10').toBe(true);
    expect(picks.find((pick) => pick.eventDate === '2026-08-08')?.title).toBe('Near Saturday');
    expect(picks.map((pick) => pick.title)).not.toContain('Far Saturday');
  });

  it('keeps the nearest sessions when a single day has more than the cap', () => {
    const sessions = Array.from({ length: MAX_CIVIC_CANDIDATES_PER_FAMILY + 1 }, (_, i) =>
      near({
        id: `d${i}`,
        title: `D${i}`,
        lat: SCARBOROUGH.lat + i * 0.006,
        lng: SCARBOROUGH.lng,
        startsAt: at('2026-08-05'),
      }),
    );
    const titles = selectCivicSessions(sessions, TODDLER, SCARBOROUGH, NOW, TZ).map(
      (pick) => pick.title,
    );
    expect(titles).toContain('D0');
    expect(titles).not.toContain(`D${MAX_CIVIC_CANDIDATES_PER_FAMILY}`);
  });

  it('does not spend a full nearby slate to reach a farther Saturday', () => {
    const nearby = Array.from({ length: MAX_CIVIC_CANDIDATES_PER_FAMILY }, (_, i) =>
      near({ id: `n${i}`, title: `Nearby ${i}`, startsAt: at('2026-08-03') }),
    );
    const saturday = midway({
      id: 'sat',
      title: 'Farther Saturday',
      startsAt: at('2026-08-08'),
    });

    const titles = selectCivicSessions([...nearby, saturday], TODDLER, SCARBOROUGH, NOW, TZ).map(
      (pick) => pick.title,
    );
    expect(titles).not.toContain('Farther Saturday');
  });

  it('leaves the empty-Saturday nudge a candidate', () => {
    const monday = Array.from({ length: 12 }, (_, i) =>
      near({ id: `mon-${i}`, title: `Monday ${i}`, startsAt: at('2026-08-03') }),
    );
    const picks = selectCivicSessions(
      [
        ...monday,
        near({ id: 'sat', title: 'Saturday storytime', startsAt: at('2026-08-08') }),
      ],
      TODDLER,
      SCARBOROUGH,
      NOW,
      TZ,
    );
    const saturday = picks.find((pick) => pick.eventDate === '2026-08-08');
    expect(saturday).toBeDefined();

    const decision = decideNudge({
      children: [{ id: 'maya', name: 'Maya', ageMonths: 30, dobPrecision: 'exact' }],
      candidates: picks.map((pick, index) => toRadar(pick, `cand-${index}`)),
      windows: [],
      weather: [],
      teenChildIds: [],
      healthChildren: [],
      areaCoarse: null,
      suppressedCheckpointRefs: new Set(),
      claimedWindowIds: new Set(),
      weekdayCare: 'disarmed',
      saturdayPlans: { householdBusy: false, busyChildIds: new Set() },
      householdBias: emptyHouseholdFindBias(),
      now: NOW,
      timeZone: TZ,
    });

    expect(decision.nudge).toMatchObject({
      kind: 'empty_saturday',
      saturday: '2026-08-08',
      kidName: 'Maya',
    });
  });
});

function toRadar(pick: ProjectedCivicCandidate, id: string): RadarCandidate {
  return {
    id,
    title: pick.title,
    venueName: pick.venueName,
    ageRange: pick.ageRange,
    priceLevel: 'free',
    indoorOutdoor: 'indoor',
    eventDate: pick.eventDate,
    seasons: null,
    childId: null,
    confidence: pick.confidence,
    source: CIVIC_SOURCE,
    sourceUrl: pick.sourceUrl,
    access: pick.access,
    whenLabel: pick.whenLabel,
  };
}

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
      '10:00 a.m.-noon',
    );
  });

  /**
   * VIL-360 · R5 — every string this layer PERSISTS is read back out over SMS, and one
   * character outside the GSM-7 basic alphabet flips the whole message to UCS-2 and
   * halves its character budget. The weekly time range joined on an en dash and the
   * summary joined on an em dash were both doing exactly that, invisibly, because
   * nothing downstream renders a candidate's summary yet.
   *
   * Asserted against the ENCODER the sender bills on rather than against the two
   * characters, so the next typographic one fails here too.
   */
  it('persists only GSM-7 printable copy, whatever the source day and time', () => {
    const weekly = session({
      recurrence: 'weekly',
      startsAt: null,
      dayOfWeek: 2,
      startMinute: 9 * 60 + 30,
      endMinute: 11 * 60,
    });
    const pick = selectCivicSessions([weekly], TODDLER, null, NOW, TZ)[0]!;
    // The positive control: the range IS in the copy, so this is not passing by saying
    // nothing at all.
    expect(pick.summary).toContain('9:30 a.m.-11:00 a.m.');
    expect(isPrintableGsm7Basic(pick.summary)).toBe(true);
    expect(isPrintableGsm7Basic(pick.title)).toBe(true);
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

  it('maps both names the Town of Whitchurch-Stouffville is filed under', () => {
    // Feeds file the same town either way; both have to land on the one token.
    expect(municipalityForCity('Stouffville')).toBe('whitchurch_stouffville');
    expect(municipalityForCity('Whitchurch-Stouffville')).toBe('whitchurch_stouffville');
  });

  it('files a York village under the township that runs its programs', () => {
    // A Nobleton or Sharon postal code resolves to nothing (L0G spans six towns), so
    // the venue's own city field is the only way these families reach the radar.
    expect(municipalityForCity('Nobleton')).toBe('king');
    expect(municipalityForCity('King City')).toBe('king');
    expect(municipalityForCity('Sharon')).toBe('east_gwillimbury');
    expect(municipalityForCity('Mount Albert')).toBe('east_gwillimbury');
    expect(municipalityForCity('Keswick')).toBe('georgina');
    expect(municipalityForCity('Sutton West')).toBe('georgina');
    expect(municipalityForCity('Newmarket')).toBe('newmarket');
    expect(municipalityForCity('Uxbridge')).toBe('uxbridge');
  });

  it('returns null for a city it does not cover, rather than the nearest guess', () => {
    expect(municipalityForCity('Kingston')).toBeNull();
    // The map is keyed on the whole city field, so "King" does not swallow Kingston
    // and Bradford West Gwillimbury is not East Gwillimbury.
    expect(municipalityForCity('Bradford West Gwillimbury')).toBeNull();
    expect(municipalityForCity('Cannington')).toBeNull();
    expect(municipalityForCity(null)).toBeNull();
  });
});

/**
 * THE IDENTITY A CIVIC PICK CARRIES.
 *
 * `source_url` cannot be one and the two ingests fail it in opposite directions: every
 * EarlyON session in Toronto carries the single open.toronto.ca dataset page, and a
 * library event carries a per-occurrence url. The venue row is the thing that is both
 * shared and venue-grain, so it is what the pick carries.
 */
describe('the venue a civic pick came from', () => {
  it('stamps the registry venue id on every projected candidate', () => {
    const picks = selectCivicSessions([session()], TODDLER, null, NOW, TZ);

    expect(picks.map((pick) => pick.civicVenueId)).toEqual(['venue-armour-heights']);
  });

  it('keeps two EarlyON centres apart even when they share one dataset url', () => {
    const DATASET = 'https://open.toronto.ca/dataset/earlyon-child-and-family-centres/';
    const picks = selectCivicSessions(
      [
        session({
          id: 'sess-a',
          venueId: 'venue-jane-finch',
          title: 'EarlyON drop-in',
          venueName: 'Jane/Finch EarlyON',
          sourceUrl: DATASET,
          venueKind: 'earlyon_centre',
        }),
        session({
          id: 'sess-b',
          venueId: 'venue-riverdale',
          title: 'EarlyON drop-in',
          venueName: 'Riverdale EarlyON',
          sourceUrl: DATASET,
          venueKind: 'earlyon_centre',
        }),
      ],
      TODDLER,
      null,
      NOW,
      TZ,
    );

    expect(new Set(picks.map((pick) => pick.civicVenueId)).size).toBe(2);
    // The positive control on the same rows: the url they would have collided on IS
    // the same string, so the distinctness above is the venue id doing the work.
    expect(new Set(picks.map((pick) => pick.sourceUrl)).size).toBe(1);
  });
});

/**
 * VIL-3xx · the two structured facts the projection used to throw away.
 *
 * `registration_required` never survived the projection at all, and the session's own
 * time survived only folded into `summary`'s prose. Recovering either by matching that
 * prose is the "resolver keyed on an unwritten field" shape — and the prose carries
 * punctuation an SMS may not, so a reader that quoted it would bill the whole message
 * as UCS-2. Both are columns now, derived from `civic_sessions`' own semantics
 * (packages/db/src/schema/civic.ts) rather than from what the projection happens to
 * print today.
 */
describe('access and whenLabel — what a parent DOES, and when', () => {
  it('projects a session the source says needs no sign-up as a drop-in', () => {
    const pick = selectCivicSessions(
      [session({ registrationRequired: false })],
      TODDLER,
      null,
      NOW,
      TZ,
    )[0]!;
    expect(pick.access).toBe('drop_in');
  });

  it('projects a session the source says wants a sign-up first as register_at_venue', () => {
    const pick = selectCivicSessions(
      [session({ registrationRequired: true })],
      TODDLER,
      null,
      NOW,
      TZ,
    )[0]!;
    expect(pick.access).toBe('register_at_venue');
  });

  it('carries the weekly band as the label, already folded to printable GSM-7', () => {
    const weekly = session({
      recurrence: 'weekly',
      startsAt: null,
      dayOfWeek: 2,
      startMinute: 9 * 60 + 30,
      endMinute: 11 * 60,
    });
    const pick = selectCivicSessions([weekly], TODDLER, null, NOW, TZ)[0]!;
    expect(pick.whenLabel).toBe('9:30 a.m.-11:00 a.m.');
    expect(isPrintableGsm7Basic(pick.whenLabel as string)).toBe(true);
  });

  it("carries an occurrence's own clock time, not a weekly band", () => {
    // The fixture's startsAt is 2026-08-05T14:30Z = 10:30 a.m. Toronto.
    const pick = selectCivicSessions([session()], TODDLER, null, NOW, TZ)[0]!;
    expect(pick.whenLabel).toBe('10:30 a.m.');
    expect(pick.whenLabel).not.toContain('-');
  });

  /**
   * THE POSITIVE CONTROL. `summary` is the web card's string and the two new columns
   * were added beside it, not carved out of it: a change that re-worded the card while
   * "adding a structured field" is the drift this pins.
   */
  it('leaves the card summary byte-identical while the structured fields appear', () => {
    const weekly = session({
      recurrence: 'weekly',
      startsAt: null,
      dayOfWeek: 2,
      startMinute: 9 * 60 + 30,
      endMinute: 11 * 60,
      registrationRequired: true,
    });
    const pick = selectCivicSessions([weekly], TODDLER, null, NOW, TZ)[0]!;
    expect(pick.summary).toBe(
      'Registration required at Armour Heights, Toronto - 9:30 a.m.-11:00 a.m..',
    );
    expect(pick.access).toBe('register_at_venue');
    expect(pick.whenLabel).toBe('9:30 a.m.-11:00 a.m.');
  });
});
