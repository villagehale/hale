import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fragment, readCourseModel, readSpot } from '~/lib/channel/spots/availability';
import { sanitizeSpotUrl } from '~/lib/channel/spots/url';
import {
  ASSUMED_MAX_AGE_MONTHS_COMPONENT,
  BIND_FETCH_TIMEOUT_MS,
  type CourseFacts,
  GO_FETCH_TIMEOUT_MS,
  MAX_BIND_DRIFT_DAYS,
  type PrepChild,
  type PrepContext,
  READ_WALL_BUDGET_MS,
  WINDOW_DRIFT_TOLERANCE_MINUTES,
  ageEligibility,
  applicableClock,
  courseClocks,
  courseFactsSchema,
  courseSignInUrl,
  driftMinutes,
  isBookMe4ErrorPage,
  priceClause,
  rawStringValue,
  readCourseFacts,
  readCoursePrep,
} from './prepare';

/**
 * VIL-338 · the reader and the verdict, against the bytes seven PerfectMind pages
 * actually served.
 *
 * THE BUG THESE CASES EXIST TO PREVENT is a text on the wrong morning. Every
 * expectation below is transcribed from a fixture's own model or from a published
 * municipal rule — never from what the reader currently returns — because the whole
 * value of this module is that it disagrees with the M1 registration_windows row when
 * the page disagrees with it, and a test fitted to the code could not tell the two
 * apart.
 *
 * ONE MODEL IS HYPOTHETICAL AND SAYS SO. No saved page shows a course whose
 * registration has not yet opened (none was postable at capture time), so that shape is
 * a real open-window model with named overrides and every test that uses it carries
 * ASSUMPTION in its name.
 */

const FIXTURES = join(__dirname, '..', '..', 'channel', 'spots', 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.html`), 'utf8');
}

const TZ = 'America/Toronto';

/** Course GUIDs, read off each fixture's own `EventId`. */
const LEGO = '961140fe-0866-460f-9973-7c42cbe0a928';
const CHESS = '85770d4d-bce9-4e53-b969-cf7e88775180';
const OAKVILLE = '16765c8e-835f-4ba6-9803-bbc84bd5ff8f';
const NEWMARKET = '5f397fce-9475-4fcf-96d5-8769645f06b3';
const NVRC = 'e1533a1c-30bf-4ef2-8765-3e123ec964db';
const MARKHAM = '4241ad2f-9b67-464f-9f19-ad5f46d4a92d';

/** Every saved page that carries a model, with the course it was fetched for. */
const MODEL_PAGES = [
  ['open-window-open-markham', LEGO],
  ['open-window-markham', CHESS],
  ['oakville-course', OAKVILLE],
  ['newmarket-course', NEWMARKET],
  ['nvrc-course', NVRC],
  ['markham-course', MARKHAM],
] as const;

function readingOf(name: string, courseId: string) {
  const read = readCourseModel(fixture(name), courseId);
  if (!read.ok) throw new Error(`${name}: expected a model, got ${read.reason}`);
  return read;
}

function modelOf(name: string, courseId: string) {
  return readingOf(name, courseId).model;
}

/** The bytes the model was parsed out of — what `readCourseFacts` checks against, and
 * what the tampering cases below edit, because the page is not what it reads. */
function blobOf(name: string, courseId: string): string {
  return readingOf(name, courseId).blob;
}

function factsOf(name: string, courseId: string): CourseFacts {
  const read = readingOf(name, courseId);
  return readCourseFacts(read.model, read.blob).facts;
}

/** The variant harness. The PAGE shape is the real one; the model is a real model with
 * NAMED overrides, so only the override is ever hypothetical. */
function pageWith(model: Record<string, unknown>): string {
  return `<html><body><script>\r\n  var eventInfo = $.extend(true, {}, {\r\n    BackAction: { Url: '/Clients/BookMe4' }\r\n  }, ${JSON.stringify(model)});\r\n</script></body></html>`;
}

function variantOf(name: string, courseId: string, overrides: Record<string, unknown>): string {
  return pageWith({ ...modelOf(name, courseId), ...overrides });
}

const legoUrl =
  'https://cityofmarkham.perfectmind.com/Clients/BookMe4LandingPages/CoursesLandingPage?widgetId=bfd08479-60d6-43d9-b586-5b4c8305a003&courseId=961140fe-0866-460f-9973-7c42cbe0a928';
const oakvilleUrl =
  'https://townofoakville.perfectmind.com/Contacts/BookMe4LandingPages/CoursesLandingPage?widgetId=15f6af07-39c5-473e-b053-96653f77a406&courseId=16765c8e-835f-4ba6-9803-bbc84bd5ff8f';

/** The sign-in link the page itself serves, with its lower-case percent escapes raised
 * to the upper case WHATWG emits — the POSITIVE CONTROL for the rebuilt link, so
 * `courseSignInUrl` is checked against the portal's own anchor and not against itself. */
function pageOwnSignInPath(name: string, segment: string): string {
  const match = fixture(name).match(
    new RegExp(`href="(/${segment}/MemberRegistration/MemberSignIn\\?returnUrl=[^"]+)"`),
  );
  const path = match?.[1];
  if (path === undefined) throw new Error(`${name}: no sign-in anchor on the saved page`);
  return path.replace(/%[0-9a-f]{2}/g, (hex) => hex.toUpperCase());
}

