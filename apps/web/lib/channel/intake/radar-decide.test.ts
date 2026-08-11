import type { Municipality, ProgramDomain, RegistrationWindow } from '@hale/db';
import { describe, expect, it } from 'vitest';
import type { HealthChild } from '~/lib/health/match';
import type { RegistrationMatch } from '~/lib/registration/match-registration-windows';
import type { DailyOutlook } from '~/lib/weather/open-meteo';
import {
  CLEARLY_BETTER_MARGIN,
  type RadarCandidate,
  type RadarChild,
  decideRadar,
  parseAgeRange,
  upcomingWeekend,
} from './radar-decide.js';

/**
 * The DECIDE stage: a pure, deterministic cascade from what Hale actually knows to a
 * structured decision object. No model runs here, by design — a ranking a model
 * invents is a ranking nobody can test.
 *
 * Expectations are derived from the M3 brief, not from the implementation:
 *
 *   - deterministic filters run FIRST (age fit with the ±6-month tolerance a DERIVED
 *     DOB earns, the weekend, season, weather, teen attribution);
 *   - free/civic beats paid as a HARD ordering rule — a paid pick may only win when it
 *     is CLEARLY the better fit, and then only because it carries a price label;
 *   - one pick covering BOTH kids outranks two picks covering one each;
 *   - a day that would split the family between two siblings' activities is not
 *     suggested at all;
 *   - every degraded path is honest: no window → say so; no candidate → say Hale is
 *     still learning, never invent one.
 */

// A Friday: the "coming weekend" is tomorrow (Sat 2026-08-01) and Sunday 2026-08-02.
const FRIDAY = new Date('2026-07-31T15:00:00.000Z');
const TZ = 'America/Toronto';
const SATURDAY_DATE = '2026-08-01';
const SUNDAY_DATE = '2026-08-02';

function child(overrides: Partial<RadarChild> = {}): RadarChild {
  return { name: 'Maya', ageMonths: 48, dobPrecision: 'derived', ...overrides };
}

function candidate(overrides: Partial<RadarCandidate> = {}): RadarCandidate {
  return {
    id: 'cand-1',
    title: 'Library story time',
    venueName: null,
    ageRange: null,
    priceLevel: 'free',
    indoorOutdoor: 'indoor',
    eventDate: null,
    seasons: null,
    childId: null,
    confidence: 0.8,
    ...overrides,
  };
}

function win(overrides: Partial<RegistrationWindow> = {}): RegistrationWindow {
  return {
    id: 'w-1',
    municipality: 'markham' as Municipality,
    programDomain: 'rec_program' as ProgramDomain,
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: null,
    openAt: new Date('2026-08-11T10:30:00.000Z'),
    residentPriorityDays: null,
    waitlistResponseHours: null,
    ageMinMonths: 36,
    ageMaxMonths: 72,
    sourceUrl: 'https://www.markham.ca/example',
    verifiedAt: new Date('2026-07-30T00:00:00.000Z'),
    notes: null,
    createdAt: new Date('2026-07-30T00:00:00.000Z'),
    updatedAt: new Date('2026-07-30T00:00:00.000Z'),
    ...overrides,
  };
}

function match(overrides: Partial<RegistrationMatch> = {}): RegistrationMatch {
  const window = overrides.window ?? win();
  return {
    window,
    cycleWindows: [window],
    matchedChildAgesMonths: [48],
    ageApproximate: false,
    isResidentWindow: false,
    opensForFamilyAt: window.openAt,
    generalOpenAt: window.openAt,
    ...overrides,
  };
}

function healthChild(overrides: Partial<HealthChild> = {}): HealthChild {
  return { id: 'kid-1', name: 'Maya', ageMonths: 18, dobPrecision: 'exact', isTeen: false, ...overrides };
}

function decide(input: {
  children?: RadarChild[];
  candidates?: RadarCandidate[];
  windows?: RegistrationMatch[];
  weather?: DailyOutlook[];
  teenChildIds?: string[];
  healthChildren?: HealthChild[];
  areaCoarse?: string | null;
  suppressedCheckpointRefs?: Set<string>;
  now?: Date;
}) {
  return decideRadar({
    children: input.children ?? [child()],
    candidates: input.candidates ?? [],
    windows: input.windows ?? [],
    weather: input.weather ?? [],
    teenChildIds: input.teenChildIds ?? [],
    healthChildren: input.healthChildren ?? [],
    areaCoarse: input.areaCoarse ?? null,
    suppressedCheckpointRefs: input.suppressedCheckpointRefs ?? new Set(),
    now: input.now ?? FRIDAY,
    timeZone: TZ,
  });
}

