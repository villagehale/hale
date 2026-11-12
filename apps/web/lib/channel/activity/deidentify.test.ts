import { describe, expect, it } from 'vitest';
import {
  MAX_QUERY_FIELD_CHARS,
  deidentifyActivityQuery,
  deidentifyActivitySubject,
  refusalSentence,
} from './deidentify';
import { groundUserMessage } from './lane';

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
  town: 'Halton Hills',
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
      query: {
        subject: 'toddler gymnastics',
        window: null,
        town: 'Halton Hills',
        stage: 'toddler',
      },
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

/**
 * WHERE THE FAMILY LIVES — the second thing that must never cross, and the one the first
 * cut of this file did not test. A name is refused because Hale knows the names; a street
 * has no row to check against, so it is STRIPPED, by the same shared scrub the medical
 * lane runs. The property under test is the payload, not the mechanism: whatever the
 * model wrote, no house number, no street and no school reaches the border.
 */
describe('a street-level location never crosses the border', () => {
  it.each([
    ['the audit probe', 'toddler gym near 42 Wallace St Georgetown', ['42', 'Wallace']],
    ['an avenue', 'swim lessons at 121 Maple Ave', ['121', 'Maple']],
    [
      'a street and the postal code beside it',
      'drop-in at 12 Guelph Street L7G 4A1',
      ['12 Guelph', 'L7G'],
    ],
    ['a named school', 'after school care at St. Brigid Catholic School', ['Brigid', 'Catholic']],
    // The forms below crossed intact while the four formal suffixes were the whole rule,
    // and each names the building a child is in five days a week just as precisely.
    [
      'a lowercase head-noun',
      'gym near St. Catherine of Alexandria school',
      ['Catherine', 'Alexandria'],
    ],
    ['a suffix-less elementary', 'swim lessons by Holy Cross Elementary', ['Holy', 'Cross']],
    ['a Montessori', 'toddler music at Pineview Montessori', ['Pineview', 'Montessori']],
    ['an academy', 'after-care at Georgetown Christian Academy', ['Christian', 'Academy']],
    ['a bare École', 'programmes pres de École Sainte-Marie', ['Sainte-Marie']],
  ])('strips %s out of the subject', (_label, subject, mustNotCross) => {
    const result = deidentifyActivityQuery({ ...base, subject });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const fragment of mustNotCross) {
      expect(result.query.subject).not.toContain(fragment);
    }
  });

  it('strips it out of the WINDOW too, which crosses the border on the same payload', () => {
    const result = deidentifyActivityQuery({
      ...base,
      subject: 'toddler gymnastics',
      window: 'fall, once we move to 42 Wallace St',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.query.window).not.toContain('Wallace');
    // POSITIVE CONTROL on the same string: the season still travels, or the strip has
    // just deleted the field the search needed.
    expect(result.query.window).toContain('fall');
  });

  it('POSITIVE CONTROL - a venue the parent named is not a street, and survives whole', () => {
    const result = deidentifyActivityQuery({
      ...base,
      subject: 'Cartwheel Gym parent and tot classes',
      window: 'fall term',
    });
    expect(result).toEqual({
      ok: true,
      query: {
        subject: 'Cartwheel Gym parent and tot classes',
        window: 'fall term',
        town: 'Halton Hills',
        stage: 'toddler',
      },
    });
  });

  it('POSITIVE CONTROL - "after school" is an activity, not a school', () => {
    const result = deidentifyActivityQuery({
      ...base,
      subject: 'after school program for toddlers',
    });
    expect(result).toMatchObject({
      ok: true,
      query: { subject: 'after school program for toddlers' },
    });
  });
});

/**
 * THE WINDOW IS FREE TEXT AND CROSSES THE BORDER, so it is capped exactly as the subject
 * is. It was not, and a 431-character window - a parent's whole message pasted into the
 * second field - crossed intact while the first field was held to 120.
 */
describe('the window is held to the same ceiling as the subject', () => {
  it('refuses a window past the ceiling', () => {
    expect(
      deidentifyActivityQuery({
        ...base,
        subject: 'toddler gymnastics',
        window: 'this fall '.repeat(MAX_QUERY_FIELD_CHARS),
      }),
    ).toEqual({ ok: false, refusal: 'window_too_long' });
  });

  it('POSITIVE CONTROL - a real season phrase is well inside it', () => {
    expect(
      deidentifyActivityQuery({
        ...base,
        subject: 'toddler gymnastics',
        window: 'September to December, weekday mornings',
      }),
    ).toMatchObject({ ok: true, query: { window: 'September to December, weekday mornings' } });
  });

  it('says which field was too long, because they are different fixes', () => {
    expect(refusalSentence('window_too_long')).toContain('window');
    expect(refusalSentence('subject_too_long')).toContain('subject');
    // Neither sentence may echo what it refused (rule #1).
    expect(refusalSentence('window_too_long')).not.toContain('subject is longer');
  });
});

