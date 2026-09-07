import { z } from 'zod';
import { type BookMe4Model, fragment, readCourseModel } from '~/lib/channel/spots/availability';
import { dayKeyIn, zonedLocalInstant } from '~/lib/plan/spine';
import { ageInMonths } from '@hale/types';

/**
 * VIL-338 · what a bound course page says, and which single truthful sentence the
 * ladder is allowed to send about it. Pure: no DB, no network, no `new Date()`.
 *
 * THE PAGE IS THE SYSTEM OF RECORD FOR ITS OWN CLOCK. The M1 registration_windows row
 * is a hand-verified municipal announcement; the course page is the software that will
 * actually open the door. On the shipped data they disagree — the Markham fall row
 * carries only the resident instant (Aug 11 06:30) while the course page publishes
 * residents Aug 11 AND public Aug 12, and the Oakville non-resident row is a
 * start-of-day placeholder against a page that says 07:00 — so a ladder that anchored
 * on the row would text a Thornhill household on the wrong morning and an Oakville
 * non-resident at 23:45. Everything here reads the page's clocks and hands the caller
 * the one that applies to THIS family; the disagreement is a number (`driftMinutes`),
 * never a silent correction.
 *
 * THE VERDICT IS SEVEN QUESTIONS IN ONE FIXED ORDER, and the order is the design:
 *
 *   1. page_unreadable — the fetch threw, the run's read budget was spent, or the
 *      model came back bad / for another course, or absent WITHOUT the error-page
 *      signature. A page Hale could not open says nothing about the class.
 *   2. course_gone — no model AND the BookMe4 error page's own signature. A missing
 *      model on its own is an Akamai challenge or a redesign, not a deleted course.
 *   3. registration_closed — the page's closed/offline flags, AND its applicable clock
 *      is not in the future. The clock decides; a not-yet-open page that reports
 *      IsRegistrationClosed true is not closed, it is early.
 *   4. late_by_drift — the applicable clock is earlier than the anchor and already past.
 *   5. window_moved — it differs from the anchor by more than the tolerance otherwise.
 *   6. age_ineligible — every matched child is outside the page's own published band.
 *   7. prepared.
 *
 * NOTHING PRINTS THAT IS NOT IN THE BYTES. A string reaches `facts` only when its raw
 * JSON token round-trips (`rawStringValue`): PerfectMind serialises `&` as the JSON
 * escape `\u0026` (measured on a saved showcase page), so `JSON.stringify` of a parsed
 * "Parks & Rec" is NOT findable in the body it came from and 337's `fragment` would
 * refuse a name the page really carries. Numbers and booleans ARE their own tokens, so
 * they keep `fragment`, and a test proves that over every saved page.
 */

/** How far the page's clock may sit from the sequence's anchor before the copy has to
 * name both instants. Fifteen minutes is the go leg's whole lead time (GO_LEAD_MINUTES),
 * so a drift this size is the difference between a text that helps and one that arrives
 * after the door opened. */
export const WINDOW_DRIFT_TOLERANCE_MINUTES = 15;

/** How far a pasted course's open may sit from the morning Hale is already running
 * before the bind is refused as a different season. A municipal cycle repeats every few
 * months, so a week is wide enough for a re-announced date and far short of the next
 * cycle. */
export const MAX_BIND_DRIFT_DAYS = 7;

/** The read budget for the bind turn — a parent is waiting on the reply. Mirrors
 * VIL-337's MINT_FETCH_TIMEOUT_MS. */
export const BIND_FETCH_TIMEOUT_MS = 6_000;

/** The read budget for a leg's send-time re-read. */
export const GO_FETCH_TIMEOUT_MS = 6_000;

/** How much WALL time one sweep may spend re-reading course pages. Phase B is a serial
 * loop with `now` captured once, so a run that spends longer than this is judging a
 * `go` interval it has already left; past the budget a bound leg still sends, with the
 * page_unreadable sentence and its deep link. */
export const READ_WALL_BUDGET_MS = 60_000;

