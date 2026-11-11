import { describe, expect, it } from 'vitest';
import { type SpotPortal, portalForMunicipality } from '~/lib/channel/spots/url';
import {
  type LegCopyInput,
  approvalCardFacts,
  battlePlanDecision,
  checkInOutcomeFacts,
  courseBoundFacts,
  courseRefusedFacts,
  courseThrottledFacts,
  headsUpFacts,
  legNoteFacts,
  morningFacts,
  readinessAnswerFacts,
} from './copy.js';
import type { CourseFacts, CoursePage, PrepVerdict } from './prepare.js';
import { courseSignInUrl } from './prepare.js';
import type { FitNote, Shortlist } from './shortlist.js';

/**
 * VIL-242 · M7 — the facts every registration message is written from. No sentence is
 * built in copy.ts (VIL-484, VIL-488, VIL-543): what these tests pin is that the model
 * is handed the right facts — the anchor's own morning, the municipality's own clock,
 * a 13+ child never named, and no page value the bytes did not back. What the model
 * writes from them is the evals' (vil484-compose-eval.mjs, vil543-note-eval.mjs).
 */

const TZ = 'America/Toronto';
const NOW = new Date('2026-09-14T22:00:00.000Z');

/** The longest source URL in the real M1 dataset (Toronto, 121 characters). */
const LONGEST_URL =
  'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/camps-after-school/after-school-recreation-care/';

function shortlist(overrides: Partial<Shortlist> = {}): Shortlist {
  return {
    windowRef: {
      id: 'win-1',
      municipality: 'richmond_hill',
      programDomain: 'rec_program',
      cycleLabel: 'Fall 2026',
    },
    cyclePhrase: 'Fall 2026 recreation programs',
    opensForFamilyAt: new Date('2026-09-15T10:30:00.000Z'),
    sourceUrl: LONGEST_URL,
    isResidentWindow: false,
    residentPriorityDays: null,
    waitlistResponseHours: 36,
    fitNotes: [{ childId: 'c1', name: 'Max', fit: 'in_band' }],
    ageApproximate: false,
    ...overrides,
  };
}

/** The ladder the thirteen municipalities with no readable portal run — which is the
 * one that shipped, and the baseline every VIL-338 change is measured against. */
const LEG_INPUT: LegCopyInput = {
  shortlist: shortlist(),
  timeZone: TZ,
  now: NOW,
  optIn: 'opted_in',
  anchor: new Date('2026-09-15T10:30:00.000Z'),
  portal: null,
  readinessReady: null,
  prep: null,
};

describe('the heads-up, evening and morning facts', () => {
  it('hands the heads-up composer the town, the cycle, the open time and who', () => {
    const facts = headsUpFacts(LEG_INPUT);
    expect(facts.window).toContain('Richmond Hill');
    expect(facts.window).toContain('Fall 2026');
    expect(facts.opensAt).toBe('6:30 a.m.');
    expect(facts.who).toBe('Max');
  });

  it('tells the composer whether a plan was promised or is still being offered', () => {
    expect(headsUpFacts(LEG_INPUT).next).toBe('plan_promised');
    expect(headsUpFacts({ ...LEG_INPUT, optIn: 'pending' }).next).toBe('offer');
  });

  it('hands the spoken-age hedge as a fact', () => {
    expect(headsUpFacts(LEG_INPUT).ageApproximate).toBe(false);
    expect(
      headsUpFacts({ ...LEG_INPUT, shortlist: shortlist({ ageApproximate: true }) }).ageApproximate,
    ).toBe(true);
  });

  it('hands the resident head start only where the family has one', () => {
    expect(headsUpFacts(LEG_INPUT).residentsFirst).toBe(false);
    expect(
      headsUpFacts({
        ...LEG_INPUT,
        shortlist: shortlist({ isResidentWindow: true, residentPriorityDays: 7 }),
      }).residentsFirst,
    ).toBe(true);
  });

  it('hands the municipal link to the evening composer, and prints it on the go', () => {
    const evening = battlePlanDecision(LEG_INPUT);
    expect(evening.kind).toBe('compose');
    if (evening.kind === 'compose') expect(evening.facts.link).toBe(LONGEST_URL);
    expect(morningFacts(LEG_INPUT).link).toBe(LONGEST_URL);
    // The heads-up is a week out and is handed no link at all.
    expect(JSON.stringify(headsUpFacts(LEG_INPUT))).not.toContain(LONGEST_URL);
  });

  it('keeps a 13+ child nameless in every leg — rule #1', () => {
    const teen = {
      ...LEG_INPUT,
      shortlist: shortlist({ fitNotes: [{ childId: 'c1', name: null, fit: 'in_band' as const }] }),
    };
    const evening = battlePlanDecision(teen);
    expect(evening.kind).toBe('compose');
    if (evening.kind === 'compose') {
      expect(evening.facts.who).toBe('your teen');
      expect(evening.facts.who).not.toContain('null');
    }
    // The generic task naming still says WHOSE registration it is, without a name.
    expect(headsUpFacts(teen).who).toBe('your teen');
  });

  it('names two children in one line rather than sending two messages', () => {
    const facts = headsUpFacts({
      ...LEG_INPUT,
      shortlist: shortlist({
        fitNotes: [
          { childId: 'c1', name: 'Max', fit: 'in_band' },
          { childId: 'c2', name: 'Mia', fit: 'in_band' },
        ],
      }),
    });
    expect(facts.who).toBe('Max and Mia');
  });

  it('hands three children to the evening composer as one who, on the longest URL', () => {
    const evening = battlePlanDecision({
      ...LEG_INPUT,
      shortlist: shortlist({
        fitNotes: [
          { childId: 'c1', name: 'Sebastian', fit: 'in_band' },
          { childId: 'c2', name: 'Genevieve', fit: 'in_band' },
          { childId: 'c3', name: 'Maximilian', fit: 'near_band' },
        ],
      }),
    });
    expect(evening.kind).toBe('compose');
    if (evening.kind !== 'compose') return;
    expect(evening.facts.who).toBe('Sebastian, Genevieve and Maximilian');
    expect(evening.facts.children).toBe(3);
    expect(evening.facts.link).toBe(LONGEST_URL);
  });
});

