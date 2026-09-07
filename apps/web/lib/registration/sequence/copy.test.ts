import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MAX_NUDGE_SEGMENTS, NUDGE_OPT_OUT } from '~/lib/channel/nudge/shell';
import { withOptOut } from '~/lib/channel/opt-out';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { type SpotPortal, portalForMunicipality } from '~/lib/channel/spots/url';
import type { CourseFacts, CoursePage, PrepVerdict } from './prepare.js';
import { courseSignInUrl } from './prepare.js';
import type { FitNote, Shortlist } from './shortlist.js';
import {
  MAX_PORTAL_SEGMENTS,
  type LegCopyInput,
  preparedCopyViolations,
  printsReadinessAsk,
  readinessClause,
  renderCheckInReply,
  renderCourseBindAck,
  renderReadinessAck,
  renderSequenceLeg,
  renderShortlistRationale,
} from './copy.js';

/**
 * VIL-242 · M7 — every string this feature can put in front of a parent.
 *
 * Three properties are checked on all of them, because each has bitten this codebase:
 *
 *   1. GSM-7 ONLY. One curly apostrophe or en dash flips the whole SMS to UCS-2 and
 *      halves the budget, for a difference nobody can see on a phone.
 *   2. TWO SEGMENTS INCLUDING THE OPT-OUT. The longest real source URL in the M1
 *      dataset is 121 characters, so the budget is checked against that, not a short
 *      placeholder that would pass and then blow up in Toronto.
 *   3. NO INVENTED PROGRAM. The copy may name the municipality, the cycle, the domain,
 *      the time and the link — never a class.
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

describe('renderSequenceLeg', () => {
  const legs = ['heads_up', 'battle_plan', 'go', 'check_in'] as const;

  it.each(legs)('renders %s inside the segment budget, in GSM-7', (leg) => {
    const body = renderSequenceLeg(leg, LEG_INPUT);
    expect(smsEncoding(withOptOut(body, 'full'))).toBe('gsm7');
    expect(smsSegments(withOptOut(body, 'full'))).toBeLessThanOrEqual(MAX_NUDGE_SEGMENTS);
  });

  it('never writes the opt-out itself — the sender appends it exactly once', () => {
    for (const leg of legs) {
      expect(renderSequenceLeg(leg, LEG_INPUT)).not.toContain(NUDGE_OPT_OUT);
    }
  });

  it('names the town, the cycle and the family-local open time in the heads-up', () => {
    const body = renderSequenceLeg('heads_up', LEG_INPUT);
    expect(body).toContain('Richmond Hill');
    expect(body).toContain('Fall 2026');
    expect(body).toContain('6:30 a.m.');
    expect(body).toContain('Max');
  });

  it('asks a pending family for the approval IN THE THREAD, never in the app', () => {
    // Doctrine: approvals happen in-thread (channel/router/copy.ts). The shortlist is an
    // ordinary drafted_for_approval row, so a texted YES approves it through the same
    // spine the app button calls — pointing at the app buys the parent nothing and is
    // the dead end the F14 voice rules refuse.
    const pending = renderSequenceLeg('heads_up', { ...LEG_INPUT, optIn: 'pending' });
    expect(pending).toContain('Reply YES');
    expect(pending).not.toContain('Open Hale');
    expect(pending.toLowerCase()).not.toContain('the app');
    expect(renderSequenceLeg('heads_up', LEG_INPUT)).not.toContain('Reply YES');
  });

  it('hedges the heads-up when the match rests on a spoken-age tolerance', () => {
    const hedged = renderSequenceLeg('heads_up', {
      ...LEG_INPUT,
      shortlist: shortlist({ ageApproximate: true }),
    });
    expect(hedged).toContain('if');
    expect(renderSequenceLeg('heads_up', LEG_INPUT)).not.toContain('if');
  });

  it('names the resident head start only where the family has one', () => {
    const resident = renderSequenceLeg('heads_up', {
      ...LEG_INPUT,
      shortlist: shortlist({ isResidentWindow: true, residentPriorityDays: 7 }),
    });
    expect(resident).toContain('residents');
    expect(renderSequenceLeg('heads_up', LEG_INPUT)).not.toContain('residents');
  });

  it('carries the direct municipal link on the battle plan and the go, not the heads-up', () => {
    expect(renderSequenceLeg('battle_plan', LEG_INPUT)).toContain(LONGEST_URL);
    expect(renderSequenceLeg('go', LEG_INPUT)).toContain(LONGEST_URL);
    // The heads-up is a week out; a link nobody can use yet just eats the budget the
    // hedge and the kids' names need.
    expect(renderSequenceLeg('heads_up', LEG_INPUT)).not.toContain(LONGEST_URL);
  });

  it('tells the check-in exactly which three answers it can read', () => {
    const body = renderSequenceLeg('check_in', LEG_INPUT);
    expect(body.toLowerCase()).toContain('got in');
    expect(body.toLowerCase()).toContain('waitlisted');
    expect(body.toLowerCase()).toContain('missed');
  });

  it('keeps a 13+ child nameless in every leg — rule #1', () => {
    const teen = {
      ...LEG_INPUT,
      shortlist: shortlist({ fitNotes: [{ childId: 'c1', name: null, fit: 'in_band' as const }] }),
    };
    for (const leg of legs) {
      const body = renderSequenceLeg(leg, teen);
      expect(body).not.toContain('null');
      expect(body).not.toContain('undefined');
    }
    // The generic task naming still says WHOSE registration it is, without a name.
    expect(renderSequenceLeg('heads_up', teen)).toContain('your teen');
  });

  it('names two children in one line rather than sending two messages', () => {
    const body = renderSequenceLeg('heads_up', {
      ...LEG_INPUT,
      shortlist: shortlist({
        fitNotes: [
          { childId: 'c1', name: 'Max', fit: 'in_band' },
          { childId: 'c2', name: 'Mia', fit: 'in_band' },
        ],
      }),
    });
    expect(body).toContain('Max and Mia');
  });

  it('stays inside the budget for a three-kid family on the longest URL', () => {
    const body = renderSequenceLeg('battle_plan', {
      ...LEG_INPUT,
      shortlist: shortlist({
        fitNotes: [
          { childId: 'c1', name: 'Sebastian', fit: 'in_band' },
          { childId: 'c2', name: 'Genevieve', fit: 'in_band' },
          { childId: 'c3', name: 'Maximilian', fit: 'near_band' },
        ],
      }),
    });
    expect(smsSegments(withOptOut(body, 'full'))).toBeLessThanOrEqual(MAX_NUDGE_SEGMENTS);
  });
});

describe('waitlist guard copy', () => {
  const DEADLINE = new Date('2026-09-17T03:00:00.000Z');
  const waitlistInput = {
    ...LEG_INPUT,
    now: new Date('2026-09-16T09:00:00.000Z'),
    waitlist: { position: 12, deadlineAt: DEADLINE },
  };

  it('renders both guards inside the segment budget, in GSM-7', () => {
    for (const leg of ['waitlist_half', 'waitlist_final'] as const) {
      const body = renderSequenceLeg(leg, waitlistInput);
      expect(smsEncoding(withOptOut(body, 'full'))).toBe('gsm7');
      expect(smsSegments(withOptOut(body, 'full'))).toBeLessThanOrEqual(MAX_NUDGE_SEGMENTS);
    }
  });

  it('names the deadline in the family’s own clock', () => {
    // 03:00 UTC on 17 Sep is 23:00 on 16 Sep in Toronto.
    expect(renderSequenceLeg('waitlist_final', waitlistInput)).toContain('11:00 p.m.');
  });

  it('is honest that the clock runs from the parent’s own message', () => {
    // Hale never sees the municipality's offer email, so it may not claim to know
    // when the offer landed — only when it was told.
    expect(renderSequenceLeg('waitlist_half', waitlistInput).toLowerCase()).toContain(
      'from your message',
    );
  });

  it('names the municipality’s published response window, not a Hale default', () => {
    expect(renderSequenceLeg('waitlist_half', waitlistInput)).toContain('36h');
    expect(
      renderSequenceLeg('waitlist_half', {
        ...waitlistInput,
        shortlist: shortlist({ waitlistResponseHours: 48 }),
      }),
    ).toContain('48h');
  });
});

describe('renderCheckInReply', () => {
  const base = { shortlist: shortlist(), timeZone: TZ, now: NOW };

  it('celebrates a spot and says what was recorded', () => {
    const body = renderCheckInReply({ ...base, reply: { outcome: 'registered' } });
    expect(body).toContain('Richmond Hill');
    expect(smsEncoding(body)).toBe('gsm7');
    expect(smsSegments(body)).toBeLessThanOrEqual(MAX_NUDGE_SEGMENTS);
  });

  it('acknowledges a waitlist position and promises the clock it can actually keep', () => {
    const body = renderCheckInReply({
      ...base,
      reply: {
        outcome: 'waitlisted',
        position: 15,
        deadlineAt: new Date('2026-09-17T03:00:00.000Z'),
      },
    });
    expect(body).toContain('15');
    expect(body).toContain('36h');
  });

  it('says plainly that there is no clock where the municipality publishes none', () => {
    const body = renderCheckInReply({
      ...base,
      shortlist: shortlist({ waitlistResponseHours: null }),
      reply: { outcome: 'waitlisted', position: 15, deadlineAt: null },
    });
    expect(body.toLowerCase()).toContain('no published');
    expect(body).not.toContain('36h');
  });

  it('acknowledges a waitlist with no position number', () => {
    const body = renderCheckInReply({
      ...base,
      reply: {
        outcome: 'waitlisted',
        position: null,
        deadlineAt: new Date('2026-09-17T03:00:00.000Z'),
      },
    });
    expect(body).not.toContain('null');
    expect(body).not.toContain('#');
  });

  it('answers a missed window without a silver lining nobody asked for', () => {
    const body = renderCheckInReply({ ...base, reply: { outcome: 'missed' } });
    expect(smsEncoding(body)).toBe('gsm7');
    expect(smsSegments(body)).toBeLessThanOrEqual(MAX_NUDGE_SEGMENTS);
  });

  it('re-asks once, repeating the three answers it can read', () => {
    const body = renderCheckInReply({ ...base, reply: { outcome: null } });
    expect(body.toLowerCase()).toContain('got in');
    expect(body.toLowerCase()).toContain('waitlisted');
    expect(body.toLowerCase()).toContain('missed');
  });
});

describe('renderShortlistRationale', () => {
  it('states the window, the link and the per-child fit, and nothing else', () => {
    const text = renderShortlistRationale(shortlist(), TZ, NOW, null);
    expect(text).toContain('Richmond Hill');
    expect(text).toContain('Fall 2026');
    expect(text).toContain('recreation programs');
    expect(text).toContain(LONGEST_URL);
    expect(text).toContain('Max');
  });

  it('spells out the tolerance rather than asserting a band Hale cannot confirm', () => {
    const text = renderShortlistRationale(
      shortlist({ fitNotes: [{ childId: 'c1', name: 'Max', fit: 'near_band' }] }),
      TZ,
      NOW,
      null,
    );
    expect(text.toLowerCase()).toContain('just outside');
  });

  it('keeps a 13+ child nameless', () => {
    const text = renderShortlistRationale(
      shortlist({ fitNotes: [{ childId: 'c1', name: null, fit: 'in_band' }] }),
      TZ,
      NOW,
      null,
    );
    expect(text).toContain('Your teen');
    expect(text).not.toContain('null');
  });

  it('names the resident head start in days where the family has one', () => {
    const text = renderShortlistRationale(
      shortlist({ isResidentWindow: true, residentPriorityDays: 7 }),
      TZ,
      NOW,
      null,
    );
    expect(text).toContain('7 days');
  });
});

/**
 * VIL-260 · WS3 — the approval card is the thing being consented to, so it may not
 * assert an age band the municipality never published. Burlington publishes none on
 * any of its rows, and its own cycle labels already name the program.
 */
