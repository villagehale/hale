import type { Municipality, ProgramDomain } from '@hale/db';
import type { TorontoDistrict } from './fsa-municipalities';

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

/** The three dated fields a row carries. Named once here because two different
 * questions are asked of them — which weekday the source printed beside one, and which
 * of them this row did not read off its own source. */
export type RegistrationWindowDateField = 'previewAt' | 'residentOpenAt' | 'openAt';

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
  /**
   * Which part of the municipality this morning is for. Absent (city-wide) is
   * every row except Toronto's seasonal cycle, which opens on two mornings.
   */
  district?: TorontoDistrict | null;
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
  publishedWeekdays: Partial<Record<RegistrationWindowDateField, PublishedWeekday>>;
  /**
   * Fields this row did NOT read off its own source — carried from a sibling row of the
   * same published cycle. Seed-only, like `publishedWeekdays`, and ABSENT is the ordinary
   * case: every field was read off `sourceUrl`.
   *
   * It exists because "inferred" is a different claim from "verified", and a sentence in
   * `notes` is a claim nothing can act on. The weekly re-verify sweep reads this and
   * refuses to count an inferred field as confirmed evidence, so a page that is silent
   * about the field can never quietly launder the inference into a confirmation.
   */
  inferredFields?: readonly RegistrationWindowDateField[];
}

const VERIFIED_AT = '2026-07-30T00:00:00-04:00';
/** The Mississauga rows were re-read against a better source on this day (VIL-261). */
const MISSISSAUGA_VERIFIED_AT = '2026-08-02T00:00:00-04:00';
/** The eight-municipality coverage sweep (2026-08-11): every row below carrying this
 * date was researched and then adversarially re-fetched against its source the same
 * day, per the M1 discipline. */
const SWEEP_VERIFIED_AT = '2026-08-11T00:00:00-04:00';
/** Whitchurch-Stouffville joined the radar on this day, read off its own Play Book PDF. */
const WHITCHURCH_STOUFFVILLE_VERIFIED_AT = '2026-09-17T00:00:00-04:00';
/** The York-region round (2026-09-18): Newmarket, King, East Gwillimbury, Georgina and
 * Uxbridge. Every row below carrying this date was read off the town's own page or PDF
 * the same day — the two PDFs downloaded and text-extracted rather than searched for,
 * because both towns' landing pages print no dates at all. */
const YORK_ROUND_VERIFIED_AT = '2026-09-18T00:00:00-04:00';

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
/**
 * The Town's own Fall 2026 Play Book, page 2 — the PDF linked from
 * townofws.ca/play/recreation/programs/play-book/, not the landing page. The landing
 * page carries no dates; the Play Book prints both, with weekdays and the clock time.
 */
const WHITCHURCH_STOUFFVILLE_PLAY_BOOK =
  'https://www.townofws.ca/media/gvyjvnnq/f2026_playbook_tagged-2.pdf';
/**
 * The Town's own Recreation & Culture FALL ACTIVITIES 2026 magazine, page 2 — the PDF,
 * not newmarket.ca/recreation-parks/programs-camps, which prints no date anywhere. The
 * slug is per-season (cf. `summer-seasonal-magazine`) and next year's fall guide will
 * overwrite it in place, so a re-verify against this URL can silently read a different
 * cycle: check the magazine's own "Fall Activities 2026" footer before trusting it.
 */
const NEWMARKET_FALL_MAGAZINE = 'https://www.newmarket.ca/media/file/fall-seasonal-magazine';
/** King publishes its dates in the "Registration Start Dates" section of this page and
 * nowhere else that a non-browser client can read: both of the Township's news releases
 * for this cycle answer HTTP 403 to every client, and the copies that ARE reachable are
 * the 2025 releases — the stale-year trap with the door held open. */
const KING_RECREATION = 'https://www.king.ca/recreation';
const EAST_GWILLIMBURY_GUIDE =
  'https://www.eastgwillimbury.ca/en/living-in-eg/health-and-active-living-guide.aspx';
/**
 * Georgina's PROGRAMS page, and deliberately not its recreation-general-information
 * page, which on the same day still carried the SPRING block ("Mar. 3 ... Mar. 10").
 * Two Georgina pages, two different cycles, neither printing a year.
 */