/**
 * ASSUMPTION — the months component of an upper bound the page leaves unstated.
 * Newmarket publishes "13 to 16 y 11m" as MaxAge 16 + MaxAgeMonths 11, so the months
 * field is a COMPONENT of the year, not a total; every other saved page leaves it null
 * beside a band that reads "4 to 6", i.e. through the end of the sixth year. Until a
 * page is observed carrying an explicit `MaxAgeMonths: 0`, an absent component means
 * the year is inclusive.
 */
export const ASSUMED_MAX_AGE_MONTHS_COMPONENT = 11;

const priceRowSchema = z
  .object({
    Name: z.string().nullish().catch(null),
    DisplayAmount: z.string().nullish().catch(null),
  })
  .passthrough();

/**
 * The eighteen keys of somebody else's 168-key payload that this ladder reads. Every
 * field is nullish AND `.catch(null)`: a tenant that ships `MinAge` as a string has not
 * broken the page, it has withheld a band, and the sentence that band would have
 * produced is simply absent. `readCourseModel` has already validated the twelve fields
 * a reading rests on.
 */
export const courseFactsSchema = z
  .object({
    EventName: z.string().nullish().catch(null),
    /** The human barcode a phone-registration lane asks for ("344301"), NOT the GUID
     * `EventId` the URL carries. */
    CourseId: z.string().nullish().catch(null),
    StartDay: z.string().nullish().catch(null),
    StartTime: z.string().nullish().catch(null),
    StartDateValue: z.string().nullish().catch(null),
    MinAge: z.number().nullish().catch(null),
    MaxAge: z.number().nullish().catch(null),
    MinAgeMonths: z.number().nullish().catch(null),
    MaxAgeMonths: z.number().nullish().catch(null),
    AgeRestrictions: z.string().nullish().catch(null),
    /** Non-null when the portal will demand a questionnaire Hale has never seen and
     * holds no source for — a warning on the bind ack, never something Hale fills. */
    RegFormId: z.string().nullish().catch(null),
    PrerequisiteEvents: z.boolean().nullish().catch(null),
    Prices: z.array(priceRowSchema).nullish().catch(null),
    PublicRegistrationStartDateValue: z.string().nullish().catch(null),
    ResidentsRegistrationDateValue: z.string().nullish().catch(null),
    MembersRegistrationDateValue: z.string().nullish().catch(null),
    IsRegistrationClosed: z.boolean().nullish().catch(null),
    OnlineRegistration: z.boolean().nullish().catch(null),
  })
  .passthrough();

export type CourseFacts = z.infer<typeof courseFactsSchema>;

/** The string fields whose value may reach a parent's screen verbatim, plus the three
 * clock strings, which reach it as a rendered time. Each occurs exactly once in a saved
 * page (pinned by a test), so a whole-body search has one answer. */
const BACKED_STRING_KEYS = [
  'EventName',
  'CourseId',
  'StartDay',
  'StartTime',
  'StartDateValue',
  'AgeRestrictions',
  'RegFormId',
  'PublicRegistrationStartDateValue',
  'ResidentsRegistrationDateValue',
  'MembersRegistrationDateValue',
] as const satisfies readonly (keyof CourseFacts)[];

/** The subset of those a sentence prints as itself, so a composer can check what it is
 * about to say against the read that produced it. A rendered instant is checked against
 * the clock, not against this list. */
const PRINTABLE_STRING_KEYS = new Set<string>([
  'EventName',
  'CourseId',
  'StartDay',
  'StartTime',
  'AgeRestrictions',
]);

/**
 * The value `modelBytes` carries for `key`, or null when the key is absent or the token
 * does not parse. The token IS the bytes: located at `"key":"`, taken to its closing
 * unescaped quote and parsed as the JSON string it is — which is why a `\u0026` in the
 * body proves a `&` in the value instead of refusing it.
 *
 * TOTAL, both ways. It is handed the model's own blob rather than the page, so the one
 * occurrence it finds is the model's; and the parse is a boundary, so a caller that
 * hands it some other bytes gets null instead of a SyntaxError thrown through a leg.
 */
