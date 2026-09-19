import { describe, expect, it } from 'vitest';
import { REGISTRATION_WINDOWS } from './registration-windows-data.js';
import { toRegistrationWindowRow } from './registration-windows.js';

/**
 * GOLDEN ROWS. Every expectation below is transcribed from the municipality's own page,
 * NOT from what the seed module currently contains — that is the whole point. If someone
 * "fixes" a date, refreshes the file from a stale search result, or lets a prior-year
 * date creep back in, these fail.
 *
 * Toronto, verbatim, https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/camps-after-school/after-school-recreation-care/
 *   "Registration starts on June 5, 2026, at 7 a.m."
 *   "The After-School Recreation Care (ARC) Program, for ages six to 12 years old…"
 *   "The Community Leadership After-School Program (CLASP), for ages 10 to 15 years old…"
 * and https://www.toronto.ca/explore-enjoy/parks-recreation/how-to-use-our-services/how-to-register-for-recreation-programs/
 *   "You'll have up to 36 hours to accept or decline the spot…"
 *   non-Toronto residents "can register for a recreation activity 10 days after
 *   registration starts for that activity"
 *   "Friday, June 5 – After-School Recreation Care registration is now open."
 *
 * Markham, verbatim, https://www.markham.ca/sports-recreation-fitness/sports-recreation-programs/registration-and-general-information
 *   "2026 Fall Programs, Swim Lessons and Winter Break Camps"
 *   "Preview starting Aug, 3"      (the comma is a typo in the source)
 *   "Register starting Aug. 11 at 6:30 AM"
 *   "You will have 48 hours to decide…"
 * and Markham's own PerfectMind course pages for that cycle, checked in whole under
 * lib/channel/spots/fixtures/ — where the city page's single unlabelled date turns out
 * to be the RESIDENT one (VIL-347). open-window-markham.html ("Chess: Preschool",
 * categories "REC: Programs - Specialty 1 - Resident / - Non-Resident") and
 * open-window-open-markham.html ("LEGO: Preschool", "REC: Programs - Variety 1 -
 * Resident / - Non-Resident") both carry, verbatim:
 *   "ResidentsRegistrationDateValue":"2026-08-11T06:30:00"
 *   "PublicRegistrationStartDateValue":"2026-08-12T06:30:00"
 * corroborated on a different cycle by markham-course.html (2026-02-24 / 2026-02-25).
 */

function seed(municipality: string, programDomain: string, cycleLabel: string) {
  const found = REGISTRATION_WINDOWS.find(
    (s) =>
      s.municipality === municipality &&
      s.programDomain === programDomain &&
      s.cycleLabel === cycleLabel,
  );
  if (!found) throw new Error(`no seed row for ${municipality}/${programDomain}/${cycleLabel}`);
  return found;
}

describe('golden — Toronto After-School Recreation Care 2026/2027', () => {
  const row = toRegistrationWindowRow(
    seed(
      'toronto',
      'after_school_care',
      'After-School Recreation Care (ARC) 2026/2027 school year',
    ),
  );

  it('opens for residents at 7 a.m. on Friday 5 June 2026 (11:00 UTC, EDT)', () => {
    expect(row.residentOpenAt).toEqual(new Date('2026-06-05T11:00:00.000Z'));
  });

  it('opens for non-residents ten days later, per the published city-wide rule', () => {
    expect(row.residentPriorityDays).toBe(10);
    expect(row.openAt).toEqual(new Date('2026-06-15T11:00:00.000Z'));
    const gapDays =
      (row.openAt.getTime() - (row.residentOpenAt as Date).getTime()) / (24 * 60 * 60 * 1000);
    expect(gapDays).toBe(10);
  });

  it("carries the 36-hour Toronto waitlist window, not a neighbouring town's", () => {
    expect(row.waitlistResponseHours).toBe(36);
  });

  it('bands ARC at ages six to twelve', () => {
    expect(row.ageMinMonths).toBe(6 * 12);
    expect(row.ageMaxMonths).toBe(12 * 12);
  });

  it('bands CLASP at ages ten to fifteen on the same registration date', () => {
    const clasp = toRegistrationWindowRow(
      seed(
        'toronto',
        'after_school_care',
        'Community Leadership After-School Program (CLASP) 2026/2027 school year',
      ),
    );
    expect(clasp.ageMinMonths).toBe(10 * 12);
    expect(clasp.ageMaxMonths).toBe(15 * 12);
    expect(clasp.residentOpenAt).toEqual(row.residentOpenAt);
  });

  it('cites the City of Toronto page it was read from', () => {
    expect(row.sourceUrl).toBe(
      'https://www.toronto.ca/explore-enjoy/parks-recreation/program-activities/camps-after-school/after-school-recreation-care/',
    );
  });

  it('carries exactly the published Fall 2026 seasonal cycle and nothing unpublished', () => {
    // Until August 24, 2026 the City printed "Registration dates will be announced at a
    // later date" and this list was empty. Now it must hold the two Fall 2026 rows (rec
    // and swim share one cycle) and nothing else — a Winter 2027 row appearing here
    // before the City prints a date means someone loaded an unpublished one.
    const seasonal = REGISTRATION_WINDOWS.filter(
      (s) => s.municipality === 'toronto' && s.programDomain !== 'after_school_care',
    ).map((s) => `${s.programDomain}/${s.cycleLabel}`);
    expect(seasonal.sort()).toEqual(['rec_program/Fall 2026', 'swim/Fall 2026']);
  });
});