const GEORGINA_PROGRAMS = 'https://www.georgina.ca/things-do/recreation/programs-0';
/** The accessible PDF of Uxplore: Fall 2026 & Winter 2027 Community Guide, linked as
 * "here" from uxbridge.ca/explore-and-play/recreation/register-for-a-program. The
 * landing page prints no dates and its embedded flipbook is still titled Fall 2025. */
const UXBRIDGE_UXPLORE_GUIDE = 'https://www.uxbridge.ca/public/download/files/360410';

const TORONTO_FALL_2026_RELEASE =
  'https://www.toronto.ca/news/city-of-toronto-releases-listings-for-fall-recreation-activities/';
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

const TORONTO_FALL_2026_QUOTE =
  'Release of August 24, 2026: "Wednesday, September 9 at 7 a.m. – Early local registration opens to eligible residents for all free centres"; "Tuesday, September 15 at 7 a.m. – Etobicoke and Toronto East York registration"; "Wednesday, September 16 at 7 a.m. – North York and Scarborough registration"; "Week of Saturday, September 26 – Most fall programming begins". Listings were browsable from the release date (the preview). Early local registration (free centres only, September 9) is a proximity rule, not a residency one, so it is not residentOpenAt.';

/**
 * Toronto's Fall 2026 seasonal cycle, one row per community-council area. The
 * release opens Etobicoke and Toronto East York on Tuesday Sept 15 and North York
 * and Scarborough on Wednesday Sept 16. A single city-wide morning told a North
 * York family the Etobicoke time (VIL-360). The non-resident date is ten days
 * after THAT area's resident morning, the same city-wide rule the after-school
 * rows use. Swim registers inside these mornings, not on its own.
 */
const TORONTO_FALL_MORNINGS: readonly {
  district: TorontoDistrict;
  residentOpenAt: string;
  openAt: string;
  weekday: 'Tuesday' | 'Wednesday';
  morning: string;
}[] = [
  {
    district: 'etobicoke_york',
    residentOpenAt: '2026-09-15T07:00:00-04:00',
    openAt: '2026-09-25T07:00:00-04:00',
    weekday: 'Tuesday',
    morning: 'Etobicoke',
  },
  {
    district: 'toronto_east_york',
    residentOpenAt: '2026-09-15T07:00:00-04:00',
    openAt: '2026-09-25T07:00:00-04:00',
    weekday: 'Tuesday',
    morning: 'Toronto and East York',
  },
  {
    district: 'north_york',
    residentOpenAt: '2026-09-16T07:00:00-04:00',
    openAt: '2026-09-26T07:00:00-04:00',
    weekday: 'Wednesday',
    morning: 'North York',
  },
  {
    district: 'scarborough',
    residentOpenAt: '2026-09-16T07:00:00-04:00',
    openAt: '2026-09-26T07:00:00-04:00',
    weekday: 'Wednesday',
    morning: 'Scarborough',
  },
];

function torontoFallSeed(
  morning: (typeof TORONTO_FALL_MORNINGS)[number],
): Omit<RegistrationWindowSeed, 'programDomain'> {
  return {
    municipality: 'toronto',
    district: morning.district,
    cycleLabel: 'Fall 2026',
    previewAt: '2026-08-24T00:00:00-04:00',
    residentOpenAt: morning.residentOpenAt,
    openAt: morning.openAt,
    residentPriorityDays: 10,
    waitlistResponseHours: 36,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: TORONTO_FALL_2026_RELEASE,
    verifiedAt: '2026-09-17T00:00:00-04:00',
    notes: `${TORONTO_FALL_2026_QUOTE} This row is the ${morning.morning} morning. ${TORONTO_NON_RESIDENT_RULE}`,
    publishedWeekdays: { residentOpenAt: morning.weekday },
  };
}

/**
 * Markham runs ONE combined cycle covering fall programs, swim lessons and winter-break
 * camps, so the published dates are recorded once per domain a family might search by.
 *
 * VIL-347 — the city page prints ONE unlabelled date ("Register starting Aug. 11"), and
 * for four weeks these rows read it as the date for everyone. Markham's own course pages
 * tier it: the Aug 11 morning is the RESIDENT one and everybody else registers Aug 12.
 * The city page is still the `sourceUrl` (it is the page a parent is sent to), so the
 * mislabel it prints is handled in the comparison rather than by pointing this row at a
 * single course; see `compareWindow`'s unlabelled-single-date rule.
 */