export function rawStringValue(modelBytes: string, key: string): string | null {
  const marker = `"${key}":"`;
  const at = modelBytes.indexOf(marker);
  if (at < 0) return null;

  const start = at + marker.length - 1;
  let escaped = false;
  for (let cursor = start + 1; cursor < modelBytes.length; cursor += 1) {
    const char = modelBytes[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char !== '"') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(modelBytes.slice(start, cursor + 1));
    } catch {
      return null;
    }
    return typeof parsed === 'string' ? parsed : null;
  }
  return null;
}

/**
 * The 200-response PerfectMind serves for a courseId it does not have. Both halves are
 * required: a body with no model and no signature is a challenge page, a maintenance
 * notice or a redesign, and calling that "the course is gone" would tell a parent their
 * class was cancelled because Hale met a firewall.
 */
export function isBookMe4ErrorPage(rawHtml: string): boolean {
  return rawHtml.includes('<title>BookMe4 Error Page') && rawHtml.includes('was not found');
}

export interface CourseFactsReading {
  facts: CourseFacts;
  /** Every page string this read proved, for a composer to check its own output
   * against. A value that is not here was not in the bytes and is null in `facts`. */
  backed: readonly string[];
}

/**
 * The facts, with every printable string dropped unless the model's own token backs it.
 * A dropped value is not an error: the sentence that would have printed it is simply
 * not composed, which is the whole point.
 *
 * `modelBytes` is `readCourseModel`'s blob — the serialisation these facts were parsed
 * out of — and never the whole page. A page carries other people's inline script, so a
 * whole-body search answers about whichever `"EventName":"` comes first.
 */
export function readCourseFacts(model: BookMe4Model, modelBytes: string): CourseFactsReading {
  // Total by construction: every field is `.catch(null)`, so a tenant that ships
  // `MinAge` as a string withholds a band rather than breaking the read.
  const facts = courseFactsSchema.parse(model);
  const backed: string[] = [];

  for (const key of BACKED_STRING_KEYS) {
    const value = facts[key];
    if (typeof value !== 'string') continue;
    if (rawStringValue(modelBytes, key) === value) {
      if (PRINTABLE_STRING_KEYS.has(key)) backed.push(value);
      continue;
    }
    facts[key] = null;
  }

  if (facts.Prices != null) {
    // A price key repeats once per row, so these are checked as fragments — "is this
    // pair of bytes on the page" — rather than by first-occurrence lookup, which would
    // answer about the wrong row.
    facts.Prices = facts.Prices.filter(
      (row) =>
        typeof row.Name === 'string' &&
        typeof row.DisplayAmount === 'string' &&
        modelBytes.includes(fragment('Name', row.Name)) &&
        modelBytes.includes(fragment('DisplayAmount', row.DisplayAmount)),
    );
    for (const row of facts.Prices) {
      if (typeof row.DisplayAmount === 'string') backed.push(row.DisplayAmount);
    }
  }

  return { facts, backed };
}

export interface CourseClocks {
  /** When residents may first register, where the tenant publishes a head start. */
  residents: Date | null;
  /** Members-first, which every saved page publishes equal to the public instant. Read
   * so a tenant that ever leads with it is a test failure rather than a silent miss. */
  members: Date | null;
  public: Date | null;
  /** The first class, which the age band is evaluated at. */
  start: Date | null;
}

const NAIVE_LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/;

/**
 * A PerfectMind naive local datetime as an instant in the portal's own zone, or null.
 * Never a guess: an offset-bearing string, a `24/02/2026`, a rolled-over `2026-02-30`
 * and a non-zero seconds component (which no sampled page publishes and which no copy
 * renders) all yield null rather than an instant that is off by a day or a minute.
 *
 * TOTAL. The regex fixes the SHAPE and says nothing about the VALUE, so the range is
 * checked here rather than downstream: `zonedLocalInstant` builds a Date out of the
 * pair and THROWS on a NaN, and a throw inside a leg costs the family the tick. `24:00`
 * is refused for the reason `2026-02-30` is — it rolls into the next day, and a clock
 * that is off by a day is the one failure this whole module exists to prevent.
 */