describe('golden — Markham 2026 Fall Programs, Swim Lessons and Winter Break Camps', () => {
  const CYCLE = '2026 Fall Programs, Swim Lessons and Winter Break Camps';
  const row = toRegistrationWindowRow(seed('markham', 'rec_program', CYCLE));

  it('opens for residents at 6:30 a.m. on 11 August 2026 (10:30 UTC, EDT)', () => {
    expect(row.residentOpenAt).toEqual(new Date('2026-08-11T10:30:00.000Z'));
  });

  it('opens for everyone else at 6:30 a.m. the NEXT morning, one day behind', () => {
    expect(row.openAt).toEqual(new Date('2026-08-12T10:30:00.000Z'));
    expect(row.residentPriorityDays).toBe(1);
  });

  it('previews from 3 August 2026', () => {
    expect(row.previewAt).toEqual(new Date('2026-08-03T04:00:00.000Z'));
  });

  it('carries the 48-hour Markham waitlist window', () => {
    expect(row.waitlistResponseHours).toBe(48);
  });

  it('covers all three domains the one combined cycle registers, on identical dates', () => {
    const domains = REGISTRATION_WINDOWS.filter(
      (s) => s.municipality === 'markham' && s.cycleLabel === CYCLE,
    );
    expect(domains.map((s) => s.programDomain).sort()).toEqual(['camp', 'rec_program', 'swim']);
    for (const other of domains) {
      expect(toRegistrationWindowRow(other).openAt).toEqual(row.openAt);
      expect(toRegistrationWindowRow(other).residentOpenAt).toEqual(row.residentOpenAt);
    }
  });

  // The tier above is read off two REC: Programs course pages. No swim or camp course
  // page for this cycle is checked in, so those two rows hold it on the strength of the
  // shared cycle label alone — which is an inference, and has to be one the code can
  // read rather than a sentence in `notes`.
  it('names the resident tier as inferred on swim and camp, and only there', () => {
    const inferredBy = (domain: string) => seed('markham', domain, CYCLE).inferredFields ?? [];
    expect(inferredBy('swim')).toEqual(['residentOpenAt']);
    expect(inferredBy('camp')).toEqual(['residentOpenAt']);
    expect(inferredBy('rec_program')).toEqual([]);
  });

  it('cites the City of Markham registration page it was read from', () => {
    expect(row.sourceUrl).toBe(
      'https://www.markham.ca/sports-recreation-fitness/sports-recreation-programs/registration-and-general-information',
    );
  });
});

/**
 * Mississauga, verbatim, https://www.mississauga.ca/city-of-mississauga-news/news/fall-into-fun-with-city-programs-and-activities/
 * (City media advisory, datelined "City services | July 31, 2026", read 2026-08-02)
 *   "Program browsing opens Tuesday, August 4"
 *   "Resident registration begins Tuesday, August 11 at 7 a.m."
 *   "Non-resident registration begins Tuesday, August 18 at 7 a.m."
 *
 * VIL-261. These rows previously carried the recreation landing banner's
 * "View programs August 4 and register August 11" — which is the RESIDENT date with
 * no time, stored as the general open. A Mississauga family outside the city was
 * therefore told to register a week before they are allowed to, and a resident was
 * told midnight instead of 7 a.m.
 */
