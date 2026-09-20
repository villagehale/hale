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
    source: null,
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
    cycleWindows: [window],
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

/** The whole decision, including the reasons a leg had nothing (VIL-360). */
function decideAll(overrides: Partial<Parameters<typeof decideNudge>[0]> = {}) {
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
    suppressedCheckpointRefs: new Set<string>(),
    // VIL-242 · no M7 sequence has claimed anything by default.
    claimedWindowIds: new Set<string>(),
    // VIL-360 · the weekday legs are off unless a case arms them, so every case
    // below decides between exactly the three classes it was written for.
    weekdayCare: 'disarmed' as const,
    now: FRIDAY,
    timeZone: TZ,
    ...overrides,
  });
}

/** Just the nudge, for the cases whose whole subject is which one wins. */
function decide(overrides: Partial<Parameters<typeof decideNudge>[0]> = {}) {
  return decideAll(overrides).nudge;
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

  /**
   * VIL-242 · M7 takes this job over for the windows it has claimed. The sequence
   * sends its own heads-up leg, so a nudge for a claimed window would be the SAME news
   * twice from the same number on the same morning.
   */
  describe('a window an M7 sequence has claimed', () => {
    it('is skipped rather than announced twice', () => {
      const nudge = decide({
        windows: [match()],
        claimedWindowIds: new Set(['w-1']),
      });
      expect(nudge).toBeNull();
    });

    it('does not suppress an UNCLAIMED window behind it', () => {
      // The claim is per window, not per family: a family prepared for Markham's Fall
      // date is still owed Vaughan's camp date.
      const claimed = match();
      const other = match({
        window: win({ id: 'w-2', municipality: 'vaughan', cycleLabel: 'Summer 2027 Camps' }),
      });
      const nudge = decide({
        windows: [claimed, other],
        claimedWindowIds: new Set(['w-1']),
      });
      if (nudge?.kind !== 'registration') throw new Error('expected a registration nudge');
      expect(nudge.windowRef.id).toBe('w-2');
    });

    it('lets a lower-priority nudge through instead of going silent', () => {
      // The M8 lesson: a claim must DEFER the class, never mute the family.
      const nudge = decide({
        windows: [match()],
        claimedWindowIds: new Set(['w-1']),
        candidates: [candidate({ indoorOutdoor: 'indoor' })],
        weather: [outlook(SATURDAY, WET), outlook(SUNDAY, WET)],
      });
      expect(nudge?.kind).toBe('weather_swap');
    });
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

  it('still raises the 18-month window here — the POST-consent surface (ads-week audit positive control)', () => {
    // The pre-consent first find no longer carries checkpoints (lib/channel/intake/radar.ts),
    // and this sweep — gated on watch consent in run.ts — is where the same reviewed row
    // now reaches the family. If this ever goes quiet too, the checkpoint is nowhere.
    const nudge = decide({
      healthChildren: [healthChild({ ageMonths: 18 })],
      areaCoarse: 'L7G',
    });
    expect(nudge?.kind).toBe('health_checkpoint');
    if (nudge?.kind !== 'health_checkpoint') throw new Error('expected a health nudge');
    expect(nudge.checkpointRef.id).toBe('immunization_18_months');
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
        suppressedCheckpointRefs: done,
      });
      if (nudge === null) break;
      if (nudge.kind !== 'health_checkpoint') throw new Error('expected a health nudge');
      seen.push(nudge.checkpointRef.id);
      done.add(nudge.ref);
    }

    expect(seen).toEqual(['immunization_4_to_6_years', 'dental_school_screening']);
    expect(
      decide({ healthChildren: [healthChild()], areaCoarse: 'L4C', suppressedCheckpointRefs: done }),
    ).toBeNull();
  });
});

/**
 * VIL-360 · priority 4 — the WEEKDAY civic drop-in.
 *
 * Expectations come from the brief's rules, not from the code: a weekday time claim
 * may rest ONLY on a civic_registry row (R4); a row the weekly sweep dated to a day
 * that has already gone may never be offered (R8); and the three care states are
 * three DIFFERENT skip reasons, because "they said daycare" and "nobody told us" call
 * for opposite next moves (R9, rule #11).
 */