function zonedNaiveInstant(naive: string | null | undefined, timeZone: string): Date | null {
  if (typeof naive !== 'string') return null;
  if (!NAIVE_LOCAL.test(naive)) return null;
  const dayKey = naive.slice(0, 10);
  const hourMinute = naive.slice(11, 16);
  if (Number(hourMinute.slice(0, 2)) > 23 || Number(hourMinute.slice(3)) > 59) return null;
  if (naive.length > 16 && naive.slice(17) !== '00') return null;
  // `new Date('2026-02-30T…')` rolls into March rather than refusing, so the day key is
  // re-rendered and compared before any zone arithmetic runs.
  const utc = new Date(`${dayKey}T00:00:00Z`);
  if (Number.isNaN(utc.getTime()) || utc.toISOString().slice(0, 10) !== dayKey) return null;
  return zonedLocalInstant(dayKey, hourMinute, timeZone);
}

export function courseClocks(facts: CourseFacts, timeZone: string): CourseClocks {
  return {
    residents: zonedNaiveInstant(facts.ResidentsRegistrationDateValue, timeZone),
    members: zonedNaiveInstant(facts.MembersRegistrationDateValue, timeZone),
    public: zonedNaiveInstant(facts.PublicRegistrationStartDateValue, timeZone),
    start: zonedNaiveInstant(facts.StartDateValue, timeZone),
  };
}

/** Which of the page's clocks the copy is naming, in the words the copy uses. */
export type ClockName = 'residents-first date' | 'public date';

export interface ApplicableClock {
  at: Date;
  name: ClockName;
}

/**
 * The clock THIS family opens on. `isResidentWindow` is `resolveFamilyOpen`'s answer
 * and nothing else: a resident head start is claimed only where the FSA resolves to one
 * municipality, so a Thornhill household straddling two towns is read the public clock
 * — which is the whole reason the M1 row's single instant is not enough.
 */
export function applicableClock(
  clocks: CourseClocks,
  isResidentWindow: boolean,
): ApplicableClock | null {
  if (isResidentWindow && clocks.residents !== null) {
    return { at: clocks.residents, name: 'residents-first date' };
  }
  return clocks.public === null ? null : { at: clocks.public, name: 'public date' };
}

/** Whole minutes from `from` to `to`, signed: positive when the page is later. */
export function driftMinutes(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}

export type AgeEligibility = 'in_band' | 'outside_band' | 'unknown';

export interface PrepChild {
  id: string;
  dateOfBirth: string;
  /** 'exact' only where a parent typed the real date. A DOB derived from "she's about
   * three" is a midpoint, and a midpoint may not decide a band. */
  dobPrecision: string;
}

/**
 * Whether the page's own published band admits this child, at every instant that could
 * decide it.
 *
 * AgeRule / AgeRuleSpecificDate ARE DELIBERATELY UNREAD. Every saved page carries
 * AgeRule 1 beside a rule date years before the course (2021-07-09 on a September 2026
 * preschool class), so "age as of the rule date" would rule out every child alive.
 * Instead the band is checked at THREE instants — today, the first class, and Dec 31 of
 * the course-start year, which is Oakville's own published rule for ages 6+ — and any
 * disagreement between them is 'unknown'. That is municipality-agnostic and strictly
 * more conservative than picking one: a child near any plausible boundary prints
 * nothing rather than a verdict that depends on which town wrote the page.
 */
/**
 * A day key as an instant whose CALENDAR fields are that day. `ageInMonths` reads a Date
 * through the machine's own `getFullYear/getMonth/getDate`, so the instant is built in
 * machine-local time and the day survives on any host — a UTC-noon instant would be the
 * previous day for a runner east of UTC+12.
 */
function calendarNoon(dayKey: string): Date {
  const year = Number(dayKey.slice(0, 4));
  const month = Number(dayKey.slice(5, 7));
  const day = Number(dayKey.slice(8, 10));
  return new Date(year, month - 1, day, 12);
}

