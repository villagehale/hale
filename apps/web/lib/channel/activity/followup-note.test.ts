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

  it('POSITIVE CONTROL - a message that names the pick BETTER than the field does passes', () => {
    // A verbatim match on `name` is the wrong test, and this is the message that proved
    // it: the real corpus answer for the fall-gymnastics fixture. No SMS repeats that
    // composite field whole, so the gate refused it, recomposed three times and then
    // DEFERRED - Hale going quiet on a good find, which is the failure, not the guard.
    const composite: ActivityPick = {
      ...PICK,
      name: 'Kinderfun (Toddler Program), Halton Hills Gymnastics Centre',
    };
    const real =
      'Halton Hills Gymnastics Centre has a Kinderfun toddler program (18 months - 3 years) running Sept 10 - Dec 16 - their site says. Want me to confirm the spot?';

    expect(topPickLeads(real, [composite])).toBe(true);
    expect(followUpViolations(real, { subject: 'toddler gymnastics', picks: [composite] })).toEqual(
      [],
    );
  });

  it('POSITIVE CONTROL - the Oakville answer, which names the find in its first six words', () => {
    // The corpus answer for the swim fixture. A phrase-contiguous check refused it: the
    // field says "Learn to Swim: Parent and Tot / Preschool, Town of Oakville" and the
    // message says "Oakville's Learn to Swim Preschool program", which is how a person
    // would say it.
    const oakville: ActivityPick = {
      ...PICK,
      name: 'Learn to Swim: Parent and Tot / Preschool, Town of Oakville',
      when: 'Fall registration opens Tuesday, August 11 at 7 a.m.',
      price: null,
      sourceName: 'Town of Oakville Parks and Recreation',
    };
    const real =
      "Oakville's Learn to Swim Preschool program looks like a good fit - their site says fall registration opens Aug 11 at 7am (no pricing posted yet). Want me to check closer to Aug 11?";

    expect(topPickLeads(real, [oakville])).toBe(true);
    expect(followUpViolations(real, { subject: 'preschool swim lessons', picks: [oakville] })).toEqual(
      [],
    );
  });

  it('still refuses a body whose lead names nothing in particular', () => {
    // The other direction: matching on the name's PARTS must not be satisfied by a
    // programme noun. "a toddler program" has named no venue a parent could look up.
    const composite = {
      ...PICK,
      name: 'Kinderfun (Toddler Program), Halton Hills Gymnastics Centre',
    };
    const vague = `A toddler program is the pick of them this fall. ${filler}${filler}${composite.name}.`;
    expect(vague.indexOf(composite.name)).toBeGreaterThan(153);
    expect(topPickLeads(vague, [composite])).toBe(false);
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