describe('golden — Mississauga Fall 2026 Programs and Winter Camps', () => {
  const CYCLE = 'Fall 2026 Programs and Winter Camps';
  const row = toRegistrationWindowRow(seed('mississauga', 'rec_program', CYCLE));

  it('opens for residents at 7 a.m. on 11 August 2026 (11:00 UTC, EDT)', () => {
    expect(row.residentOpenAt).toEqual(new Date('2026-08-11T11:00:00.000Z'));
  });

  it('opens for everyone else at 7 a.m. a full week later, as the advisory prints', () => {
    expect(row.openAt).toEqual(new Date('2026-08-18T11:00:00.000Z'));
    expect(row.residentPriorityDays).toBe(7);
  });

  it('previews from the start of 4 August 2026 — browsing publishes no time', () => {
    expect(row.previewAt).toEqual(new Date('2026-08-04T04:00:00.000Z'));
  });

  it('claims no waitlist window, because Mississauga publishes none', () => {
    expect(row.waitlistResponseHours).toBeNull();
  });

  it('cites the dated advisory, not the year-less recreation landing page', () => {
    // The landing page states no year anywhere, so the re-verify sweep can only ever
    // answer `no_year_stated` against it. A source it cannot read is a source that
    // quietly stops being checked.
    expect(row.sourceUrl).toBe(
      'https://www.mississauga.ca/city-of-mississauga-news/news/fall-into-fun-with-city-programs-and-activities/',
    );
  });

  it('carries the same dates on the winter-camps domain the one event also registers', () => {
    const camp = toRegistrationWindowRow(seed('mississauga', 'camp', CYCLE));
    expect(camp.openAt).toEqual(row.openAt);
    expect(camp.residentOpenAt).toEqual(row.residentOpenAt);
  });
});

/**
 * Toronto Fall 2026, verbatim, https://www.toronto.ca/news/city-of-toronto-releases-listings-for-fall-recreation-activities/ (August 24, 2026)
 *   "Wednesday, September 9 at 7 a.m. – Early local registration opens to eligible residents for all free centres"
 *   "Tuesday, September 15 at 7 a.m. – Etobicoke and Toronto East York registration"
 *   "Wednesday, September 16 at 7 a.m. – North York and Scarborough registration"
 */
describe('golden — Toronto Fall 2026 seasonal registration', () => {
  const row = toRegistrationWindowRow(seed('toronto', 'rec_program', 'Fall 2026'));

  it('opens for residents at 7 a.m. on Tuesday 15 September 2026 (11:00 UTC, EDT)', () => {
    expect(row.residentOpenAt).toEqual(new Date('2026-09-15T11:00:00.000Z'));
  });

  it('opens for non-residents ten days later, per the published city-wide rule', () => {
    expect(row.residentPriorityDays).toBe(10);
    expect(row.openAt).toEqual(new Date('2026-09-25T11:00:00.000Z'));
  });

  it('registers swim on the same morning — Toronto has no separate swim cycle', () => {
    const swim = toRegistrationWindowRow(seed('toronto', 'swim', 'Fall 2026'));
    expect(swim.residentOpenAt).toEqual(row.residentOpenAt);
    expect(swim.openAt).toEqual(row.openAt);
  });
});

/**
 * Whitchurch-Stouffville, verbatim, page 2 of the Fall 2026 Stouffville PLAY Book
 * (https://www.townofws.ca/media/gvyjvnnq/f2026_playbook_tagged-2.pdf), read 2026-09-17
 *   "Fall 2026 Registration"
 *   "Residents:" / "Tuesday, August 25, 2026" / "Online and in–person at 12 PM, noon"
 *   "Non-Residents:" / "Tuesday, September 1, 2026" / "Online and in–person at 12 PM, noon"
 *   "Non-residents are subject to a 20% surcharge to register in Town programs"
 *   "Most programs begin September 28, 2026"
 *
 * NOON is the outlier in this dataset — every other town in it opens between 6 and 9
 * a.m., so a carried-over "7 a.m." would put a Stouffville parent five hours early.
 */