function child(dateOfBirth: string, dobPrecision = 'exact', id = 'c1'): PrepChild {
  return { id, dateOfBirth, dobPrecision };
}

function ctx(overrides: Partial<PrepContext> = {}): PrepContext {
  return {
    now: new Date('2026-08-11T10:15:00Z'),
    courseId: LEGO,
    timeZone: TZ,
    isResidentWindow: true,
    anchor: new Date('2026-08-11T10:30:00Z'),
    children: [],
    readinessReady: null,
    ...overrides,
  };
}

/**
 * The six numbers the brief fixes. Four of them are read only by later workstreams (the
 * bind's drift refusal, the two fetch budgets, the sweep's wall budget), so without this
 * they can be edited to anything and every test in this file still passes.
 */
it('pins the budgets and tolerances the ladder is specified in', () => {
  expect({
    WINDOW_DRIFT_TOLERANCE_MINUTES,
    MAX_BIND_DRIFT_DAYS,
    BIND_FETCH_TIMEOUT_MS,
    GO_FETCH_TIMEOUT_MS,
    READ_WALL_BUDGET_MS,
    ASSUMED_MAX_AGE_MONTHS_COMPONENT,
  }).toEqual({
    WINDOW_DRIFT_TOLERANCE_MINUTES: 15,
    MAX_BIND_DRIFT_DAYS: 7,
    BIND_FETCH_TIMEOUT_MS: 6_000,
    GO_FETCH_TIMEOUT_MS: 6_000,
    READ_WALL_BUDGET_MS: 60_000,
    ASSUMED_MAX_AGE_MONTHS_COMPONENT: 11,
  });
});

describe('the applicable clock', () => {
  /**
   * THE ANCHOR TEST. Markham's shipped M1 row (registration-windows-data.ts) carries
   * ONE instant — 2026-08-11T06:30-04:00, with residentOpenAt null — while the very
   * page a parent would paste publishes residents Aug 11 06:30 AND public Aug 12 06:30.
   * A Thornhill household sits in an FSA that resolves to two municipalities, so
   * resolveFamilyOpen gives it isResidentWindow false: its morning is Aug 12, and a
   * ladder anchored on the row would text it a day early.
   */
  it('gives a resident household the page’s residents-first clock', () => {
    const clocks = courseClocks(factsOf('open-window-open-markham', LEGO), TZ);

    expect(applicableClock(clocks, true)).toEqual({
      at: new Date('2026-08-11T06:30:00-04:00'),
      name: 'residents-first date',
    });
  });

  it('gives a two-municipality (Thornhill) household the public clock, a day later', () => {
    const clocks = courseClocks(factsOf('open-window-open-markham', LEGO), TZ);
    const markhamRowOpensAt = new Date('2026-08-11T06:30:00-04:00');

    const applicable = applicableClock(clocks, false);

    expect(applicable).toEqual({
      at: new Date('2026-08-12T06:30:00-04:00'),
      name: 'public date',
    });
    expect(applicable === null ? null : driftMinutes(markhamRowOpensAt, applicable.at)).toBe(1440);
  });

  it("falls back to the public clock when a tenant publishes no residents' date", () => {
    const noResidents = courseClocks(
      { ...factsOf('open-window-open-markham', LEGO), ResidentsRegistrationDateValue: null },
      TZ,
    );

    expect(applicableClock(noResidents, true)).toEqual({
      at: new Date('2026-08-12T06:30:00-04:00'),
      name: 'public date',
    });
  });

  /**
   * Oakville's M1 non-resident row is a DATE-ONLY source: the Town publishes no
   * non-resident time, so the row holds the start of that local day. The page holds
   * 07:00. Seven hours of drift is the difference between a text at 06:45 and one at
   * 23:45 the night before.
   */
  it('measures the Oakville midnight placeholder against the page’s own 07:00', () => {
    const clocks = courseClocks(factsOf('oakville-course', OAKVILLE), TZ);
    const startOfLocalDay = new Date('2023-08-30T00:00:00-04:00');

    const applicable = applicableClock(clocks, false);

    expect(applicable?.at).toEqual(new Date('2023-08-30T07:00:00-04:00'));
    expect(applicable === null ? null : driftMinutes(startOfLocalDay, applicable.at)).toBe(420);
  });

  it("reads Oakville's published 14-day resident head start off the page", () => {
    const clocks = courseClocks(factsOf('oakville-course', OAKVILLE), TZ);

    expect(clocks.residents).toEqual(new Date('2023-08-16T07:00:00-04:00'));
    expect(driftMinutes(clocks.residents as Date, clocks.public as Date)).toBe(14 * 24 * 60);
  });

  it('reads members-first equal to public on every saved page, so no tenant leads with it', () => {
    for (const [name, courseId] of MODEL_PAGES) {
      const clocks = courseClocks(factsOf(name, courseId), TZ);
      expect([name, clocks.members?.toISOString()]).toEqual([name, clocks.public?.toISOString()]);
    }
  });

  it('refuses a datetime it cannot read exactly, and never guesses one', () => {
    const base = factsOf('open-window-open-markham', LEGO);
    const cases = [
      '24/02/2026',
      '',
      '2026-08-11',
      '2026-08-11T06:30:00-04:00',
      '2026-02-30T06:30:00',
      '2026-13-01T06:30:00',
      '2026-08-11T06:30:45',
    ];

    for (const value of cases) {
      const clocks = courseClocks({ ...base, PublicRegistrationStartDateValue: value }, TZ);
      expect([value, clocks.public]).toEqual([value, null]);
    }
    // Positive control: the real value on the same field still parses.
    expect(courseClocks(base, TZ).public).toEqual(new Date('2026-08-12T06:30:00-04:00'));
  });

  it('reads a naive datetime in the portal’s zone across the March change', () => {
    const base = factsOf('open-window-open-markham', LEGO);

    const winter = courseClocks(
      { ...base, PublicRegistrationStartDateValue: '2027-03-13T06:30:00' },
      TZ,
    );
    const summer = courseClocks(
      { ...base, PublicRegistrationStartDateValue: '2027-03-15T06:30:00' },
      TZ,
    );

    expect(winter.public?.toISOString()).toBe('2027-03-13T11:30:00.000Z');
    expect(summer.public?.toISOString()).toBe('2027-03-15T10:30:00.000Z');
  });
});