/**
 * VIL-338 · the prepared ladder. Everything below is measured against the WORST CASE
 * the reader can actually hand a composer — `prepare.ts`'s own PRINTABLE_STRING_CAPS,
 * not the longest value any municipality has been observed publishing — because a cap
 * is a promise about a stranger's string and the segment budget is a promise about the
 * message that carries it. The host is the longest in the registry (Oakville, whose
 * sign-in deep link is 288 characters), and the opt-out is the FULL form, because the
 * gate picks the form per recipient and the budget has to hold for whichever it picks.
 */

const OAKVILLE = portalForMunicipality('oakville') as SpotPortal;

/** A real two-parameter course URL on the longest registry host. */
const COURSE_URL =
  'https://townofoakville.perfectmind.com/Contacts/BookMe4LandingPages/CoursesLandingPage?widgetId=11111111-2222-3333-4444-555555555555&courseId=66666666-7777-8888-9999-000000000000';
const DEEP_LINK = courseSignInUrl(COURSE_URL) as string;

/** prepare.ts's caps, as strings of that exact length. */
const NAME_AT_CAP = 'x'.repeat(60);
const BAND_AT_CAP = 'y'.repeat(40);

/** A course name that is BACKED and inside every cap the reader enforces — and still
 * unprintable, because a name ending in a question mark turns Hale's sentence into an
 * ask it never made. `readCourseFacts` has no rule against it: `?` is GSM-7, the string
 * is 30 characters, and it is neither link-shaped nor a carrier keyword. */
const NAME_WITH_QUESTION = 'Parent and Tot: Ready to Swim?';

/** Three long names — the family this ladder is hardest for. */
const THREE_KIDS: FitNote[] = [
  { childId: 'c1', name: 'Sebastian', fit: 'in_band' },
  { childId: 'c2', name: 'Genevieve', fit: 'in_band' },
  { childId: 'c3', name: 'Maximilian', fit: 'in_band' },
];

/** Markham's own cycle label, which is the longest window phrase in the M1 dataset. */
const MARKHAM_SHORTLIST = shortlist({
  windowRef: {
    id: 'win-m',
    municipality: 'markham',
    programDomain: 'rec_program',
    cycleLabel: '2026 Fall Programs, Swim Lessons and Winter Break Camps',
  },
  cyclePhrase: '2026 Fall Programs, Swim Lessons and Winter Break Camps',
  fitNotes: THREE_KIDS,
});

const ANCHOR = new Date('2026-09-15T14:30:00.000Z');
const MOVED_LATER = new Date('2026-09-15T15:30:00.000Z');
const MOVED_NEXT_DAY = new Date('2026-09-16T14:30:00.000Z');
/** Ten minutes past the anchor — inside WINDOW_DRIFT_TOLERANCE_MINUTES, which is what
 * makes the verdict `prepared` rather than `window_moved`. The ladder is scheduled off
 * the anchor, so this instant is a minute no leg of it ever fires on. */
const DRIFTED_INSIDE_TOLERANCE = new Date('2026-09-15T14:40:00.000Z');

function courseFacts(over: Partial<CourseFacts> = {}): CourseFacts {
  return {
    EventName: null,
    CourseId: null,
    StartDay: null,
    StartTime: null,
    StartDateValue: null,
    MinAge: null,
    MaxAge: null,
    MinAgeMonths: null,
    MaxAgeMonths: null,
    AgeRestrictions: null,
    RegFormId: null,
    PrerequisiteEvents: null,
    Prices: null,
    PublicRegistrationStartDateValue: null,
    ResidentsRegistrationDateValue: null,
    MembersRegistrationDateValue: null,
    IsRegistrationClosed: null,
    OnlineRegistration: null,
    ...over,
  };
}

/**
 * A page reading. `backed` defaults to every printable string the facts carry, which is
 * `readCourseFacts`'s own contract — a value it could not prove is NULL in the facts,
 * never present-and-unbacked. A test that wants the unbacked case passes it explicitly.
 */
