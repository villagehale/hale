import type { Municipality, ProgramDomain } from '@hale/db';

/**
 * VIL-236 · M1 — the hand-VERIFIED GTA registration-window dataset. Every row was read
 * off the municipality's own page (the `sourceUrl`) on the date in `verifiedAt`.
 * Nothing here is projected from a prior year: a municipality that has not yet
 * published its next date has NO row, and the gap lives in the ticket's coverage report
 * rather than being filled with a plausible guess. A wrong date is worse than a missing
 * one — a parent who trusts it misses the registration entirely.
 *
 * THE STALE-YEAR TRAP. Web search returns last year's registration dates for this year's
 * query, confidently and unqualified — Toronto's Fall 2025 dates came back three times
 * for an explicit "Fall 2026" search. Where a source prints a weekday next to a date,
 * `publishedWeekdays` records it and a test checks it against the real calendar; a
 * carried-over prior-year date fails that check immediately (Sept 15 is a Monday in
 * 2025 and a Tuesday in 2026). Rows whose source prints no weekday carry no entry and
 * must be re-verified by hand.
 *
 * TIME ENCODING. Every instant is an ISO-8601 string carrying its EXPLICIT
 * America/Toronto offset (-04:00 during EDT, -05:00 during EST; the changeovers in this
 * range are 1 Nov 2026 and 14 Mar 2027). The offsets are checked against the real IANA
 * zone in the tests, so a hand-typed -04:00 on a February date fails the build rather
 * than silently shifting a 7 a.m. open by an hour.
 *
 * DATE-ONLY SOURCES. Where a municipality publishes a DATE but no TIME (Richmond Hill's
 * whole calendar, Mississauga's banner, every preview date), the instant is the START OF
 * THAT LOCAL DAY and the row's `notes` says so. Start-of-day asserts no time the town
 * did not publish.
 *
 * RULE-DERIVED NON-RESIDENT DATES. Three municipalities publish a resident date plus a
 * standing rule ("non-residents may register N days later") but never print the second
 * date. Those `openAt` values are the resident date plus the published rule, flagged in
 * `notes`. This is arithmetic on a published rule, not a guess — and it is never the
 * date shown to a family we matched as a resident, who gets the printed resident date.
 */

export type PublishedWeekday =
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday'
  | 'Sunday';

export interface RegistrationWindowSeed {
  municipality: Municipality;
  programDomain: ProgramDomain;
  cycleLabel: string;
  /** ISO instant with an explicit offset, or null when no preview is published. */
  previewAt: string | null;
  residentOpenAt: string | null;
  openAt: string;
  residentPriorityDays: number | null;
  waitlistResponseHours: number | null;
  ageMinMonths: number | null;
  ageMaxMonths: number | null;
  sourceUrl: string;
  /** The day this row was last read off `sourceUrl`. */
  verifiedAt: string;
  notes: string | null;
  /** Weekdays the SOURCE printed beside each date. Seed-only (never persisted) — a
   * build-time guard against a prior-year date carried forward. */
  publishedWeekdays: Partial<Record<'previewAt' | 'residentOpenAt' | 'openAt', PublishedWeekday>>;
}

const VERIFIED_AT = '2026-07-30T00:00:00-04:00';
/** The Mississauga rows were re-read against a better source on this day (VIL-261). */
const MISSISSAUGA_VERIFIED_AT = '2026-08-02T00:00:00-04:00';
/** The eight-municipality coverage sweep (2026-08-11): every row below carrying this
 * date was researched and then adversarially re-fetched against its source the same
 * day, per the M1 discipline. */
const SWEEP_VERIFIED_AT = '2026-08-11T00:00:00-04:00';

const BRAMPTON_REGISTERED =
  'https://www.brampton.ca/EN/residents/Recreation/Pages/Registered-Programs.aspx';
const CALEDON_PROGRAMS = 'https://www.caledon.ca/en/living-here/recreation-programs.aspx';
const HALTON_HILLS_PROGRAMS = 'https://www.haltonhills.ca/Play/Recreation/Programs';
const AJAX_PROGRAMS =
  'https://ajax.ca/explore/parks-recreation/sports-recreation/recreation-programs/';