/**
 * THE DAY A FIND IS FOR CROSSES ONLY AS `date`. Free text is scrubbed of every full date,
 * whatever day it names, so a newborn's "born <today>" never crosses. The one date that
 * may cross is the structured `date`, and only when it is today on the family's clock or a
 * later day within FIND_DATE_MAX_DAYS_AHEAD of it. Weekdays here are worked out by hand
 * from 2026-08-09, a Sunday.
 */
describe('the day a find is for crosses as `date`, and a date in free text never does', () => {
  const today = '2026-08-09 (Sunday)';
  const subject = 'things to do';

  it('carries a window "today Sunday" with the system date to the search', () => {
    const result = deidentifyActivityQuery({
      ...base,
      subject,
      window: 'today Sunday',
      date: '2026-08-09',
      today,
    });
    expect(result).toEqual({
      ok: true,
      query: {
        subject,
        window: 'today Sunday',
        date: '2026-08-09 (Sunday)',
        town: 'Halton Hills',
        stage: 'toddler',
        today,
      },
    });
    if (!result.ok) throw new Error('unreachable');
    expect(groundUserMessage(result.query)).toBe(
      '{"subject":"things to do","town":"Halton Hills","stage":"toddler","window":"today Sunday","date":"2026-08-09 (Sunday)","today":"2026-08-09 (Sunday)"}',
    );
  });

  it.each([
    ['six days on', '2026-08-15', '2026-08-15 (Saturday)'],
    ['the last day of the reach', '2027-09-13', '2027-09-13 (Monday)'],
  ])('carries a later day: %s', (_label, date, crossed) => {
    expect(deidentifyActivityQuery({ ...base, subject, date, today })).toMatchObject({
      ok: true,
      query: { date: crossed },
    });
  });

  it('scrubs "born <today>" in the query text', () => {
    expect(
      deidentifyActivityQuery({ ...base, subject: 'class for a baby born 2026-08-09', today }),
    ).toMatchObject({ ok: true, query: { subject: 'class for a baby born [redacted]' } });
  });

  it('scrubs every full date in the window text, today and later days included', () => {
    const result = deidentifyActivityQuery({
      ...base,
      subject,
      window: 'today Sunday 2026-08-09, appointment August 20, 2026',
      date: '2026-08-09',
      today,
    });
    expect(result).toMatchObject({
      ok: true,
      query: { window: 'today Sunday [redacted], appointment [redacted]' },
    });
  });

  it.each([
    ['a past date of birth', '2024-03-15'],
    ['yesterday', '2026-08-08'],
    ['two years out', '2028-08-09'],
    ['one day past the reach', '2027-09-14'],
    ['no such day', '2026-09-31'],
    ['a weekday and not a date', 'Saturday'],
    ['a date with words around it', '2026-08-15 (Saturday)'],
  ])('drops a `date` that is %s', (_label, date) => {
    const result = deidentifyActivityQuery({ ...base, subject, window: 'Saturday', date, today });
    expect(result).toEqual({
      ok: true,
      query: {
        subject,
        window: 'Saturday',
        town: 'Halton Hills',
        stage: 'toddler',
        today,
      },
    });
  });

  it('drops a `date` when there is no family clock to hold it against', () => {
    expect(deidentifyActivityQuery({ ...base, subject, date: '2026-08-09' })).toEqual({
      ok: true,
      query: { subject, window: null, town: 'Halton Hills', stage: 'toddler' },
    });
  });
});

describe('the shape of what may be sent', () => {
  it('refuses an empty subject and one past the ceiling', () => {
    expect(deidentifyActivityQuery({ ...base, subject: '   ' })).toEqual({
      ok: false,
      refusal: 'empty_subject',
    });
    expect(
      deidentifyActivityQuery({ ...base, subject: 'gymnastics '.repeat(MAX_QUERY_FIELD_CHARS) }),
    ).toEqual({ ok: false, refusal: 'subject_too_long' });
  });

  it('refuses a search with no place, and carries the town it was given', () => {
    expect(deidentifyActivityQuery({ ...base, town: null, subject: 'story time' })).toEqual({
      ok: false,
      refusal: 'no_place',
    });
    expect(
      deidentifyActivityQuery({
        ...base,
        town: 'Seattle, Washington, United States',
        subject: 'story time',
      }),
    ).toMatchObject({ ok: true, query: { town: 'Seattle, Washington, United States' } });
  });

  it('gates a stored subject alone, with the same refusals', () => {
    expect(deidentifyActivitySubject('toddler gymnastics', HOUSEHOLD)).toEqual({
      ok: true,
      value: 'toddler gymnastics',
    });
    expect(deidentifyActivitySubject('gymnastics for Noah', HOUSEHOLD)).toEqual({
      ok: false,
      refusal: 'names_a_person',
    });
  });
});