const MARKHAM_FALL_2026 = {
  municipality: 'markham',
  cycleLabel: '2026 Fall Programs, Swim Lessons and Winter Break Camps',
  previewAt: '2026-08-03T00:00:00-04:00',
  residentOpenAt: '2026-08-11T06:30:00-04:00',
  openAt: '2026-08-12T06:30:00-04:00',
  residentPriorityDays: 1,
  waitlistResponseHours: 48,
  ageMinMonths: null,
  ageMaxMonths: null,
  sourceUrl: MARKHAM_REGISTRATION,
  verifiedAt: VERIFIED_AT,
  notes:
    'Published as "Preview starting Aug, 3" and "Register starting Aug. 11 at 6:30 AM" (the comma is a typo in the source). No preview time is published, so it is the start of that day. Waitlist: "You will have 48 hours to decide". The registration page prints that one date unlabelled and the string "non-resident" appears nowhere on it, but Markham\'s own PerfectMind course pages for this cycle tier it — "ResidentsRegistrationDateValue":"2026-08-11T06:30:00" and "PublicRegistrationStartDateValue":"2026-08-12T06:30:00" on both checked-in fixtures (lib/channel/spots/fixtures/open-window-markham.html, "Chess: Preschool", categories "REC: Programs - Specialty 1 - Resident / - Non-Resident"; and open-window-open-markham.html, "LEGO: Preschool", "REC: Programs - Variety 1"). One combined cycle covers fall programs, swim lessons and winter-break camps. Both fixtures are REC: Programs courses, so the head start is READ for rec_program and INFERRED for swim and camp on the strength of the shared cycle label — carried in `inferredFields` on those two rows, not just in this sentence.',
  publishedWeekdays: {},
} as const satisfies Omit<RegistrationWindowSeed, 'programDomain'>;

/**
 * Markham's one-day head start is read off two REC: Programs course pages of this cycle.
 * No swim or camp course page for it is checked in, so those two rows carry the tier on
 * the strength of the shared cycle label — an inference, named where the sweep can act on
 * it. Pull a live swim or camp course page for the cycle into the fixtures and this goes.
 */
const MARKHAM_INFERRED_TIER = ['residentOpenAt'] as const;

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

/**
 * Whitchurch-Stouffville runs ONE window for the whole Play Book. The Swimming section
 * (page 48) registers in it, and so do the Winter Break Camps (Dec 21–23 and Dec 29–30),
 * which is why the camp row below carries the fall dates and a December cycle label —
 * the radar has to fire in August, not in December.
 *
 * NOON, which is the outlier in this dataset: every other town here opens between 6 and
 * 9 a.m., so a carried-over "7 a.m." would put a Stouffville parent five hours early.
 * No waitlist window and no preview date are published anywhere in the Play Book, so
 * both stay null rather than 0 — "not published" is a different claim from "none".
 */
const WHITCHURCH_STOUFFVILLE_FALL_2026 = {
  municipality: 'whitchurch_stouffville',
  previewAt: null,
  residentOpenAt: '2026-08-25T12:00:00-04:00',
  openAt: '2026-09-01T12:00:00-04:00',
  residentPriorityDays: 7,
  waitlistResponseHours: null,
  ageMinMonths: null,
  ageMaxMonths: null,
  sourceUrl: WHITCHURCH_STOUFFVILLE_PLAY_BOOK,
  verifiedAt: WHITCHURCH_STOUFFVILLE_VERIFIED_AT,
  publishedWeekdays: { residentOpenAt: 'Tuesday', openAt: 'Tuesday' },
} as const;

const WHITCHURCH_STOUFFVILLE_PAGE_TWO =
  'Play Book page 2, verbatim: "Fall 2026 Registration — Residents: Tuesday, August 25, 2026, Online and in–person at 12 PM, noon"; "Non-Residents: Tuesday, September 1, 2026, Online and in–person at 12 PM, noon"; "Non-residents are subject to a 20% surcharge to register in Town programs"; "Most programs begin September 28, 2026". Registration is at townofws.ca/active, and the Town asks for an Online Account Form plus proof of residency before the resident date — account setup takes up to 48 hours.';

/**
 * Newmarket runs ONE window for the whole magazine: the Swimming section on page 26
 * reprints the same two dates rather than publishing its own. The only weekday printed
 * anywhere in the guide is in the Mayor's letter, beside the RESIDENT date — so that is
 * the only field `publishedWeekdays` can guard here.
 */