const PICKERING_REGISTRATION =
  'https://www.pickering.ca/parks-recreation-culture/recreation-programs/program-registration/';
const WHITBY_REGISTRATION =
  'https://www.whitby.ca/explore-and-enjoy/parks-and-recreation/register-for-a-recreation-program/';
const OSHAWA_PROGRAMS =
  'https://www.oshawa.ca/explore-play/recreation/activeoshawa-registered-programs/';
const AURORA_GUIDE =
  'https://www.aurora.ca/recreation-arts-and-culture/recreation-programs-and-drop-in-activities/program-guide/';

const TORONTO_ARC =
  'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/camps-after-school/after-school-recreation-care/';
const MARKHAM_REGISTRATION =
  'https://www.markham.ca/sports-recreation-fitness/sports-recreation-programs/registration-and-general-information';
const VAUGHAN_PROGRAMS =
  'https://www.vaughan.ca/residential/recreation-programs-and-fitness/recreation-programs';
const RICHMOND_HILL_GUIDE =
  'https://www.richmondhill.ca/en/things-to-do/Community-Recreation-Guide.aspx';
/**
 * The City's own media advisory for this cycle, NOT the recreation landing page
 * (VIL-261). The landing banner reads "View programs August 4 and register August 11"
 * and states no year, no time and no resident split anywhere on the page, so the
 * re-verify sweep can only ever answer `no_year_stated` against it — and, as the live
 * run proved, what it does publish is also incomplete. The advisory carries its own
 * dateline, all three dates and the 7 a.m. time.
 */
const MISSISSAUGA_FALL_ADVISORY =
  'https://www.mississauga.ca/city-of-mississauga-news/news/fall-into-fun-with-city-programs-and-activities/';
const OAKVILLE_REGISTERED_PROGRAMS =
  'https://www.oakville.ca/parks-recreation-culture/programs-activities/registered-programs/';
const BURLINGTON_REGISTERING =
  'https://www.burlington.ca/en/recreation/registering-for-a-program.aspx';

/**
 * Toronto's two after-school streams register on ONE date but have different age bands,
 * so they are separate rows. Toronto is the inverse of its neighbours: the printed date
 * is the RESIDENT date and non-Torontonians follow ten days later under a city-wide
 * rule, so `openAt` here is rule-derived.
 */
const TORONTO_AFTER_SCHOOL = {
  municipality: 'toronto',
  programDomain: 'after_school_care',
  previewAt: null,
  residentOpenAt: '2026-06-05T07:00:00-04:00',
  openAt: '2026-06-15T07:00:00-04:00',
  residentPriorityDays: 10,
  waitlistResponseHours: 36,
  sourceUrl: TORONTO_ARC,
  verifiedAt: VERIFIED_AT,
  publishedWeekdays: { residentOpenAt: 'Friday' },
} as const;

const TORONTO_NON_RESIDENT_RULE =
  'Toronto prints only the resident date; non-residents "can register for a recreation activity 10 days after registration starts for that activity" (plus a $54.90 per-activity surcharge), so the general open is rule-derived, not printed. Waitlist: "You\'ll have up to 36 hours to accept or decline the spot."';

/**
 * Markham runs ONE combined cycle covering fall programs, swim lessons and winter-break
 * camps, so the published dates are recorded once per domain a family might search by.
 * Markham publishes no resident/non-resident tier anywhere on the page — the fields stay
 * null rather than 0, because "not published" is a different claim from "no head start".
 */
const MARKHAM_FALL_2026 = {
  municipality: 'markham',
  cycleLabel: '2026 Fall Programs, Swim Lessons and Winter Break Camps',
  previewAt: '2026-08-03T00:00:00-04:00',
  residentOpenAt: null,
  openAt: '2026-08-11T06:30:00-04:00',
  residentPriorityDays: null,
  waitlistResponseHours: 48,
  ageMinMonths: null,
  ageMaxMonths: null,
  sourceUrl: MARKHAM_REGISTRATION,
  verifiedAt: VERIFIED_AT,
  notes:
    'Published as "Preview starting Aug, 3" and "Register starting Aug. 11 at 6:30 AM" (the comma is a typo in the source). No preview time is published, so it is the start of that day. Waitlist: "You will have 48 hours to decide". The string "non-resident" appears nowhere on Markham\'s registration page — treat the resident fields as not published, not as confirmed absent. One combined cycle covers fall programs, swim lessons and winter-break camps.',
  publishedWeekdays: {},
} as const satisfies Omit<RegistrationWindowSeed, 'programDomain'>;