describe('upcomingWeekend', () => {
  it('gives the coming Saturday and Sunday from a weekday', () => {
    expect(upcomingWeekend(FRIDAY, TZ)).toEqual([
      { day: 'saturday', date: SATURDAY_DATE },
      { day: 'sunday', date: SUNDAY_DATE },
    ]);
  });

  it('on Saturday, the weekend is today and tomorrow — not next week', () => {
    // 2026-08-01 is a Saturday; 10:00 local.
    expect(upcomingWeekend(new Date('2026-08-01T14:00:00.000Z'), TZ)).toEqual([
      { day: 'saturday', date: SATURDAY_DATE },
      { day: 'sunday', date: SUNDAY_DATE },
    ]);
  });

  it('on Sunday, Saturday has already gone — only Sunday is left', () => {
    expect(upcomingWeekend(new Date('2026-08-02T14:00:00.000Z'), TZ)).toEqual([
      { day: 'sunday', date: SUNDAY_DATE },
    ]);
  });

  it("reads the day in the FAMILY zone, not the server's", () => {
    // 2026-08-02T03:00Z is Saturday 23:00 in Toronto — still the Saturday weekend.
    expect(upcomingWeekend(new Date('2026-08-02T03:00:00.000Z'), TZ)).toEqual([
      { day: 'saturday', date: SATURDAY_DATE },
      { day: 'sunday', date: SUNDAY_DATE },
    ]);
  });
});

describe('parseAgeRange', () => {
  it('reads a plain year range', () => {
    expect(parseAgeRange('3-5 years')).toEqual({ minMonths: 36, maxMonths: 60 });
    expect(parseAgeRange('ages 3 to 5')).toEqual({ minMonths: 36, maxMonths: 60 });
    expect(parseAgeRange('3–5')).toEqual({ minMonths: 36, maxMonths: 60 });
  });

  it('reads a month range in months', () => {
    expect(parseAgeRange('6-18 months')).toEqual({ minMonths: 6, maxMonths: 18 });
  });

  it('reads open-ended bands', () => {
    expect(parseAgeRange('5+')).toEqual({ minMonths: 60, maxMonths: null });
    expect(parseAgeRange('18 months and up')).toEqual({ minMonths: 18, maxMonths: null });
    expect(parseAgeRange('under 5')).toEqual({ minMonths: null, maxMonths: 60 });
  });

  it('treats an all-ages label as unbounded, not unknown', () => {
    expect(parseAgeRange('All ages')).toEqual({ minMonths: null, maxMonths: null });
  });

  it('is null — UNKNOWN, not unbounded — for a label it cannot read', () => {
    expect(parseAgeRange(null)).toBeNull();
    expect(parseAgeRange('')).toBeNull();
    expect(parseAgeRange('school-aged kids welcome')).toBeNull();
  });
});

describe('decideRadar — age fit', () => {
  it('drops a candidate whose band cannot admit any child', () => {
    const decision = decide({
      children: [child({ ageMonths: 24 })],
      candidates: [candidate({ ageRange: '8-12 years' })],
    });
    expect(decision.weekendPick).toBeNull();
    expect(decision.followUpNeeded).toBe(true);
  });

  it('keeps a child just outside the band when the DOB was DERIVED (±6 months)', () => {
    // "she's about 3" → 36 months; the band starts at 42. Inside the tolerance.
    const decision = decide({
      children: [child({ ageMonths: 36, dobPrecision: 'derived' })],
      candidates: [candidate({ ageRange: '3.5-5 years' })],
    });
    expect(decision.weekendPick?.candidateRef.id).toBe('cand-1');
  });

  it('does NOT stretch the band for an EXACT DOB — the tolerance is what a guess earns', () => {
    const decision = decide({
      children: [child({ ageMonths: 36, dobPrecision: 'exact' })],
      candidates: [candidate({ ageRange: '3.5-5 years' })],
    });
    expect(decision.weekendPick).toBeNull();
  });

  it('keeps a candidate whose age label it cannot read (unknown is not a disqualifier)', () => {
    const decision = decide({
      candidates: [candidate({ ageRange: 'school-aged kids welcome' })],
    });
    expect(decision.weekendPick?.candidateRef.id).toBe('cand-1');
    // …but it must not CLAIM an age fit it never established.
    expect(decision.weekendPick?.whyFacts.join(' ')).not.toContain('school-aged');
  });
});