describe('byte-backing', () => {
  /**
   * PerfectMind serialises `&` as the JSON escape `\u0026` (measured on a saved
   * PerfectMind showcase page whose EventName is "... (Parks & Rec, ...)"), so
   * JSON.stringify of the PARSED value is not findable in the bytes it came from and
   * 337's `fragment` would refuse a name the page really carries. The raw token is.
   */
  it('backs a string through its raw token, so an escaped ampersand round-trips', () => {
    const escaped = variantOf('open-window-open-markham', LEGO, {
      EventName: 'Parent & Tot',
    }).replace('"EventName":"Parent & Tot"', '"EventName":"Parent \\u0026 Tot"');
    const read = readCourseModel(escaped, LEGO);
    if (!read.ok) throw new Error(`expected a model, got ${read.reason}`);

    // THE PINNED REASON: 337's `fragment` re-serialises the PARSED value, and those
    // bytes are not on the page — so a name with an ampersand would be refused.
    expect(read.model.EventName).toBe('Parent & Tot');
    expect(escaped.includes(fragment('EventName', 'Parent & Tot'))).toBe(false);
    expect(rawStringValue(escaped, 'EventName')).toBe('Parent & Tot');

    const facts = readCourseFacts(read.model, read.blob);

    expect(facts.facts.EventName).toBe('Parent & Tot');
    expect(facts.backed).toContain('Parent & Tot');
  });

  it('drops a string the bytes do not carry, and never lists it as backed', () => {
    const tampered = blobOf('open-window-open-markham', LEGO).replace(
      '"EventName":"LEGO: Preschool"',
      '"EventName":"LEGO: Preschool "',
    );
    const model = { ...modelOf('open-window-open-markham', LEGO), EventName: 'LEGO: Preschool' };

    const read = readCourseFacts(model, tampered);

    expect(read.facts.EventName).toBeNull();
    expect(read.backed).not.toContain('LEGO: Preschool');
    // Positive control on the untampered bytes.
    const clean = readCourseFacts(model, blobOf('open-window-open-markham', LEGO));
    expect(clean.facts.EventName).toBe('LEGO: Preschool');
    expect(clean.backed).toContain('LEGO: Preschool');
  });

  it('lists exactly the page strings a sentence may print', () => {
    const read = readCourseFacts(
      modelOf('open-window-open-markham', LEGO),
      blobOf('open-window-open-markham', LEGO),
    );

    expect([...read.backed].sort()).toEqual(
      ['$121.16', '$139.36', '10:15 AM', '344301', '4 to 6', 'LEGO: Preschool', 'Sunday'].sort(),
    );
  });

  /** The precondition a whole-body token search rests on: one answer per key. */
  it('finds each backed key exactly once in every saved page', () => {
    const keys = [
      'EventName',
      'CourseId',
      'StartDay',
      'StartTime',
      'StartDateValue',
      'AgeRestrictions',
      'PublicRegistrationStartDateValue',
      'ResidentsRegistrationDateValue',
      'MembersRegistrationDateValue',
    ];

    for (const [name] of MODEL_PAGES) {
      const raw = fixture(name);
      for (const key of keys) {
        expect([name, key, raw.split(`"${key}":"`).length - 1]).toEqual([name, key, 1]);
      }
    }
  });

  /** Why numbers and booleans keep `fragment` instead of a token round-trip. */
  it('serialises every numeric and boolean field exactly as the page did', () => {
    for (const [name, courseId] of MODEL_PAGES) {
      const raw = fixture(name);
      const model = modelOf(name, courseId) as Record<string, unknown>;
      for (const key of [
        'MinAge',
        'MaxAge',
        'MinAgeMonths',
        'MaxAgeMonths',
        'PrerequisiteEvents',
      ]) {
        expect([name, key, raw.includes(`"${key}":${JSON.stringify(model[key])}`)]).toEqual([
          name,
          key,
          true,
        ]);
      }
    }
  });

  it('drops a price row whose bytes are not on the page, and keeps the ones that are', () => {
    const model = modelOf('open-window-open-markham', LEGO) as Record<string, unknown>;
    const prices = model.Prices as { Name: string; DisplayAmount: string }[];

    const read = readCourseFacts(
      { ...model, Prices: [...prices, { Name: 'Invented Fee', DisplayAmount: '$1.00' }] } as never,
      blobOf('open-window-open-markham', LEGO),
    );

    expect(read.facts.Prices?.map((row) => row.DisplayAmount)).toEqual(['$139.36', '$121.16']);
    expect(read.backed).not.toContain('$1.00');
  });
});

