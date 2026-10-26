import { describe, expect, it } from 'vitest';
import {
  type FollowUpGrounding,
  type FollowUpPick,
  claimsVerification,
  followUpUserMessage,
  followUpViolations,
  topPickLeads,
  waitsOnAPageItCouldNotRead,
} from './followup-note';
import { asksTheParent } from './followup-note';
import type { ActivityPick } from './lane';

it('does not mistake a checked source URL query for an approval question', () => {
  expect(
    asksTheParent('Current dates remain unconfirmed. https://example.org/events?topic=kids#dates'),
  ).toBe(false);
  expect(asksTheParent('Would you like that? https://example.org/events?topic=kids')).toBe(true);
});

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
/** The composer's own `commits_to_return`, defaulting to the honest reading (it matches the row). */
function gates(body: string, g: FollowUpGrounding, commitsToReturn: boolean = g.watch): string[] {
  return followUpViolations(body, g, commitsToReturn);
}

function grounding(over: Partial<FollowUpGrounding> = {}): FollowUpGrounding {
  return {
    subject: 'toddler gymnastics',
    language: 'en-CA',
    picks: [PICK],
    pageEvidence: 'page_has_no_schedule',
    watch: false,
    moreRemaining: 0,
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
    const violations = gates(
      'I confirmed Halton Hills Gymnastics for Saturdays.',
      grounding(grounding()),
    );
    expect(violations.join(' ')).toContain('their site says');
  });

  it('has NO violation for a find being unverified - going quiet is the other failure', () => {
    // The offer this sentence used to close on ("Want me to confirm before you book?")
    // is gone by doctrine, not by accident: an offer is a proposal and nothing on this
    // path can write the row a proposal needs. What survives is the honest sourcing,
    // which was always the point of this case.
    const honest =
      'Halton Hills Gymnastics has parent & tot Saturdays 9:15 from Sept 13, $142 - their site says.';
    expect(gates(honest, grounding())).toEqual([]);
  });
});

describe('the top pick is named', () => {
  const filler = 'There are a few options worth looking at this fall in your area if you want. ';

  it('accepts a body that names the best find past the old 153-character window', () => {
    const buried = `${filler}${filler}${PICK.name} runs Saturdays.`;
    expect(buried.indexOf(PICK.name)).toBeGreaterThan(153);
    expect(topPickLeads(buried, [PICK])).toBe(true);
    expect(gates(buried, grounding())).toEqual([]);
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
    expect(gates(real, grounding({ picks: [composite] }))).toEqual([]);
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
      gates(real, grounding({ subject: 'preschool swim lessons', picks: [oakville], watch: true })),
    ).toEqual([]);
  });

  it('still refuses a body whose lead names nothing in particular', () => {
    // The other direction: matching on the name's PARTS must not be satisfied by a
    // programme noun. "a toddler program" has named no venue a parent could look up.
    const composite = {
      ...PICK,
      name: 'Kinderfun (Toddler Program), Halton Hills Gymnastics Centre',
    };
    const vague = `A toddler program is the pick of them this fall. ${filler}${filler}Something else entirely.`;
    expect(topPickLeads(vague, [composite])).toBe(false);
  });

  it('is vacuously satisfied when there is nothing to lead with', () => {
    // The empty-handed message has no pick to name, and demanding one would make the
    // honest "I looked and found nothing" unsendable.
    expect(topPickLeads('I went through the fall listings and nothing is open yet.', [])).toBe(
      true,
    );
    expect(
      gates('I went through the fall listings and nothing is open yet.', grounding({ picks: [] })),
    ).toEqual([]);
  });
});

/**
 * THE CONTINUATION IS A CLAIM ABOUT WHY HALE IS COMING BACK.
 *
 * The same claim can wear the future: "I'll keep watching and text you once the details are up" presupposes they are
 * not up. Live on 2026-08-24 the composer got the gap right in Hale's own voice — "I
 * couldn't pin down the day, time or price from their term PDF" — and then handed it
 * straight back to the page one clause later, about a venue whose term schedule WAS
 * posted, in a PDF it could not decode and behind a login it could not enter.
 */