describe('decideRadar — free-first ordering', () => {
  it('picks the FREE option over a paid one that fits marginally better', () => {
    const decision = decide({
      children: [child({ ageMonths: 48 })],
      candidates: [
        candidate({ id: 'paid', title: 'Paid gym class', priceLevel: 'moderate', ageRange: '3-5 years' }),
        candidate({ id: 'free', title: 'Library story time', priceLevel: 'free' }),
      ],
    });
    expect(decision.weekendPick?.candidateRef.id).toBe('free');
  });

  it('picks the free option over an unpriced one (an unknown price is not free)', () => {
    const decision = decide({
      candidates: [
        candidate({ id: 'unknown', title: 'Drop-in gym', priceLevel: null }),
        candidate({ id: 'free', title: 'Library story time', priceLevel: 'free' }),
      ],
    });
    expect(decision.weekendPick?.candidateRef.id).toBe('free');
  });

  it('lets a paid pick win ONLY when it is clearly the better fit, and labels the price', () => {
    // The paid one covers BOTH kids (+2 = the clearly-better margin); the free one, one.
    const decision = decide({
      children: [child({ name: 'Maya', ageMonths: 48 }), child({ name: 'Leo', ageMonths: 18 })],
      candidates: [
        candidate({
          id: 'paid',
          title: 'Family swim',
          priceLevel: 'moderate',
          ageRange: 'all ages',
        }),
        candidate({ id: 'free', title: 'Preschool story time', priceLevel: 'free', ageRange: '3-5 years' }),
      ],
    });
    expect(CLEARLY_BETTER_MARGIN).toBe(2);
    expect(decision.weekendPick?.candidateRef.id).toBe('paid');
    expect(decision.weekendPick?.whyFacts.join(' ')).toContain('paid');
  });

  it('says a free pick is free', () => {
    const decision = decide({ candidates: [candidate({ priceLevel: 'free' })] });
    expect(decision.weekendPick?.whyFacts).toContain('free');
  });

  it('claims no price at all when the source labelled none', () => {
    const decision = decide({ candidates: [candidate({ priceLevel: null })] });
    expect(decision.weekendPick?.whyFacts.join(' ')).not.toContain('free');
    expect(decision.weekendPick?.whyFacts.join(' ')).not.toContain('paid');
  });
});