describe('the age band', () => {
  /**
   * AgeRule / AgeRuleSpecificDate are NEVER read. Every saved page carries AgeRule 1
   * beside a rule date years before the course — 2021-07-09 on a class that starts
   * 2026-09-27 — so "age as of the rule date" would make every child alive ineligible.
   */
  it('is not the AgeRule the page prints a stale date for', () => {
    const facts = factsOf('open-window-open-markham', LEGO);
    const at = { now: new Date('2026-08-11T10:15:00Z'), timeZone: TZ };
    const five = child('2021-08-01');

    expect(ageEligibility(facts, five, at)).toBe('in_band');
    expect(
      ageEligibility(
        { ...facts, AgeRule: 7, AgeRuleSpecificDate: '1999-01-01T00:00:00' } as never,
        five,
        at,
      ),
    ).toBe('in_band');
  });

  it('does not pick either rule field into the schema at all', () => {
    const keys = Object.keys(courseFactsSchema.shape);

    expect(keys).not.toContain('AgeRule');
    expect(keys).not.toContain('AgeRuleSpecificDate');
    // Positive control: the fields the band DOES rest on are picked.
    expect(keys).toEqual(
      expect.arrayContaining(['MinAge', 'MaxAge', 'MinAgeMonths', 'MaxAgeMonths']),
    );
  });

  /**
   * Newmarket publishes "13 to 16 y 11m" as MaxAge 16 + MaxAgeMonths 11 — a months
   * COMPONENT of the year, so the band is 156..203 months. A total-months reading
   * (11, or 16*12 ignoring the component) puts every teen outside it.
   */
  it('reads the months field as a component of the year, not a total', () => {
    const facts = factsOf('newmarket-course', NEWMARKET);
    const at = { now: new Date('2026-03-01T12:00:00Z'), timeZone: TZ };

    expect(facts.AgeRestrictions).toBe('13 to 16 y 11m');
    // 190 months on 2026-03-01, 199 on 2026-12-31: inside at all three instants.
    expect(ageEligibility(facts, child('2010-05-01'), at)).toBe('in_band');
    // 204 months on 2026-03-01 and later: outside at all three.
    expect(ageEligibility(facts, child('2009-03-01'), at)).toBe('outside_band');
    // 154 months on 2026-12-31: outside at all three.
    expect(ageEligibility(facts, child('2014-02-01'), at)).toBe('outside_band');
  });

  it('takes the lower bound as the year plus zero, not the year plus eleven', () => {
    const facts = factsOf('newmarket-course', NEWMARKET);
    const at = { now: new Date('2026-03-01T12:00:00Z'), timeZone: TZ };

    // 156 months exactly on 2026-03-01, 165 on 2026-12-31 — in band throughout only if
    // an absent MinAgeMonths means zero.
    expect(ageEligibility(facts, child('2013-03-01'), at)).toBe('in_band');
  });

  /**
   * The three instants are today, the first class, and Dec 31 of the course-start
   * year — Oakville's own published rule for ages 6+. A child who straddles the band
   * at ANY of them prints nothing.
   */
  it('is unknown for a child who ages out between today and the first class', () => {
    const facts = factsOf('open-window-open-markham', LEGO);
    const at = { now: new Date('2026-08-11T10:15:00Z'), timeZone: TZ };

    expect(facts.AgeRestrictions).toBe('4 to 6');
    expect(facts.StartDateValue).toBe('2026-09-27T10:15:00');
    // 82 months (6y10m) on 2026-08-11, 84 on 2026-09-27.
    expect(ageEligibility(facts, child('2019-09-15'), at)).toBe('unknown');
  });

  it('is unknown for a child who ages out between the first class and Dec 31', () => {
    const facts = factsOf('open-window-open-markham', LEGO);
    const at = { now: new Date('2026-08-11T10:15:00Z'), timeZone: TZ };

    // 82 months on 2026-09-27, 85 on 2026-12-31 — inside at two instants, outside the third.
    expect(ageEligibility(facts, child('2019-11-20'), at)).toBe('unknown');
  });

  it('never decides a band on a birthday Hale derived from a spoken age', () => {
    const facts = factsOf('open-window-open-markham', LEGO);
    const at = { now: new Date('2026-08-11T10:15:00Z'), timeZone: TZ };

    expect(ageEligibility(facts, child('2021-08-01', 'exact'), at)).toBe('in_band');
    expect(ageEligibility(facts, child('2021-08-01', 'derived'), at)).toBe('unknown');
  });

  it('is unknown where the page publishes no band, and open-ended where it publishes one end', () => {
    const facts = factsOf('open-window-open-markham', LEGO);
    const at = { now: new Date('2026-08-11T10:15:00Z'), timeZone: TZ };

    expect(ageEligibility({ ...facts, MinAge: null, MaxAge: null }, child('2021-08-01'), at)).toBe(
      'unknown',
    );
    // NVRC's "16+": MaxAge null is no upper bound, not an upper bound of zero.
    const nvrc = { ...factsOf('nvrc-course', NVRC), StartDateValue: '2026-04-13T18:30:00' };
    expect(nvrc.AgeRestrictions).toBe('16+');
    expect(ageEligibility(nvrc, child('1995-01-01'), at)).toBe('in_band');
    expect(ageEligibility(nvrc, child('2015-01-01'), at)).toBe('outside_band');
  });

  /** A date the reader cannot read is not a child outside the band. NaN months compares
   * false against every bound, so an unguarded evaluator calls all three instants
   * "outside" and the ladder sends a family the one sentence it has no basis for. */
  it('is unknown for a date of birth it cannot read, never outside the band', () => {
    const facts = factsOf('open-window-open-markham', LEGO);
    const at = { now: new Date('2026-08-11T10:15:00Z'), timeZone: TZ };

    expect(ageEligibility(facts, child('not-a-date'), at)).toBe('unknown');
    expect(ageEligibility(facts, child(''), at)).toBe('unknown');
    // Positive control: a readable date on the same facts still decides.
    expect(ageEligibility(facts, child('2021-08-01'), at)).toBe('in_band');
  });

  it('is unknown when the page publishes no start date to evaluate against', () => {
    const facts = { ...factsOf('open-window-open-markham', LEGO), StartDateValue: null };
    const at = { now: new Date('2026-08-11T10:15:00Z'), timeZone: TZ };

    expect(ageEligibility(facts, child('2021-08-01'), at)).toBe('unknown');
  });
});