function coursePage(
  over: { facts?: Partial<CourseFacts>; backed?: readonly string[]; clock?: Date } = {},
): CoursePage {
  const facts = courseFacts(over.facts);
  const strings = [
    facts.EventName,
    facts.CourseId,
    facts.StartDay,
    facts.StartTime,
    facts.AgeRestrictions,
  ]
    .filter((value): value is string => typeof value === 'string')
    .concat(
      (facts.Prices ?? [])
        .map((row) => row.DisplayAmount)
        .filter((v): v is string => typeof v === 'string'),
    );
  const at = over.clock ?? ANCHOR;
  return {
    facts,
    backed: over.backed ?? strings,
    clocks: { residents: null, members: null, public: at, start: null },
    clock: { at, name: 'public date' },
    anchorDriftMinutes: Math.round((at.getTime() - ANCHOR.getTime()) / 60_000),
    age: { fit: 'unknown', outsideBandChildIds: [] },
  };
}

function portalInput(over: Partial<LegCopyInput> = {}): LegCopyInput {
  return {
    ...LEG_INPUT,
    shortlist: MARKHAM_SHORTLIST,
    portal: OAKVILLE,
    anchor: ANCHOR,
    now: new Date('2026-09-14T22:00:00.000Z'),
    ...over,
  };
}

function bound(verdict: PrepVerdict, over: Partial<LegCopyInput> = {}): LegCopyInput {
  return portalInput({ prep: { verdict, courseUrl: COURSE_URL }, ...over });
}

const PREPARED = (over = {}): PrepVerdict => ({
  kind: 'prepared',
  readinessReady: null,
  ...coursePage(over),
});

function composeFacts(input: LegCopyInput) {
  const decision = battlePlanDecision(input);
  if (decision.kind !== 'compose') {
    throw new Error('expected the evening text to be composed from facts');
  }
  return decision.facts;
}

describe('VIL-338 · the go leg carries the portal’s own link', () => {
  it('carries the portal’s own deep link on every go leg that has one', () => {
    // The link is the whole point of the flagship text, and it is never withheld
    // because Hale had a bad fetch — a mutation that dropped it on page_unreadable
    // would leave a parent with a sentence and nowhere to go.
    for (const ready of [true, false, null] as const) {
      expect(morningFacts(bound(PREPARED(), { readinessReady: ready })).link).toBe(DEEP_LINK);
    }
    expect(morningFacts(bound({ kind: 'page_unreadable', reason: 'fetch_failed' })).link).toBe(
      DEEP_LINK,
    );
    expect(morningFacts(bound({ kind: 'age_ineligible', ...coursePage() })).link).toBe(DEEP_LINK);
    // A course the portal no longer serves, or one it has closed, is not a course to
    // sign in and register for: those two send the page itself.
    for (const verdict of [
      { kind: 'course_gone' },
      { kind: 'registration_closed', ...coursePage() },
    ] as PrepVerdict[]) {
      expect(morningFacts(bound(verdict)).link).toBe(COURSE_URL);
    }
  });
});

describe('VIL-338 · a bound ladder names ONE morning', () => {
  /** `portalInput()` is the shipped Oakville non-resident shape: the M1 row is a
   * placeholder (6:30 a.m. here) and the course page carries the clock this family
   * actually opens on (10:30 a.m.). Every leg on a bound ladder is scheduled off the
   * anchor, so a sentence that reached back for the row's instant would put a parent at
   * their phone four hours early — and on the real Oakville row, the evening before. */
  const ROW_TIME = '6:30 a.m.';
  const ANCHOR_TIME = '10:30 a.m.';

  it('hands the anchor’s time, never the M1 row’s, to the readiness checklist', () => {
    const facts = legNoteFacts('readiness', portalInput());
    expect(facts).toMatchObject({ kind: 'readiness_checklist', opensAt: ANCHOR_TIME });
    expect(JSON.stringify(facts)).not.toContain(ROW_TIME);
  });

  it('prints the anchor’s own time on every variant that names the morning', () => {
    const evening = [
      portalInput(),
      bound(PREPARED({ facts: { EventName: NAME_AT_CAP, AgeRestrictions: BAND_AT_CAP } })),
      bound(PREPARED({ facts: { EventName: NAME_AT_CAP }, clock: DRIFTED_INSIDE_TOLERANCE })),
      bound(PREPARED({ facts: { EventName: NAME_WITH_QUESTION } })),
      bound(PREPARED()),
      bound({ kind: 'page_unreadable', reason: 'fetch_failed' }),
      bound({ kind: 'course_gone' }),
      bound({ kind: 'registration_closed', ...coursePage() }),
      bound({ kind: 'age_ineligible', ...coursePage({ facts: { AgeRestrictions: BAND_AT_CAP } }) }),
    ];
    const wrong = evening.filter((input) => composeFacts(input).opensAt !== ANCHOR_TIME);
    expect(wrong).toEqual([]);
    const wrongMorning = evening.filter((input) => morningFacts(input).had !== ANCHOR_TIME);
    expect(wrongMorning).toEqual([]);
  });

  it('prints the anchor even where this read’s clock drifted inside the tolerance', () => {
    // The distinguishing case: `prepared` is the verdict for a page that AGREES with
    // the anchor to within fifteen minutes, so it still carries a clock of its own, and
    // a composer reaching for it would name a minute the ladder does not fire on. Every
    // other prepared fixture has a page clock EQUAL to the anchor, which is exactly the
    // shape that cannot tell the two apart.
    const DRIFTED_TIME = '10:40 a.m.';
    const morning = morningFacts(
      bound(PREPARED({ facts: { EventName: NAME_AT_CAP }, clock: DRIFTED_INSIDE_TOLERANCE })),
    );
    expect(morning.had).toBe(ANCHOR_TIME);
    expect(morning.pageShows).toBeNull();
    const drifted = composeFacts(
      bound(
        PREPARED({
          facts: { EventName: NAME_AT_CAP, AgeRestrictions: BAND_AT_CAP },
          clock: DRIFTED_INSIDE_TOLERANCE,
        }),
      ),
    );
    expect(drifted.opensAt).toBe(ANCHOR_TIME);
    expect(drifted.opensAt).not.toBe(DRIFTED_TIME);
  });

  it('names both instants only where the page itself moved the morning', () => {
    // The two branches whose whole content is the disagreement are allowed a second
    // instant, and they say which is which; nothing else may carry two times.
    const morning = morningFacts(
      bound({
        kind: 'window_moved',
        ...coursePage({ facts: { EventName: NAME_AT_CAP }, clock: MOVED_LATER }),
      }),
    );
    expect(morning.had).toBe('10:30 a.m.');
    expect(morning.pageShows?.time).toBe('11:30 a.m.');
    const moved = composeFacts(
      bound({
        kind: 'window_moved',
        ...coursePage({
          facts: { EventName: NAME_AT_CAP, AgeRestrictions: BAND_AT_CAP },
          clock: MOVED_LATER,
        }),
      }),
    );
    expect(moved.opensAt).toBe('11:30 a.m.');
    expect(moved.opensAt).not.toBe(ANCHOR_TIME);
    expect(moved.situation).toBe('course');
  });
});