describe('a message may not say Hale could not get at a fact AND that it awaits posting', () => {
  const CANNOT = 'I could not pin down the day, time or price from their term PDF.';

  it.each([
    "I'll keep watching and text you once the details are up.",
    "I'll keep watching and text you when they post those.",
    "I'll keep watching and text you when more posts.",
    "I'll keep watching and text you when the fall guide goes up.",
    "I'll text you as soon as they're posted.",
  ])('refuses it beside an access failure: %s', (tail) => {
    expect(waitsOnAPageItCouldNotRead(`${CANNOT} ${tail}`)).toBe(true);
  });

  it.each([
    // What Hale is really waiting on, said beside the same access failure.
    "I'll keep watching and text you when I can get to them.",
    "I'll keep watching and text you when I can read them.",
    "I'll text you once I can look it up.",
    "I'll keep watching and text you if that changes.",
  ])('lets through the honest continuation: %s', (tail) => {
    expect(waitsOnAPageItCouldNotRead(`${CANNOT} ${tail}`)).toBe(false);
  });

  /**
   * AND WITHOUT THE ACCESS FAILURE THERE IS NO CONTRADICTION. `page_evidence` is one
   * verdict for a whole message while the gaps are per-field, so a body whose schedule
   * the page published and whose FEES really do live in a Council guide is entitled to
   * wait on the town. Gating on the verdict alone refused that message three times and
   * deferred a promise the judge scored 4.
   */
  it('POSITIVE CONTROL - the same waiting sentence stands when Hale claimed no failure', () => {
    const honest =
      "Oakville's Learn to Swim has Preschool A Saturdays 9:00-9:30 - their site says, price set in the current Recreation Guide. I'll keep watching and text you when more posts.";

    const oakville: ActivityPick = {
      ...PICK,
      name: 'Preschool A, Town of Oakville Learn to Swim',
      sourceName: 'Town of Oakville',
    };

    expect(waitsOnAPageItCouldNotRead(honest)).toBe(false);
    expect(
      gates(
        honest,
        grounding({ picks: [oakville], pageEvidence: 'page_has_schedule', watch: true }),
      ),
    ).toEqual([]);
  });

  it('is a violation whatever the page verdict says, because the body contradicts itself', () => {
    const body = `${PICK.name} runs Saturdays - their site says, though I could not pin down the price. I'll keep watching and text you once the price is up.`;

    for (const pageEvidence of ['page_has_schedule', 'no_page_read'] as const) {
      expect(gates(body, grounding({ pageEvidence, watch: true })).join(' ')).toContain(
        'when YOU can get at them',
      );
    }
  });
});

describe('any language, as long as the find leads and the text fits', () => {
  const zh =
    'Halton Hills Gymnastics 有亲子课，周六 9:15 起，9 月 13 日开始，一期 142 加元。他们网站上是这么写的。还有更多选择，你在这里问我就发下一档。';
  const ar =
    'Halton Hills Gymnastics دروس السبت الساعة 9:15 من 13 سبتمبر، 142 دولارا للفصل. موقعهم يقول ذلك. هناك المزيد، واسأل هنا عن التالية.';

  it.each([
    ['zh', zh],
    ['ar', ar],
  ])(
    'lets a %s follow-up through when the day and the price are already in hand',
    (label, body) => {
      expect(label.length).toBeGreaterThan(0);
      expect(
        gates(
          body,
          grounding({
            watch: false,
            pageEvidence: 'page_has_schedule',
            picks: [{ ...PICK, when: 'Saturdays 9:15', price: '$142' }],
          }),
        ),
      ).toEqual([]);
    },
  );
});