/** Burlington registers fall+winter youth, fall swim and fall+winter aquatic leadership
 * on one identical schedule; only the cycle label differs. */
const BURLINGTON_FALL_YOUTH = {
  municipality: 'burlington',
  previewAt: '2026-08-12T00:00:00-04:00',
  residentOpenAt: '2026-08-22T09:00:00-04:00',
  openAt: '2026-08-28T09:00:00-04:00',
  residentPriorityDays: 6,
  waitlistResponseHours: 48,
  ageMinMonths: null,
  ageMaxMonths: null,
  sourceUrl: BURLINGTON_REGISTERING,
  verifiedAt: VERIFIED_AT,
  publishedWeekdays: {},
} as const;

const BURLINGTON_TABLE_NOTE =
  'From the Town\'s registration table, columns "Program viewable online | Registration date and time (resident) | Registration date and time (non-resident)". No time is published for the viewable-online date, so the preview is the start of that day. Waitlist: "The spot will be held for only 48 hours."';

export const REGISTRATION_WINDOWS: readonly RegistrationWindowSeed[] = [
  // ── Toronto ──────────────────────────────────────────────────────────────────
  // Toronto's seasonal recreation dates for Fall 2026 are NOT published ("Registration
  // dates will be announced at a later date"), so there is no rec_program row and no
  // swim row — Toronto registers swim inside the seasonal cycle, never separately.
  {
    ...TORONTO_AFTER_SCHOOL,
    cycleLabel: 'After-School Recreation Care (ARC) 2026/2027 school year',
    ageMinMonths: 72,
    ageMaxMonths: 144,
    notes: `"Registration starts on June 5, 2026, at 7 a.m." for the 2026/2027 school year; the program runs September 8, 2026 to June 18, 2027. Ages published as "six to 12 years old" — recorded as 72–144 months; the fine print is "Minimum age: In grade one or six years old on or before the first day of the program. Maximum age: 12 years of age on or after the first day of the program", so a child part-way through age 12 is admitted by the source but only via the tolerance here. ${TORONTO_NON_RESIDENT_RULE}`,
  },
  {
    ...TORONTO_AFTER_SCHOOL,
    cycleLabel: 'Community Leadership After-School Program (CLASP) 2026/2027 school year',
    ageMinMonths: 120,
    ageMaxMonths: 180,
    notes: `Registers on the same date as ARC: "Registration starts on June 5, 2026, at 7 a.m." Ages published as "10 to 15 years old" — recorded as 120–180 months. ${TORONTO_NON_RESIDENT_RULE}`,
  },

  // ── Markham ──────────────────────────────────────────────────────────────────
  { ...MARKHAM_FALL_2026, programDomain: 'rec_program' },
  { ...MARKHAM_FALL_2026, programDomain: 'swim' },
  { ...MARKHAM_FALL_2026, programDomain: 'camp' },

  // ── Vaughan ──────────────────────────────────────────────────────────────────
  // Vaughan registers swim lessons on their OWN dates, two days after general programs —
  // collapsing them into one row would send half the city two days late.
  {
    municipality: 'vaughan',
    programDomain: 'rec_program',
    cycleLabel: 'Fall Session 2026',
    previewAt: '2026-08-05T00:00:00-04:00',
    residentOpenAt: '2026-08-18T07:00:00-04:00',
    openAt: '2026-08-25T07:00:00-04:00',
    residentPriorityDays: 7,
    waitlistResponseHours: 24,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: VAUGHAN_PROGRAMS,
    verifiedAt: VERIFIED_AT,
    notes:
      '"Registration for general programs begins Tuesday, August 18 at 7 a.m. for residents and Tuesday, August 25 at 7 a.m. for non-residents." eGuide viewable from Wednesday, August 5 (no time published — start of day). Session begins Saturday, September 19. The 24-hour waitlist window is published separately at https://www.vaughan.ca/residential/recreation-programs-and-fitness/service-registration/online-account-registration-frequently-asked-questions',
    publishedWeekdays: {
      previewAt: 'Wednesday',
      residentOpenAt: 'Tuesday',
      openAt: 'Tuesday',
    },
  },
  {
    municipality: 'vaughan',
    programDomain: 'swim',
    cycleLabel: 'Fall Session 2026',
    previewAt: '2026-08-05T00:00:00-04:00',
    residentOpenAt: '2026-08-20T07:00:00-04:00',
    openAt: '2026-08-27T07:00:00-04:00',
    residentPriorityDays: 7,
    waitlistResponseHours: 24,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: VAUGHAN_PROGRAMS,
    verifiedAt: VERIFIED_AT,
    notes:
      '"Registration for swim lessons and aquatic leadership courses begins Thursday, August 20 at 7 a.m. for residents and Thursday, August 27 at 7 a.m. for non-residents." Same eGuide preview as the general-programs cycle; 24-hour waitlist window from the online-account registration FAQ.',
    publishedWeekdays: {
      previewAt: 'Wednesday',
      residentOpenAt: 'Thursday',
      openAt: 'Thursday',
    },
  },

  // ── Richmond Hill ────────────────────────────────────────────────────────────
  // Four cycles out to Summer 2027 with a uniform 7-day resident head start, but NO time
  // of day anywhere in the Town's calendar — every instant is the start of the published
  // local day, and each row's note says so.
  {
    municipality: 'richmond_hill',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: '2026-08-25T00:00:00-04:00',
    openAt: '2026-09-01T00:00:00-04:00',
    residentPriorityDays: 7,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: RICHMOND_HILL_GUIDE,
    verifiedAt: VERIFIED_AT,
    notes:
      '"Fall Program Registration | Resident: Tuesday, August 25, 2026 | Non-resident: Tuesday, September 1, 2026." No time of day is published for any Richmond Hill cycle, so both instants are the start of the published local day. Automatic waitlists launch with this cycle but the response window is published only as "a limited amount of time" — left null rather than borrowed from another town. Non-residents pay a $15 per-program fee.',
    publishedWeekdays: { residentOpenAt: 'Tuesday', openAt: 'Tuesday' },
  },
  {
    municipality: 'richmond_hill',
    programDomain: 'rec_program',
    cycleLabel: 'Winter 2026-2027',
    previewAt: null,
    residentOpenAt: '2026-11-24T00:00:00-05:00',
    openAt: '2026-12-01T00:00:00-05:00',
    residentPriorityDays: 7,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: RICHMOND_HILL_GUIDE,
    verifiedAt: VERIFIED_AT,
    notes:
      '"Winter Program Registration | Resident: Tuesday, November 24, 2026 | Non-resident: Tuesday, December 1, 2026." No time of day published — instants are the start of the published local day.',
    publishedWeekdays: { residentOpenAt: 'Tuesday', openAt: 'Tuesday' },
  },
  {
    municipality: 'richmond_hill',
    programDomain: 'rec_program',
    cycleLabel: 'Spring 2027',
    previewAt: null,
    residentOpenAt: '2027-02-23T00:00:00-05:00',
    openAt: '2027-03-02T00:00:00-05:00',
    residentPriorityDays: 7,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: RICHMOND_HILL_GUIDE,
    verifiedAt: VERIFIED_AT,
    notes:
      '"Spring Program Registration 2027 | Resident Registration: Tuesday, February 23, 2027 | Non-Resident Registration: Tuesday, March 2, 2027." No time of day published — instants are the start of the published local day.',
    publishedWeekdays: { residentOpenAt: 'Tuesday', openAt: 'Tuesday' },
  },
  {
    municipality: 'richmond_hill',
    programDomain: 'rec_program',
    cycleLabel: 'Summer 2027',
    previewAt: null,
    residentOpenAt: '2027-05-25T00:00:00-04:00',
    openAt: '2027-06-01T00:00:00-04:00',
    residentPriorityDays: 7,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: RICHMOND_HILL_GUIDE,
    verifiedAt: VERIFIED_AT,
    notes:
      '"Summer Program Registration 2027 | Resident Registration: Tuesday, May 25, 2027 | Non-Resident Registration: Tuesday, June 1, 2027." No time of day published — instants are the start of the published local day.',
    publishedWeekdays: { residentOpenAt: 'Tuesday', openAt: 'Tuesday' },
  },

  // ── Mississauga ──────────────────────────────────────────────────────────────
  // One bundled event covers fall programs AND winter camps, recorded once per domain.
  // Re-read off the City's media advisory on 2026-08-02 (VIL-261), which publishes the
  // resident/non-resident split and the 7 a.m. time the landing banner omits — the
  // banner's bare "register August 11" is the RESIDENT date, and storing it as the
  // general open told every non-resident family to act a week early.
  ...(['rec_program', 'camp'] as const).map((programDomain) => ({
    municipality: 'mississauga' as const,
    programDomain,
    cycleLabel: 'Fall 2026 Programs and Winter Camps',
    previewAt: '2026-08-04T00:00:00-04:00',
    residentOpenAt: '2026-08-11T07:00:00-04:00',
    openAt: '2026-08-18T07:00:00-04:00',
    residentPriorityDays: 7,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: MISSISSAUGA_FALL_ADVISORY,
    verifiedAt: MISSISSAUGA_VERIFIED_AT,
    notes:
      '"Program browsing opens Tuesday, August 4 | Resident registration begins Tuesday, August 11 at 7 a.m. | Non-resident registration begins Tuesday, August 18 at 7 a.m.", under "Fall registration at a glance" in the City media advisory datelined "City services | July 31, 2026" — which is also the page text that supplies the year. Browsing publishes no time, so the preview instant is the start of that local day. No waitlist response window is published. The recreation landing page carries only "View programs August 4 and register August 11": no year, no time, and the resident date presented as if it were the only one.',
    publishedWeekdays: {
      previewAt: 'Tuesday',
      residentOpenAt: 'Tuesday',
      openAt: 'Tuesday',
    } as const,
  })),

  // ── Oakville ─────────────────────────────────────────────────────────────────
  {
    municipality: 'oakville',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: '2026-08-04T00:00:00-04:00',
    residentOpenAt: '2026-08-11T07:00:00-04:00',
    openAt: '2026-08-25T00:00:00-04:00',
    residentPriorityDays: 14,
    waitlistResponseHours: 48,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: OAKVILLE_REGISTERED_PROGRAMS,
    verifiedAt: VERIFIED_AT,
    notes:
      '"Opens Tuesday, August 11 at 7 a.m." and "Program options will be available to browse online starting August 4." The non-resident date is NOT printed; it is derived from the published rule "Registered program registration for non-residents opens 14 days after Oakville resident registration begins", and no non-resident time is published, so it is the start of that day. Waitlist: "If you do not respond within 48 hours, your spot will be offered to the next person." Oakville runs Winter/Spring/Fall cycles only — there is no summer sessional cycle. Its published age math: ages 6+ are calculated as of December 31, preschool ages 0–5 from the course start date. NOT AUTO-VERIFIABLE (VIL-261): this is the Town\'s only page carrying these dates — its registration-help, program-guidelines, aquatics and news pages publish none — and it states no year beside them, only "Copyright © 2026" in the footer. The weekday it does print ("Tuesday, August 11") is what pins the year, and the sweep cannot read a weekday as a year, so this row stays human-verified by design rather than by oversight.',
    publishedWeekdays: { residentOpenAt: 'Tuesday' },
  },

  // ── Burlington ───────────────────────────────────────────────────────────────
  // The fall ADULT cycle (resident Aug 20 7 a.m., general Aug 28 9 a.m., 8-day head
  // start) is verified but deliberately omitted: it publishes no age band, so it would
  // match every child in the family. The radar is a children's-programs surface.
  {
    ...BURLINGTON_FALL_YOUTH,
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026 and Winter 2027 youth programs',
    notes: `"Fall and winter youth | Aug. 12 | Aug. 22 9 a.m. | Aug. 28 9 a.m." — ONE registration event covers both the fall and winter youth seasons, which is why the label names both. ${BURLINGTON_TABLE_NOTE}`,
  },
  {
    ...BURLINGTON_FALL_YOUTH,
    programDomain: 'swim',
    cycleLabel: 'Fall 2026 swimming lessons',
    notes: `"Fall swimming lessons | Aug. 12 | Aug. 22 9 a.m. | Aug. 28 9 a.m." ${BURLINGTON_TABLE_NOTE}`,
  },
  {
    ...BURLINGTON_FALL_YOUTH,
    programDomain: 'swim',
    cycleLabel: 'Fall 2026 and Winter 2027 Aquatic Leadership programs',
    notes: `"Fall and winter Aquatic Leadership programs | Aug. 12 | Aug. 22 9 a.m. | Aug. 28 9 a.m." — one event covers both seasons. ${BURLINGTON_TABLE_NOTE}`,
  },

  // ── Halton Hills ─────────────────────────────────────────────────────────────
  // NO ROWS. The Town's registration page still reads "Summer Registration On Now!" and
  // publishes no seasonal date table; nothing for Fall 2026 onward exists to record.
  // Its standing policy (7-day delay for non-taxpayers, +20% fee) is a rule without a
  // date, and a rule alone cannot make a window.
  // ── Brampton ─────────────────────────────────────────────────────────────────
  // Brampton splits swim/skate 16 days after general rec, and its Winter Break
  // Camps register inside the FALL window — a parent waiting for a "winter" date
  // misses them. Pages print weekdays but no year; 2026 confirmed by weekday math
  // (Mon Aug 24 / Wed Sep 9 exist only in 2026) plus the live page banner.
  {
    municipality: 'brampton',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: '2026-08-24T07:00:00-04:00',
    openAt: '2026-09-07T07:00:00-04:00',
    residentPriorityDays: 14,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: BRAMPTON_REGISTERED,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'General Interest, Sports and STEAM programs plus Brampton Sports League. Residents Monday August 24 at 7 a.m.; non-residents Monday September 7 at 7 a.m. Source prints weekdays but no year — 2026 confirmed by weekday math and the live banner.',
    publishedWeekdays: { residentOpenAt: 'Monday', openAt: 'Monday' },
  },
  {
    municipality: 'brampton',
    programDomain: 'swim',
    cycleLabel: 'Fall 2026 (Learn to Swim and Learn to Skate)',
    previewAt: null,
    residentOpenAt: '2026-09-09T07:00:00-04:00',
    openAt: '2026-09-21T07:00:00-04:00',
    residentPriorityDays: 12,
    waitlistResponseHours: 24,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: BRAMPTON_REGISTERED,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      "Aquatics and skating register on their OWN dates, 16 days after general rec: residents Wednesday September 9 at 7 a.m., non-residents Monday September 21 at 7 a.m. Waitlist pending-confirmation is 24 hours (Brampton how-to page), not Toronto's 36.",
    publishedWeekdays: { residentOpenAt: 'Wednesday', openAt: 'Monday' },
  },
  {
    municipality: 'brampton',
    programDomain: 'camp',
    cycleLabel: 'Winter Break Camps December 2026',
    previewAt: null,
    residentOpenAt: '2026-08-24T07:00:00-04:00',
    openAt: '2026-09-07T07:00:00-04:00',
    residentPriorityDays: 14,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: BRAMPTON_REGISTERED,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'December winter-break camps register in the FALL window (residents August 24, non-residents September 7) — seeded as its own row so the radar fires in August, not December.',
    publishedWeekdays: { residentOpenAt: 'Monday', openAt: 'Monday' },
  },

  // ── Caledon ──────────────────────────────────────────────────────────────────
  {
    municipality: 'caledon',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: '2026-08-12T07:00:00-04:00',
    residentOpenAt: '2026-08-19T07:00:00-04:00',
    openAt: '2026-08-26T07:00:00-04:00',
    residentPriorityDays: 7,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: CALEDON_PROGRAMS,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'One blanket window for all registered seasonal programs, three stages: online catalogue viewable Wednesday August 12 at 7 a.m. (browse-only), residents Wednesday August 19 at 7 a.m., non-residents Wednesday August 26 at 7 a.m. Page carries "dates are subject to change" — the weekly verify sweep is the guard.',
    publishedWeekdays: { previewAt: 'Wednesday', residentOpenAt: 'Wednesday', openAt: 'Wednesday' },
  },

  // ── Halton Hills ─────────────────────────────────────────────────────────────
  // The gap the founder personally hit on live-gate day one (L7G, 2026-08-11):
  // dates were unpublished on 2026-07-30, published by 2026-08-11.
  {
    municipality: 'halton_hills',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: '2026-09-01T07:00:00-04:00',
    openAt: '2026-09-08T07:00:00-04:00',
    residentPriorityDays: 7,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: HALTON_HILLS_PROGRAMS,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'One opening for all rec programs (fall swim, fitness, children\'s): taxpayers Tuesday September 1 at 7 a.m. Only the taxpayer date is printed; non-taxpayer open is the published "delayed 7 days" rule — September 8 is rule-derived with the time carried from the taxpayer open, and non-taxpayers pay a 20% surcharge.',
    publishedWeekdays: { residentOpenAt: 'Tuesday' },
  },

  // ── Ajax ─────────────────────────────────────────────────────────────────────
  // Aquatics opens BEFORE general rec (two distinct resident alarms), and the
  // Active Ajax portal warns account activation "can take 24 business hours" —
  // any prep message must say: create the account well before the 7 a.m. open.
  {
    municipality: 'ajax',
    programDomain: 'swim',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: '2026-08-18T07:00:00-04:00',
    openAt: '2026-08-26T07:00:00-04:00',
    residentPriorityDays: 8,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: AJAX_PROGRAMS,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'Aquatics: residents Tuesday August 18 at 7 a.m., non-residents Wednesday August 26. Active Ajax account activation can take 24 business hours — parents need the account BEFORE the open.',
    publishedWeekdays: { residentOpenAt: 'Tuesday', openAt: 'Wednesday' },
  },
  {
    municipality: 'ajax',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: '2026-08-20T07:00:00-04:00',
    openAt: '2026-08-26T07:00:00-04:00',
    residentPriorityDays: 6,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: AJAX_PROGRAMS,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'All other rec programs: residents Thursday August 20 at 7 a.m., non-residents Wednesday August 26. Same portal caveat as aquatics: account activation can take 24 business hours.',
    publishedWeekdays: { residentOpenAt: 'Thursday', openAt: 'Wednesday' },
  },

  // ── Pickering ────────────────────────────────────────────────────────────────
  // Pickering INVERTS its neighbours: aquatics registers a week AFTER general rec
  // (Ajax/Whitby/Aurora open aquatics first) — no shared mental model across
  // cities, which is exactly why the radar exists. Non-resident lines print a
  // date but no time — start-of-local-day per the dataset convention.
  {
    municipality: 'pickering',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: '2026-08-20T07:00:00-04:00',
    openAt: '2026-08-27T00:00:00-04:00',
    residentPriorityDays: 7,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: PICKERING_REGISTRATION,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'Fitness and Leisure programs: residents Thursday August 20 at 7 a.m.; non-residents Thursday August 27 — date printed with no time, recorded as start of the local day.',
    publishedWeekdays: { residentOpenAt: 'Thursday', openAt: 'Thursday' },
  },
  {
    municipality: 'pickering',
    programDomain: 'swim',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: '2026-08-27T07:00:00-04:00',
    openAt: '2026-09-03T00:00:00-04:00',
    residentPriorityDays: 7,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: PICKERING_REGISTRATION,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'Aquatics registers a week AFTER general rec: residents Thursday August 27 at 7 a.m.; non-residents Thursday September 3 — date printed with no time, recorded as start of the local day.',
    publishedWeekdays: { residentOpenAt: 'Thursday', openAt: 'Thursday' },
  },

  // ── Whitby ───────────────────────────────────────────────────────────────────
  // Whitby opens at 9 a.m., not the 7 a.m. most of the GTA uses.
  {
    municipality: 'whitby',
    programDomain: 'swim',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: '2026-08-18T09:00:00-04:00',
    openAt: '2026-08-26T09:00:00-04:00',
    residentPriorityDays: 8,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: WHITBY_REGISTRATION,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'All aquatics programs: residents Tuesday August 18 at 9 a.m., non-residents Wednesday August 26 at 9 a.m.',
    publishedWeekdays: { residentOpenAt: 'Tuesday', openAt: 'Wednesday' },
  },
  {
    municipality: 'whitby',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: '2026-08-20T09:00:00-04:00',
    openAt: '2026-08-26T09:00:00-04:00',
    residentPriorityDays: 6,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: WHITBY_REGISTRATION,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'General (non-aquatics) rec programs: residents Thursday August 20 at 9 a.m., non-residents Wednesday August 26 at 9 a.m.',
    publishedWeekdays: { residentOpenAt: 'Thursday', openAt: 'Wednesday' },
  },

  // ── Oshawa ───────────────────────────────────────────────────────────────────
  // No resident/non-resident split at all — one open for everyone. The PRACTICAL
  // action time is 8 a.m., when the virtual waiting room opens, an hour before
  // the nominal 9 a.m. — a "be ready at 9" reminder would be an hour late.
  // Fall section prints no year; 2026 read from the live page's own context on
  // the fetch date, flagged here as an inference.
  {
    municipality: 'oshawa',
    programDomain: 'swim',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: null,
    openAt: '2026-08-18T09:00:00-04:00',
    residentPriorityDays: null,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: OSHAWA_PROGRAMS,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'Swimming registers Tuesday August 18 at 9 a.m., one open for all (no resident priority). Virtual waiting room opens at 8 a.m. — the practical be-ready time. Year not printed; 2026 inferred from live-page context on 2026-08-11.',
    publishedWeekdays: { openAt: 'Tuesday' },
  },
  {
    municipality: 'oshawa',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: null,
    openAt: '2026-08-20T09:00:00-04:00',
    residentPriorityDays: null,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: OSHAWA_PROGRAMS,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'General rec programs register Thursday August 20 at 9 a.m., one open for all. Virtual waiting room opens at 8 a.m. Year not printed; 2026 inferred from live-page context on 2026-08-11.',
    publishedWeekdays: { openAt: 'Thursday' },
  },
  {
    municipality: 'oshawa',
    programDomain: 'camp',
    cycleLabel: 'Holiday Camp (winter break) — registers in the Fall 2026 window',
    previewAt: null,
    residentOpenAt: null,
    openAt: '2026-08-20T09:00:00-04:00',
    residentPriorityDays: null,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: OSHAWA_PROGRAMS,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'Holiday Camp registers with the general fall open (Thursday August 20 at 9 a.m.) — seeded as its own row so the radar fires in August, not December.',
    publishedWeekdays: { openAt: 'Thursday' },
  },

  // ── Aurora ───────────────────────────────────────────────────────────────────
  // Aurora opens at 6 a.m. — the earliest clock time in the GTA dataset; a
  // generic "7 a.m." assumption would be an hour late. The general-rec resident
  // open (Aug 10) had already passed on the verification date; the row stays for
  // the still-upcoming non-resident open and the cycle's source of record.
  {
    municipality: 'aurora',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: '2026-08-10T06:00:00-04:00',
    openAt: '2026-08-17T06:00:00-04:00',
    residentPriorityDays: 7,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: AURORA_GUIDE,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'General registered rec programs: residents Monday August 10 at 6 a.m., non-residents Monday August 17 at 6 a.m.',
    publishedWeekdays: { residentOpenAt: 'Monday', openAt: 'Monday' },
  },
  {
    municipality: 'aurora',
    programDomain: 'swim',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: '2026-08-12T06:00:00-04:00',
    openAt: '2026-08-19T06:00:00-04:00',
    residentPriorityDays: 7,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: AURORA_GUIDE,
    verifiedAt: SWEEP_VERIFIED_AT,
    notes:
      'Aquatics / Learn to Swim: residents Wednesday August 12 at 6 a.m., non-residents Wednesday August 19 at 6 a.m.',
    publishedWeekdays: { residentOpenAt: 'Wednesday', openAt: 'Wednesday' },
  },
];