const NEWMARKET_FALL_2026 = {
  municipality: 'newmarket',
  previewAt: null,
  residentOpenAt: '2026-08-19T08:00:00-04:00',
  openAt: '2026-08-26T08:00:00-04:00',
  residentPriorityDays: 7,
  waitlistResponseHours: null,
  ageMinMonths: null,
  ageMaxMonths: null,
  sourceUrl: NEWMARKET_FALL_MAGAZINE,
  verifiedAt: YORK_ROUND_VERIFIED_AT,
  publishedWeekdays: { residentOpenAt: 'Wednesday' },
} as const;

const NEWMARKET_PAGE_TWO =
  'Fall Activities 2026 magazine, page 2, verbatim: "2026 Fall Registration" / "Registration Dates" / "Resident Registration" "August 19 at 8 a.m." / "Non-Resident Registration" "August 26 at 8 a.m." The Mayor\'s letter on the same page carries the only weekday in the whole guide: "save the date for resident registration on Wednesday, August 19 at 8 a.m." No preview date, no waitlist window and no non-resident surcharge are published anywhere in it, so all three stay null. Registration is on Xplor at newmarket.perfectmind.com; the guide asks parents to "Have your Xplor account created and ready to go before registration opens".';

/**
 * King publishes a DATE and never a clock, so every instant here is the start of the
 * published local day — naming a time would invent the one fact the Township withheld.
 *
 * The Fall 2026 RESIDENT date is not printed on any page reachable without a browser
 * session, so there is no Fall 2026 rec_program row: the one fall date the Township
 * prints is the non-resident AQUATICS one, and that is the only fall row below.
 */
const KING_SWIM_FALL_2026 = {
  municipality: 'king',
  programDomain: 'swim',
  cycleLabel: 'Fall 2026',
  previewAt: null,
  residentOpenAt: null,
  openAt: '2026-08-21T00:00:00-04:00',
  residentPriorityDays: null,
  waitlistResponseHours: null,
  ageMinMonths: null,
  ageMaxMonths: null,
  sourceUrl: KING_RECREATION,
  verifiedAt: YORK_ROUND_VERIFIED_AT,
  publishedWeekdays: {},
} as const;

const KING_WINTER_QUOTE =
  'king.ca/recreation, "Registration Start Dates", verbatim: "Winter 2027 Recreation & Aquatic Programs" / "Winter session: January 11 - March 31, 2027" / "Programs are viewable online as of November 23, 2026." / "Registration opens on December 7 at townshipofking.perfectmind.com" / "Aquatics program registration for non-residents opens on December 11, 2026." No clock time and no weekday are printed for any King date, so each instant is the start of the published local day.';

/**
 * Georgina publishes the fall window on its PROGRAMS page. On the same day its
 * recreation-general-information page still carried the SPRING block, un-updated —
 * two pages, two cycles, neither printing a year. The programs page is the citation.
 */
const GEORGINA_FALL_2026 = {
  municipality: 'georgina',
  previewAt: null,
  residentOpenAt: '2026-08-18T08:30:00-04:00',
  openAt: '2026-08-25T08:30:00-04:00',
  residentPriorityDays: 7,
  waitlistResponseHours: null,
  ageMinMonths: null,
  ageMaxMonths: null,
  sourceUrl: GEORGINA_PROGRAMS,
  verifiedAt: YORK_ROUND_VERIFIED_AT,
  publishedWeekdays: {},
} as const;

const GEORGINA_PROGRAMS_QUOTE =
  'georgina.ca/things-do/recreation/programs-0, verbatim: "Fall program registration" / "Aug. 18 at 8:30 a.m. - residents" / "Aug. 25 at 8:30 a.m. - non-residents". No year and no weekday are printed, so the stale-year weekday guard cannot cover this row: the year is evidenced instead by the July 2025 snapshot of the SAME page, which read "Summer program registration is now open / Resident registration will open on Tuesday, June 3 at 8:30 a.m." CITE THIS PAGE, not georgina.ca/things-do/recreation/recreation-general-information, which on 2026-09-18 still carried the Spring block ("Resident registration will open on Mar. 3 at 8:30 a.m. Non-resident registration will open on Mar. 10 at 8:30 a.m."). Waitlists are published as a practice and not a window: "Staff monitor all waitlists regularly to create availability for programs or lessons in demand when possible."';

/**
 * East Gwillimbury publishes a date and no clock, so both instants are the start of the
 * published local day. There is no guide PDF — the page itself is the source.
 */