describe('the mechanical gates', () => {
  it('refuses a link', () => {
    const withLink = `${PICK.name} runs Saturdays - see haltonhillsgym.ca`;
    expect(gates(withLink, grounding({ subject: 's' })).join(' ')).toContain('link');
  });

  it('refuses an empty body outright', () => {
    expect(gates('   ', grounding({ subject: 's' }))).toEqual(['The message was empty.']);
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
    const payload = JSON.parse(followUpUserMessage(grounding()));

    expect(payload.picks[0]).toHaveProperty('registration', null);
  });

  it('carries what the pages license and whether a continuation row exists', () => {
    // Both are facts about the SWEEP, and both reached the model through nothing until
    // now — which is how a turn that opened no page went on writing "not posted yet",
    // and how an offer with no row behind it went out. `page_evidence` is three-valued
    // rather than a boolean because "I could not open it" and "I opened it and could not
    // pin these details" are different sentences (2026-08-24).
    const payload = JSON.parse(
      followUpUserMessage(grounding({ pageEvidence: 'no_page_read', watch: true })),
    );

    expect(payload.page_evidence).toBe('no_page_read');
    expect(payload.watch).toBe(true);
    expect(
      JSON.parse(followUpUserMessage(grounding({ pageEvidence: 'page_has_schedule' })))
        .page_evidence,
    ).toBe('page_has_schedule');
  });

  /**
   * WITH NO PICKS THERE ARE NO PAGES TO REPORT ON, so the payload carries none.
   *
   * The skill's precedence rule already said `page_evidence` is not the subject of an
   * empty-handed message, and the rule lost: handed `no_page_read` and nothing else to
   * talk about, the composer wrote "I could not get into any pages today for toddler
   * underwater basket weaving" — a sentence that tells a parent the programme exists and
   * Hale merely missed it. It does not exist. A model that is never handed a page fact
   * cannot blame a page, which is the difference between a rule and a construction.
   *
   * `picks_empty` rather than a dropped key, for the same reason the picks carry an
   * explicit `registration: null`: silence reads to a model as a field it may fill in,
   * and this one is a fact about the search that the message is entirely about.
   */
  it('with NO picks the payload carries no page state at all - only that there was nothing', () => {
    const payload = JSON.parse(
      followUpUserMessage(grounding({ picks: [], pageEvidence: 'no_page_read', watch: true })),
    );

    expect(Object.keys(payload).sort()).toEqual([
      'language',
      'mode',
      'picks',
      'picks_empty',
      'subject',
      'watch',
    ]);
    expect(payload.picks_empty).toBe(true);
    expect(payload.picks).toEqual([]);
  });

  it('carries the subject and the mode, and nothing about the family (rule #1)', () => {
    const payload = JSON.parse(followUpUserMessage(grounding({ picks: [DEEP_SLOT] })));

    expect(Object.keys(payload).sort()).toEqual([
      'language',
      'mode',
      'page_evidence',
      'picks',
      'subject',
      'watch',
    ]);
    expect(payload.mode).toBe('followup_text');
    expect(payload).not.toHaveProperty('more_remaining');
  });

  it('tells the model more options were held back, and says nothing when none were', () => {
    const held = JSON.parse(followUpUserMessage(grounding({ moreRemaining: 2 })));
    expect(held.more_remaining).toBe(2);
    expect(typeof held.more_remaining_instruction).toBe('string');
    expect(held.more_remaining_instruction.length).toBeGreaterThan(0);
    expect(Object.keys(held)).toEqual([
      'mode',
      'subject',
      'language',
      'page_evidence',
      'watch',
      'more_remaining',
      'more_remaining_instruction',
      'picks',
    ]);

    const none = JSON.parse(followUpUserMessage(grounding({ moreRemaining: 0 })));
    expect(none).not.toHaveProperty('more_remaining');
    expect(none).not.toHaveProperty('more_remaining_instruction');
  });

  it("passes the language tag through unchanged, and never the parent's words", () => {
    for (const language of ['zh', 'ar', 'en-CA']) {
      const payload = JSON.parse(followUpUserMessage(grounding({ language })));
      expect(payload.language).toBe(language);
      expect(JSON.stringify(payload)).not.toMatch(/parent said|raw message/i);
    }
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

    expect(gates(asked, grounding()).join(' ')).toContain('asks the parent a question');
  });

  it('POSITIVE CONTROL - the same find, ending on a statement, passes', () => {
    const told = `${PICK.name} runs Saturdays 9:15 from Sept 13, $142 - their site says.`;

    expect(gates(told, grounding())).toEqual([]);
  });
});

