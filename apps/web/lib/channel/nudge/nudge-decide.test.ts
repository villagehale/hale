import type { Municipality, ProgramDomain, RegistrationWindow } from '@hale/db';
import { describe, expect, it } from 'vitest';
import type {
  RadarCandidate,
  RadarChild,
} from '~/lib/channel/intake/radar-decide';
import type { HealthChild } from '~/lib/health/match';
import type { RegistrationMatch } from '~/lib/registration/match-registration-windows';
import type { DailyOutlook } from '~/lib/weather/open-meteo';
import { REGISTRATION_HORIZON_DAYS, decideNudge } from './nudge-decide.js';

/**
 * VIL-239 · M4 — DECIDE: the ONE thing worth texting a family unprompted, or nothing.
 *
 * Expectations come from the M4 brief, not the implementation:
 *
 *   - a registration window a family can still act on OUTRANKS everything, because it
 *     is the only thing here with a deadline;
 *   - a weather swap may only be claimed when there IS a forecast and there IS a real
 *     village candidate to swap to — "it might rain, maybe stay in" is not a nudge;
 *   - NOTHING is a first-class answer. Every honest-absence path returns null rather
 *     than degrading into a vaguer message.
 */

// A Friday: the coming weekend is Sat 2026-08-01 / Sun 2026-08-02.
const FRIDAY = new Date('2026-07-31T15:00:00.000Z');
const TZ = 'America/Toronto';
const SATURDAY = '2026-08-01';
const SUNDAY = '2026-08-02';

function child(overrides: Partial<RadarChild> = {}): RadarChild {
  return { name: 'Maya', ageMonths: 48, dobPrecision: 'derived', ...overrides };
}

/** The same child, as M8's matcher needs her. 48 months sits in the 4-to-6-year
 * checkpoint, so a health nudge is always on the table in these cases. */
function healthChild(overrides: Partial<HealthChild> = {}): HealthChild {
  return {
    id: 'child-1',
    name: 'Maya',
    ageMonths: 48,
    dobPrecision: 'derived',
    isTeen: false,
    ...overrides,
  };
}

function candidate(overrides: Partial<RadarCandidate> = {}): RadarCandidate {
  return {
    id: 'cand-1',
    title: 'Library story time',
    venueName: 'Riverdale Library',
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
    ageMinMonths: 36,
    ageMaxMonths: 72,
    openAt: new Date('2026-08-05T10:30:00.000Z'),
    residentOpenAt: null,
    closesAt: null,
    sourceUrl: null,
    notes: null,
    createdAt: FRIDAY,
    updatedAt: FRIDAY,
    ...overrides,
  } as RegistrationWindow;
}

function match(overrides: Partial<RegistrationMatch> = {}): RegistrationMatch {
  const window = overrides.window ?? win();
  return {
    window,
    matchedChildAgesMonths: [48],
    ageApproximate: false,
    isResidentWindow: false,
    opensForFamilyAt: window.openAt,
    generalOpenAt: window.openAt,
    ...overrides,
  };
}

function outlook(date: string, overrides: Partial<DailyOutlook> = {}): DailyOutlook {
  return { date, precipitationChancePct: 10, highTempC: 24, ...overrides };
}

const WET = { precipitationChancePct: 90 };
const FREEZING = { highTempC: -20 };

function decide(overrides: Partial<Parameters<typeof decideNudge>[0]> = {}) {
  return decideNudge({
    children: [child()],
    candidates: [],
    windows: [],
    weather: [],
    teenChildIds: [],
    // M8's inputs default to "no health checkpoint on the table", so these M4 cases keep
    // deciding between a registration date and a weekend.
    healthChildren: [],
    areaCoarse: null,
    doneCheckpointRefs: new Set<string>(),
    now: FRIDAY,
    timeZone: TZ,
    ...overrides,
  });
}