describe('renderShortlistRationale — an unpublished band is said to be unpublished', () => {
  const BURLINGTON_REF = {
    id: 'win-1',
    municipality: 'burlington' as const,
    programDomain: 'swim' as const,
    cycleLabel: 'Fall 2026 swimming lessons',
  };

  it('says the band is not published instead of claiming the child is inside it', () => {
    const text = renderShortlistRationale(
      shortlist({
        windowRef: BURLINGTON_REF,
        cyclePhrase: 'recreation programs and swim lessons',
        fitNotes: [{ childId: 'c1', name: 'Mira', fit: 'band_unknown' }],
      }),
      TZ,
      NOW,
      null,
    );

    expect(text).not.toContain('inside the published age band');
    expect(text.toLowerCase()).toContain('does not publish an age band');
    expect(text).toContain('Mira');
  });

  it('does not repeat the program noun the cycle label already carries', () => {
    const text = renderShortlistRationale(
      shortlist({ windowRef: BURLINGTON_REF, cyclePhrase: 'Fall 2026 swimming lessons' }),
      TZ,
      NOW,
      null,
    );
    expect(text).toContain('Burlington Fall 2026 swimming lessons registration opens');
    expect(text).not.toContain('lessons swim lessons');
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
const MARKHAM_PORTAL = portalForMunicipality('markham') as SpotPortal;

/** A real two-parameter course URL on the longest registry host. */
const COURSE_URL =
  'https://townofoakville.perfectmind.com/Contacts/BookMe4LandingPages/CoursesLandingPage?widgetId=11111111-2222-3333-4444-555555555555&courseId=66666666-7777-8888-9999-000000000000';
const DEEP_LINK = courseSignInUrl(COURSE_URL) as string;

/** prepare.ts's caps, as strings of that exact length. A cap raised there without a
 * re-measurement here is what these fixtures exist to catch. */
const NAME_AT_CAP = 'x'.repeat(60);
const BAND_AT_CAP = 'y'.repeat(40);
const BARCODE_AT_CAP = 'z'.repeat(20);
const DAY_AT_CAP = 'd'.repeat(12);
const TIME_AT_CAP = 't'.repeat(12);
const PRICE_AT_CAP = `$${'1'.repeat(15)}`;
const PRICE_AT_CAP_2 = `$${'2'.repeat(15)}`;

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

/** Every portal-leg body a real send can carry, at the reader's caps. */
function everyPortalBody(): Record<string, string> {
  const capsPage = { facts: { EventName: NAME_AT_CAP, AgeRestrictions: BAND_AT_CAP } };
  const bodies: Record<string, string> = {};
  for (const ready of [true, false, null] as const) {
    bodies[`readiness/${ready}`] = renderSequenceLeg(
      'readiness',
      portalInput({ readinessReady: ready }),
    );
    bodies[`go unbound/${ready}`] = renderSequenceLeg('go', portalInput({ readinessReady: ready }));
    bodies[`battle_plan unbound/${ready}`] = renderSequenceLeg(
      'battle_plan',
      portalInput({ readinessReady: ready }),
    );
    bodies[`go prepared/${ready}`] = renderSequenceLeg(
      'go',
      bound(PREPARED(capsPage), { readinessReady: ready }),
    );
    bodies[`battle_plan prepared/${ready}`] = renderSequenceLeg(
      'battle_plan',
      bound(PREPARED(capsPage), { readinessReady: ready }),
    );
    // A page that reads clean but publishes no name Hale can print takes the OTHER
    // branch of `plannedCourse`, which is a whole sentence no sweep reached while the
    // fixture page always carried a name.
    bodies[`battle_plan prepared_unnamed/${ready}`] = renderSequenceLeg(
      'battle_plan',
      bound(PREPARED(), { readinessReady: ready }),
    );
    bodies[`battle_plan unreadable/${ready}`] = renderSequenceLeg(
      'battle_plan',
      bound({ kind: 'page_unreadable', reason: 'fetch_failed' }, { readinessReady: ready }),
    );
  }
  const failures: [string, PrepVerdict][] = [
    ['page_unreadable', { kind: 'page_unreadable', reason: 'fetch_failed' }],
    ['course_gone', { kind: 'course_gone' }],
    ['registration_closed', { kind: 'registration_closed', ...coursePage(capsPage) }],
    ['age_ineligible', { kind: 'age_ineligible', ...coursePage(capsPage) }],
    [
      'age_ineligible_no_band',
      { kind: 'age_ineligible', ...coursePage({ facts: { EventName: NAME_AT_CAP } }) },
    ],
    ['window_moved', { kind: 'window_moved', ...coursePage({ ...capsPage, clock: MOVED_LATER }) }],
    [
      'window_moved_next_day',
      { kind: 'window_moved', ...coursePage({ ...capsPage, clock: MOVED_NEXT_DAY }) },
    ],
    [
      'late_by_drift',
      {
        kind: 'late_by_drift',
        ...coursePage({ ...capsPage, clock: new Date('2026-09-15T13:30:00.000Z') }),
      },
    ],
  ];
  for (const [name, verdict] of failures) {
    bodies[`go ${name}`] = renderSequenceLeg('go', bound(verdict));
    bodies[`battle_plan ${name}`] = renderSequenceLeg('battle_plan', bound(verdict));
  }
  return bodies;
}

/** The one link a body carries, read back OUT of it so the sweep below needs no
 * hand-kept table of which template links where — the failure mode the gate exists to
 * catch is a template nobody has listed yet. It makes `url_missing` and
 * `unexpected_link` vacuous in that sweep on purpose; both have their own tests. */
function linkIn(body: string): string | null {
  return /https?:\/\/\S+/.exec(body)?.[0] ?? null;
}

/** Every body the ladder can send, measured against the composer's own gate. */
function gateViolations(body: string, optOut: 'full' | null = 'full'): string[] {
  return preparedCopyViolations(body, { url: linkIn(body), printed: [], backed: [], optOut });
}

describe('VIL-338 · every portal variant fits three segments at the reader’s caps', () => {
  it('holds MAX_PORTAL_SEGMENTS with the FULL CASL form on the longest registry host', () => {
    expect(MAX_PORTAL_SEGMENTS).toBe(3);
    expect(DEEP_LINK.length).toBe(288);
    const over: string[] = [];
    for (const [name, body] of Object.entries(everyPortalBody())) {
      const wire = withOptOut(body, 'full');
      if (smsEncoding(wire) !== 'gsm7' || smsSegments(wire) > MAX_PORTAL_SEGMENTS) {
        over.push(`${name}: ${smsSegments(wire)} segments, ${smsEncoding(wire)}`);
      }
    }
    expect(over).toEqual([]);
  });

  it('carries the portal’s own deep link on every go leg that has one', () => {
    // The link is the whole point of the flagship text, and it is never withheld
    // because Hale had a bad fetch — a mutation that dropped it on page_unreadable
    // would leave a parent with a sentence and nowhere to go.
    for (const name of ['prepared/true', 'prepared/false', 'prepared/null']) {
      expect(everyPortalBody()[`go ${name}`]).toContain(DEEP_LINK);
    }
    for (const name of ['page_unreadable', 'age_ineligible', 'window_moved', 'late_by_drift']) {
      expect(everyPortalBody()[`go ${name}`]).toContain(DEEP_LINK);
    }
    // A course the portal no longer serves, or one it has closed, is not a course to
    // sign in and register for: those two send the page itself.
    for (const name of ['course_gone', 'registration_closed']) {
      const body = everyPortalBody()[`go ${name}`] as string;
      expect(body).toContain(COURSE_URL);
      expect(body).not.toContain(DEEP_LINK);
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

  it('never prints the M1 row’s time on a leg the anchor scheduled', () => {
    const offenders = Object.entries(everyPortalBody())
      .filter(([, body]) => body.includes(ROW_TIME))
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it('prints the anchor’s own time on every variant that names the morning', () => {
    const bodies = everyPortalBody();
    const namesTheMorning = [
      'readiness/null',
      'battle_plan unbound/null',
      'battle_plan prepared/null',
      'battle_plan prepared_unnamed/null',
      'battle_plan unreadable/null',
      'battle_plan course_gone',
      'battle_plan registration_closed',
      'battle_plan age_ineligible',
      'go unbound/null',
      'go prepared/null',
      'go page_unreadable',
      'go course_gone',
      'go age_ineligible',
    ];
    const missing = namesTheMorning.filter(
      (name) => !(bodies[name] as string).includes(ANCHOR_TIME),
    );
    expect(missing).toEqual([]);
  });

  it('names both instants only where the page itself moved the morning', () => {
    // The two branches whose whole content is the disagreement are allowed a second
    // instant, and they say which is which; nothing else may carry two times.
    const bodies = everyPortalBody();
    expect(bodies['go window_moved']).toContain('I had 10:30 a.m. for this');
    expect(bodies['go window_moved']).toContain('11:30 a.m.');
    expect(bodies['battle_plan window_moved']).toContain('11:30 a.m.');
    expect(bodies['battle_plan window_moved']).not.toContain(ANCHOR_TIME);
  });
});

describe('VIL-338 · the forbidden sentence is unsayable', () => {
  const FORBIDDEN = /filled in|staged|held for you|ready to go/i;

  it('is absent from the copy module’s own source', () => {
    // The grep is over the SOURCE, not only the output: a template nobody has wired a
    // test for yet is exactly where one of these sentences would arrive.
    const source = readFileSync(new URL('./copy.ts', import.meta.url), 'utf8');
    const offenders = source
      .split('\n')
      .filter((line) => FORBIDDEN.test(line) && !line.includes('FORBIDDEN'));
    expect(offenders).toEqual([]);
  });

  it('is absent from every rendered output — and so is every other violation', () => {
    // A grep for the forbidden regex alone left the nine no-value failure templates
    // ungated: `UNATTRIBUTED_READINESS` lives inside `preparedCopyViolations`, which the
    // composer runs only on the bodies that print a page value, so "You are all set."
    // could be spliced into the go leg's unreadable-page sentence and no test would
    // move. The sweep now runs the gate itself, which is the same one the composer
    // uses, over every body a real send can carry.
    const offenders: [string, string[]][] = [];
    for (const [name, body] of Object.entries(everyPortalBody())) {
      const found = gateViolations(body);
      if (found.length > 0) offenders.push([name, found]);
    }
    for (const ready of [true, false]) {
      const ack = renderReadinessAck({ portal: OAKVILLE, ready, fitNotes: THREE_KIDS });
      const found = gateViolations(ack, null);
      if (found.length > 0) offenders.push([`readiness ack/${ready}`, found]);
    }
    expect(offenders).toEqual([]);
  });

  it('catches a claim spliced into a body the composer never gates — the positive control', () => {
    // The exact mutation that survived: an unattributed state asserted inside a failure
    // template, which prints no page value and therefore never reached the gate.
    const spliced = `${everyPortalBody()['go page_unreadable']} You are all set.`;
    expect(gateViolations(spliced)).toContain('unattributed_readiness');
    const claimed = `${everyPortalBody()['battle_plan course_gone']} Everything is filled in.`;
    expect(gateViolations(claimed)).toContain('forbidden_claim');
  });
});

describe('VIL-338 · readiness is always attributed to the parent who said it', () => {
  it('emits only the two "you told me" / "you have not told me" forms', () => {
    expect(readinessClause(true, 'evening')).toBe('You told me the setup is done.');
    expect(readinessClause(true, 'morning')).toBe('You told me the setup is done.');
    expect(readinessClause(false, 'evening')).toMatch(/^You have not told me the setup is done/);
    // Silence is the same state as a NO for the copy: neither is a claim that anything
    // is done, and both are the parent's, not Hale's.
    expect(readinessClause(null, 'evening')).toBe(readinessClause(false, 'evening'));
    expect(readinessClause(null, 'morning')).toBe(readinessClause(false, 'morning'));
    expect(readinessClause(false, 'morning')).not.toBe(readinessClause(false, 'evening'));
  });

  it('refuses a body that asserts the state instead of attributing it', () => {
    const ctx = { url: null, printed: [], backed: [], optOut: null } as const;
    for (const body of [
      'Your account is set for tomorrow.',
      'You are ready for tomorrow.',
      'You are all set for tomorrow.',
    ]) {
      expect(preparedCopyViolations(body, ctx)).toContain('unattributed_readiness');
    }
    // The positive control: an absence test that cannot fail open.
    expect(preparedCopyViolations(`Tomorrow. ${readinessClause(true, 'evening')}`, ctx)).toEqual(
      [],
    );
  });

  it('says which leg prints the ask, so the ledger and the copy cannot drift', () => {
    expect(printsReadinessAsk('readiness', OAKVILLE)).toBe(true);
    expect(printsReadinessAsk('battle_plan', OAKVILLE)).toBe(true);
    expect(printsReadinessAsk('go', OAKVILLE)).toBe(false);
    expect(printsReadinessAsk('heads_up', OAKVILLE)).toBe(false);
    // A town with no readable portal never prints an ask, so no ledger row of its can
    // manufacture an open question.
    expect(printsReadinessAsk('readiness', null)).toBe(false);
    expect(printsReadinessAsk('battle_plan', null)).toBe(false);
  });

  it('asks exactly once, in the imperative, on the two legs that ask', () => {
    const readiness = renderSequenceLeg('readiness', portalInput());
    expect(readiness).toContain('Reply YES when that is done, or NO if not.');
    expect(readiness).not.toContain('?');
    const plan = renderSequenceLeg('battle_plan', portalInput({ readinessReady: false }));
    expect(plan).toContain('Reply YES when it is.');
    // A parent who has answered is not asked again.
    expect(renderSequenceLeg('battle_plan', portalInput({ readinessReady: true }))).not.toContain(
      'Reply YES',
    );
  });

  it('carries the clause itself on every portal leg that has one', () => {
    // Only the deep link and the segment count were pinned on the go bodies, so a
    // template that dropped `${clause}` altogether sent a flagship text that said
    // nothing about the parent's own setup and no test moved. The clause IS the leg's
    // content for a household that has answered nothing.
    const bodies = everyPortalBody();
    const missing: string[] = [];
    const expected = (leg: string, ready: string) =>
      ready === 'true'
        ? 'You told me the setup is done.'
        : leg === 'go'
          ? 'You have not told me the setup is done - sign in now and check it.'
          : 'You have not told me the setup is done - tonight is the time. Reply YES when it is.';
    for (const leg of ['go', 'battle_plan']) {
      for (const shape of leg === 'go'
        ? ['prepared', 'unbound']
        : ['prepared', 'prepared_unnamed', 'unbound']) {
        for (const ready of ['true', 'false', 'null']) {
          const name = `${leg} ${shape}/${ready}`;
          if (!(bodies[name] as string).includes(expected(leg, ready))) missing.push(name);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('VIL-338 · the readiness checklist', () => {
  it('names the four things only the parent can do, on the portal that will ask for them', () => {
    const body = renderSequenceLeg('readiness', portalInput({ portal: MARKHAM_PORTAL }));
    expect(body).toContain('a Markham portal account');
    expect(body).toContain('added with their birthday(s)');
    expect(body).toContain('your address complete');
    expect(body).toContain('a card saved');
    // Oakville's login is the Town's own SSO, not a PerfectMind account — the label is
    // hand-written per portal for exactly this reason.
    expect(renderSequenceLeg('readiness', portalInput())).toContain('a ServiceOakville account');
  });

  it('carries the news the heads-up would have carried at this hour', () => {
    // The leg is CARVED OUT of the heads-up's tail, so a family matched three days out
    // must still learn what opens, when, and for whom.
    const body = renderSequenceLeg('readiness', portalInput());
    expect(body).toContain('Markham 2026 Fall Programs');
    expect(body).toContain('Sebastian, Genevieve and Maximilian');
    expect(body).toContain('10:30 a.m.');
  });

  it('runs on the bound anchor, not the M1 row’s morning', () => {
    // The whole reason a bind stores the page's clock: a Thornhill household's Markham
    // morning is the public date, a day after the row's.
    const nextDay = renderSequenceLeg('readiness', portalInput({ anchor: MOVED_NEXT_DAY }));
    expect(nextDay).toContain('Sep 16');
    expect(renderSequenceLeg('readiness', portalInput())).toContain('Sep 15');
  });

  it('falls back to the heads-up where there is no portal to name', () => {
    // dueLeg never routes a portal-less sequence here, but a renderer that threw or
    // named an undefined portal would take the family's whole tick with it.
    expect(renderSequenceLeg('readiness', LEG_INPUT)).toBe(
      renderSequenceLeg('heads_up', LEG_INPUT),
    );
  });
});

describe('VIL-338 · each failure verdict has its own true sentence', () => {
  const bodies = everyPortalBody();

  it('says the course is gone only where the portal said so', () => {
    expect(bodies['go course_gone']).toContain('is not showing the course you sent me');
    expect(bodies['battle_plan course_gone']).toContain('is gone from');
  });

  it('says registration is closed without claiming anything changed on Hale’s side', () => {
    expect(bodies['go registration_closed']).toContain('closed to online registration');
    expect(bodies['go registration_closed']).toContain('Nothing changed on my side');
    expect(bodies['battle_plan registration_closed']).toContain('shows registration closed');
  });

  it('says only that it could not read the page — never anything about the course', () => {
    const body = bodies['go page_unreadable'] as string;
    expect(body).toContain('I could not read');
    expect(body).toContain('I cannot tell you what it says');
    // The false-safe property: an unreadable page says NOTHING about the class, so the
    // sentence may not carry a name, a band, a price or a seat count.
    expect(body).not.toContain(NAME_AT_CAP);
    expect(body).not.toContain(BAND_AT_CAP);
    expect(bodies['battle_plan page_unreadable']).toContain('could not re-read the course page');
  });

  it('names the page’s own band when it has one, and never invents one when it does not', () => {
    expect(bodies['go age_ineligible']).toContain(`ages ${BAND_AT_CAP}`);
    expect(bodies['go age_ineligible']).toContain('outside');
    const noBand = bodies['go age_ineligible_no_band'] as string;
    expect(noBand).toContain('outside the age band');
    expect(noBand).not.toContain('ages y');
  });

  it('names both instants when the page has moved, and never says "opens" after the open', () => {
    const moved = bodies['go window_moved'] as string;
    expect(moved).toContain('10:30 a.m.');
    expect(moved).toContain('11:30 a.m.');
    const late = bodies['go late_by_drift'] as string;
    expect(late).toContain('now shows this opened at');
    expect(late).not.toContain('opens');
  });

  it('moves the morning in the plan when the page moved it to another day', () => {
    const nextDay = bodies['battle_plan window_moved_next_day'] as string;
    expect(nextDay).toContain('That is not tomorrow');
    expect(nextDay).toContain('Sep 16');
    // A move INSIDE tomorrow is not news — the anchor was refreshed and the plan simply
    // prints the new time, which is true now.
    const sameDay = bodies['battle_plan window_moved'] as string;
    expect(sameDay).toContain('Tomorrow:');
    expect(sameDay).toContain('11:30 a.m.');
  });
});

describe('VIL-338 · preparedCopyViolations, the composer’s own self-gate', () => {
  const base = { url: COURSE_URL, printed: [], backed: [], optOut: 'full' } as const;

  it('refuses a body that lost its link', () => {
    expect(preparedCopyViolations('Opens at 6:30 a.m.', base)).toContain('url_missing');
    expect(preparedCopyViolations(`Opens. ${COURSE_URL}`, base)).not.toContain('url_missing');
  });

  it('refuses a page string the bytes did not back, and passes one they did', () => {
    // The positive control is an ampersand name: PerfectMind serialises `&` as its JSON
    // escape, so a backing rule written over `JSON.stringify` would refuse a name the
    // page really carries and this control would fail.
    const backed = ['Parent & Tot'];
    expect(
      preparedCopyViolations(`Parent & Tot. ${COURSE_URL}`, { ...base, printed: backed, backed }),
    ).toEqual([]);
    expect(
      preparedCopyViolations(`Parent & Tots. ${COURSE_URL}`, {
        ...base,
        printed: ['Parent & Tots'],
        backed,
      }),
    ).toContain('unbacked_value');
  });

  it('refuses a question mark outside the link, and never reads the link’s own', () => {
    expect(preparedCopyViolations(`Want the link? ${COURSE_URL}`, base)).toContain(
      'asks_a_question',
    );
    // The sanitized URL carries `?widgetId=` — subtracting it is what makes the rule
    // about Hale's sentence rather than about the portal's query string.
    expect(preparedCopyViolations(`Your link. ${COURSE_URL}`, base)).not.toContain(
      'asks_a_question',
    );
  });

  it('refuses a forbidden claim, a non-GSM-7 character and a fourth segment', () => {
    expect(preparedCopyViolations(`Everything is filled in. ${COURSE_URL}`, base)).toContain(
      'forbidden_claim',
    );
    expect(preparedCopyViolations(`Opens — now. ${COURSE_URL}`, base)).toContain('not_gsm7');
    expect(preparedCopyViolations(`${'a'.repeat(300)} ${COURSE_URL}`, base)).toContain(
      'too_many_segments',
    );
  });

  it('measures a solicited reply without a CASL footer it will never carry', () => {
    const solicited = { url: null, printed: [], backed: [], optOut: null } as const;
    const body = 'a'.repeat(455);
    expect(preparedCopyViolations(body, solicited)).toEqual([]);
    expect(preparedCopyViolations(body, { ...solicited, optOut: 'full' })).toContain(
      'too_many_segments',
    );
    // A solicited reply carries no link at all, so one appearing in it is a link the
    // parent never asked for.
    expect(preparedCopyViolations(`Noted. ${COURSE_URL}`, solicited)).toContain('unexpected_link');
  });
});

describe('VIL-338 · the course bind ack', () => {
  const CLOCK = { at: ANCHOR, name: 'public date' as const };
  const ackInput = (over: Partial<Parameters<typeof renderCourseBindAck>[0]> = {}) => ({
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

  it('states precisely what it read, and nothing it did not', () => {
    const body = renderCourseBindAck(ackInput());
    expect(body).toContain("Oakville's portal: Preschool Sports and Games, Wednesday 10:30 AM.");
    expect(body).toContain('$280.60 / $290.60 non-resident');
    expect(body).toContain('Course 00028147');
    expect(body).toContain('Opens Sep 15, 10:30 a.m.');
    expect(body).toContain('public date');
    expect(body).not.toContain('Swapped');
    expect(smsEncoding(body)).toBe('gsm7');
    expect(smsSegments(body)).toBeLessThanOrEqual(MAX_PORTAL_SEGMENTS);
  });

  it('drops a clause whose value the bytes did not back, rather than printing it', () => {
    const body = renderCourseBindAck(
      ackInput({
        page: coursePage({
          facts: { EventName: 'Preschool Sports and Games', CourseId: '00028147' },
          backed: ['00028147'],
        }),
      }),
    );
    expect(body).toContain('Course 00028147');
    expect(body).not.toContain('Preschool Sports and Games');
    expect(body).toContain('that course');
  });

  it('says the M1 row disagreed rather than silently correcting it', () => {
    const body = renderCourseBindAck(
      ackInput({ opensForFamilyAt: new Date('2026-09-14T14:30:00.000Z'), municipality: 'markham' }),
    );
    expect(body).toContain('My Markham dates said Sep 14');
    expect(body).toContain('I am going by the page');
    // Inside the tolerance there is no disagreement to report.
    expect(renderCourseBindAck(ackInput())).not.toContain('going by the page');
  });

  it('warns about the two things a parent cannot pre-do', () => {
    const body = renderCourseBindAck(
      ackInput({
        page: coursePage({
          facts: { EventName: 'Swim', RegFormId: 'form-1', PrerequisiteEvents: true },
        }),
      }),
    );
    expect(body).toContain('a form I cannot see');
    expect(body).toContain('a prerequisite level');
    expect(renderCourseBindAck(ackInput())).not.toContain('a form I cannot see');
  });

  it('keeps a 13+ child nameless in the fit phrase — rule #1', () => {
    const body = renderCourseBindAck(
      ackInput({
        page: {
          ...coursePage({ facts: { EventName: 'Swim', AgeRestrictions: '13 to 16 y 11m' } }),
          age: { fit: 'outside_band', outsideBandChildIds: ['c1'] },
        },
        fitNotes: [{ childId: 'c1', name: null, fit: 'in_band' }],
      }),
    );
    expect(body).toContain('your teen is outside that on the birthday I hold');
    expect(body).not.toContain('null');
  });

  it('holds three segments at the reader’s caps by dropping the two clauses a parent can read for themselves', () => {
    const body = renderCourseBindAck(
      ackInput({
        replaced: true,
        opensForFamilyAt: new Date('2026-09-14T14:30:00.000Z'),
        page: {
          ...coursePage({
            facts: {
              EventName: NAME_AT_CAP,
              CourseId: BARCODE_AT_CAP,
              StartDay: DAY_AT_CAP,
              StartTime: TIME_AT_CAP,
              AgeRestrictions: BAND_AT_CAP,
              RegFormId: 'f',
              PrerequisiteEvents: true,
              Prices: [
                { Name: 'Fee', DisplayAmount: PRICE_AT_CAP },
                { Name: 'Fee Non-Resident', DisplayAmount: PRICE_AT_CAP_2 },
              ],
            },
          }),
          age: { fit: 'outside_band', outsideBandChildIds: ['c1'] },
        },
        fitNotes: THREE_KIDS,
      }),
    );
    expect(smsSegments(body)).toBeLessThanOrEqual(MAX_PORTAL_SEGMENTS);
    // What survives is what the parent cannot get any other way: the identity, the
    // clock, the disagreement and the two warnings.
    expect(body).toContain('Swapped.');
    expect(body).toContain(NAME_AT_CAP);
    expect(body).toContain('going by the page');
    expect(body).toContain('leave time');
    expect(body).not.toContain(BARCODE_AT_CAP);
    expect(body).not.toContain(PRICE_AT_CAP);
  });

  it('agrees its verb with the number of birthdays it holds', () => {
    const banded = (fit: 'in_band' | 'outside_band', fitNotes: readonly FitNote[]) =>
      renderCourseBindAck(
        ackInput({
          page: {
            ...coursePage({ facts: { AgeRestrictions: '3 to 5' } }),
            age: { fit, outsideBandChildIds: [] },
          },
          fitNotes,
        }),
      );
    const one = [{ childId: 'c1', name: 'Maya', fit: 'in_band' as const }];
    expect(banded('in_band', one)).toContain('Maya fits on the birthday I hold');
    expect(banded('outside_band', one)).toContain('Maya is outside that on the birthday I hold');
    expect(banded('in_band', THREE_KIDS)).toContain(
      'Sebastian, Genevieve and Maximilian fit on the birthdays I hold',
    );
    expect(banded('outside_band', THREE_KIDS)).toContain(
      'Sebastian, Genevieve and Maximilian are outside that on the birthdays I hold',
    );
  });

  it('keeps the trimmed form honest even where it cannot keep it short', () => {
    // The trimmed ack is returned UNGATED — it is the last form there is, and a fourth
    // segment on a solicited reply is a cost rather than a lie. The bound is measured
    // here rather than assumed: at every cap, five named children and both warnings,
    // the only thing the gate may still object to is the length.
    const body = renderCourseBindAck(
      ackInput({
        replaced: true,
        opensForFamilyAt: new Date('2026-09-14T14:30:00.000Z'),
        page: {
          ...coursePage({
            facts: {
              EventName: NAME_AT_CAP,
              CourseId: BARCODE_AT_CAP,
              StartDay: DAY_AT_CAP,
              StartTime: TIME_AT_CAP,
              AgeRestrictions: BAND_AT_CAP,
              RegFormId: 'f',
              PrerequisiteEvents: true,
              Prices: [
                { Name: 'Fee', DisplayAmount: PRICE_AT_CAP },
                { Name: 'Fee Non-Resident', DisplayAmount: PRICE_AT_CAP_2 },
              ],
            },
          }),
          age: { fit: 'outside_band', outsideBandChildIds: [] },
          // A household on the public clock in a town that publishes a residents-first
          // date gets the one extra sub-clause the ack can carry.
          clocks: {
            residents: new Date('2026-09-08T14:30:00.000Z'),
            members: null,
            public: ANCHOR,
            start: null,
          },
        },
        fitNotes: [
          ...THREE_KIDS,
          { childId: 'c4', name: 'Alexandria', fit: 'in_band' },
          { childId: 'c5', name: 'Bartholomew', fit: 'in_band' },
        ],
      }),
    );
    expect(gateViolations(body, null).filter((v) => v !== 'too_many_segments')).toEqual([]);
    expect(smsSegments(body)).toBe(4);
  });
});

describe('VIL-338 · the readiness answer ack', () => {
  it('attributes a YES and does not re-ask on a NO', () => {
    const yes = renderReadinessAck({ portal: OAKVILLE, ready: true, fitNotes: THREE_KIDS });
    expect(yes).toBe("Noted - you told me the setup on Oakville's portal is done.");
    const no = renderReadinessAck({ portal: OAKVILLE, ready: false, fitNotes: THREE_KIDS });
    expect(no).toContain('a ServiceOakville account');
    expect(no).toContain('I will ask again the evening before');
    // The NO ack closes the question until the battle plan re-asks: a 'yes' two days
    // later, after unrelated coach traffic, must never be filed here.
    expect(no).not.toContain('Reply YES');
    for (const body of [yes, no]) {
      expect(smsEncoding(body)).toBe('gsm7');
      expect(smsSegments(body)).toBeLessThanOrEqual(MAX_PORTAL_SEGMENTS);
    }
  });
});

/**
 * THE INERTNESS PROOF. These are the exact bytes `origin/main` renders, captured before
 * a line of VIL-338 was written. Thirteen of the fifteen municipalities in the M1
 * dataset have no portal Hale can read, and this ticket must be invisible to every one
 * of them — including the double period at "6:30 a.m..", which is a pre-existing
 * cosmetic defect and is deliberately NOT fixed here.
 */
describe('VIL-338 · a non-portal municipality renders byte-identically to today', () => {
  const TODAY = {
    heads_up:
      "Richmond Hill Fall 2026 recreation programs registration opens Sep 15, 6:30 a.m. for Max. I'll send your plan the evening before.",
    battle_plan: `Tomorrow: Richmond Hill Fall 2026 recreation programs opens 6:30 a.m. for Max. Sign in tonight and have this open: ${LONGEST_URL}`,
    go: `Richmond Hill Fall 2026 recreation programs opens 6:30 a.m.. Your link: ${LONGEST_URL}`,
    check_in:
      'How did Richmond Hill Fall 2026 recreation programs go? Reply "got in", "waitlisted #12" or "missed it".',
  } as const;

  it.each(Object.entries(TODAY))('renders %s exactly as it did before', (leg, expected) => {
    const body = renderSequenceLeg(leg as keyof typeof TODAY, LEG_INPUT);
    expect(body).toBe(expected);
    expect(smsSegments(withOptOut(body, 'full'))).toBeLessThanOrEqual(MAX_NUDGE_SEGMENTS);
  });

  it('renders today’s bytes for a caller that has not wired a portal yet', () => {
    // Same asymmetry as schedule.ts: an absent portal renders the sentence that
    // shipped, rather than reaching into a portal label nobody looked up.
    const unwired = { ...LEG_INPUT, portal: undefined } as unknown as LegCopyInput;
    expect(renderSequenceLeg('go', unwired)).toBe(TODAY.go);
    expect(renderSequenceLeg('battle_plan', unwired)).toBe(TODAY.battle_plan);
    expect(renderSequenceLeg('readiness', unwired)).toBe(TODAY.heads_up);
    // Same for the thing being consented to: an unwired caller must not enumerate a
    // fourth text nobody wired the leg for.
    expect(renderShortlistRationale(shortlist(), TZ, NOW, undefined as unknown as null)).toContain(
      'Approving this asks me to text you a week ahead, the evening before, and 15 minutes before it opens.',
    );
  });

  it('renders the pending household’s heads-up exactly as it did before', () => {
    expect(renderSequenceLeg('heads_up', { ...LEG_INPUT, optIn: 'pending' })).toBe(
      "Richmond Hill Fall 2026 recreation programs registration opens Sep 15, 6:30 a.m. for Max. Reply YES and I'll run the morning with you.",
    );
  });

  it('states the three texts a non-portal approval consents to, verbatim', () => {
    expect(renderShortlistRationale(shortlist(), TZ, NOW, null)).toBe(
      `Richmond Hill Fall 2026 recreation programs registration opens Sep 15, 6:30 a.m..\nRegister here: ${LONGEST_URL}\nMax is inside the published age band.\nApproving this asks me to text you a week ahead, the evening before, and 15 minutes before it opens. I never register for you.`,
    );
  });

  it('states the FOUR texts a portal approval consents to, and how to send the link', () => {
    const text = renderShortlistRationale(shortlist(), TZ, NOW, OAKVILLE);
    expect(text).toContain(
      'Approving this asks me to text you a week ahead, a checklist a few days out, the evening before, and 15 minutes before it opens. I never register for you.',
    );
    expect(text).toContain(
      'If you send me the link to the course page once you have picked one, the morning text will carry it.',
    );
  });

  it('keeps "I never register for you" verbatim on both surfaces', () => {
    // Asserted in the toddler journey and mirrored in the capability table's CANNOT
    // row. The whole ladder's honesty rests on this sentence staying true.
    for (const portal of [null, OAKVILLE]) {
      expect(renderShortlistRationale(shortlist(), TZ, NOW, portal)).toContain(
        'I never register for you.',
      );
    }
  });
});