describe('naming the find a parent is being handed', () => {
  const GRID_ROW = {
    ...PICK,
    name: 'Parent and Tot 1, 2, 3 - Gellert Community Centre (Mon 10:00AM daytime, code 108969)',
  };

  it('THE 2026-08-24 DEFERRAL: a name disambiguated in brackets is still named by its place', () => {
    // Once the merge could see the grid it returned thirty rows differing only by
    // weekday and told them apart inside `name`. Read whole, that made "daytime" and
    // "108969" identifying words - so the gate wanted an SMS to quote a session code,
    // no draft could, and a complete verified schedule deferred into silence.
    const body =
      'Gellert Community Centre runs Parent and Tot swim Mondays 10:00-10:30am, Oct 5 to Dec 7, $86.22 for 9 lessons - their site says.';

    expect(topPickLeads(body, [GRID_ROW])).toBe(true);
  });

  it('POSITIVE CONTROL - a message that names no place is still refused', () => {
    const vague = 'There is a toddler swim class running this fall - their site says.';

    expect(topPickLeads(vague, [GRID_ROW])).toBe(false);
  });

  it('a name whose only distinctive word is IN the bracket is matched without it', () => {
    // "Parent and Tot (18 months - 3.11 yrs)" - the venue lives in `sourceName`, and
    // stripping the bracket leaves nothing over five letters that is not a programme
    // noun. The first version then fell back to demanding the RAW name whole, bracket
    // included: the same defect as the one above, wearing the other face.
    const bracketed = { ...PICK, name: 'Parent and Tot (18 months - 3.11 yrs)' };

    expect(
      topPickLeads('Halton Hills runs Parent and Tot swim Mondays 10:00am.', [bracketed]),
    ).toBe(true);
    expect(topPickLeads('There is a swim class on Mondays at 10:00am.', [bracketed])).toBe(false);
  });

  it('naming the VENUE names the find, when the name itself carries a programme stream', () => {
    // "Toddler Program (18 months - 3 years), Preschool and Kinderfun" reduces to
    // "kinderfun" - a stream nobody would text - and the venue lives in `sourceName`.
    // A parent reading "Halton Hills Gymnastics Centre runs a Toddler Program" knows
    // exactly which find this is; the gate used to refuse it.
    const streamNamed = {
      ...PICK,
      name: 'Toddler Program (18 months - 3 years), Preschool and Kinderfun',
      sourceName: 'Halton Hills Gymnastics Centre',
    };

    expect(
      topPickLeads(
        'Halton Hills Gymnastics Centre runs a Toddler Program for 18 months-3 years, fall session Sept 10 to Dec 16 - their site says.',
        [streamNamed],
      ),
    ).toBe(true);
    // POSITIVE CONTROL - naming neither the venue nor the programme is still refused.
    expect(
      topPickLeads('There is a fall toddler session running Sept 10 to Dec 16.', [streamNamed]),
    ).toBe(false);
  });

  it('a session code is not a name, brackets or no brackets', () => {
    // The merge disambiguates however it likes, and it does not always reach for
    // brackets. A bare code is the same demand in a different shape: no SMS is going to
    // say "108969", and no parent would want it to.
    const bare = { ...PICK, name: 'Parent and Tot 108969, Gellert Community Centre' };
    const body =
      'Gellert Community Centre runs Parent and Tot swim Mondays 10:00-10:30am, $86.22 for 9 lessons - their site says.';

    expect(topPickLeads(body, [bare])).toBe(true);
  });

  it('still needs two words when the name outside the brackets carries two', () => {
    const twoWords = {
      ...PICK,
      name: 'Kinderfun Toddler Program, Cartwheels Gym Centre (Sat 9:15)',
    };

    expect(topPickLeads('Cartwheels runs a toddler program Saturdays 9:15.', [twoWords])).toBe(
      false,
    );
    expect(topPickLeads('Cartwheels Gym Centre runs Kinderfun Saturdays 9:15.', [twoWords])).toBe(
      true,
    );
  });
});