describe('decideNudge — priority 1: a registration window', () => {
  it('names the window, when it opens for THIS family, and the kids it fits', () => {
    const nudge = decide({ windows: [match()] });
    expect(nudge?.kind).toBe('registration');
    if (nudge?.kind !== 'registration') throw new Error('expected a registration nudge');
    expect(nudge.windowRef.municipality).toBe('markham');
    expect(nudge.windowRef.cycleLabel).toBe('Fall 2026');
    expect(nudge.kidNames).toEqual(['Maya']);
    expect(nudge.opensAtLocal).toContain('Aug 5');
  });

  it('outranks a weather swap that would otherwise fire', () => {
    const nudge = decide({
      windows: [match()],
      candidates: [candidate({ indoorOutdoor: 'outdoor' })],
      weather: [outlook(SATURDAY), outlook(SUNDAY)],
    });
    expect(nudge?.kind).toBe('registration');
  });

  it('ignores a window past the horizon — a date three weeks out is not news yet', () => {
    const far = new Date(FRIDAY.getTime() + (REGISTRATION_HORIZON_DAYS + 1) * 86_400_000);
    expect(decide({ windows: [match({ window: win({ openAt: far }), opensForFamilyAt: far })] })).toBeNull();
  });

  it('takes the soonest window when several are inside the horizon', () => {
    const later = new Date('2026-08-06T10:30:00.000Z');
    const nudge = decide({
      windows: [
        match(),
        match({
          window: win({ id: 'w-2', municipality: 'vaughan' as Municipality, openAt: later }),
          opensForFamilyAt: later,
        }),
      ],
    });
    if (nudge?.kind !== 'registration') throw new Error('expected a registration nudge');
    expect(nudge.windowRef.municipality).toBe('markham');
  });

  it('carries the resident head start only when the family actually has one', () => {
    const resident = decide({ windows: [match({ isResidentWindow: true, window: win({ residentOpenAt: new Date('2026-08-03T10:30:00.000Z') }) })] });
    if (resident?.kind !== 'registration') throw new Error('expected a registration nudge');
    expect(resident.residentNote).toBe('residents can register first');
    const general = decide({ windows: [match()] });
    if (general?.kind !== 'registration') throw new Error('expected a registration nudge');
    expect(general.residentNote).toBeNull();
  });

  it('flags an approximate age fit so the copy can hedge it', () => {
    const nudge = decide({ windows: [match({ ageApproximate: true })] });
    if (nudge?.kind !== 'registration') throw new Error('expected a registration nudge');
    expect(nudge.ageApproximate).toBe(true);
  });

  it('names every kid the window admits, in one message', () => {
    const nudge = decide({
      children: [child(), child({ name: 'Leo', ageMonths: 60 }), child({ name: 'Ada', ageMonths: 9 })],
      windows: [match({ matchedChildAgesMonths: [48, 60] })],
    });
    if (nudge?.kind !== 'registration') throw new Error('expected a registration nudge');
    expect(nudge.kidNames).toEqual(['Maya', 'Leo']);
  });

  it('names nobody rather than guessing when the parent named nobody', () => {
    const nudge = decide({ children: [child({ name: null })], windows: [match()] });
    if (nudge?.kind !== 'registration') throw new Error('expected a registration nudge');
    expect(nudge.kidNames).toEqual([]);
  });
});

describe('decideNudge — priority 2: a weather-fit weekend swap', () => {
  it('swaps to an indoor pick when the whole weekend is wet', () => {
    const nudge = decide({
      candidates: [candidate({ indoorOutdoor: 'indoor' })],
      weather: [outlook(SATURDAY, WET), outlook(SUNDAY, WET)],
    });
    if (nudge?.kind !== 'weather_swap') throw new Error('expected a weather swap');
    expect(nudge.candidateRef.title).toBe('Library story time');
    expect(nudge.day).toBe('saturday');
    expect(nudge.weatherFact).toContain('wet');
    expect(nudge.whyFacts).toContain('indoor');
  });

  it('says COLD when cold is what actually rules the day out', () => {
    const nudge = decide({
      candidates: [candidate({ indoorOutdoor: 'indoor' })],
      weather: [outlook(SATURDAY, FREEZING), outlook(SUNDAY, FREEZING)],
    });
    if (nudge?.kind !== 'weather_swap') throw new Error('expected a weather swap');
    expect(nudge.weatherFact).toContain('cold');
    expect(nudge.weatherFact).not.toContain('wet');
  });

  it('offers a FREE outdoor pick when a weekend day is genuinely good', () => {
    const nudge = decide({
      candidates: [candidate({ indoorOutdoor: 'outdoor', priceLevel: 'free', title: 'Splash pad' })],
      weather: [outlook(SATURDAY), outlook(SUNDAY)],
    });
    if (nudge?.kind !== 'weather_swap') throw new Error('expected a weather swap');
    expect(nudge.candidateRef.title).toBe('Splash pad');
    expect(nudge.whyFacts).toContain('free');
    expect(nudge.weatherFact).toContain('dry');
  });

  it('places the pick on the good day, not the washed-out one', () => {
    const nudge = decide({
      candidates: [candidate({ indoorOutdoor: 'outdoor' })],
      weather: [outlook(SATURDAY, WET), outlook(SUNDAY)],
    });
    if (nudge?.kind !== 'weather_swap') throw new Error('expected a weather swap');
    expect(nudge.day).toBe('sunday');
  });

  it('says nothing when a good day has only a PAID outdoor option', () => {
    expect(
      decide({
        candidates: [candidate({ indoorOutdoor: 'outdoor', priceLevel: 'paid' })],
        weather: [outlook(SATURDAY), outlook(SUNDAY)],
      }),
    ).toBeNull();
  });

  it('says nothing when the weekend is wet and there is no indoor option', () => {
    expect(
      decide({
        candidates: [candidate({ indoorOutdoor: 'outdoor' })],
        weather: [outlook(SATURDAY, WET), outlook(SUNDAY, WET)],
      }),
    ).toBeNull();
  });

  it('makes no weather claim at all when there is no forecast', () => {
    expect(decide({ candidates: [candidate()], weather: [] })).toBeNull();
  });

  it('will not call an unlabelled venue indoor', () => {
    expect(
      decide({
        candidates: [candidate({ indoorOutdoor: null })],
        weather: [outlook(SATURDAY, WET), outlook(SUNDAY, WET)],
      }),
    ).toBeNull();
  });

  it('drops a candidate whose published band excludes every child', () => {
    expect(
      decide({
        children: [child({ ageMonths: 6 })],
        candidates: [candidate({ ageRange: '8-12 years' })],
        weather: [outlook(SATURDAY, WET), outlook(SUNDAY, WET)],
      }),
    ).toBeNull();
  });

  it('never names a 13+ child’s activity to a parent (rule #1 backstop)', () => {
    expect(
      decide({
        children: [child({ ageMonths: 170 })],
        candidates: [candidate({ childId: 'teen-1' })],
        weather: [outlook(SATURDAY, WET), outlook(SUNDAY, WET)],
        teenChildIds: ['teen-1'],
      }),
    ).toBeNull();
  });

  it('keeps a dated candidate on its own date only', () => {
    const offWeekend = decide({
      candidates: [candidate({ eventDate: '2026-08-05', indoorOutdoor: 'indoor' })],
      weather: [outlook(SATURDAY, WET), outlook(SUNDAY, WET)],
    });
    expect(offWeekend).toBeNull();

    const onSunday = decide({
      candidates: [candidate({ eventDate: SUNDAY, indoorOutdoor: 'indoor' })],
      weather: [outlook(SATURDAY, WET), outlook(SUNDAY, WET)],
    });
    if (onSunday?.kind !== 'weather_swap') throw new Error('expected a weather swap');
    expect(onSunday.day).toBe('sunday');
  });

  it('prefers the pick that covers the most kids, and names them all', () => {
    const nudge = decide({
      children: [child(), child({ name: 'Leo', ageMonths: 60 })],
      candidates: [
        candidate({ id: 'c-one', title: 'Toddler gym', ageRange: '3-4 years' }),
        candidate({ id: 'c-both', title: 'Family swim', ageRange: '2-8 years' }),
      ],
      weather: [outlook(SATURDAY, WET), outlook(SUNDAY, WET)],
    });
    if (nudge?.kind !== 'weather_swap') throw new Error('expected a weather swap');
    expect(nudge.candidateRef.title).toBe('Family swim');
    expect(nudge.kidNames).toEqual(['Maya', 'Leo']);
  });

  it('drops an out-of-season candidate', () => {
    expect(
      decide({
        candidates: [candidate({ seasons: ['winter'] })],
        weather: [outlook(SATURDAY, WET), outlook(SUNDAY, WET)],
      }),
    ).toBeNull();
  });
});

