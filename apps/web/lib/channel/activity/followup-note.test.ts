import { describe, expect, it } from 'vitest';
import {
  type FollowUpGrounding,
  type FollowUpPick,
  claimsNotPosted,
  claimsVerification,
  followUpUserMessage,
  followUpViolations,
  statesTheReturn,
  topPickLeads,
} from './followup-note';
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

/**
 * The ordinary grounding: a deep pass that opened a page today, and a complete answer
 * with nothing left to come back for. Every case that cares about one of the two states
 * it, and no case gets the permissive reading by omission.
 */
function grounding(over: Partial<FollowUpGrounding> = {}): FollowUpGrounding {
  return {
    subject: 'toddler gymnastics',
    picks: [PICK],
    pagesOpened: true,
    watch: false,
    ...over,
  };
}

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
    const violations = followUpViolations('I confirmed Halton Hills Gymnastics for Saturdays.', grounding(grounding()));
    expect(violations.join(' ')).toContain('their site says');
  });

  it('has NO violation for a find being unverified - going quiet is the other failure', () => {
    // The offer this sentence used to close on ("Want me to confirm before you book?")
    // is gone by doctrine, not by accident: an offer is a proposal and nothing on this
    // path can write the row a proposal needs. What survives is the honest sourcing,
    // which was always the point of this case.
    const honest =
      'Halton Hills Gymnastics has parent & tot Saturdays 9:15 from Sept 13, $142 - their site says.';
    expect(followUpViolations(honest, grounding())).toEqual([]);
  });
});

describe('the top pick lands in the first segment', () => {
  const filler = 'There are a few options worth looking at this fall in your area if you want. ';

  it('refuses a body that buries the best find past 153 characters', () => {
    const buried = `${filler}${filler}${PICK.name} runs Saturdays.`;
    expect(topPickLeads(buried, [PICK])).toBe(false);
    expect(
      followUpViolations(buried, grounding()).join(' '),
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
      'Halton Hills Gymnastics Centre has a Kinderfun toddler program (18 months - 3 years) running Sept 10 - Dec 16 - their site says.';

    expect(topPickLeads(real, [composite])).toBe(true);
    expect(followUpViolations(real, grounding({ picks: [composite] }))).toEqual([]);
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
      "Oakville's Learn to Swim Preschool program looks like a good fit - their site says fall registration opens Aug 11 at 7am, no pricing posted yet. I'll check back closer to Aug 11.";

    expect(topPickLeads(real, [oakville])).toBe(true);
    expect(
      followUpViolations(
        real,
        grounding({ subject: 'preschool swim lessons', picks: [oakville], watch: true }),
      ),
    ).toEqual([]);
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
      followUpViolations(
        'I went through the fall listings and nothing is open yet.',
        grounding({ picks: [] }),
      ),
    ).toEqual([]);
  });
});

describe('the mechanical gates', () => {
  it('refuses a link, an over-long body and a non-GSM7 character', () => {
    const withLink = `${PICK.name} runs Saturdays - see haltonhillsgym.ca`;
    expect(followUpViolations(withLink, grounding({ subject: 's' })).join(' ')).toContain(
      'link',
    );

    const long = `${PICK.name} runs Saturdays. ${'and there is more to say. '.repeat(20)}`;
    expect(followUpViolations(long, grounding({ subject: 's' })).join(' ')).toContain(
      'segments',
    );
  });

  it('refuses an empty body outright', () => {
    expect(followUpViolations('   ', grounding({ subject: 's' }))).toEqual([
      'The message was empty.',
    ]);
  });
});

/**
 * WHAT THE COMPOSER IS ACTUALLY TOLD — the boundary the gates above never look at.
 *
 * Every test in this file so far scores a body the model already wrote. None of them
 * could see the failure underneath: the deep pass spends a page-open to learn that
 * registration opened on July 22, hands the slot to the composer, and the composer is
 * handed a payload with no such field in it. The model cannot write a fact nobody gave
 * it, so the message comes back correct, gated, sendable — and silent about the one
 * thing that decides whether the parent acts today (rule #11: the fact went missing with
 * nothing named).
 *
 * A hand-listed projection is where that happens, so this is the assertion that has to be
 * whole-object rather than a spot check: a field added to a slot and forgotten here is
 * invisible at every other boundary in the lane.
 */