describe('the uncertain sentence', () => {
  it('POSITIVE CONTROL - the uncertain sentence passes in both unlicensed states', () => {
    const unread = `${PICK.name} runs a toddler class for under-3s - their site says. I could not get into their fall schedule page today, so I'll keep looking and text you what it says.`;
    const unpinned = `${PICK.name} runs a toddler class for under-3s - their site lists it. I could not pin down the fall day or fee, so I'll keep looking and text you what it says.`;

    expect(gates(unread, grounding({ pageEvidence: 'no_page_read', watch: true }))).toEqual([]);
    expect(gates(unpinned, grounding({ pageEvidence: 'page_has_schedule', watch: true }))).toEqual(
      [],
    );
  });
});

describe('a continuation row must be spoken for', () => {
  it('THE DEFECT MIRRORED: a watch row with no sentence claiming it is refused', () => {
    const silent = `${PICK.name} runs a toddler class for under-3s - their site says.`;

    expect(gates(silent, grounding({ watch: true }), false).join(' ')).toContain(
      'Hale has already committed to going back',
    );
  });

  it('POSITIVE CONTROL - with no watch row, the same silent message is fine', () => {
    const silent = `${PICK.name} runs a toddler class for under-3s - their site says.`;

    expect(gates(silent, grounding({ watch: false }))).toEqual([]);
  });

  /**
   * THE MIRROR, and it is not hypothetical. The first live re-recording of this composer
   * after the watch field was added — handed a complete find and `watch: false` — closed
   * with "I'll keep looking and text you what it says": a promise to come back with no
   * row behind it, written by the very change that exists to stop that.
   */
  it('refuses a coming-back sentence when NO row was written for it', () => {
    const promised = `${PICK.name} runs Saturdays 9:15, $142 - their site says. I'll keep looking and text you what else opens.`;

    expect(gates(promised, grounding({ watch: false }), true).join(' ')).toContain(
      'no such promise has been written down',
    );
  });

  it('POSITIVE CONTROL - the SAME sentence passes once the row exists', () => {
    const promised = `${PICK.name} runs Saturdays 9:15, $142 - their site says. I'll keep looking and text you what else opens.`;

    expect(gates(promised, grounding({ watch: true }))).toEqual([]);
  });
});

describe("the coming-back fact is the model's, in any language", () => {
  const zhWatch = `${PICK.name} 有幼儿课，周六上午，他们网站上这么写。秋季时间还没公布，我会继续关注，一有消息就发短信告诉你。`;
  const arWatch = `${PICK.name} لديه صف للأطفال الصغار أيام السبت، حسب موقعهم. لم يُنشر جدول الخريف بعد، وسأواصل المتابعة وأراسلك عندما يُنشر.`;

  it.each([
    ['zh', zhWatch],
    ['ar', arWatch],
  ])('a %s message that commits to coming back passes when the row exists', (_label, body) => {
    expect(gates(body, grounding({ watch: true }), true)).toEqual([]);
  });

  it.each([
    ['zh', zhWatch],
    ['ar', arWatch],
  ])(
    'a %s message the model says commits to nothing is refused when the row exists',
    (_label, body) => {
      expect(gates(body, grounding({ watch: true }), false).join(' ')).toContain(
        'Hale has already committed to going back',
      );
    },
  );

  it.each([
    ['zh', zhWatch],
    ['ar', arWatch],
  ])('a %s promise with no row behind it is refused', (_label, body) => {
    expect(gates(body, grounding({ watch: false }), true).join(' ')).toContain(
      'no such promise has been written down',
    );
  });

  it('reads no words: the same English body is judged only by the fact it is handed', () => {
    const body = `${PICK.name} runs Saturdays - their site says. I'll keep watching and text you when they post.`;
    expect(gates(body, grounding({ watch: true }), true)).toEqual([]);
    expect(gates(body, grounding({ watch: true }), false)).not.toEqual([]);
  });
});