describe('decideNudge — priority 4: a weekday civic drop-in', () => {
  /** A Toronto-local Friday, so "today" is 2026-07-31 in the family's own zone. */
  const homeCare = {
    stated: [
      { childId: 'child-1', care: 'home' as const, provider: null, validFrom: FRIDAY },
    ],
  };

  function civic(overrides: Partial<RadarCandidate> = {}): RadarCandidate {
    return candidate({
      id: 'civic-1',
      title: 'EarlyON drop-in',
      venueName: 'Armour Heights',
      source: 'civic_registry',
      // The Tuesday after FRIDAY.
      eventDate: '2026-08-04',
      ...overrides,
    });
  }

  it('picks the soonest upcoming Mon-Fri civic session and names the weekday', () => {
    const nudge = decide({
      weekdayCare: homeCare,
      candidates: [
        civic({ id: 'thu', title: 'Thursday storytime', eventDate: '2026-08-06' }),
        civic({ id: 'tue', title: 'Tuesday drop-in', eventDate: '2026-08-04' }),
      ],
    });
    if (nudge?.kind !== 'weekday_dropin') throw new Error('expected a weekday drop-in');
    expect(nudge.candidateRef.title).toBe('Tuesday drop-in');
    expect(nudge.eventDate).toBe('2026-08-04');
    expect(nudge.weekday).toBe('tuesday');
    expect(nudge.kidNames).toEqual(['Maya']);
  });

  it('R4 — never an LLM-discovered row, even when it is nearer and more confident', () => {
    const decision = decideAll({
      weekdayCare: homeCare,
      candidates: [
        candidate({
          id: 'llm',
          title: 'Tuesday music circle',
          source: 'llm',
          eventDate: '2026-08-03',
          confidence: 1,
        }),
      ],
    });
    expect(decision.nudge).toBeNull();
    expect(decision.skips).toEqual({ no_civic_candidate: 1 });
  });

  it('never a weekend-dated civic row — that is the weekend pick, not this', () => {
    const decision = decideAll({
      weekdayCare: homeCare,
      candidates: [civic({ eventDate: SATURDAY }), civic({ id: 'sun', eventDate: SUNDAY })],
    });
    expect(decision.nudge).toBeNull();
    expect(decision.skips).toEqual({ no_weekday_date: 1 });
  });

  it('R5 — drops a candidate whose renderable strings are not GSM-7, and COUNTS it', () => {
    const decision = decideAll({
      weekdayCare: homeCare,
      candidates: [
        // The em dash the civic sweep used to persist. It is dated sooner, so a decide
        // that did not drop it would pick it and double the bill.
        civic({ id: 'dashed', title: 'Story time — babies', eventDate: '2026-08-03' }),
        civic({ id: 'clean', title: 'Story time for babies', eventDate: '2026-08-04' }),
      ],
    });
    if (decision.nudge?.kind !== 'weekday_dropin') throw new Error('expected a drop-in');
    expect(decision.nudge.candidateRef.title).toBe('Story time for babies');
    expect(decision.skips).toEqual({ not_gsm7_printable: 1 });
  });

  it('R5 — an unprintable VENUE is dropped too, and then there is nothing to offer', () => {
    const decision = decideAll({
      weekdayCare: homeCare,
      candidates: [civic({ venueName: 'Café – north branch' })],
    });
    expect(decision.nudge).toBeNull();
    expect(decision.skips).toEqual({ not_gsm7_printable: 1 });
  });

  describe('R8 — a Mon-Fri row the weekly sweep has not re-dated yet', () => {
    // The production shape: the civic sweep runs Mondays, dates a Tuesday session to
    // THAT Tuesday, and the row stays live and unchanged all week.
    const SATURDAY_NOW = new Date('2026-08-01T15:00:00.000Z');
    const TUESDAY_GONE = '2026-07-28';
    const TUESDAY_COMING = '2026-08-04';

    it('picks the Tuesday coming, not the Tuesday just gone', () => {
      const nudge = decide({
        now: SATURDAY_NOW,
        weekdayCare: homeCare,
        candidates: [
          civic({ id: 'gone', title: 'Last Tuesday', eventDate: TUESDAY_GONE }),
          civic({ id: 'coming', title: 'Next Tuesday', eventDate: TUESDAY_COMING }),
        ],
      });
      if (nudge?.kind !== 'weekday_dropin') throw new Error('expected a weekday drop-in');
      expect(nudge.candidateRef.title).toBe('Next Tuesday');
    });

    it('with only the stale row, refuses and says WHY', () => {
      const decision = decideAll({
        now: SATURDAY_NOW,
        weekdayCare: homeCare,
        candidates: [civic({ id: 'gone', eventDate: TUESDAY_GONE })],
      });
      expect(decision.nudge).toBeNull();
      expect(decision.skips).toEqual({ weekday_date_past: 1 });
    });

    it('holds across a DST boundary, because the comparison is on the day KEY', () => {
      // Toronto leaves DST on 2026-11-01. `now` is the Friday before; the stale row is
      // the Tuesday before that, and the live one is the Monday AFTER the clocks change.
      const BEFORE_FALL_BACK = new Date('2026-10-30T15:00:00.000Z');
      const decision = decideAll({
        now: BEFORE_FALL_BACK,
        weekdayCare: homeCare,
        candidates: [
          civic({ id: 'gone', title: 'Gone Tuesday', eventDate: '2026-10-27' }),
          civic({ id: 'after', title: 'Post-DST Monday', eventDate: '2026-11-02' }),
        ],
      });
      if (decision.nudge?.kind !== 'weekday_dropin') throw new Error('expected a drop-in');
      expect(decision.nudge.candidateRef.title).toBe('Post-DST Monday');
      expect(decision.nudge.weekday).toBe('monday');
    });

    it('a session dated TODAY is still offerable', () => {
      const nudge = decide({
        weekdayCare: homeCare,
        // FRIDAY is 2026-07-31 in Toronto.
        candidates: [civic({ eventDate: '2026-07-31' })],
      });
      if (nudge?.kind !== 'weekday_dropin') throw new Error('expected a weekday drop-in');
      expect(nudge.weekday).toBe('friday');
    });
  });

  describe('R9 — the three care states are three different answers', () => {
    it('a starting_soon fact still produces the find', () => {
      const nudge = decide({
        weekdayCare: {
          stated: [
            {
              childId: 'child-1',
              care: 'starting_soon' as const,
              provider: null,
              validFrom: FRIDAY,
            },
          ],
        },
        candidates: [civic()],
      });
      expect(nudge?.kind).toBe('weekday_dropin');
    });

    it('a daycare fact skips as care_is_daycare', () => {
      const decision = decideAll({
        weekdayCare: {
          stated: [
            { childId: 'child-1', care: 'daycare' as const, provider: 'Little Sprouts', validFrom: FRIDAY },
          ],
        },
        candidates: [civic()],
      });
      expect(decision.nudge).toBeNull();
      expect(decision.skips).toEqual({ care_is_daycare: 1 });
    });

    it('no fact at all skips as care_unstated — a DIFFERENT state, not a quieter no', () => {
      const decision = decideAll({ weekdayCare: { stated: [] }, candidates: [civic()] });
      expect(decision.nudge).toBeNull();
      expect(decision.skips).toEqual({ care_unstated: 1 });
    });

    it("a 13+ child's fact never unlocks a find (rule #1)", () => {
      const decision = decideAll({
        teenChildIds: ['teen-1'],
        weekdayCare: {
          stated: [
            { childId: 'teen-1', care: 'home' as const, provider: null, validFrom: FRIDAY },
          ],
        },
        candidates: [civic()],
      });
      expect(decision.nudge).toBeNull();
      expect(decision.skips).toEqual({ care_unstated: 1 });
    });
  });

  it('the flag being off is SILENT, not a zeroed counter', () => {
    const decision = decideAll({ weekdayCare: 'disarmed', candidates: [civic()] });
    expect(decision.nudge).toBeNull();
    expect(decision.skips).toEqual({});
  });

  it('R3 — a weather swap outranks the find, and a registration window outranks both', () => {
    const wetWeekend = [outlook(SATURDAY, WET), outlook(SUNDAY, WET)];
    const both = {
      weekdayCare: homeCare,
      candidates: [civic(), candidate({ id: 'indoor', eventDate: SATURDAY })],
      weather: wetWeekend,
    };
    expect(decide(both)?.kind).toBe('weather_swap');
    expect(decide({ ...both, windows: [match()] })?.kind).toBe('registration');
  });
});