describe('the payload the composer is handed', () => {
  const DEEP_SLOT: FollowUpPick = {
    name: 'Tiny Gym, Cartwheels Gym Centre',
    ageFit: 'walking to 3.5 years, with a parent',
    when: 'Sundays 9:30-10:15, Sept 14 to Oct 26',
    price: '$124 per term',
    registration: 'Registration has been open since July 22',
    sourceName: 'Cartwheels Gym Centre',
    source: 'web',
  };

  it('carries the REGISTRATION fact the deep pass opened a page to get', () => {
    const payload = JSON.parse(
      followUpUserMessage(grounding({ subject: 'Cartwheels Gym Centre', picks: [DEEP_SLOT] })),
    );

    expect(payload.picks[0]).toEqual({
      name: 'Tiny Gym, Cartwheels Gym Centre',
      age_fit: 'walking to 3.5 years, with a parent',
      when: 'Sundays 9:30-10:15, Sept 14 to Oct 26',
      price: '$124 per term',
      registration: 'Registration has been open since July 22',
      source_name: 'Cartwheels Gym Centre',
      source: 'web',
    });
  });

  it('POSITIVE CONTROL - a snippet pick with no registration fact says so, and keeps the key', () => {
    // The other direction, and the reason the key is present rather than omitted: an
    // absent key reads to the model as a field it may fill in, and the shallow lane has
    // never opened a page to fill it from.
    const payload = JSON.parse(
      followUpUserMessage(grounding()),
    );

    expect(payload.picks[0]).toHaveProperty('registration', null);
  });

  it('carries whether a page was opened and whether a continuation row exists', () => {
    // Both are facts about the SWEEP, and both reached the model through nothing until
    // now — which is how a turn that opened no page went on writing "not posted yet",
    // and how an offer with no row behind it went out.
    const payload = JSON.parse(
      followUpUserMessage(grounding({ pagesOpened: false, watch: true })),
    );

    expect(payload.pages_opened).toBe(false);
    expect(payload.watch).toBe(true);
  });

  it('carries the subject and the mode, and nothing about the family (rule #1)', () => {
    const payload = JSON.parse(
      followUpUserMessage(grounding({ picks: [DEEP_SLOT] })),
    );

    expect(Object.keys(payload).sort()).toEqual([
      'mode',
      'pages_opened',
      'picks',
      'subject',
      'watch',
    ]);
    expect(payload.mode).toBe('followup_text');
  });
});

/**
 * THE THREE GATES THE 2026-08-22 TRANSCRIPT NEEDED AND DID NOT HAVE.
 *
 * 17:19 UTC, production: "Cartwheels Gym Centre runs Tiny Gym for kids under 3.5 with a
 * parent... but fall days, times and prices aren't posted yet. Want me to check back once
 * they're up?" Three things were wrong with one text. The deep pass had opened NO page
 * (its research turn timed out), so "aren't posted yet" was a report on a schedule that
 * was in fact published. The closing question was an offer with no row behind it, and
 * twenty minutes later the parent's "Yes, please" landed on an unrelated approvals menu.
 * And nothing said what Hale would actually do next.
 */
describe('an offer is a proposal, so this lane makes none', () => {
  it('refuses any question - there is no row on this path for a yes to land on', () => {
    const asked = `${PICK.name} runs Saturdays 9:15 from Sept 13, $142 - their site says. Want me to check back once they're up?`;

    expect(followUpViolations(asked, grounding()).join(' ')).toContain('asks the parent a question');
  });

  it('POSITIVE CONTROL - the same find, ending on a statement, passes', () => {
    const told = `${PICK.name} runs Saturdays 9:15 from Sept 13, $142 - their site says.`;

    expect(followUpViolations(told, grounding())).toEqual([]);
  });
});