describe('VIL-338 · each failure verdict has its own facts', () => {
  it('says the course is gone only where the portal said so', () => {
    expect(morningFacts(bound({ kind: 'course_gone' })).situation).toBe('course_gone');
    const gone = composeFacts(bound({ kind: 'course_gone' }));
    expect(gone.situation).toBe('course_gone');
    expect(gone.link).toBe(LONGEST_URL);
    expect(gone.link).not.toBe(DEEP_LINK);
  });

  it('says registration is closed without claiming anything changed on Hale’s side', () => {
    expect(morningFacts(bound({ kind: 'registration_closed', ...coursePage() })).situation).toBe(
      'registration_closed',
    );
    const closed = composeFacts(
      bound({ kind: 'registration_closed', ...coursePage({ facts: { EventName: NAME_AT_CAP } }) }),
    );
    expect(closed.situation).toBe('registration_closed');
    expect(closed.link).toBe(LONGEST_URL);
  });

  it('never says a course opens on the leg that just said it is gone or closed', () => {
    // The morning is only ever an assertion about a page Hale can still read. Where the
    // verdict is that the course is gone or that its registration is closed, "opens"
    // states something that read did not carry — and the parent it is being told to is
    // fifteen minutes from a phone. Hale's own record is still sayable, because it is
    // attributed to Hale rather than to the portal.
    expect(morningFacts(bound({ kind: 'course_gone' })).had).toBe('10:30 a.m.');
    // The evening plan degrades to the MUNICIPAL window and its general link, which is
    // a different claim about a different page — and never to the course's own sign-in
    // link, which is the one tap this verdict has no course to offer.
    for (const kind of ['course_gone', 'registration_closed'] as const) {
      const facts = composeFacts(
        bound(kind === 'course_gone' ? { kind } : { kind, ...coursePage() }),
      );
      expect(facts.link).toBe(LONGEST_URL);
      expect(facts.link).not.toBe(DEEP_LINK);
      expect(facts.situation).toBe(kind);
    }
  });

  it('says only that it could not read the page — never anything about the course', () => {
    // The false-safe property: an unreadable page hands NOTHING about the class, so the
    // facts carry no name, band, price or seat count.
    const morning = JSON.stringify(
      morningFacts(
        bound({ kind: 'page_unreadable', reason: 'fetch_failed' }, { readinessReady: true }),
      ),
    );
    expect(morning).not.toContain(NAME_AT_CAP);
    expect(morning).not.toContain(BAND_AT_CAP);
    const unread = composeFacts(bound({ kind: 'page_unreadable', reason: 'fetch_failed' }));
    expect(unread.situation).toBe('page_unreadable');
    expect(unread.link).toBe(COURSE_URL);
    expect(unread.courseName).toBeNull();
    expect(unread.ageBand).toBeNull();
  });

  it('names the page’s own band when it has one, and never invents one when it does not', () => {
    expect(
      morningFacts(
        bound({
          kind: 'age_ineligible',
          ...coursePage({ facts: { AgeRestrictions: BAND_AT_CAP } }),
        }),
      ).ageBand,
    ).toBe(BAND_AT_CAP);
    expect(
      morningFacts(
        bound({ kind: 'age_ineligible', ...coursePage({ facts: { EventName: NAME_AT_CAP } }) }),
      ).ageBand,
    ).toBeNull();
    const outside = composeFacts(
      bound({
        kind: 'age_ineligible',
        ...coursePage({ facts: { EventName: NAME_AT_CAP, AgeRestrictions: BAND_AT_CAP } }),
      }),
    );
    expect(outside.situation).toBe('age_outside');
    expect(outside.ageBand).toBe(BAND_AT_CAP);
    expect(outside.courseName).toBe(NAME_AT_CAP);
    expect(outside.link).toBe(COURSE_URL);
    expect(outside.children).toBe(3);
    const unbanded = composeFacts(
      bound({ kind: 'age_ineligible', ...coursePage({ facts: { EventName: NAME_AT_CAP } }) }),
    );
    expect(unbanded.ageBand).toBeNull();
  });

  it('hands a moved morning as facts with both instants, and builds no sentence', () => {
    const moved = morningFacts(
      bound({ kind: 'window_moved', ...coursePage({ facts: {}, clock: MOVED_LATER }) }),
    );
    expect(moved).toMatchObject({
      situation: 'moved',
      had: '10:30 a.m.',
      link: DEEP_LINK,
      pageShows: { time: '11:30 a.m.' },
    });
    const late = morningFacts(
      bound({
        kind: 'late_by_drift',
        ...coursePage({ facts: {}, clock: new Date('2026-09-15T13:30:00.000Z') }),
      }),
    );
    expect(late).toMatchObject({
      situation: 'already_open',
      link: DEEP_LINK,
      pageShows: { date: 'Tuesday, September 15, 2026', time: '9:30 a.m.' },
    });
  });

  it('moves the morning in the plan when the page moved it to another day', () => {
    const nextDay = composeFacts(
      bound({
        kind: 'window_moved',
        ...coursePage({ facts: { EventName: NAME_AT_CAP }, clock: MOVED_NEXT_DAY }),
      }),
    );
    expect(nextDay.situation).toBe('moved_day');
    expect(nextDay.pageShows?.date).toContain('September 16');
    expect(nextDay.link).toBe(COURSE_URL);
    expect(nextDay.courseName).toBe(NAME_AT_CAP);
    // A move INSIDE tomorrow is not news — the anchor was refreshed and the plan simply
    // prints the new time, which is true now.
    const sameDay = composeFacts(
      bound({
        kind: 'window_moved',
        ...coursePage({ facts: { EventName: NAME_AT_CAP }, clock: MOVED_LATER }),
      }),
    );
    expect(sameDay.situation).toBe('course');
    expect(sameDay.opensAt).toBe('11:30 a.m.');
    expect(sameDay.courseName).toBe(NAME_AT_CAP);
    expect(sameDay.pageShows).toBeNull();
  });

  it('hands an already-open course as facts, with no sentence built in code', () => {
    const late = composeFacts(
      bound({
        kind: 'late_by_drift',
        ...coursePage({
          facts: { EventName: NAME_AT_CAP },
          clock: new Date('2026-09-15T13:30:00.000Z'),
        }),
      }),
    );
    expect(late.situation).toBe('already_open');
    expect(late.pageShows).toEqual({ date: 'Tuesday, September 15, 2026', time: '9:30 a.m.' });
    expect(late.link).toBe(DEEP_LINK);
  });
});

