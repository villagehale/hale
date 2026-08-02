import { describe, expect, it } from 'vitest';
import { type StatedAgeBand, parseStatedAgeBand, plainText } from './age-band';

/**
 * VIL-260 · WS5 — reading the age a source ACTUALLY stated.
 *
 * Every string below was read from a live BiblioCommons payload (tpl / rhpl /
 * markham, 2026-08-02), not invented: the forms are the ones these three systems
 * really publish, and the rejections are the strings that sit next to them in the
 * same descriptions. The expected months are derived from the same convention the
 * audience registry uses (`throughAge`: "5 years" runs to 5y11m = 71 months), not
 * copied from the parser's output.
 */

const band = (min: number, max: number): StatedAgeBand => ({
  ageMinMonths: min,
  ageMaxMonths: max,
});

describe('parseStatedAgeBand — the forms these feeds really publish', () => {
  it('reads a month range, so an infant program stops reading as a preschool one', () => {
    // RHPL titles it; TPL says it only in the description.
    expect(parseStatedAgeBand('Babytime (0–12 months)')).toEqual(band(0, 12));
    expect(
      parseStatedAgeBand('this program for babies 0 to 18 months old with their caregiver'),
    ).toEqual(band(0, 18));
  });

  it('reads "birth to N months" — the single most common TPL Baby Time phrasing', () => {
    expect(
      parseStatedAgeBand('for babies, birth to 18 months, and their parents or caregivers'),
    ).toEqual(band(0, 18));
  });

  it('reads a MIXED-unit range, where the two ends are in different units', () => {
    // TPL Toddler Time. 3 years runs through 3y11m, the registry's own convention.
    expect(
      parseStatedAgeBand('for children, 19 months to 3 years, and their parents'),
    ).toEqual(band(19, 47));
  });

  it('reads a year range whether it is spelled years, yrs, or nothing at all', () => {
    expect(parseStatedAgeBand('Ages: 2–5 years with caregiver')).toEqual(band(24, 71));
    expect(parseStatedAgeBand("Let's Explore Art! (6–8 yrs)")).toEqual(band(72, 107));
    expect(parseStatedAgeBand('Computer Cartoon Animation Camp (Age 6-11)')).toEqual(band(72, 143));
    expect(parseStatedAgeBand('Calling all newcomer youth between the ages of 6 to 12!')).toEqual(
      band(72, 155),
    );
  });

  it('reads an open-topped "and under"', () => {
    expect(
      parseStatedAgeBand('in this program for children ages 5 and under and their caregivers'),
    ).toEqual(band(0, 71));
    expect(parseStatedAgeBand('Sunday Lego Club, for kids under 12 years')).toEqual(band(0, 143));
  });

  it('survives the HTML and entities these descriptions are stored with', () => {
    expect(parseStatedAgeBand('<p>Ages:&nbsp;0&ndash;12 months</p>')).toEqual(band(0, 12));
    // RHPL leaves a zero-width no-break space inside its own titles.
    expect(parseStatedAgeBand('Chess Classes (﻿9–12 yrs)')).toEqual(band(108, 155));
  });
});

describe('parseStatedAgeBand — what it refuses to read as an age', () => {
  it('is null for a bare number range with no unit and no age cue', () => {
    // Every one of these sits in a real description beside a real age range.
    expect(parseStatedAgeBand('Baby Time runs from 10 to 10:30 am')).toBeNull();
    expect(parseStatedAgeBand('Toddler Time runs from 10:30 to 11:00am')).toBeNull();
    expect(parseStatedAgeBand('Join us anytime between 6:30 - 7:30 PM to explore')).toBeNull();
    expect(parseStatedAgeBand('In this 4-week session, your child will dive in')).toBeNull();
  });

  it('is null for a GRADE range — a grade is a placement, not an age', () => {
    expect(parseStatedAgeBand('STEM Learning (Grades 4-6) - see details')).toBeNull();
    expect(parseStatedAgeBand('Is your child in Grades 3-4 and interested in writing?')).toBeNull();
  });

  it('is null when the text states no age at all', () => {
    expect(parseStatedAgeBand('Puppet Show: Goldilocks and the Three Bears')).toBeNull();
    expect(parseStatedAgeBand('')).toBeNull();
    expect(parseStatedAgeBand(null)).toBeNull();
  });

  it('is null for a range that is backwards or out of childhood entirely', () => {
    expect(parseStatedAgeBand('ages 12-6')).toBeNull();
    expect(parseStatedAgeBand('ages 1990 to 2020')).toBeNull();
  });
});

describe('plainText', () => {
  it('strips tags and decodes the entities the gateway stores', () => {
    expect(plainText('<p>Ages:&nbsp;0&ndash;12&nbsp;months</p>')).toBe('Ages: 0-12 months');
    expect(plainText('Fun &amp; games')).toBe('Fun & games');
  });
});