describe('a claim about a page requires a page', () => {
  it.each([
    "Their fall days, times and prices aren't posted yet.",
    'The fall guide is not up.',
    'Nothing is listed for the fall session.',
    'No dates published for the fall term.',
  ])('reads %s as a claim about a page', (body) => {
    expect(claimsNotPosted(body)).toBe(true);
  });

  it.each([
    'I could not get into their schedule page today.',
    "I could not read their page today, so I'll keep watching.",
    'Their site says Tiny Gym runs Sundays 9:30.',
    'Registration has been open since July 22.',
  ])('lets %s through - none of these claims a page said nothing', (body) => {
    expect(claimsNotPosted(body)).toBe(false);
  });

  it('THE DEFECT: with no page opened, the unposted claim is refused', () => {
    const body = `${PICK.name} runs a toddler class - their site says, but fall days and prices aren't posted yet. I'll keep watching and text you when they go up.`;

    expect(
      followUpViolations(body, grounding({ pagesOpened: false, watch: true })).join(' '),
    ).toContain('not posted');
  });

  it('POSITIVE CONTROL - the SAME words pass once a page was actually opened today', () => {
    const body = `${PICK.name} runs a toddler class - their site says, but fall days and prices aren't posted yet. I'll keep watching and text you when they go up.`;

    expect(followUpViolations(body, grounding({ pagesOpened: true, watch: true }))).toEqual([]);
  });

  it('POSITIVE CONTROL - the uncertain sentence passes with no page opened', () => {
    const body = `${PICK.name} runs a toddler class for under-3s - their site says. I could not get into their fall schedule page today, so I'll keep looking and text you what it says.`;

    expect(followUpViolations(body, grounding({ pagesOpened: false, watch: true }))).toEqual([]);
  });
});

describe('a continuation row must be spoken for', () => {
  it.each([
    "I'll keep watching and text you when they post.",
    'I will check back once the fall guide goes up.',
    "I'll go back through it and let you know.",
  ])('reads %s as Hale committing to come back', (body) => {
    expect(statesTheReturn(body)).toBe(true);
  });

  it.each([
    'Their site says Saturdays 9:15.',
    'Registration opens Sept 1 at 7am.',
    'The fall guide goes up soon.',
  ])('does not read %s as a commitment', (body) => {
    expect(statesTheReturn(body)).toBe(false);
  });

  it('THE DEFECT MIRRORED: a watch row with no sentence claiming it is refused', () => {
    const silent = `${PICK.name} runs a toddler class for under-3s - their site says.`;

    expect(followUpViolations(silent, grounding({ watch: true })).join(' ')).toContain(
      "I'll keep watching",
    );
  });

  it('POSITIVE CONTROL - with no watch row, the same silent message is fine', () => {
    const silent = `${PICK.name} runs a toddler class for under-3s - their site says.`;

    expect(followUpViolations(silent, grounding({ watch: false }))).toEqual([]);
  });

  /**
   * THE MIRROR, and it is not hypothetical. The first live re-recording of this composer
   * after the watch field was added — handed a complete find and `watch: false` — closed
   * with "I'll keep looking and text you what it says": a promise to come back with no
   * row behind it, written by the very change that exists to stop that.
   */
  it('refuses a coming-back sentence when NO row was written for it', () => {
    const promised = `${PICK.name} runs Saturdays 9:15, $142 - their site says. I'll keep looking and text you what else opens.`;

    expect(followUpViolations(promised, grounding({ watch: false })).join(' ')).toContain(
      'no such promise has been written down',
    );
  });

  it('POSITIVE CONTROL - the SAME sentence passes once the row exists', () => {
    const promised = `${PICK.name} runs Saturdays 9:15, $142 - their site says. I'll keep looking and text you what else opens.`;

    expect(followUpViolations(promised, grounding({ watch: true }))).toEqual([]);
  });
});