describe('decideNudge — silence', () => {
  it('returns nothing when there is neither a window nor anything to swap to', () => {
    expect(decide()).toBeNull();
  });

  it('returns nothing when there is village data but no forecast to justify a swap', () => {
    expect(decide({ candidates: [candidate(), candidate({ id: 'c-2' })] })).toBeNull();
  });
});

/**
 * VIL-243 · M8 — where the health checkpoint sits in the ranking, and why.
 *
 * A registration date is a HARD deadline measured in minutes; a health-admin window is
 * measured in months; a weekend suggestion expires but costs nothing to skip. So the
 * order is deadline, obligation, offer — and the middle one is new.
 */
describe('decideNudge — health checkpoints', () => {
  const health = { healthChildren: [healthChild()], areaCoarse: 'M4C' };

  it('yields to a registration window a family can still act on', () => {
    const nudge = decide({ ...health, windows: [match()] });
    expect(nudge?.kind).toBe('registration');
  });

  it('outranks a weekend swap, which is an offer rather than an obligation', () => {
    const nudge = decide({
      ...health,
      candidates: [candidate()],
      weather: [outlook(SATURDAY, WET), outlook(SUNDAY, WET)],
    });
    expect(nudge?.kind).toBe('health_checkpoint');
  });

  it('carries the checkpoint by reference and never names a 13+ child', () => {
    const nudge = decide({
      healthChildren: [healthChild({ id: 'teen-1', name: null, ageMonths: 180, isTeen: true })],
      areaCoarse: 'M4C',
    });
    expect(nudge).toMatchObject({
      kind: 'health_checkpoint',
      kidNames: [],
      teenOnly: true,
      teenCount: 1,
    });
  });

  it('moves on to the next checkpoint once one is marked done, then goes quiet', () => {
    const done = new Set<string>();
    const seen: string[] = [];

    // Every checkpoint this child is inside, one "done" at a time. The point is that a
    // done suppresses exactly ONE checkpoint — not the family, and not the feature.
    for (let round = 0; round < 5; round += 1) {
      const nudge = decide({
        healthChildren: [healthChild()],
        areaCoarse: 'L4C',
        doneCheckpointRefs: done,
      });
      if (nudge === null) break;
      if (nudge.kind !== 'health_checkpoint') throw new Error('expected a health nudge');
      seen.push(nudge.checkpointRef.id);
      done.add(nudge.ref);
    }

    expect(seen).toEqual(['immunization_4_to_6_years', 'dental_school_screening']);
    expect(
      decide({ healthChildren: [healthChild()], areaCoarse: 'L4C', doneCheckpointRefs: done }),
    ).toBeNull();
  });
});