describe('the price clause', () => {
  it('prints the pair a two-row page names, non-resident second', () => {
    expect(priceClause(factsOf('oakville-course', OAKVILLE).Prices)).toBe(
      '$6.51 / $16.51 non-resident',
    );
    expect(priceClause(factsOf('open-window-open-markham', LEGO).Prices)).toBe(
      '$121.16 / $139.36 non-resident',
    );
  });

  it('prints a single row as the one figure the page lists', () => {
    expect(priceClause(factsOf('nvrc-course', NVRC).Prices)).toBe('the page lists $51.21');
  });

  /**
   * THE REAL FOUR-ROW PAGE. Markham's "ART: Paint and Play P.A. Day" publishes member
   * and non-member rates for both residencies, transcribed here from the saved probe
   * body in the order the page serialises them. Its FIRST TWO rows are a clean
   * non-resident/resident pair, so a clause that classifies two rows and ignores the
   * rest prints the MEMBER rates — $74.70 to a household this page charges $83.00.
   * Four rows is a price question one clause cannot answer, so it answers nothing.
   */
  it('omits the real four-row page rather than printing its first two rows', () => {
    const gallery = '25/26 Culture: Gallery Children/Teen/Pre-teen Program';
    const paintAndPlay = [
      { Name: `${gallery} - Member Non Resident`, DisplayAmount: '$85.91' },
      { Name: `${gallery} - Member Resident`, DisplayAmount: '$74.70' },
      { Name: `${gallery} - Non Resident`, DisplayAmount: '$95.45' },
      { Name: `${gallery} - Resident`, DisplayAmount: '$83.00' },
    ];

    expect(priceClause(paintAndPlay as never)).toBeNull();
  });

  /** The count is the check, not the order: three rows whose first two ARE a pair are
   * still three rows, and the pair alone still prints. */
  it('omits a third row instead of dropping it', () => {
    const three = [
      { Name: 'Resident', DisplayAmount: '$10.00' },
      { Name: 'Non-Resident', DisplayAmount: '$20.00' },
      { Name: 'Senior', DisplayAmount: '$5.00' },
    ];

    expect(priceClause(three as never)).toBeNull();
    expect(priceClause(three.slice(0, 2) as never)).toBe('$10.00 / $20.00 non-resident');
  });

  it('omits a page whose two rows are not a resident pair', () => {
    expect(priceClause([] as never)).toBeNull();
    expect(priceClause(null)).toBeNull();
    expect(
      priceClause([
        { Name: 'A - Non-Resident', DisplayAmount: '$1' },
        { Name: 'B - Non-Resident', DisplayAmount: '$2' },
      ] as never),
    ).toBeNull();
  });
});

