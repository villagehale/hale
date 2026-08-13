import { describe, expect, it } from 'vitest';
import { EVERGREEN_VENUES } from './evergreen-venues-data';
import { selectStandingOption } from './standing-option';

/**
 * The standing option is what Hale offers when the Village run has produced nothing it
 * can name. It must be a real row from the verified dataset, chosen with no model in the
 * loop, and it must never be offered where the dataset cannot support it.
 */

const TORONTO = 'M4K 1A1';
/** Thornhill, recorded as straddling Markham and Vaughan (fsa-municipalities.ts). */
const THORNHILL = 'L4J 2B3';
const OTTAWA = 'K1A 0B1';

const AUGUST = 8;
const FEBRUARY = 2;

describe('selectStandingOption — who gets what', () => {
  it('offers the EarlyON centre to a family whose youngest is under four', () => {
    const option = selectStandingOption({
      postal: TORONTO,
      youngestAgeMonths: 26,
      month: AUGUST,
    });

    expect(option?.name).toBe('EarlyON Child and Family Centres (city-wide network)');
    expect(option?.cadence).toBe(
      'most sites run weekday sessions; contact centre / check toronto.ca locator',
    );
  });

  it('offers outdoor water play in a warm month once the children are past the EarlyON band', () => {
    const option = selectStandingOption({
      postal: TORONTO,
      youngestAgeMonths: 61,
      month: AUGUST,
    });

    expect(option?.name).toBe('High Park');
  });

  it('never offers a splash pad out of season — the library is the cold-month answer', () => {
    const option = selectStandingOption({
      postal: TORONTO,
      youngestAgeMonths: 61,
      month: FEBRUARY,
    });

    expect(option?.name).toBe(
      'Toronto Public Library — Baby Time / Toddler Time / Family Storytime',
    );
  });

  it('falls past a kind the municipality has no row for', () => {
    const onlyALibrary = EVERGREEN_VENUES.filter(
      (v) => v.municipality === 'toronto' && v.kind === 'library',
    );

    const option = selectStandingOption(
      { postal: TORONTO, youngestAgeMonths: 26, month: AUGUST },
      onlyALibrary,
    );

    expect(option?.name).toBe(
      'Toronto Public Library — Baby Time / Toddler Time / Family Storytime',
    );
  });

  it('hands out no URL — provenance stays in the dataset', () => {
    const option = selectStandingOption({
      postal: TORONTO,
      youngestAgeMonths: 26,
      month: AUGUST,
    });

    expect(option).not.toBeNull();
    expect(JSON.stringify(option)).not.toContain('http');
  });
});

describe('selectStandingOption — where it declines', () => {
  it('declines when the family has no postal code on file', () => {
    expect(
      selectStandingOption({ postal: null, youngestAgeMonths: 26, month: AUGUST }),
    ).toBeNull();
  });

  it('declines outside the covered set rather than guessing a neighbouring town', () => {
    expect(
      selectStandingOption({ postal: OTTAWA, youngestAgeMonths: 26, month: AUGUST }),
    ).toBeNull();
  });

  it('declines on a straddling FSA, which names no one town', () => {
    expect(
      selectStandingOption({ postal: THORNHILL, youngestAgeMonths: 26, month: AUGUST }),
    ).toBeNull();
  });

  it('declines when the family has no children on file to choose for', () => {
    expect(
      selectStandingOption({ postal: TORONTO, youngestAgeMonths: null, month: AUGUST }),
    ).toBeNull();
  });
});

describe('the dataset the selector rests on', () => {
  it('carries an EarlyON and a library row for every municipality it covers', () => {
    const covered = new Set(EVERGREEN_VENUES.map((v) => v.municipality));
    expect(covered.size).toBe(15);

    for (const municipality of covered) {
      const kinds = new Set(
        EVERGREEN_VENUES.filter((v) => v.municipality === municipality).map((v) => v.kind),
      );
      expect({ municipality, earlyon: kinds.has('earlyon'), library: kinds.has('library') }).toEqual(
        { municipality, earlyon: true, library: true },
      );
    }
  });

  it('carries a source for every row, because a row that cannot be re-checked is a guess', () => {
    expect(EVERGREEN_VENUES).toHaveLength(83);
    const unsourced = EVERGREEN_VENUES.filter((v) => !v.source.startsWith('https://'));
    expect(unsourced).toEqual([]);
  });
});
