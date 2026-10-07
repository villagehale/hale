import { describe, expect, it } from 'vitest';
import { parseRosterReading } from './roster-reading';

/**
 * A roster reply is a model object. Code accepts it only when it matches the enum.
 * Free text is not a role. Aunt is family (`extended`), never a word the regex used
 * to file under not family.
 */

describe('parseRosterReading', () => {
  it('accepts an aunt as extended family', () => {
    expect(parseRosterReading({ role: 'extended', parentRole: null, relation: 'aunt' })).toEqual({
      kind: 'role',
      role: 'extended',
      parentRole: null,
      relation: 'aunt',
    });
  });

  it('accepts not_family and a parent only with a parent role', () => {
    expect(parseRosterReading({ role: 'not_family', parentRole: null, relation: null })).toEqual({
      kind: 'role',
      role: 'not_family',
      parentRole: null,
      relation: null,
    });
    expect(parseRosterReading({ role: 'parent', parentRole: 'father', relation: null })).toEqual({
      kind: 'role',
      role: 'parent',
      parentRole: 'father',
      relation: null,
    });
  });

  it('refuses a role word that is not in the enum, including a bare aunt', () => {
    expect(parseRosterReading({ role: 'aunt', parentRole: null, relation: null })).toEqual({
      kind: 'unclear',
    });
    expect(parseRosterReading("I'm your aunt")).toEqual({ kind: 'unclear' });
  });

  it('refuses a parent role or a relation on the wrong role', () => {
    expect(
      parseRosterReading({ role: 'grandparent', parentRole: 'mother', relation: null }),
    ).toEqual({ kind: 'unclear' });
    expect(parseRosterReading({ role: 'nanny', parentRole: null, relation: 'aunt' })).toEqual({
      kind: 'unclear',
    });
    expect(parseRosterReading({ role: 'unclear', parentRole: null, relation: null })).toEqual({
      kind: 'unclear',
    });
  });
});