describe('the sign-in deep link', () => {
  it("is the portal's own anchor, rebuilt from the registry", () => {
    const anchor = pageOwnSignInPath('open-window-open-markham', 'Clients');
    const sanitized = sanitizeSpotUrl(legoUrl);
    if (!sanitized.ok) throw new Error(`expected a sanitized url, got ${sanitized.reason}`);

    const built = courseSignInUrl(sanitized.url);

    expect(built).toBe(`https://cityofmarkham.perfectmind.com${anchor}`);
    expect(new URL(built).protocol).toBe('https:');
    expect(new URL(built).hostname).toBe('cityofmarkham.perfectmind.com');
    expect([...new URL(built).searchParams.keys()]).toEqual(['returnUrl']);
    expect(new URL(built).searchParams.get('returnUrl')).toBe(sanitized.url);
  });

  it("uses Oakville's own first path segment, not Markham's", () => {
    const anchor = pageOwnSignInPath('oakville-course', 'Contacts');
    const sanitized = sanitizeSpotUrl(oakvilleUrl);
    if (!sanitized.ok) throw new Error(`expected a sanitized url, got ${sanitized.reason}`);

    const built = courseSignInUrl(sanitized.url);

    expect(built).toContain('/Contacts/MemberRegistration/MemberSignIn?returnUrl=');
    expect(built).toBe(`https://townofoakville.perfectmind.com${anchor}`);
    expect(new URL(built).searchParams.get('returnUrl')).toBe(sanitized.url);
  });

  /**
   * The refusals happen BEFORE the link is built. `courseSignInUrl`'s contract is a
   * sanitized URL, and sanitizeSpotUrl is what makes one: a returnUrl aimed at another
   * host and any second parameter are dropped by the rebuild, http:// and a tampered
   * course id never get that far. Without this, "rebuilt, never echoed" rests on a
   * contract nothing in this suite exercises.
   */
  it('never carries a pasted returnUrl, a second parameter, http:// or a bad course id', () => {
    const smuggled = sanitizeSpotUrl(
      `${legoUrl}&returnUrl=https%3A%2F%2Fevil.example%2Fsteal&sessionId=abc`,
    );
    if (!smuggled.ok) throw new Error(`expected a sanitized url, got ${smuggled.reason}`);

    const built = courseSignInUrl(smuggled.url);

    expect([...new URL(built).searchParams.keys()]).toEqual(['returnUrl']);
    expect(new URL(built).searchParams.get('returnUrl')).toBe(legoUrl);
    expect(built).not.toContain('evil.example');
    expect(built).not.toContain('sessionId');

    expect(sanitizeSpotUrl(legoUrl.replace('https://', 'http://'))).toEqual({
      ok: false,
      reason: 'not_https',
    });
    expect(sanitizeSpotUrl(legoUrl.replace(LEGO, '../../etc/passwd'))).toEqual({
      ok: false,
      reason: 'not_a_course_page',
    });
  });
});

describe('the error-page signature', () => {
  it('is both halves of the page PerfectMind serves for an unknown course', () => {
    const raw = fixture('markham-course-not-found');

    expect(isBookMe4ErrorPage(raw)).toBe(true);
    expect(isBookMe4ErrorPage(raw.replace('<title>BookMe4 Error Page', '<title>Courses'))).toBe(
      false,
    );
    expect(isBookMe4ErrorPage(raw.replace('was not found', 'is unavailable'))).toBe(false);
  });
});