const EAST_GWILLIMBURY_FALL_2026 = {
  municipality: 'east_gwillimbury',
  previewAt: null,
  residentOpenAt: '2026-08-20T00:00:00-04:00',
  openAt: '2026-08-27T00:00:00-04:00',
  residentPriorityDays: 7,
  waitlistResponseHours: null,
  ageMinMonths: null,
  ageMaxMonths: null,
  sourceUrl: EAST_GWILLIMBURY_GUIDE,
  verifiedAt: YORK_ROUND_VERIFIED_AT,
  publishedWeekdays: {},
} as const;

const EAST_GWILLIMBURY_QUOTE =
  'eastgwillimbury.ca Health and Active Living Guide page, verbatim: "Fall 2026 and Winter 2027 Health and Active Living Guide" / "Fall Registration:" "August 20 for residents and August 27 for non-residents" / "Registration for ActiveNet users listed as an East Gwillimbury resident open a week before users not listed as a resident." THE TRAP A SHARON OR MOUNT ALBERT PARENT NEEDS: "For resident registration, the city included in your address must be \'East Gwillimbury.\' The system will not recognize Sharon, Mount Albert, Queensville, etc. as residential addresses." No clock time and no weekday are printed, so both instants are the start of the published local day; the year is evidenced by the May 2026 snapshot of the same URL, which carried the Spring and Summer guide instead. Registration is on ActiveNet ("iReg").';

/**
 * Uxbridge is DURHAM, not York — it is on the radar because the family is, not because
 * the region is. Its rows are the best-sourced in this round: the guide prints weekday,
 * full date AND clock for both cycles, and prints the fall/winter instants twice over
 * (Uxpool page 20 and Youth Recreation page 43, identical).
 *
 * There is no resident/non-resident REGISTRATION split anywhere in the 81 pages — the
 * only residency difference is a membership fee — so `residentOpenAt` and
 * `residentPriorityDays` are null on every Uxbridge row. Inventing a head start here
 * would tell an Uxbridge parent to wait for a morning that does not exist.
 */
const UXBRIDGE_ROW = {
  municipality: 'uxbridge',
  previewAt: null,
  residentOpenAt: null,
  residentPriorityDays: null,
  waitlistResponseHours: null,
  ageMinMonths: null,
  ageMaxMonths: null,
  sourceUrl: UXBRIDGE_UXPLORE_GUIDE,
  verifiedAt: YORK_ROUND_VERIFIED_AT,
} as const;

const UXBRIDGE_NO_RESIDENT_SPLIT =
  'Uxbridge publishes no resident/non-resident registration split: the only residency difference in the guide is "A $52 fee will be added to non-residents yearly membership", which is a membership fee and not a second registration morning.';

const BURLINGTON_TABLE_NOTE =
  'From the Town\'s registration table, columns "Program viewable online | Registration date and time (resident) | Registration date and time (non-resident)". No time is published for the viewable-online date, so the preview is the start of that day. Waitlist: "The spot will be held for only 48 hours."';

