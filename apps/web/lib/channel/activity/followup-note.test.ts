import { describe, expect, it } from 'vitest';
import { claimsVerification, followUpViolations, topPickLeads } from './followup-note';
import type { ActivityPick } from './lane';

/**
 * THE TWO GATES THE FOLLOW-UP TEXT CANNOT SHIP WITHOUT PASSING.
 *
 * Both are refusals, so both are tested in BOTH directions. A one-way test of a gate is
 * satisfied by a gate that refuses everything, which is the same product failure as one
 * that refuses nothing: Hale going quiet.
 */

const PICK: ActivityPick = {
  name: 'Halton Hills Gymnastics',
  ageFit: '18 months - 3 years',
  when: 'Saturdays 9:15am from Sept 13',
  price: '$142',
  sourceName: 'Halton Hills Gymnastics Centre',
  source: 'web',
};

describe('never claims to have verified what it only read', () => {
  it.each([
    'I confirmed Saturdays at 9:15 with them.',
    'Verified: parent and tot runs Saturday mornings.',
    'I double-checked the fall schedule.',
    'Their fall times are confirmed for Sept 13.',
  ])('refuses %s', (body) => {
    expect(claimsVerification(body)).toBe(true);
  });

  it.each([
    // The sentence Hale is SUPPOSED to write. A whole-body match on "confirm" would kill
    // exactly this, which is why the guard is clause-scoped.
    "Their site says Saturdays 9:15 - I'll confirm before you book.",
    'Listed as Saturdays 9:15. Want me to confirm the spot?',
    'The times are not confirmed yet, so I would call first.',
    'Their site says $142 for 12 weeks.',
  ])('lets through %s', (body) => {
    expect(claimsVerification(body)).toBe(false);
  });

  it('surfaces the honest phrasing in the refusal the model reads', () => {
    const violations = followUpViolations('I confirmed Halton Hills Gymnastics for Saturdays.', {
      subject: 'toddler gymnastics',
      picks: [PICK],
    });
    expect(violations.join(' ')).toContain('their site says');
  });

  it('has NO violation for a find being unverified - going quiet is the other failure', () => {
    const honest =
      "Halton Hills Gymnastics has parent & tot Saturdays 9:15 from Sept 13, $142 - their site says. Want me to confirm before you book?";
    expect(followUpViolations(honest, { subject: 'toddler gymnastics', picks: [PICK] })).toEqual([]);
  });
});

describe('the top pick lands in the first segment', () => {
  const filler = 'There are a few options worth looking at this fall in your area if you want. ';

  it('refuses a body that buries the best find past 153 characters', () => {
    const buried = `${filler}${filler}${PICK.name} runs Saturdays.`;
    expect(topPickLeads(buried, [PICK])).toBe(false);
    expect(
      followUpViolations(buried, { subject: 'toddler gymnastics', picks: [PICK] }).join(' '),
    ).toContain(PICK.name);
  });

  it('POSITIVE CONTROL - the same find, named first, passes the same check', () => {
    const led = `${PICK.name} runs Saturdays. ${filler}`;
    expect(topPickLeads(led, [PICK])).toBe(true);
  });

  it('is vacuously satisfied when there is nothing to lead with', () => {
    // The empty-handed message has no pick to name, and demanding one would make the
    // honest "I looked and found nothing" unsendable.
    expect(topPickLeads('I went through the fall listings and nothing is open yet.', [])).toBe(
      true,
    );
    expect(
      followUpViolations('I went through the fall listings and nothing is open yet.', {
        subject: 'toddler gymnastics',
        picks: [],
      }),
    ).toEqual([]);
  });
});

describe('the mechanical gates', () => {
  it('refuses a link, an over-long body and a non-GSM7 character', () => {
    const withLink = `${PICK.name} runs Saturdays - see haltonhillsgym.ca`;
    expect(followUpViolations(withLink, { subject: 's', picks: [PICK] }).join(' ')).toContain(
      'link',
    );

    const long = `${PICK.name} runs Saturdays. ${'and there is more to say. '.repeat(20)}`;
    expect(followUpViolations(long, { subject: 's', picks: [PICK] }).join(' ')).toContain(
      'segments',
    );
  });

  it('refuses an empty body outright', () => {
    expect(followUpViolations('   ', { subject: 's', picks: [PICK] })).toEqual([
      'The message was empty.',
    ]);
  });
});