describe('golden — Whitchurch-Stouffville Fall 2026', () => {
  const row = toRegistrationWindowRow(seed('whitchurch_stouffville', 'rec_program', 'Fall 2026'));

  it('opens for residents at noon on Tuesday 25 August 2026 (16:00 UTC, EDT)', () => {
    expect(row.residentOpenAt).toEqual(new Date('2026-08-25T16:00:00.000Z'));
  });

  it('opens for everyone else at noon a week later, as the Play Book prints both dates', () => {
    expect(row.openAt).toEqual(new Date('2026-09-01T16:00:00.000Z'));
    expect(row.residentPriorityDays).toBe(7);
    const gapDays =
      (row.openAt.getTime() - (row.residentOpenAt as Date).getTime()) / (24 * 60 * 60 * 1000);
    expect(gapDays).toBe(7);
  });

  it('claims no preview, because the Play Book publishes no browse date', () => {
    expect(row.previewAt).toBeNull();
  });

  it('claims no waitlist window, because the Town publishes none', () => {
    // Null, not zero: "not published" is a different claim from "there is none".
    expect(row.waitlistResponseHours).toBeNull();
  });

  it('quotes the 20% non-resident surcharge and the September 28 program start', () => {
    expect(row.notes).toContain(
      'Non-residents are subject to a 20% surcharge to register in Town programs',
    );
    expect(row.notes).toContain('Most programs begin September 28, 2026');
  });

  it('carries swim and the winter-break camps on the same two dates', () => {
    const swim = toRegistrationWindowRow(seed('whitchurch_stouffville', 'swim', 'Fall 2026'));
    const camp = toRegistrationWindowRow(
      seed('whitchurch_stouffville', 'camp', 'Winter Break Camps December 2026'),
    );
    for (const other of [swim, camp]) {
      expect(other.openAt).toEqual(row.openAt);
      expect(other.residentOpenAt).toEqual(row.residentOpenAt);
    }
  });

  it("cites the Town's own Play Book PDF", () => {
    expect(row.sourceUrl).toBe(
      'https://www.townofws.ca/media/gvyjvnnq/f2026_playbook_tagged-2.pdf',
    );
  });
});

/**
 * Newmarket, verbatim, page 2 of Recreation & Culture FALL ACTIVITIES 2026
 * (https://www.newmarket.ca/media/file/fall-seasonal-magazine), read 2026-09-18
 *   "2026 Fall Registration" / "Registration Dates"
 *   "Resident Registration"      "August 19 at 8 a.m."
 *   "Non-Resident Registration"  "August 26 at 8 a.m."
 *   Mayor's letter, same page: "save the date for resident registration on
 *   Wednesday, August 19 at 8 a.m."
 *   Swimming section, page 26: "Program Registration begins August 19 for Newmarket
 *   residents. Non-resident registration begins August 26." / "Registration opens at
 *   8 a.m."
 */
describe('golden — Newmarket Fall 2026', () => {
  const row = toRegistrationWindowRow(seed('newmarket', 'rec_program', 'Fall 2026'));

  it('opens for residents at 8 a.m. on Wednesday 19 August 2026 (12:00 UTC, EDT)', () => {
    expect(row.residentOpenAt).toEqual(new Date('2026-08-19T12:00:00.000Z'));
  });

  it('opens for everyone else a week later, the second date the magazine prints', () => {
    expect(row.openAt).toEqual(new Date('2026-08-26T12:00:00.000Z'));
    expect(row.residentPriorityDays).toBe(7);
  });

  it('claims no preview and no waitlist window, because the magazine publishes neither', () => {
    // Null, not zero: "not published" is a different claim from "there is none".
    expect(row.previewAt).toBeNull();
    expect(row.waitlistResponseHours).toBeNull();
  });

  it('carries swim on the same window, as the Swimming section reprints the same dates', () => {
    const swim = toRegistrationWindowRow(seed('newmarket', 'swim', 'Fall 2026'));
    expect(swim.openAt).toEqual(row.openAt);
    expect(swim.residentOpenAt).toEqual(row.residentOpenAt);
    expect(swim.notes).toContain(
      'Program Registration begins August 19 for Newmarket residents. Non-resident registration begins August 26.',
    );
  });

  it("cites the Town's own magazine PDF, not the landing page that prints no dates", () => {
    expect(row.sourceUrl).toBe('https://www.newmarket.ca/media/file/fall-seasonal-magazine');
  });
});

/**
 * King Township, verbatim, https://www.king.ca/recreation ("Registration Start Dates"),
 * read 2026-09-18
 *   "Fall Recreation & Aquatic Programs" / "Fall session: September 14 - December 31"
 *   "Registration is now open at townshipofking.perfectmind.com"
 *   "Aquatics program registration for non-residents opens on August 21."
 *   "Winter 2027 Recreation & Aquatic Programs"
 *   "Winter session: January 11 - March 31, 2027"
 *   "Programs are viewable online as of November 23, 2026."
 *   "Registration opens on December 7 at townshipofking.perfectmind.com"
 *   "Aquatics program registration for non-residents opens on December 11, 2026."
 *
 * NO CLOCK TIME is printed for any King date, so every instant is the start of the
 * published local day; a borrowed "7 a.m." would be seven hours wrong. And every winter
 * date is EST: the clock went back on 1 November 2026, so a hand-typed -04:00 would put
 * a King parent an hour early.
 */