describe('decideRadar — multi-kid discipline', () => {
  it('prefers one pick covering BOTH kids over a better-scoring single-kid pick', () => {
    const decision = decide({
      children: [child({ name: 'Maya', ageMonths: 48 }), child({ name: 'Leo', ageMonths: 18 })],
      candidates: [
        candidate({ id: 'single', title: 'Preschool art', ageRange: '3-5 years', eventDate: SATURDAY_DATE }),
        candidate({ id: 'both', title: 'Family swim', ageRange: 'all ages' }),
      ],
    });
    expect(decision.weekendPick?.candidateRef.id).toBe('both');
    expect(decision.weekendPick?.kidNames).toEqual(['Maya', 'Leo']);
  });

  it('names only the kids the pick actually fits', () => {
    const decision = decide({
      children: [child({ name: 'Maya', ageMonths: 48 }), child({ name: 'Leo', ageMonths: 8 })],
      candidates: [candidate({ ageRange: '3-5 years' })],
    });
    expect(decision.weekendPick?.kidNames).toEqual(['Maya']);
  });

  it('speaks about ONE pick for a three-kid family, never one per age band', () => {
    const decision = decide({
      children: [
        child({ name: 'Maya', ageMonths: 48 }),
        child({ name: 'Leo', ageMonths: 18 }),
        child({ name: 'Sam', ageMonths: 120 }),
      ],
      candidates: [
        candidate({ id: 'a', title: 'Toddler gym', ageRange: '1-2 years' }),
        candidate({ id: 'b', title: 'Preschool art', ageRange: '3-5 years' }),
        candidate({ id: 'c', title: 'Kids climbing', ageRange: '8-12 years' }),
      ],
    });
    expect(decision.weekendPick).not.toBeNull();
    expect(decision.weekendPick?.kidNames).toHaveLength(1);
  });

  it('does not suggest a day that would split the siblings between two activities', () => {
    const decision = decide({
      children: [child({ name: 'Maya', ageMonths: 48 }), child({ name: 'Leo', ageMonths: 18 })],
      candidates: [
        candidate({ id: 'sat-a', title: 'Preschool art', ageRange: '3-5 years', eventDate: SATURDAY_DATE }),
        candidate({ id: 'sat-b', title: 'Toddler gym', ageRange: '1-2 years', eventDate: SATURDAY_DATE }),
        candidate({ id: 'sun', title: 'Family swim', ageRange: 'all ages', eventDate: SUNDAY_DATE }),
      ],
    });
    expect(decision.weekendPick?.candidateRef.id).toBe('sun');
    expect(decision.weekendPick?.day).toBe('sunday');
  });

  it('does not call it a split when both same-day options are for the SAME child', () => {
    const decision = decide({
      children: [child({ name: 'Maya', ageMonths: 48 }), child({ name: 'Leo', ageMonths: 18 })],
      candidates: [
        candidate({ id: 'sat-a', title: 'Preschool art', ageRange: '3-5 years', eventDate: SATURDAY_DATE }),
        candidate({ id: 'sat-b', title: 'Preschool music', ageRange: '3-5 years', eventDate: SATURDAY_DATE }),
      ],
    });
    expect(decision.weekendPick?.day).toBe('saturday');
  });
});

describe('decideRadar — weather', () => {
  const wet: DailyOutlook = { date: SATURDAY_DATE, precipitationChancePct: 90, highTempC: 18 };
  const dry: DailyOutlook = { date: SUNDAY_DATE, precipitationChancePct: 5, highTempC: 24 };

  it('places an outdoor pick on the dry day', () => {
    const decision = decide({
      candidates: [candidate({ indoorOutdoor: 'outdoor' })],
      weather: [wet, dry],
    });
    expect(decision.weekendPick?.day).toBe('sunday');
  });

  it('drops an outdoor-only option when the whole weekend is wet, and picks indoors', () => {
    const decision = decide({
      candidates: [
        candidate({ id: 'out', title: 'Splash pad', indoorOutdoor: 'outdoor' }),
        candidate({ id: 'in', title: 'Library story time', indoorOutdoor: 'indoor' }),
      ],
      weather: [wet, { ...dry, precipitationChancePct: 95 }],
    });
    expect(decision.weekendPick?.candidateRef.id).toBe('in');
  });

  it('still picks when the forecast is unavailable — and claims nothing about weather', () => {
    const decision = decide({
      candidates: [candidate({ id: 'out', title: 'Splash pad', indoorOutdoor: 'outdoor' })],
      weather: [],
    });
    expect(decision.weekendPick?.candidateRef.id).toBe('out');
    expect(decision.weekendPick?.whyFacts.join(' ')).not.toContain('dry');
  });

  it('only claims a dry forecast when the forecast actually says so', () => {
    const decision = decide({
      candidates: [candidate({ indoorOutdoor: 'outdoor' })],
      weather: [{ ...dry, date: SATURDAY_DATE }],
    });
    expect(decision.weekendPick?.whyFacts.join(' ')).toContain('dry');
  });
});

describe('decideRadar — season and dates', () => {
  it('drops an out-of-season seasonal pick', () => {
    const decision = decide({ candidates: [candidate({ seasons: ['winter'] })] });
    expect(decision.weekendPick).toBeNull();
  });

  it('keeps a seasonal pick whose season is the one we are in', () => {
    const decision = decide({ candidates: [candidate({ seasons: ['summer'] })] });
    expect(decision.weekendPick?.candidateRef.id).toBe('cand-1');
  });

  it('drops a dated event that does not fall on the coming weekend', () => {
    const decision = decide({ candidates: [candidate({ eventDate: '2026-08-05' })] });
    expect(decision.weekendPick).toBeNull();
  });
});