describe('VIL-484 · every morning-of case is facts for the model, never fixed copy', () => {
  const caps = { facts: { EventName: NAME_AT_CAP, AgeRestrictions: BAND_AT_CAP } };
  const cases: [string, LegCopyInput, Record<string, unknown>][] = [
    ['municipal', LEG_INPUT, { situation: 'opens', portal: null, setup: null, link: LONGEST_URL }],
    ['portal, nothing bound', portalInput(), { situation: 'opens', setup: 'not_told' }],
    [
      'prepared, told done',
      bound(PREPARED(caps), { readinessReady: true }),
      { situation: 'opens', setup: 'told_done', link: DEEP_LINK, pageShows: null },
    ],
    [
      'page_unreadable',
      bound({ kind: 'page_unreadable', reason: 'fetch_failed' }),
      { situation: 'page_unreadable', link: DEEP_LINK },
    ],
    [
      'course_gone',
      bound({ kind: 'course_gone' }),
      { situation: 'course_gone', link: COURSE_URL, setup: null },
    ],
    [
      'registration_closed',
      bound({ kind: 'registration_closed', ...coursePage(caps) }),
      { situation: 'registration_closed', link: COURSE_URL, setup: null },
    ],
    [
      'age_ineligible',
      bound({ kind: 'age_ineligible', ...coursePage(caps) }),
      { situation: 'age_ineligible', ageBand: BAND_AT_CAP, link: DEEP_LINK },
    ],
    [
      'age_ineligible, no band',
      bound({ kind: 'age_ineligible', ...coursePage({ facts: { EventName: NAME_AT_CAP } }) }),
      { situation: 'age_ineligible', ageBand: null },
    ],
    [
      'window_moved, no clock (bare)',
      bound({ kind: 'window_moved', ...coursePage({ facts: {} }), clock: null }),
      { situation: 'opens', link: DEEP_LINK, pageShows: null },
    ],
    [
      'late_by_drift, no clock (bare)',
      bound({ kind: 'late_by_drift', ...coursePage({ facts: {} }), clock: null }),
      { situation: 'opens', link: DEEP_LINK, pageShows: null },
    ],
  ];

  it.each(cases)('builds facts for %s', (_n, input, want) => {
    const facts = morningFacts(input);
    expect(facts).toMatchObject(want);
    expect(facts.had).toMatch(/^\d{1,2}:\d\d [ap]\.m\.$/);
    expect(facts.now.date).toMatch(/2026/);
  });

  it('leaves no fixed morning-of sentence in copy.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./copy.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/function go\(|function goPrepared\(|function ageSentence\(/);
    expect(src).not.toMatch(/READINESS_UNTOLD_MORNING|'morning'\)/);
    for (const phrase of [
      'Your link:',
      'Sign in, then Register',
      'Then Register:',
      'I could not read',
      'is not showing the course',
      'closed to online registration. Nothing changed',
      'sign in now and check it',
      'Check the page yourself',
    ]) {
      expect(src).not.toContain(phrase);
    }
  });
});