describe('readCoursePrep — the seven questions, in order', () => {
  it('calls a 200 with no model and no signature unreadable, never gone', () => {
    const verdict = readCoursePrep(
      { ok: true, raw: '<html><body>We are performing maintenance.</body></html>' },
      ctx(),
    );

    expect(verdict).toEqual({ kind: 'page_unreadable', reason: 'no_model' });
  });

  /** THE ORDER, pinned where it is load-bearing: the error page is fed with an
   * out-of-band child AND a drifted anchor, and course_gone still wins. */
  it('calls the error page gone even with an ineligible child and a drifted anchor', () => {
    const verdict = readCoursePrep(
      { ok: true, raw: fixture('markham-course-not-found') },
      ctx({
        courseId: 'deadbeef-0000-0000-0000-000000000000',
        anchor: new Date('2020-01-01T00:00:00Z'),
        children: [child('1990-01-01')],
      }),
    );

    expect(verdict).toEqual({ kind: 'course_gone' });
  });

  it('names why a page could not be read, and never invents a course', () => {
    expect(readCoursePrep({ ok: false, reason: 'fetch_failed' }, ctx())).toEqual({
      kind: 'page_unreadable',
      reason: 'fetch_failed',
    });
    expect(readCoursePrep({ ok: false, reason: 'wall_budget' }, ctx())).toEqual({
      kind: 'page_unreadable',
      reason: 'wall_budget',
    });
    expect(
      readCoursePrep(
        { ok: true, raw: fixture('open-window-open-markham') },
        ctx({ courseId: CHESS }),
      ),
    ).toEqual({ kind: 'page_unreadable', reason: 'wrong_course' });
    expect(
      readCoursePrep({ ok: true, raw: pageWith({ EventId: LEGO, IsFull: 'no' }) }, ctx()),
    ).toEqual({ kind: 'page_unreadable', reason: 'bad_model' });
  });

  /**
   * THE SHAPE 338 EXISTS FOR (ASSUMPTION model — no saved page shows a course whose
   * registration has not opened): seats with CanNotBook true and both clocks ahead.
   * 337's classifier throws the model away on it; the ladder must still read the page.
   */
  it('prepares a not-yet-open page that classify refuses (ASSUMPTION model)', () => {
    const raw = variantOf('open-window-open-markham', LEGO, {
      CanNotBook: true,
      SpotsLeft: 10,
    });

    expect(readSpot(raw, LEGO)).toEqual({ state: 'unreadable', reason: 'inconsistent' });

    const verdict = readCoursePrep({ ok: true, raw }, ctx({ readinessReady: true }));

    expect(verdict).toMatchObject({
      kind: 'prepared',
      readinessReady: true,
      clock: { at: new Date('2026-08-11T06:30:00-04:00'), name: 'residents-first date' },
      anchorDriftMinutes: 0,
    });
  });

  /** The flag never overrides the clock: a page that has not opened is early, not over. */
  it('is not closed while the applicable clock is still ahead', () => {
    const raw = variantOf('open-window-open-markham', LEGO, { IsRegistrationClosed: true });

    expect(readCoursePrep({ ok: true, raw }, ctx())).toMatchObject({ kind: 'prepared' });
  });

  it('is closed once the flag stands and the clock has passed', () => {
    const raw = variantOf('open-window-open-markham', LEGO, { IsRegistrationClosed: true });

    expect(
      readCoursePrep(
        { ok: true, raw },
        ctx({ now: new Date('2026-08-11T11:00:00Z'), anchor: new Date('2026-08-11T10:30:00Z') }),
      ),
    ).toMatchObject({ kind: 'registration_closed' });
  });

  it('is closed when the page takes the course off online registration', () => {
    const raw = variantOf('open-window-open-markham', LEGO, { OnlineRegistration: false });

    expect(
      readCoursePrep({ ok: true, raw }, ctx({ now: new Date('2026-08-11T11:00:00Z') })),
    ).toMatchObject({ kind: 'registration_closed' });
  });

  it('separates the two drift verdicts by the open, on the clock that applies', () => {
    const later = variantOf('open-window-open-markham', LEGO, {
      ResidentsRegistrationDateValue: '2026-08-11T07:30:00',
    });
    const earlier = variantOf('open-window-open-markham', LEGO, {
      ResidentsRegistrationDateValue: '2026-08-11T06:00:00',
    });

    expect(readCoursePrep({ ok: true, raw: later }, ctx())).toMatchObject({
      kind: 'window_moved',
      anchorDriftMinutes: 60,
    });
    // The SAME page for a two-municipality household reads the public clock, which
    // agrees with that household's anchor.
    expect(
      readCoursePrep(
        { ok: true, raw: later },
        ctx({ isResidentWindow: false, anchor: new Date('2026-08-12T10:30:00Z') }),
      ),
    ).toMatchObject({ kind: 'prepared' });
    expect(
      readCoursePrep({ ok: true, raw: earlier }, ctx({ now: new Date('2026-08-11T10:15:00Z') })),
    ).toMatchObject({ kind: 'late_by_drift', anchorDriftMinutes: -30 });
  });

  it('calls an earlier clock that has not arrived moved, not late', () => {
    const earlier = variantOf('open-window-open-markham', LEGO, {
      ResidentsRegistrationDateValue: '2026-08-11T06:00:00',
    });

    expect(
      readCoursePrep({ ok: true, raw: earlier }, ctx({ now: new Date('2026-08-11T09:00:00Z') })),
    ).toMatchObject({ kind: 'window_moved', anchorDriftMinutes: -30 });
  });

  it('tolerates a drift inside the fifteen-minute window without a word about it', () => {
    const nudged = variantOf('open-window-open-markham', LEGO, {
      ResidentsRegistrationDateValue: '2026-08-11T06:45:00',
    });

    expect(readCoursePrep({ ok: true, raw: nudged }, ctx())).toMatchObject({
      kind: 'prepared',
      anchorDriftMinutes: 15,
    });
  });

  /**
   * THE ORDER WHERE THE LADDER RESTS ON IT. Four conditions on one page — the closed
   * flag, a clock already past, an anchor thirty minutes later than that clock, and a
   * household with no child in the band — then peeled one at a time. The battle plan
   * refreshes `course_opens_at` only on window_moved / late_by_drift, so an age verdict
   * that outranked the drift would leave the stale instant in place and fire the go leg
   * on the wrong minute; a drift verdict that outranked the closed flag would promise a
   * morning on a course nobody can register for.
   */
  it('answers closed before drift, and drift before the age band', () => {
    const pastClock = { ResidentsRegistrationDateValue: '2026-08-11T06:00:00' };
    const closed = variantOf('open-window-open-markham', LEGO, {
      ...pastClock,
      IsRegistrationClosed: true,
    });
    const open = variantOf('open-window-open-markham', LEGO, pastClock);
    const stacked = {
      now: new Date('2026-08-11T11:00:00Z'),
      anchor: new Date('2026-08-11T10:30:00Z'),
      children: [child('2010-01-01', 'exact', 'out')],
    };

    expect(readCoursePrep({ ok: true, raw: closed }, ctx(stacked))).toMatchObject({
      kind: 'registration_closed',
      anchorDriftMinutes: -30,
      age: { fit: 'outside_band' },
    });
    expect(readCoursePrep({ ok: true, raw: open }, ctx(stacked))).toMatchObject({
      kind: 'late_by_drift',
      anchorDriftMinutes: -30,
      age: { fit: 'outside_band' },
    });
    expect(
      readCoursePrep(
        { ok: true, raw: open },
        ctx({ ...stacked, anchor: new Date('2026-08-11T10:00:00Z') }),
      ),
    ).toMatchObject({ kind: 'age_ineligible', anchorDriftMinutes: 0 });
  });

  it('is age_ineligible only when every matched child is outside the page’s band', () => {
    const raw = fixture('open-window-open-markham');
    const inBand = child('2021-08-01', 'exact', 'in');
    const outOfBand = child('2010-01-01', 'exact', 'out');

    expect(readCoursePrep({ ok: true, raw }, ctx({ children: [outOfBand] }))).toMatchObject({
      kind: 'age_ineligible',
      age: { fit: 'outside_band', outsideBandChildIds: ['out'] },
    });
    expect(readCoursePrep({ ok: true, raw }, ctx({ children: [inBand, outOfBand] }))).toMatchObject(
      { kind: 'prepared', age: { fit: 'unknown', outsideBandChildIds: ['out'] } },
    );
    expect(readCoursePrep({ ok: true, raw }, ctx({ children: [inBand] }))).toMatchObject({
      kind: 'prepared',
      age: { fit: 'in_band', outsideBandChildIds: [] },
    });
    expect(
      readCoursePrep({ ok: true, raw }, ctx({ children: [child('2010-01-01', 'derived', 'out')] })),
    ).toMatchObject({ kind: 'prepared', age: { fit: 'unknown' } });
  });

  it('hands the prepared verdict everything a leg prints, byte-backed', () => {
    const verdict = readCoursePrep(
      { ok: true, raw: fixture('open-window-open-markham') },
      ctx({ readinessReady: false, children: [child('2021-08-01')] }),
    );

    expect(verdict).toMatchObject({
      kind: 'prepared',
      readinessReady: false,
      clock: { at: new Date('2026-08-11T06:30:00-04:00'), name: 'residents-first date' },
      anchorDriftMinutes: 0,
      age: { fit: 'in_band' },
    });
    if (verdict.kind !== 'prepared') throw new Error('expected prepared');
    expect(verdict.facts.EventName).toBe('LEGO: Preschool');
    expect(verdict.facts.CourseId).toBe('344301');
    expect(verdict.facts.StartDay).toBe('Sunday');
    expect(verdict.facts.StartTime).toBe('10:15 AM');
    expect(verdict.facts.RegFormId).toBeNull();
    expect(verdict.facts.PrerequisiteEvents).toBe(false);
    expect(priceClause(verdict.facts.Prices)).toBe('$121.16 / $139.36 non-resident');
    expect(verdict.clocks.public).toEqual(new Date('2026-08-12T06:30:00-04:00'));
  });

  it('carries the questionnaire warning only where the page has one', () => {
    expect(factsOf('newmarket-course', NEWMARKET).RegFormId).toBe(
      '18d27cc3-1e98-4bce-aebc-a5c6d78a80f9',
    );
    expect(factsOf('open-window-open-markham', LEGO).RegFormId).toBeNull();
  });

  /**
   * THE TOTALITY CONTRACT. The token search reads the MODEL's own bytes, so an earlier
   * `"EventName":"` in some other inline script — here with `\'`, which is not a JSON
   * escape — is neither parsed nor allowed to answer for the model. Before the search
   * was scoped, that byte sequence reached JSON.parse and threw, and a throw inside the
   * leg costs the family the whole tick this module exists to protect.
   */
  it('answers a page whose first token occurrence is outside the model, and never throws', () => {
    const decoy = `<script>var other = {"EventName":"it\\'s"};</script>`;
    const raw = `${decoy}${fixture('open-window-open-markham')}`;

    const verdict = readCoursePrep({ ok: true, raw }, ctx());

    expect(rawStringValue(decoy, 'EventName')).toBeNull();
    expect(verdict).toMatchObject({ kind: 'prepared' });
    if (verdict.kind !== 'prepared') throw new Error('expected prepared');
    // The model's own name still backs itself: the decoy answered for nothing.
    expect(verdict.facts.EventName).toBe('LEGO: Preschool');
    expect(verdict.backed).toContain('LEGO: Preschool');
  });

  it('still answers when the page publishes no clock at all', () => {
    const raw = variantOf('open-window-open-markham', LEGO, {
      PublicRegistrationStartDateValue: null,
      ResidentsRegistrationDateValue: null,
    });

    expect(readCoursePrep({ ok: true, raw }, ctx())).toMatchObject({
      kind: 'prepared',
      clock: null,
      anchorDriftMinutes: null,
    });
  });
});
