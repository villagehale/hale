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

  it('has no Toronto seasonal recreation row — the City has not published Fall 2026', () => {
    // "Registration dates will be announced at a later date." An empty result here is
    // the correct state; a row appearing means someone loaded an unpublished date.
    const seasonal = REGISTRATION_WINDOWS.filter(
      (s) => s.municipality === 'toronto' && s.programDomain !== 'after_school_care',
    );
    expect(seasonal).toEqual([]);
  });
});

describe('golden — Markham 2026 Fall Programs, Swim Lessons and Winter Break Camps', () => {
  const CYCLE = '2026 Fall Programs, Swim Lessons and Winter Break Camps';
  const row = toRegistrationWindowRow(seed('markham', 'rec_program', CYCLE));

  it('opens at 6:30 a.m. on 11 August 2026 (10:30 UTC, EDT)', () => {
    expect(row.openAt).toEqual(new Date('2026-08-11T10:30:00.000Z'));
  });

  it('previews from 3 August 2026', () => {
    expect(row.previewAt).toEqual(new Date('2026-08-03T04:00:00.000Z'));
  });

  it('carries the 48-hour Markham waitlist window', () => {
    expect(row.waitlistResponseHours).toBe(48);
  });

  it('claims no resident head start, because Markham publishes none', () => {
    expect(row.residentOpenAt).toBeNull();
    expect(row.residentPriorityDays).toBeNull();
  });

  it('covers all three domains the one combined cycle registers, on identical dates', () => {
    const domains = REGISTRATION_WINDOWS.filter(
      (s) => s.municipality === 'markham' && s.cycleLabel === CYCLE,
    );
    expect(domains.map((s) => s.programDomain).sort()).toEqual(['camp', 'rec_program', 'swim']);
    for (const other of domains) {
      expect(toRegistrationWindowRow(other).openAt).toEqual(row.openAt);
    }
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