describe('decideRadar — teen privacy (rule #1)', () => {
  it('never surfaces a candidate attributed to a 13+ child', () => {
    const decision = decide({
      children: [child({ name: 'Ava', ageMonths: 168 })],
      candidates: [candidate({ id: 'teen', childId: 'kid-teen' })],
      teenChildIds: ['kid-teen'],
    });
    expect(decision.weekendPick).toBeNull();
  });
});

describe('decideRadar — registration line', () => {
  it('carries the soonest window this family can act on, named for the kids it admits', () => {
    const decision = decide({
      children: [child({ name: 'Maya', ageMonths: 48 }), child({ name: 'Leo', ageMonths: 18 })],
      windows: [match({ matchedChildAgesMonths: [48] })],
    });
    expect(decision.registrationLine?.windowRef).toEqual({
      municipality: 'markham',
      programDomain: 'rec_program',
      cycleLabel: 'Fall 2026',
    });
    expect(decision.registrationLine?.kidNames).toEqual(['Maya']);
    expect(decision.registrationLine?.opensAtLocal).toContain('Aug 11');
  });

  it("carries a resident note only when the head start is really this family's", () => {
    const residentWindow = win({ residentOpenAt: new Date('2026-08-04T10:30:00.000Z') });
    const resident = decide({
      windows: [
        match({
          window: residentWindow,
          isResidentWindow: true,
          opensForFamilyAt: residentWindow.residentOpenAt as Date,
        }),
      ],
    });
    expect(resident.registrationLine?.residentNote).not.toBeNull();

    const ambiguous = decide({ windows: [match({ isResidentWindow: false })] });
    expect(ambiguous.registrationLine?.residentNote).toBeNull();
  });

  it('flags an approximate age match so the copy can hedge', () => {
    const decision = decide({ windows: [match({ ageApproximate: true })] });
    expect(decision.registrationLine?.ageApproximate).toBe(true);
  });

  it('takes the SOONEST window when several match', () => {
    const later = win({ id: 'w-2', cycleLabel: 'Winter 2027', openAt: new Date('2026-11-01T10:30:00.000Z') });
    const decision = decide({
      windows: [match(), match({ window: later, opensForFamilyAt: later.openAt, generalOpenAt: later.openAt })],
    });
    expect(decision.registrationLine?.windowRef.cycleLabel).toBe('Fall 2026');
  });
});

describe('decideRadar — honest degradation', () => {
  it('says nothing about registration when no window is in range', () => {
    const decision = decide({ candidates: [candidate()], windows: [] });
    expect(decision.registrationLine).toBeNull();
    expect(decision.weekendPick).not.toBeNull();
  });

  it('returns no pick at all — never a fabricated one — when there is no village data', () => {
    const decision = decide({ candidates: [], windows: [match()] });
    expect(decision.weekendPick).toBeNull();
    expect(decision.registrationLine).not.toBeNull();
  });

  it('flags a follow-up when it could not name a pick, and not when it could', () => {
    expect(decide({ candidates: [] }).followUpNeeded).toBe(true);
    expect(decide({ candidates: [candidate()] }).followUpNeeded).toBe(false);
  });

  it('always asks for the watch offer — the shell appends the question itself', () => {
    expect(decide({}).offerQuestion).toBe(true);
  });

  it('holds up with nothing at all to say', () => {
    const decision = decide({ children: [], candidates: [], windows: [] });
    expect(decision).toEqual({
      weekendPick: null,
      registrationLine: null,
      checkpoint: null,
      offerQuestion: true,
      followUpNeeded: true,
    });
  });
});

/**
 * The third rung. Geography can be empty — an FSA no civic adapter covers, a town with
 * no published registration windows, a family four milliseconds old with no discovered
 * candidates — but an age never is, and Ontario publishes an administrative calendar
 * against it. What is proved here is that the block is SELECTED, never composed: the
 * rows, the region gate, the teen wording and the suppression set all come from the M8
 * matcher (lib/health/match.ts), so this stage cannot hold a different opinion than the
 * 48h nudge about what applies to a child.
 */