export const REGISTRATION_WINDOWS: readonly RegistrationWindowSeed[] = [
  // ── Toronto ──────────────────────────────────────────────────────────────────
  // Fall 2026 was published August 24, 2026. Four district mornings per domain;
  // swim registers inside the same mornings, never on its own date.
  ...TORONTO_FALL_MORNINGS.flatMap((morning) => {
    const seed = torontoFallSeed(morning);
    return [
      { ...seed, programDomain: 'rec_program' as const },
      { ...seed, programDomain: 'swim' as const },
    ];
  }),
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
  { ...MARKHAM_FALL_2026, programDomain: 'swim', inferredFields: MARKHAM_INFERRED_TIER },
  { ...MARKHAM_FALL_2026, programDomain: 'camp', inferredFields: MARKHAM_INFERRED_TIER },

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

  // ── Whitchurch-Stouffville ───────────────────────────────────────────────────
  {
    ...WHITCHURCH_STOUFFVILLE_FALL_2026,
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    notes: `General registered rec programs, the whole Play Book on one window. ${WHITCHURCH_STOUFFVILLE_PAGE_TWO}`,
  },
  {
    ...WHITCHURCH_STOUFFVILLE_FALL_2026,
    programDomain: 'swim',
    cycleLabel: 'Fall 2026',
    notes: `Swimming (Play Book page 48) registers inside the same window as everything else — the Town publishes no separate aquatics date. ${WHITCHURCH_STOUFFVILLE_PAGE_TWO}`,
  },
  {
    ...WHITCHURCH_STOUFFVILLE_FALL_2026,
    programDomain: 'camp',
    cycleLabel: 'Winter Break Camps December 2026',
    notes: `Winter Break Camp (December 21–23 and December 29–30) registers in the FALL window, not in December — seeded as its own row so the radar fires in August. ${WHITCHURCH_STOUFFVILLE_PAGE_TWO}`,
  },

  // ── Newmarket ────────────────────────────────────────────────────────────────
  {
    ...NEWMARKET_FALL_2026,
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    notes: `General registered rec programs, one window for the whole magazine. ${NEWMARKET_PAGE_TWO}`,
  },
  {
    ...NEWMARKET_FALL_2026,
    programDomain: 'swim',
    cycleLabel: 'Fall 2026',
    notes: `Swimming (magazine page 26) registers inside the same window — the Town publishes no separate aquatics date, only the same reminder: "Program Registration begins August 19 for Newmarket residents. Non-resident registration begins August 26." / "Registration opens at 8 a.m." ${NEWMARKET_PAGE_TWO}`,
  },

  // ── King ─────────────────────────────────────────────────────────────────────
  // The Township's ONLY published Fall 2026 date is the non-resident aquatics one, so
  // there is no Fall 2026 rec row: a general fall date exists but is printed nowhere a
  // client can read, and a row would have to invent it.
  {
    ...KING_SWIM_FALL_2026,
    notes: `king.ca/recreation, "Registration Start Dates", verbatim: "Fall Recreation & Aquatic Programs" / "Fall session: September 14 - December 31" / "Programs are currently viewable online." / "Registration is now open at townshipofking.perfectmind.com" / "Aquatics program registration for non-residents opens on August 21." The resident/general fall date is NOT printed on any reachable page, so this row carries only the one date the Township published — the non-resident aquatics open — and residentOpenAt stays null. No clock time is printed, so the instant is the start of the published local day.`,
  },
  {
    municipality: 'king',
    programDomain: 'rec_program',
    cycleLabel: 'Winter 2027',
    previewAt: '2026-11-23T00:00:00-05:00',
    // The Township prints one general Winter open and splits only AQUATICS by residency
    // (the swim row below). For rec there is no published split, so December 7 is the
    // general open — putting it in residentOpenAt would promise a head start nobody has.
    residentOpenAt: null,
    openAt: '2026-12-07T00:00:00-05:00',
    residentPriorityDays: null,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: KING_RECREATION,
    verifiedAt: YORK_ROUND_VERIFIED_AT,
    notes: `General winter recreation programs. ${KING_WINTER_QUOTE}`,
    publishedWeekdays: {},
  },
  {
    municipality: 'king',
    programDomain: 'swim',
    cycleLabel: 'Winter 2027',
    previewAt: '2026-11-23T00:00:00-05:00',
    residentOpenAt: '2026-12-07T00:00:00-05:00',
    openAt: '2026-12-11T00:00:00-05:00',
    residentPriorityDays: 4,
    waitlistResponseHours: null,
    ageMinMonths: null,
    ageMaxMonths: null,
    sourceUrl: KING_RECREATION,
    verifiedAt: YORK_ROUND_VERIFIED_AT,
    notes: `Aquatics is the one program King splits by residency: the December 7 general open is the resident date for swim because the Township separately prints "Aquatics program registration for non-residents opens on December 11, 2026." The four-day head start is the gap between the two sentences, not a published rule. ${KING_WINTER_QUOTE}`,
    publishedWeekdays: {},
  },

  // ── East Gwillimbury ─────────────────────────────────────────────────────────
  {
    ...EAST_GWILLIMBURY_FALL_2026,
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    notes: `General registered rec programs, one window for the whole Health and Active Living Guide. ${EAST_GWILLIMBURY_QUOTE}`,
  },
  {
    ...EAST_GWILLIMBURY_FALL_2026,
    programDomain: 'swim',
    cycleLabel: 'Fall 2026',
    notes: `Aquatics registers inside the same window — the Town publishes no separate swim date. ${EAST_GWILLIMBURY_QUOTE}`,
  },

  // ── Georgina ─────────────────────────────────────────────────────────────────
  {
    ...GEORGINA_FALL_2026,
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    notes: `General registered rec programs. ${GEORGINA_PROGRAMS_QUOTE}`,
  },
  {
    ...GEORGINA_FALL_2026,
    programDomain: 'swim',
    cycleLabel: 'Fall 2026',
    notes: `Aquatics registers inside the same window: the Town's aquatic-programs page prints no date of its own, only "Resident and non-resident registration is now open." ${GEORGINA_PROGRAMS_QUOTE}`,
  },

  // ── Uxbridge (Durham) ────────────────────────────────────────────────────────
  {
    ...UXBRIDGE_ROW,
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    openAt: '2026-08-20T09:00:00-04:00',
    notes: `Uxplore: Fall 2026 & Winter 2027 Community Guide, Youth Recreation page 43, verbatim: "Fall Sessions (10 Weeks):" / "Registration Opens August 20, 2026 at 9:00 a.m." The same instant is printed again on Uxpool page 20 with its weekday: "Fall Registration Begins" / "Thursday, August 20, 2026 at 9:00 a.m." ${UXBRIDGE_NO_RESIDENT_SPLIT}`,
    publishedWeekdays: { openAt: 'Thursday' },
  },
  {
    ...UXBRIDGE_ROW,
    programDomain: 'swim',
    cycleLabel: 'Fall 2026',
    openAt: '2026-08-20T09:00:00-04:00',
    notes: `Uxpool (aquatics), page 20, verbatim: "Registration" / "Fall Registration Begins" / "Thursday, August 20, 2026 at 9:00 a.m." Aquatics and youth recreation open on the same instant; the guide prints it in both sections. ${UXBRIDGE_NO_RESIDENT_SPLIT}`,
    publishedWeekdays: { openAt: 'Thursday' },
  },
  {
    ...UXBRIDGE_ROW,
    programDomain: 'rec_program',
    cycleLabel: 'Winter 2027',
    openAt: '2026-11-10T09:00:00-05:00',
    notes: `Youth Recreation page 43, verbatim: "Winter Sessions (8 Weeks):" / "Registration Opens November 10, 2026 at 9:00 a.m." Printed again on Uxpool page 20 with its weekday: "Winter Registration Begins" / "Tuesday, November 10, 2026 at 9:00 a.m." EST, not EDT — the clock went back on 1 November 2026. ${UXBRIDGE_NO_RESIDENT_SPLIT}`,
    publishedWeekdays: { openAt: 'Tuesday' },
  },
  {
    ...UXBRIDGE_ROW,
    programDomain: 'swim',
    cycleLabel: 'Winter 2027',
    openAt: '2026-11-10T09:00:00-05:00',
    notes: `Uxpool (aquatics), page 20, verbatim: "Winter Registration Begins" / "Tuesday, November 10, 2026 at 9:00 a.m." The guide adds "Winter Session Dates and Lesson Schedule will be available online", so the sessions are unpublished but the registration morning is not. ${UXBRIDGE_NO_RESIDENT_SPLIT}`,
    publishedWeekdays: { openAt: 'Tuesday' },
  },
  {
    ...UXBRIDGE_ROW,
    programDomain: 'camp',
    cycleLabel: 'Winter Break Day Camps December 2026',
    openAt: '2026-11-10T09:00:00-05:00',
    ageMinMonths: 60,
    ageMaxMonths: 120,
    notes: `Winter Break Camps, page 47, verbatim: "Winter Break Day Camps" / "Registration opens November 10, 2026 at 9:00am" / "December 21-23, 2026" / "8:30 a.m. - 4:30 p.m." / "Ages: 5-9 years" (recorded 60-120 months, inclusive of the whole tenth year, as the Toronto ARC row is). Seeded as its own row because it registers in the NOVEMBER window, not in December — the radar has to fire six weeks before the camp. ${UXBRIDGE_NO_RESIDENT_SPLIT}`,
    publishedWeekdays: { openAt: 'Tuesday' },
  },
  {
    ...UXBRIDGE_ROW,
    programDomain: 'camp',
    cycleLabel: 'UxCamps March Break 2027',
    openAt: '2027-01-26T12:00:00-05:00',
    notes: `UxCamps March Break Camps, page 48, verbatim: "Registration Details" / "Registration opens January 26th, 2027, at 12:00 p.m. Limited spaces are available, register early to secure your spot!" / "Jr. Variety Camp March 15-19, 2027". NOON, and the guide prints no weekday here — the only Uxbridge date in the guide that does not carry one. ${UXBRIDGE_NO_RESIDENT_SPLIT}`,
    publishedWeekdays: {},
  },
];