export function ageEligibility(
  facts: CourseFacts,
  child: PrepChild,
  ctx: { now: Date; timeZone: string },
): AgeEligibility {
  if (child.dobPrecision !== 'exact') return 'unknown';

  const lower = facts.MinAge == null ? null : facts.MinAge * 12 + (facts.MinAgeMonths ?? 0);
  const upper =
    facts.MaxAge == null
      ? null
      : facts.MaxAge * 12 + (facts.MaxAgeMonths ?? ASSUMED_MAX_AGE_MONTHS_COMPONENT);
  if (lower === null && upper === null) return 'unknown';

  const startDay = facts.StartDateValue?.slice(0, 10);
  if (startDay === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(startDay)) return 'unknown';

  const days = [dayKeyIn(ctx.now, ctx.timeZone), startDay, `${startDay.slice(0, 4)}-12-31`];
  const months = days.map((day) => ageInMonths(child.dateOfBirth, calendarNoon(day)));
  // NaN compares false against both bounds, so a date this reader cannot read would
  // otherwise be unanimously "outside" — the one verdict there is no basis for.
  if (months.some((value) => Number.isNaN(value))) return 'unknown';
  const verdicts = months.map(
    (value) => (lower === null || value >= lower) && (upper === null || value <= upper),
  );

  if (verdicts.every((inside) => inside)) return 'in_band';
  if (verdicts.every((inside) => !inside)) return 'outside_band';
  return 'unknown';
}

export interface AgeVerdict {
  /** The household's verdict: unanimous or 'unknown'. A family whose children disagree
   * has no sentence to send about the band. */
  fit: AgeEligibility;
  outsideBandChildIds: readonly string[];
}

function readAge(
  facts: CourseFacts,
  children: readonly PrepChild[],
  ctx: { now: Date; timeZone: string },
): AgeVerdict {
  const each = children.map((child) => ({ child, fit: ageEligibility(facts, child, ctx) }));
  const outsideBandChildIds = each
    .filter((entry) => entry.fit === 'outside_band')
    .map((entry) => entry.child.id);

  if (each.length === 0) return { fit: 'unknown', outsideBandChildIds };
  if (each.every((entry) => entry.fit === 'in_band'))
    return { fit: 'in_band', outsideBandChildIds };
  if (each.every((entry) => entry.fit === 'outside_band')) {
    return { fit: 'outside_band', outsideBandChildIds };
  }
  return { fit: 'unknown', outsideBandChildIds };
}

const NON_RESIDENT = /non[- ]?resident/i;

/**
 * What the page says the course costs, or nothing.
 *
 * The non-resident test runs FIRST because "Resident" is a substring of "Non-Resident"
 * on both Markham's rows and Newmarket's. A pair BOUNDS the cost and never asserts
 * which rate this household pays: `CanSelect` is false for an anonymous reader on every
 * sampled tenant, because the portal picks the rate from the account's own address.
 * Anything that is not a clean pair or a single row is omitted — a page printing four
 * member/non-member rows is a price question Hale cannot answer in one clause.
 */
export function priceClause(prices: CourseFacts['Prices']): string | null {
  const rows = (prices ?? []).filter(
    (row): row is { Name: string; DisplayAmount: string } =>
      typeof row.Name === 'string' && typeof row.DisplayAmount === 'string',
  );
  const [first, second] = rows;
  if (first === undefined) return null;
  if (rows.length === 1) return `the page lists ${first.DisplayAmount}`;
  // The COUNT is the check. Markham's four-row paint-and-play page opens with a member
  // non-resident/resident pair, so a clause that classified the first two rows and let
  // the rest go would quote the member rate to a household the page charges $83.
  if (rows.length !== 2 || second === undefined) return null;

  const pair = [first, second];
  const nonResident = pair.find((row) => NON_RESIDENT.test(row.Name));
  const resident = pair.find((row) => !NON_RESIDENT.test(row.Name));
  if (nonResident === undefined || resident === undefined) return null;
  return `${resident.DisplayAmount} / ${nonResident.DisplayAmount} non-resident`;
}

/**
 * The portal's own sign-in-and-return link for a course, REBUILT from the sanitized URL
 * rather than echoed from the page's markup — so a session id a parent once pasted, or
 * a returnUrl a compromised page swapped, cannot ride back out in a Hale text. The path
 * is the vendor's, under the tenant's own first segment (/Clients, /Contacts).
 */
export function courseSignInUrl(sanitizedUrl: string): string {
  const parsed = new URL(sanitizedUrl);
  const segment = parsed.pathname.split('/')[1];
  const returnUrl = encodeURIComponent(sanitizedUrl);
  return `https://${parsed.hostname}/${segment}/MemberRegistration/MemberSignIn?returnUrl=${returnUrl}`;
}

