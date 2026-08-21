import { describe, expect, it } from 'vitest';
import { MAX_SUBJECT_CHARS, deidentifyActivityQuery, townFor } from './deidentify';

/**
 * PHASE 0 — the rule-#1 gate in front of a cross-border search.
 *
 * Everything here is a negative property, so every one of them is paired with a POSITIVE
 * CONTROL through the same call: a test that only proves "the name did not get through"
 * passes just as well when nothing gets through at all, which is a gate that has silently
 * stopped answering. Each refusal below has a twin that must be let out.
 */

const HOUSEHOLD = ['Noah', 'Chloé', 'Sam'];

const base = {
  municipality: 'halton_hills' as const,
  stage: 'toddler' as const,
  householdNames: HOUSEHOLD,
};

describe('a name never crosses the border', () => {
  it.each([
    ['a child named outright', 'gymnastics for Noah'],
    ['a name mid-sentence', 'something Noah can do this fall'],
    ['an accented name, whose boundary \\b cannot see', 'swim lessons for Chloé'],
    ['a parent', 'a class Sam can bring him to'],
    ['a name in the window rather than the subject', null],
  ])('refuses %s', (label, subject) => {
    const result =
      subject === null
        ? deidentifyActivityQuery({ ...base, subject: 'gymnastics', window: 'while Noah naps' })
        : deidentifyActivityQuery({ ...base, subject });
    expect(result).toEqual({ ok: false, refusal: 'names_a_person' });
    expect(label).toBeTypeOf('string');
  });

  it('POSITIVE CONTROL - lets an ordinary subject through the same call', () => {
    const result = deidentifyActivityQuery({ ...base, subject: 'toddler gymnastics' });
    expect(result).toEqual({
      ok: true,
      query: { subject: 'toddler gymnastics', window: null, town: 'Halton Hills', stage: 'toddler' },
    });
  });

  it('POSITIVE CONTROL - a longer name is not matched by a shorter sibling of it', () => {
    // "Noa" is not "Noah", and a substring match here would refuse half the language.
    const result = deidentifyActivityQuery({
      ...base,
      householdNames: ['Noa'],
      subject: 'noah county gymnastics',
    });
    expect(result.ok).toBe(true);
  });
});

describe('what is stripped rather than refused', () => {
  it('strips an exact age, a postal code and a phone number', () => {
    const result = deidentifyActivityQuery({
      ...base,
      subject: 'gymnastics for 18 months, L7G 4S6, call 416-555-0100',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query.subject).not.toMatch(/18 months|L7G|416/);
    // POSITIVE CONTROL on the same string: the useful part survives the scrub.
    expect(result.query.subject).toContain('gymnastics');
  });

  it('leaves the age BAND, which is the whole reason a band exists', () => {
    const result = deidentifyActivityQuery({ ...base, subject: 'swim lessons' });
    expect(result.ok && result.query.stage).toBe('toddler');
  });
});

describe('the shape of what may be sent', () => {
  it('refuses an empty subject and one past the ceiling', () => {
    expect(deidentifyActivityQuery({ ...base, subject: '   ' })).toEqual({
      ok: false,
      refusal: 'empty_subject',
    });
    expect(
      deidentifyActivityQuery({ ...base, subject: 'gymnastics '.repeat(MAX_SUBJECT_CHARS) }),
    ).toEqual({ ok: false, refusal: 'subject_too_long' });
  });

  it('carries a town only when the postal code named one', () => {
    expect(
      deidentifyActivityQuery({ ...base, municipality: null, subject: 'story time' }),
    ).toMatchObject({ ok: true, query: { town: null } });
  });

  it('turns a municipality id into the words a search engine reads', () => {
    expect(townFor('halton_hills')).toBe('Halton Hills');
    expect(townFor('richmond_hill')).toBe('Richmond Hill');
    expect(townFor('toronto')).toBe('Toronto');
  });
});
