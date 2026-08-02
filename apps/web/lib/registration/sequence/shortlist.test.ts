import type { RegistrationWindow } from '@hale/db';
import { describe, expect, it } from 'vitest';
import type { RegistrationMatch } from '~/lib/registration/match-registration-windows';
import { type SequenceChild, buildShortlist } from './shortlist.js';

/**
 * VIL-242 · M7 — what Hale is allowed to put in front of a parent days before a
 * registration window opens.
 *
 * The governing rule is the ticket's hard boundary read backwards: Hale prepares, it
 * does not pretend. The M1 dataset carries a municipality, a cycle label, an age band,
 * a source URL and a set of dates — so those are the shortlist. It does NOT carry
 * program names, class times or instructor slots, so a shortlist may never contain one.
 * A fabricated "Tadpole Level 2, Tuesdays 4:30" is worse than no shortlist at all: the
 * parent plans their morning around it.
 *
 * Rule #1 rides along: a 13+ child's fit note is never named.
 */

const NOW = new Date('2026-09-05T12:00:00.000Z');

function window(overrides: Partial<RegistrationWindow> = {}): RegistrationWindow {
  return {
    id: 'win-1',
    municipality: 'toronto',
    programDomain: 'rec_program',
    cycleLabel: 'Fall 2026',
    previewAt: null,
    residentOpenAt: null,
    openAt: new Date('2026-09-15T10:30:00.000Z'),
    residentPriorityDays: null,
    waitlistResponseHours: 36,
    ageMinMonths: 36,
    ageMaxMonths: 72,
    sourceUrl: 'https://www.toronto.ca/explore-enjoy/parks-recreation/',
    verifiedAt: new Date('2026-07-30T04:00:00.000Z'),
    notes: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as RegistrationWindow;
}

function match(overrides: Partial<RegistrationMatch> = {}): RegistrationMatch {
  return {
    window: window(),
    cycleWindows: [window()],
    matchedChildAgesMonths: [48],
    ageApproximate: false,
    isResidentWindow: false,
    opensForFamilyAt: new Date('2026-09-15T10:30:00.000Z'),
    generalOpenAt: new Date('2026-09-15T10:30:00.000Z'),
    ...overrides,
  };
}

/** A child of `years` on NOW. */
function child(id: string, name: string, years: number, months = 0): SequenceChild {
  const dob = new Date(NOW);
  dob.setUTCFullYear(dob.getUTCFullYear() - years);
  dob.setUTCMonth(dob.getUTCMonth() - months);
  return { id, name, dateOfBirth: dob.toISOString().slice(0, 10) };
}

describe('buildShortlist', () => {
  it('carries only facts the M1 row actually holds', () => {
    const shortlist = buildShortlist(match(), [child('c1', 'Max', 4)], NOW);
    expect(shortlist).not.toBeNull();
    expect(shortlist?.windowRef).toEqual({
      id: 'win-1',
      municipality: 'toronto',
      programDomain: 'rec_program',
      cycleLabel: 'Fall 2026',
    });
    expect(shortlist?.sourceUrl).toBe('https://www.toronto.ca/explore-enjoy/parks-recreation/');
    expect(shortlist?.opensForFamilyAt.toISOString()).toBe('2026-09-15T10:30:00.000Z');
    // The whole object, so a future field that smuggles in an invented program name
    // fails this test rather than reaching a parent.
    expect(Object.keys(shortlist ?? {}).sort()).toEqual([
      'ageApproximate',
      'cyclePhrase',
      'fitNotes',
      'isResidentWindow',
      'opensForFamilyAt',
      'residentPriorityDays',
      'sourceUrl',
      'waitlistResponseHours',
      'windowRef',
    ]);
  });

  it('writes one fit note per child the band admits, named, in input order', () => {
    const shortlist = buildShortlist(
      match({ matchedChildAgesMonths: [48, 60] }),
      [child('c1', 'Max', 4), child('c2', 'Mia', 5)],
      NOW,
    );
    expect(shortlist?.fitNotes).toEqual([
      { childId: 'c1', name: 'Max', fit: 'in_band' },
      { childId: 'c2', name: 'Mia', fit: 'in_band' },
    ]);
  });

  it('leaves out a child the band does not admit at all', () => {
    // 10 years old against a 3–6 band: outside even the tolerance.
    const shortlist = buildShortlist(
      match(),
      [child('c1', 'Max', 4), child('c2', 'Ada', 10)],
      NOW,
    );
    expect(shortlist?.fitNotes.map((note) => note.name)).toEqual(['Max']);
  });

  it('flags a child who only fits on the tolerance rather than dropping them', () => {
    // 6y6m against a band that ends at 72 months — inside the ±6-month tolerance the
    // matcher grants a spoken-age DOB, so the note hedges instead of vanishing.
    const shortlist = buildShortlist(match(), [child('c1', 'Max', 6, 6)], NOW);
    expect(shortlist?.fitNotes).toEqual([{ childId: 'c1', name: 'Max', fit: 'near_band' }]);
  });

  it('never names a 13+ child — rule #1', () => {
    const teenWindow = window({ ageMinMonths: 144, ageMaxMonths: 216 });
    const shortlist = buildShortlist(
      match({ window: teenWindow, matchedChildAgesMonths: [168] }),
      [child('c1', 'Rae', 14)],
      NOW,
    );
    expect(shortlist?.fitNotes).toEqual([{ childId: 'c1', name: null, fit: 'in_band' }]);
  });

  it('keeps a teen sibling generic while naming the younger one in the same shortlist', () => {
    const wideWindow = window({ ageMinMonths: null, ageMaxMonths: null });
    const shortlist = buildShortlist(
      match({ window: wideWindow, matchedChildAgesMonths: [48, 168] }),
      [child('c1', 'Max', 4), child('c2', 'Rae', 14)],
      NOW,
    );
    // No band published, so the fit is 'band_unknown' for both — the teen is still
    // counted and still nameless (rule #1).
    expect(shortlist?.fitNotes).toEqual([
      { childId: 'c1', name: 'Max', fit: 'band_unknown' },
      { childId: 'c2', name: null, fit: 'band_unknown' },
    ]);
  });

  it('admits every age where the municipality publishes no band', () => {
    const shortlist = buildShortlist(
      match({ window: window({ ageMinMonths: null, ageMaxMonths: null }) }),
      [child('c1', 'Max', 4), child('c2', 'Ada', 10)],
      NOW,
    );
    expect(shortlist?.fitNotes.map((note) => note.name)).toEqual(['Max', 'Ada']);
  });

  it('is nothing at all when no child fits — there is no shortlist to approve', () => {
    expect(buildShortlist(match(), [child('c1', 'Ada', 10)], NOW)).toBeNull();
    expect(buildShortlist(match(), [], NOW)).toBeNull();
  });

  it('carries the resident head start only where the family actually has one', () => {
    const residentWindow = window({ residentOpenAt: new Date('2026-09-08T10:30:00.000Z'), residentPriorityDays: 7 });
    const resident = buildShortlist(
      match({
        window: residentWindow,
        isResidentWindow: true,
        opensForFamilyAt: new Date('2026-09-08T10:30:00.000Z'),
      }),
      [child('c1', 'Max', 4)],
      NOW,
    );
    expect(resident?.isResidentWindow).toBe(true);
    expect(resident?.residentPriorityDays).toBe(7);
    expect(resident?.opensForFamilyAt.toISOString()).toBe('2026-09-08T10:30:00.000Z');

    const nonResident = buildShortlist(
      match({ window: residentWindow, isResidentWindow: false }),
      [child('c1', 'Max', 4)],
      NOW,
    );
    expect(nonResident?.isResidentWindow).toBe(false);
    expect(nonResident?.residentPriorityDays).toBeNull();
  });

  it('carries the age hedge straight off the matcher', () => {
    expect(buildShortlist(match({ ageApproximate: true }), [child('c1', 'Max', 4)], NOW)?.ageApproximate).toBe(true);
  });

  it('labels the program domain in words a parent uses', () => {
    expect(buildShortlist(match(), [child('c1', 'Max', 4)], NOW)?.cyclePhrase).toBe(
      'Fall 2026 recreation programs',
    );
    const care = window({ programDomain: 'after_school_care' });
    expect(
      buildShortlist(
        match({ window: care, cycleWindows: [care] }),
        [child('c1', 'Max', 4)],
        NOW,
      )?.cyclePhrase,
    ).toBe('Fall 2026 before-and-after-school care');
  });

  it('carries the municipality’s waitlist response window for the clock to use later', () => {
    expect(buildShortlist(match(), [child('c1', 'Max', 4)], NOW)?.waitlistResponseHours).toBe(36);
    expect(
      buildShortlist(
        match({ window: window({ waitlistResponseHours: null }) }),
        [child('c1', 'Max', 4)],
        NOW,
      )?.waitlistResponseHours,
    ).toBeNull();
  });
});

/**
 * VIL-260 · WS3 — two things the shortlist asserted that the source never published.
 *
 * 1. A window with NO age band read as "inside the published age band" for every
 *    child, because fitOf's null-band path fell through to 'in_band'. Burlington
 *    publishes no band on any of its rows, so a Burlington family was told a band
 *    admitted their child when there was no band at all.
 * 2. One registration event printed as several cycle rows has no single published
 *    cycle name, so the phrase a parent reads names what actually opens.
 */
describe('buildShortlist — what the source did and did not publish', () => {
  const NO_BAND = window({ ageMinMonths: null, ageMaxMonths: null });

  it("marks a child's fit 'band_unknown' when the window publishes no band", () => {
    const shortlist = buildShortlist(
      match({ window: NO_BAND, cycleWindows: [NO_BAND] }),
      [child('c1', 'Mira', 2, 6)],
      NOW,
    );
    expect(shortlist?.fitNotes).toEqual([{ childId: 'c1', name: 'Mira', fit: 'band_unknown' }]);
  });

  it('still admits every child when no band is published — silence is not exclusion', () => {
    const shortlist = buildShortlist(
      match({ window: NO_BAND, cycleWindows: [NO_BAND] }),
      [child('c1', 'Mira', 2, 6), child('c2', 'Sam', 14)],
      NOW,
    );
    expect(shortlist?.fitNotes).toHaveLength(2);
  });

  it('keeps the municipality’s own cycle label when it already names the program', () => {
    const swim = window({ programDomain: 'swim', cycleLabel: 'Fall 2026 swimming lessons' });
    // "Fall 2026 swimming lessons swim lessons" was the old rendering.
    expect(
      buildShortlist(match({ window: swim, cycleWindows: [swim] }), [child('c1', 'Max', 4)], NOW)
        ?.cyclePhrase,
    ).toBe('Fall 2026 swimming lessons');
  });

  it('adds the domain in a parent’s words when the cycle label is a bare season', () => {
    expect(
      buildShortlist(match(), [child('c1', 'Max', 4)], NOW)?.cyclePhrase,
    ).toBe('Fall 2026 recreation programs');
  });

  it('names every domain that opens together, deduped, for a collapsed event', () => {
    const youth = window({
      id: 'youth',
      programDomain: 'rec_program',
      cycleLabel: 'Fall 2026 and Winter 2027 youth programs',
    });
    const swim = window({ id: 'swim', programDomain: 'swim', cycleLabel: 'Fall 2026 swimming lessons' });
    const leadership = window({
      id: 'leadership',
      programDomain: 'swim',
      cycleLabel: 'Fall 2026 and Winter 2027 Aquatic Leadership programs',
    });
    expect(
      buildShortlist(
        match({ window: youth, cycleWindows: [youth, swim, leadership] }),
        [child('c1', 'Mira', 2, 6)],
        NOW,
      )?.cyclePhrase,
    ).toBe('recreation programs and swim lessons');
  });
});