export type PrepFailure =
  | 'course_gone'
  | 'registration_closed'
  | 'page_unreadable'
  | 'age_ineligible'
  | 'window_moved'
  | 'late_by_drift';

/** Why a page could not be read, kept apart from `course_gone` so the copy can only say
 * "I could not read it" when that is what happened. */
export type UnreadableReason =
  | 'fetch_failed'
  | 'wall_budget'
  | 'no_model'
  | 'bad_model'
  | 'wrong_course';

/** What every verdict that actually read a page carries. */
export interface CoursePage {
  facts: CourseFacts;
  backed: readonly string[];
  clocks: CourseClocks;
  /** The clock this family opens on, or null where the page publishes none. */
  clock: ApplicableClock | null;
  /** The page's clock minus the sequence's anchor, in whole minutes. Null with no
   * clock. This is the number the leg_sent audit row carries. */
  anchorDriftMinutes: number | null;
  age: AgeVerdict;
}

export type PrepVerdict =
  | ({ kind: 'prepared'; readinessReady: boolean | null } & CoursePage)
  | ({ kind: 'registration_closed' } & CoursePage)
  | ({ kind: 'late_by_drift' } & CoursePage)
  | ({ kind: 'window_moved' } & CoursePage)
  | ({ kind: 'age_ineligible' } & CoursePage)
  | { kind: 'course_gone' }
  | { kind: 'page_unreadable'; reason: UnreadableReason };

export type PrepInput =
  | { ok: true; raw: string }
  | { ok: false; reason: 'fetch_failed' | 'wall_budget' };

export interface PrepContext {
  now: Date;
  /** The sanitized URL's courseId, so a page served for another class is refused. */
  courseId: string;
  /** The portal's own zone (`SpotPortal.timeZone`), which is what the page's naive
   * datetimes are published in. The registry entry itself is not needed here — a
   * verdict is about clocks and a band, and the label belongs to the composer. */
  timeZone: string;
  isResidentWindow: boolean;
  /** `course_opens_at` — the page's own instant, stored at bind. */
  anchor: Date;
  children: readonly PrepChild[];
  readinessReady: boolean | null;
}

/**
 * The seven questions, in the order the module header states. Total: every input this
 * can be handed yields exactly one verdict, and every verdict has a sentence.
 */
export function readCoursePrep(input: PrepInput, ctx: PrepContext): PrepVerdict {
  if (!input.ok) return { kind: 'page_unreadable', reason: input.reason };

  const read = readCourseModel(input.raw, ctx.courseId);
  if (!read.ok) {
    if (read.reason === 'no_model' && isBookMe4ErrorPage(input.raw)) return { kind: 'course_gone' };
    return { kind: 'page_unreadable', reason: read.reason };
  }

  const { facts, backed } = readCourseFacts(read.model, read.blob);
  const clocks = courseClocks(facts, ctx.timeZone);
  const clock = applicableClock(clocks, ctx.isResidentWindow);
  const page: CoursePage = {
    facts,
    backed,
    clocks,
    clock,
    anchorDriftMinutes: clock === null ? null : driftMinutes(ctx.anchor, clock.at),
    age: readAge(facts, ctx.children, { now: ctx.now, timeZone: ctx.timeZone }),
  };

  // The clock decides, the flag does not: a course whose registration has not opened is
  // entitled to report itself closed, and that page is early rather than over.
  const opensLater = clock !== null && clock.at.getTime() > ctx.now.getTime();
  if ((facts.IsRegistrationClosed === true || facts.OnlineRegistration === false) && !opensLater) {
    return { kind: 'registration_closed', ...page };
  }

  const drift = page.anchorDriftMinutes;
  if (drift !== null && Math.abs(drift) > WINDOW_DRIFT_TOLERANCE_MINUTES) {
    return drift < 0 && !opensLater
      ? { kind: 'late_by_drift', ...page }
      : { kind: 'window_moved', ...page };
  }

  if (page.age.fit === 'outside_band') return { kind: 'age_ineligible', ...page };

  return { kind: 'prepared', readinessReady: ctx.readinessReady, ...page };
}