describe('VIL-543 · the leg notes are facts for the model', () => {
  it('hands the readiness checklist the portal, its account and who it is for', () => {
    const facts = legNoteFacts('readiness', portalInput());
    expect(facts).toMatchObject({
      kind: 'readiness_checklist',
      portal: OAKVILLE.portalLabel,
      account: OAKVILLE.accountLabel,
      who: 'Sebastian, Genevieve and Maximilian',
      opensOn: 'Tuesday, September 15, 2026',
    });
  });

  it('leaves a portal-less readiness leg to the heads-up composer', () => {
    expect(() => legNoteFacts('readiness', LEG_INPUT)).toThrow(/heads-up/);
  });

  it('hands the check-in the window, and nothing about a child', () => {
    expect(legNoteFacts('check_in', LEG_INPUT)).toEqual({
      kind: 'check_in_ask',
      now: { date: 'Monday, September 14, 2026', time: '6:00 p.m.' },
      window: 'Richmond Hill Fall 2026 recreation programs',
    });
  });

  it('hands both waitlist guards where the clock started and the deadline counted from it', () => {
    // 15:00 UTC on 15 Sep is 11:00 in Toronto; 48h later is 11:00 on 17 Sep.
    const input = {
      ...LEG_INPUT,
      shortlist: shortlist({ waitlistResponseHours: 48 }),
      waitlist: { position: 12, startedAt: new Date('2026-09-15T15:00:00.000Z') },
    };
    const clockFrom = { date: 'Tuesday, September 15, 2026', time: '11:00 a.m.' };
    const deadline = { date: 'Thursday, September 17, 2026', time: '11:00 a.m.' };
    expect(legNoteFacts('waitlist_half', input)).toMatchObject({
      kind: 'waitlist_halfway',
      town: 'Richmond Hill',
      responseHours: 48,
      clockFrom,
      deadline,
    });
    expect(legNoteFacts('waitlist_final', input)).toMatchObject({
      kind: 'waitlist_final',
      responseHours: 48,
      clockFrom,
      deadline,
      hoursLeft: 2,
    });
    // No clock on file is a null deadline and a null start, never a Hale default.
    expect(
      legNoteFacts('waitlist_half', { ...LEG_INPUT, waitlist: { position: 3, startedAt: null } }),
    ).toMatchObject({ clockFrom: null, deadline: null });
  });

  it('counts each guard’s deadline from its own start and the town’s own hours', () => {
    // Positive control for the sum: the same start with 36h lands a day and a half on.
    const facts = legNoteFacts('waitlist_final', {
      ...LEG_INPUT,
      shortlist: shortlist({ waitlistResponseHours: 36 }),
      waitlist: { position: null, startedAt: new Date('2026-09-15T15:00:00.000Z') },
    });
    expect(facts).toMatchObject({
      clockFrom: { date: 'Tuesday, September 15, 2026', time: '11:00 a.m.' },
      deadline: { date: 'Wednesday, September 16, 2026', time: '11:00 p.m.' },
    });
  });
});