describe('golden — King Winter 2027', () => {
  const rec = toRegistrationWindowRow(seed('king', 'rec_program', 'Winter 2027'));
  const swim = toRegistrationWindowRow(seed('king', 'swim', 'Winter 2027'));

  it('opens rec at the start of Monday 7 December 2026 (05:00 UTC, EST)', () => {
    expect(rec.openAt).toEqual(new Date('2026-12-07T05:00:00.000Z'));
  });

  it('gives rec no resident head start, because King publishes no rec split', () => {
    // December 7 is the GENERAL open for rec. Filing it as the resident date would
    // promise a King parent a head start the Township never printed.
    expect(rec.residentOpenAt).toBeNull();
    expect(rec.residentPriorityDays).toBeNull();
  });

  it('previews on 23 November 2026, the one browse date King prints', () => {
    expect(rec.previewAt).toEqual(new Date('2026-11-23T05:00:00.000Z'));
    expect(swim.previewAt).toEqual(rec.previewAt);
  });

  it('splits only aquatics: residents 7 December, non-residents 11 December', () => {
    expect(swim.residentOpenAt).toEqual(new Date('2026-12-07T05:00:00.000Z'));
    expect(swim.openAt).toEqual(new Date('2026-12-11T05:00:00.000Z'));
    expect(swim.residentPriorityDays).toBe(4);
  });

  it('holds the one Fall 2026 date King printed - the non-resident aquatics open', () => {
    // The fall RESIDENT date is on no reachable page, so there is no fall rec row at
    // all; this row carries the single sentence the Township did publish.
    const fallSwim = toRegistrationWindowRow(seed('king', 'swim', 'Fall 2026'));
    expect(fallSwim.openAt).toEqual(new Date('2026-08-21T04:00:00.000Z'));
    expect(fallSwim.residentOpenAt).toBeNull();
    expect(
      REGISTRATION_WINDOWS.some(
        (s) => s.municipality === 'king' && s.programDomain === 'rec_program' && s.cycleLabel === 'Fall 2026',
      ),
    ).toBe(false);
  });

  it('cites the one King page that prints dates at all', () => {
    expect(rec.sourceUrl).toBe('https://www.king.ca/recreation');
  });
});

/**
 * East Gwillimbury, verbatim,
 * https://www.eastgwillimbury.ca/en/living-in-eg/health-and-active-living-guide.aspx,
 * read 2026-09-18
 *   "Fall 2026 and Winter 2027 Health and Active Living Guide"
 *   "Fall Registration:" "August 20 for residents and August 27 for non-residents"
 *   "Registration for ActiveNet users listed as an East Gwillimbury resident open a
 *   week before users not listed as a resident."
 *   "For resident registration, the city included in your address must be 'East
 *   Gwillimbury.' The system will not recognize Sharon, Mount Albert, Queensville,
 *   etc. as residential addresses."
 */
describe('golden — East Gwillimbury Fall 2026', () => {
  const row = toRegistrationWindowRow(seed('east_gwillimbury', 'rec_program', 'Fall 2026'));

  it('opens at the start of 20 August 2026, because the Town published no clock', () => {
    expect(row.residentOpenAt).toEqual(new Date('2026-08-20T04:00:00.000Z'));
    expect(row.openAt).toEqual(new Date('2026-08-27T04:00:00.000Z'));
    expect(row.residentPriorityDays).toBe(7);
  });

  it('carries the residency trap a Sharon or Mount Albert parent cannot see elsewhere', () => {
    expect(row.notes).toContain(
      'The system will not recognize Sharon, Mount Albert, Queensville, etc. as residential addresses.',
    );
  });

  it('claims no preview and no waitlist window', () => {
    expect(row.previewAt).toBeNull();
    expect(row.waitlistResponseHours).toBeNull();
  });
});

/**
 * Georgina, verbatim, https://www.georgina.ca/things-do/recreation/programs-0,
 * read 2026-09-18
 *   "Fall program registration"
 *   "Aug. 18 at 8:30 a.m. - residents"
 *   "Aug. 25 at 8:30 a.m. - non-residents"
 *   "Staff monitor all waitlists regularly to create availability for programs or
 *   lessons in demand when possible."
 *
 * The sibling page georgina.ca/things-do/recreation/recreation-general-information was
 * on the same day still printing the SPRING block, "Resident registration will open on
 * Mar. 3 at 8:30 a.m." — two pages, two cycles, neither printing a year.
 */