describe('an empty search tells the composer where it looked', () => {
  const searched = { town: 'Halton Hills', notes: 'what the search read' };
  const base = {
    subject: 'toddler swim',
    language: 'en-CA',
    pageEvidence: 'no_page_read' as const,
    watch: true,
    moreRemaining: 0,
  };

  it('keeps uncertain references beside supported picks without exposing research notes', () => {
    const reference = {
      name: 'Family workshop',
      sourceName: 'Example Library',
      sourceUrl: 'https://library.example/workshop',
      ageFit: null,
      when: null,
      price: null,
      status: 'unconfirmed' as const,
      evidence: {
        program: 'Family workshop',
        age: null,
        sessions: [],
        schedule: null,
        price: null,
        history: null,
        windowConfirmed: false,
      },
    };
    const payload = JSON.parse(
      followUpUserMessage({
        ...base,
        picks: [PICK],
        searched: {
          ...searched,
          notes: 'Rejected research says $999 and ages 12-18.',
          references: [reference],
          checkedSources: [reference.sourceUrl],
        },
      }),
    );
    expect(payload.picks.map((pick: ActivityPick) => pick.name)).toEqual([PICK.name]);
    expect(payload.page_evidence).toBe(base.pageEvidence);
    expect(payload).not.toHaveProperty('picks_empty');
    expect(payload.searched).toEqual({
      town: searched.town,
      references: [reference],
      checkedSources: [reference.sourceUrl],
    });
    expect(JSON.stringify(payload)).not.toContain('$999');
    expect(payload.searched).not.toHaveProperty('notes');
    expect(
      followUpUserMessage({ ...base, picks: [PICK], searched: { ...searched, references: [] } }),
    ).toBe(followUpUserMessage({ ...base, picks: [PICK] }));
  });

  it('never returns rejected research facts to the writer through empty-search notes', () => {
    const payload = JSON.parse(
      followUpUserMessage({
        ...base,
        picks: [],
        searched: {
          ...searched,
          notes: 'Cartwheels costs $140',
          references: [],
          checkedSources: ['https://gym.example/classes'],
        },
      }),
    );
    expect(payload.searched).toEqual({
      town: searched.town,
      references: [],
      checkedSources: ['https://gym.example/classes'],
    });
    expect(JSON.stringify(payload)).not.toContain('$140');
  });

  it('keeps fact evidence alongside main’s language and held-option handoff', () => {
    const evidence = {
      program: 'Family storytime',
      age: 'ages 2-5',
      sessions: ['October 23 at 10:30'],
      schedule: null,
      price: null,
      history: null,
      windowConfirmed: true,
    };
    const payload = JSON.parse(
      followUpUserMessage({
        ...base,
        language: 'fr-CA',
        moreRemaining: 2,
        picks: [{ ...PICK, evidence }],
      }),
    );
    expect(payload.language).toBe('fr-CA');
    expect(payload.more_remaining).toBe(2);
    expect(payload.picks[0].evidence).toEqual(evidence);
  });

  it('carries the area, not unvalidated research, when there are no picks', () => {
    const empty = JSON.parse(followUpUserMessage({ ...base, picks: [], searched }));
    expect(empty.picks_empty).toBe(true);
    expect(empty.searched).toEqual({ town: searched.town });
  });

  it('leaves a message with a find composed from the payload it always had', () => {
    const pick = {
      name: 'n',
      ageFit: 'a',
      when: null,
      price: null,
      sourceName: 's',
      source: 'web' as const,
    };
    const withFind = followUpUserMessage({ ...base, picks: [pick], searched });
    expect(withFind).toBe(followUpUserMessage({ ...base, picks: [pick] }));
  });
});