describe('VIL-543 · the check-in answer is facts for the model', () => {
  const base = { shortlist: shortlist(), timeZone: TZ, now: NOW };

  it('hands a spot the window it was for', () => {
    expect(checkInOutcomeFacts({ ...base, reply: { outcome: 'registered' } })).toMatchObject({
      kind: 'outcome_registered',
      window: 'Richmond Hill Fall 2026 recreation programs',
    });
  });

  it('hands a waitlist its position, where the clock started and the deadline from it', () => {
    expect(
      checkInOutcomeFacts({
        ...base,
        reply: {
          outcome: 'waitlisted',
          position: 12,
          startedAt: new Date('2026-09-15T15:00:00.000Z'),
        },
      }),
    ).toMatchObject({
      kind: 'outcome_waitlisted',
      position: 12,
      responseHours: 36,
      clockFrom: { date: 'Tuesday, September 15, 2026', time: '11:00 a.m.' },
      deadline: { date: 'Wednesday, September 16, 2026', time: '11:00 p.m.' },
    });
  });

  it('hands no clock where the municipality publishes no response window', () => {
    expect(
      checkInOutcomeFacts({
        shortlist: shortlist({ waitlistResponseHours: null }),
        timeZone: TZ,
        now: NOW,
        reply: {
          outcome: 'waitlisted',
          position: null,
          startedAt: new Date('2026-09-15T15:00:00.000Z'),
        },
      }),
    ).toMatchObject({
      kind: 'outcome_waitlisted',
      position: null,
      responseHours: null,
      clockFrom: null,
      deadline: null,
    });
  });

  it('hands a missed window its town', () => {
    expect(checkInOutcomeFacts({ ...base, reply: { outcome: 'missed' } })).toMatchObject({
      kind: 'outcome_missed',
      town: 'Richmond Hill',
    });
  });
});

describe('VIL-543 · the course bind ack is facts for the model', () => {
  const CLOCK = { at: ANCHOR, name: 'public date' as const };
  const ackInput = (over: Partial<Parameters<typeof courseBoundFacts>[0]> = {}) => ({
    portal: OAKVILLE,
    page: coursePage({
      facts: {
        EventName: 'Preschool Sports and Games',
        CourseId: '00028147',
        StartDay: 'Wednesday',
        StartTime: '10:30 AM',
        AgeRestrictions: '3 to 5',
        Prices: [
          { Name: '2026 Program Fee', DisplayAmount: '$280.60' },
          { Name: '2026 Program Fee Non-Resident', DisplayAmount: '$290.60' },
        ],
      },
    }),
    clock: CLOCK,
    replaced: false,
    municipality: 'markham',
    opensForFamilyAt: ANCHOR,
    fitNotes: [{ childId: 'c1', name: 'Maya', fit: 'in_band' as const }],
    timeZone: TZ,
    now: new Date('2026-09-01T12:00:00.000Z'),
    ...over,
  });

  it('hands what the page backed, and the clock the bind decided on', () => {
    expect(courseBoundFacts(ackInput())).toMatchObject({
      kind: 'course_bound',
      portal: OAKVILLE.portalLabel,
      course: { name: 'Preschool Sports and Games', day: 'Wednesday', time: '10:30 AM' },
      courseCode: '00028147',
      price: '2026 Program Fee: $280.60; 2026 Program Fee Non-Resident: $290.60',
      opensOn: 'Tuesday, September 15, 2026',
      opensAt: '10:30 a.m.',
      clockName: 'public date',
      haleHad: null,
      regForm: false,
      prerequisite: false,
      replaced: false,
    });
  });

  it('nulls a value the bytes did not back rather than handing it', () => {
    const facts = courseBoundFacts(
      ackInput({
        page: coursePage({
          facts: { EventName: 'Preschool Sports and Games', CourseId: '00028147' },
          backed: ['Preschool Sports and Games'],
        }),
      }),
    );
    expect(facts).toMatchObject({
      course: { name: 'Preschool Sports and Games' },
      courseCode: null,
    });
    // Positive control: the same code, backed, is handed.
    expect(
      courseBoundFacts(ackInput({ page: coursePage({ facts: { CourseId: '00028147' } }) })),
    ).toMatchObject({ courseCode: '00028147' });
  });

  it('hands the M1 row’s instant only where it disagrees with the page', () => {
    expect(
      courseBoundFacts(ackInput({ opensForFamilyAt: new Date('2026-09-14T14:30:00.000Z') })),
    ).toMatchObject({
      haleHad: { date: 'Monday, September 14, 2026', time: '10:30 a.m.' },
    });
  });

  it('hands the band and the fit only when the age verdict is known', () => {
    expect(courseBoundFacts(ackInput())).toMatchObject({ ageBand: null, ageFit: null });
    const page = {
      ...ackInput().page,
      age: { fit: 'outside_band' as const, outsideBandChildIds: ['c1'] },
    };
    expect(courseBoundFacts(ackInput({ page }))).toMatchObject({
      ageBand: '3 to 5',
      ageFit: 'outside',
      who: 'Maya',
    });
  });

  it('keeps a 13+ child nameless — rule #1', () => {
    const facts = courseBoundFacts(
      ackInput({ fitNotes: [{ childId: 'c1', name: null, fit: 'in_band' }] }),
    );
    expect(facts).toMatchObject({ who: 'your teen' });
  });

  it('names the two things a parent cannot pre-do', () => {
    expect(
      courseBoundFacts(
        ackInput({
          page: coursePage({ facts: { RegFormId: 'form-7', PrerequisiteEvents: true } }),
        }),
      ),
    ).toMatchObject({ regForm: true, prerequisite: true });
  });
});