describe('golden — Georgina Fall 2026', () => {
  const row = toRegistrationWindowRow(seed('georgina', 'rec_program', 'Fall 2026'));

  it('opens for residents at 8:30 a.m. on 18 August 2026 (12:30 UTC, EDT)', () => {
    // The half hour is the part a rounded "8 a.m." would lose.
    expect(row.residentOpenAt).toEqual(new Date('2026-08-18T12:30:00.000Z'));
    expect(row.openAt).toEqual(new Date('2026-08-25T12:30:00.000Z'));
    expect(row.residentPriorityDays).toBe(7);
  });

  it('claims no waitlist window: Georgina publishes a practice, not a deadline', () => {
    expect(row.waitlistResponseHours).toBeNull();
    expect(row.notes).toContain('Staff monitor all waitlists regularly');
  });

  it('cites the programs page and says why, not the page still stuck on spring', () => {
    expect(row.sourceUrl).toBe('https://www.georgina.ca/things-do/recreation/programs-0');
    expect(row.notes).toContain('recreation-general-information');
  });
});

/**
 * Uxbridge, verbatim, Uxplore: Fall 2026 & Winter 2027 Community Guide
 * (https://www.uxbridge.ca/public/download/files/360410), read 2026-09-18
 *   Uxpool, page 20: "Fall Registration Begins" / "Thursday, August 20, 2026 at 9:00 a.m."
 *                    "Winter Registration Begins" / "Tuesday, November 10, 2026 at 9:00 a.m."
 *   Youth Recreation, page 43: "Registration Opens August 20, 2026 at 9:00 a.m." /
 *                    "Registration Opens November 10, 2026 at 9:00 a.m."
 *   Winter Break Camps, page 47: "Registration opens November 10, 2026 at 9:00am" /
 *                    "December 21-23, 2026" / "Ages: 5-9 years"
 *   UxCamps, page 48: "Registration opens January 26th, 2027, at 12:00 p.m."
 *
 * THE -05:00 CLIFF. Three of these instants are after 1 November 2026. A hand-typed
 * -04:00 on the November date would be an hour early, and this block is what reddens.
 */
describe('golden — Uxbridge Fall 2026 and Winter 2027', () => {
  const fall = toRegistrationWindowRow(seed('uxbridge', 'rec_program', 'Fall 2026'));
  const winter = toRegistrationWindowRow(seed('uxbridge', 'rec_program', 'Winter 2027'));

  it('opens fall at 9 a.m. on Thursday 20 August 2026 (13:00 UTC, EDT)', () => {
    expect(fall.openAt).toEqual(new Date('2026-08-20T13:00:00.000Z'));
  });

  it('opens winter at 9 a.m. on Tuesday 10 November 2026 — 14:00 UTC, EST not EDT', () => {
    expect(winter.openAt).toEqual(new Date('2026-11-10T14:00:00.000Z'));
  });

  it('gives no Uxbridge row a resident head start, because the guide publishes none', () => {
    // The only residency difference in 81 pages is a membership fee. A head start here
    // would tell an Uxbridge parent to wait for a morning that does not exist.
    for (const seedRow of REGISTRATION_WINDOWS.filter((s) => s.municipality === 'uxbridge')) {
      expect(seedRow.residentOpenAt, seedRow.cycleLabel).toBeNull();
      expect(seedRow.residentPriorityDays, seedRow.cycleLabel).toBeNull();
    }
  });

  it('fires the winter-break camp in November, not in December', () => {
    const camp = toRegistrationWindowRow(
      seed('uxbridge', 'camp', 'Winter Break Day Camps December 2026'),
    );
    expect(camp.openAt).toEqual(new Date('2026-11-10T14:00:00.000Z'));
    expect(camp.ageMinMonths).toBe(60);
    expect(camp.ageMaxMonths).toBe(120);
  });

  it('opens the March Break camp at NOON on 26 January 2027 (17:00 UTC, EST)', () => {
    const camp = toRegistrationWindowRow(seed('uxbridge', 'camp', 'UxCamps March Break 2027'));
    expect(camp.openAt).toEqual(new Date('2027-01-26T17:00:00.000Z'));
  });

  it('cites the accessible guide PDF, not the landing page still titled Fall 2025', () => {
    expect(fall.sourceUrl).toBe('https://www.uxbridge.ca/public/download/files/360410');
  });
});