describe('decideRadar — the age checkpoint', () => {
  it('names an Ontario checkpoint for a family with no window and no candidate at all', () => {
    // Halton Hills: outside every civic adapter, no registration windows. The live-gate
    // family whose first message was a shrug.
    const decision = decide({
      candidates: [],
      windows: [],
      healthChildren: [healthChild({ ageMonths: 18 })],
      areaCoarse: 'L7G',
    });

    expect(decision.weekendPick).toBeNull();
    expect(decision.registrationLine).toBeNull();
    expect(decision.checkpoint?.checkpointRef.id).toBe('immunization_18_months');
    expect(decision.checkpoint?.task).toContain('18 months');
    expect(decision.checkpoint?.kidNames).toEqual(['Maya']);
  });

  it('holds the band edges the reviewed table draws, and says nothing between them', () => {
    const at23 = decide({ healthChildren: [healthChild({ ageMonths: 23 })], areaCoarse: 'L7G' });
    expect(at23.checkpoint?.checkpointRef.id).toBe('immunization_18_months');

    // 24 months is past the last infant band and years short of the first school one.
    // The verified table has no row there, and a checkpoint is never invented to fill it.
    const at24 = decide({ healthChildren: [healthChild({ ageMonths: 24 })], areaCoarse: 'L7G' });
    expect(at24.checkpoint).toBeNull();
  });

  it('speaks about the YOUNGEST child — one message, one thing', () => {
    const decision = decide({
      healthChildren: [
        healthChild({ id: 'kid-1', name: 'Leo', ageMonths: 60 }),
        healthChild({ id: 'kid-2', name: 'Maya', ageMonths: 18 }),
      ],
      areaCoarse: 'M5V',
    });

    expect(decision.checkpoint?.checkpointRef.id).toBe('immunization_18_months');
    expect(decision.checkpoint?.kidNames).toEqual(['Maya']);
  });

  it('says nothing when the area is unknown or outside Ontario', () => {
    const children = [healthChild({ ageMonths: 18 })];
    expect(decide({ healthChildren: children, areaCoarse: null }).checkpoint).toBeNull();
    // H2X is Montreal: the provincial rows are not this family's rules.
    expect(decide({ healthChildren: children, areaCoarse: 'H2X' }).checkpoint).toBeNull();
  });

  it('honours the suppression set, so the radar cannot re-raise what was already told', () => {
    const children = [healthChild({ id: 'kid-1', ageMonths: 18 })];
    const suppressed = new Set(['immunization_18_months:kid-1:0']);

    const decision = decide({ healthChildren: children, areaCoarse: 'L7G', suppressedCheckpointRefs: suppressed });
    // The next row in the same band, not silence and not the suppressed one.
    expect(decision.checkpoint?.checkpointRef.id).toBe('well_baby_18_months');
  });

  it('uses the generic wording, and no name, for a 13+ child (rule #1)', () => {
    const decision = decide({
      healthChildren: [healthChild({ id: 'kid-1', name: null, ageMonths: 156, isTeen: true })],
      areaCoarse: 'M5V',
    });

    expect(decision.checkpoint?.checkpointRef.id).toBe('immunization_grade_7');
    expect(decision.checkpoint?.task).toBe('A school immunization consent form is due.');
    expect(decision.checkpoint?.kidNames).toEqual([]);
  });

  it('yields to the two leads when a family has all three — two blocks reach a parent, never three', () => {
    const decision = decide({
      candidates: [candidate()],
      windows: [match()],
      healthChildren: [healthChild({ ageMonths: 18 })],
      areaCoarse: 'L7G',
    });

    expect(decision.registrationLine).not.toBeNull();
    expect(decision.weekendPick).not.toBeNull();
    // A date that closes and a weekend that passes beat a window open for months, so the
    // ceiling drops this one — and it drops it HERE rather than in the render, because a
    // checkpoint that survives into the decision is one the SEND marks told for every
    // other surface (lib/health/told.ts). A block the message never carried must never
    // silence the 48h nudge.
    expect(decision.checkpoint).toBeNull();
  });

  it('carries the identity the told-marker keys on, not just the row id', () => {
    const decision = decide({
      healthChildren: [healthChild({ id: 'kid-1', ageMonths: 18 })],
      areaCoarse: 'L7G',
    });

    // The matcher's own ref: per child for a one-time visit. Rebuilding it downstream is
    // how the scope goes wrong (checkpoints.ts checkpointRef).
    expect(decision.checkpoint?.ref).toBe('immunization_18_months:kid-1:0');
  });
});