describe('VIL-543 · the readiness answer is facts for the model', () => {
  it('hands the answer, the portal and its account', () => {
    expect(
      readinessAnswerFacts({
        portal: OAKVILLE,
        ready: false,
        fitNotes: THREE_KIDS,
        timeZone: TZ,
        now: NOW,
      }),
    ).toMatchObject({
      kind: 'readiness_answer',
      ready: false,
      portal: OAKVILLE.portalLabel,
      account: OAKVILLE.accountLabel,
      who: 'Sebastian, Genevieve and Maximilian',
    });
  });
});

describe('VIL-543 · the approval card is facts for the model', () => {
  it('enumerates THREE texts for a town with no portal Hale can read', () => {
    expect(approvalCardFacts(shortlist(), TZ, NOW, null)).toMatchObject({
      kind: 'approval_card',
      link: LONGEST_URL,
      opensOn: 'Tuesday, September 15, 2026',
      opensAt: '6:30 a.m.',
      texts: [
        { text: 'week_ahead', daysBefore: 7 },
        { text: 'evening_before' },
        { text: 'just_before_open', minutesBefore: 15 },
      ],
      courseLinkTip: false,
    });
  });

  it('enumerates FOUR texts, and the course-link tip, where the readiness leg fires', () => {
    expect(approvalCardFacts(shortlist(), TZ, NOW, OAKVILLE)).toMatchObject({
      texts: [
        { text: 'week_ahead', daysBefore: 7 },
        { text: 'checklist', daysBefore: 3 },
        { text: 'evening_before' },
        { text: 'just_before_open', minutesBefore: 15 },
      ],
      courseLinkTip: true,
    });
  });

  it('hands the resident head start only where the family has one', () => {
    expect(approvalCardFacts(shortlist(), TZ, NOW, null)).toMatchObject({
      residentsFirstDays: null,
    });
    expect(
      approvalCardFacts(
        shortlist({ isResidentWindow: true, residentPriorityDays: 1 }),
        TZ,
        NOW,
        null,
      ),
    ).toMatchObject({ residentsFirstDays: 1 });
  });

  it('hands per-child fit where the band is published, and keeps a teen nameless', () => {
    expect(
      approvalCardFacts(
        shortlist({
          fitNotes: [
            { childId: 'c1', name: 'Max', fit: 'in_band' },
            { childId: 'c2', name: null, fit: 'near_band' },
          ],
        }),
        TZ,
        NOW,
        null,
      ),
    ).toMatchObject({
      ageBand: {
        published: true,
        children: [
          { who: 'Max', fit: 'in_band' },
          { who: 'your teen', fit: 'near_band' },
        ],
      },
    });
  });

  it('says the band is unpublished instead of handing a fit Hale cannot confirm', () => {
    expect(
      approvalCardFacts(
        shortlist({ fitNotes: [{ childId: 'c1', name: 'Max', fit: 'band_unknown' }] }),
        TZ,
        NOW,
        null,
      ),
    ).toMatchObject({ ageBand: { published: false }, who: 'Max' });
  });
});

describe('VIL-543 · a refused course link is facts for the model', () => {
  const refusedInput = (over: Partial<Parameters<typeof courseRefusedFacts>[0]> = {}) => ({
    portal: OAKVILLE,
    municipality: 'oakville',
    reason: 'not_https' as const,
    pageOpensAt: null,
    opensForFamilyAt: ANCHOR,
    timeZone: TZ,
    now: NOW,
    ...over,
  });

  it('hands the reason, the portal and the town the morning is in', () => {
    expect(courseRefusedFacts(refusedInput())).toEqual({
      kind: 'course_link_refused',
      now: { date: 'Monday, September 14, 2026', time: '6:00 p.m.' },
      reason: 'not_https',
      portal: OAKVILLE.portalLabel,
      town: 'Oakville',
      pageOpens: null,
      haleHas: null,
    });
  });

  it('hands both mornings on a different season, and neither on any other reason', () => {
    const pageOpensAt = new Date('2026-10-27T14:30:00.000Z');
    expect(
      courseRefusedFacts(refusedInput({ reason: 'different_season', pageOpensAt })),
    ).toMatchObject({
      reason: 'different_season',
      pageOpens: { date: 'Tuesday, October 27, 2026', time: '10:30 a.m.' },
      haleHas: { date: 'Tuesday, September 15, 2026', time: '10:30 a.m.' },
    });
    expect(courseRefusedFacts(refusedInput({ reason: 'course_gone' }))).toMatchObject({
      pageOpens: null,
      haleHas: null,
    });
  });
});

describe('VIL-543 · a throttled course link is facts for the model', () => {
  it('hands the minutes until the next read is theirs', () => {
    expect(
      courseThrottledFacts({ alreadyBound: false, retryMinutes: 1, timeZone: TZ, now: NOW }),
    ).toEqual({
      kind: 'course_link_throttled',
      now: { date: 'Monday, September 14, 2026', time: '6:00 p.m.' },
      alreadyBound: false,
      retryMinutes: 1,
    });
  });

  it('hands no minutes for the link already bound: there is nothing to resend', () => {
    expect(
      courseThrottledFacts({ alreadyBound: true, retryMinutes: 10, timeZone: TZ, now: NOW }),
    ).toMatchObject({ alreadyBound: true, retryMinutes: null });
  });
});
