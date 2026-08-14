import { describe, expect, it } from 'vitest';
import { OPT_OUT_LINE } from '~/lib/channel/opt-out';
import { smsSegments } from '~/lib/channel/sms-segments';
import {
  type IntroAskRequest,
  MAX_INTRO_ASK_CHARS,
  introAskRefusals,
  introAskUserMessage,
} from './voice';

/**
 * The refusals are the pinned half of "meaning pinned, words free". Each one is here
 * because a plausible, well-written sentence can violate it — a gate that only fires on
 * nonsense is a gate that never fires.
 *
 * The QUALITY of what the model writes is not testable here and is not tested here; that
 * is apps/worker/evals/run-intro-voice-eval.mjs against real cached Claude (rule #8).
 */

const PROPOSAL: IntroAskRequest = {
  kind: 'proposal',
  counterpartWord: 'toddler',
  ownChildPossessive: "Maya's",
  anchorTitle: null,
  anchorDay: null,
};

const ANCHORED: IntroAskRequest = {
  ...PROPOSAL,
  anchorTitle: 'Ready for Reading (Ages 3-6)',
  anchorDay: 'Saturday',
};

const OPTIN: IntroAskRequest = { kind: 'optin' };

describe('introAskRefusals', () => {
  it('passes a card that carries every pinned fact and instructs nothing', () => {
    expect(
      introAskRefusals(
        "Another Hale family nearby has a toddler about Maya's age. Want me to introduce you?",
        PROPOSAL,
      ),
    ).toEqual([]);
  });

  it('passes an opt-in ask that names the offer and the reassurance', () => {
    expect(
      introAskRefusals(
        "There are other Hale families near you. I can make an introduction when someone's a real match - nothing about you is shared unless you both say yes, and you can switch it off whenever.",
        OPTIN,
      ),
    ).toEqual([]);
  });

  describe('the keyword instruction - the defect this arc removes', () => {
    it.each([
      ["Want an intro? Reply YES INTRO or NO INTRO.", 'the card that shipped'],
      ['Other Hale families are near you. Reply YES INTROS or NO INTROS.', 'the opt-in that shipped'],
      ['Want an intro? Just text yes or no.', 'a softer instruction'],
      ['Want an intro? Respond with YES.', 'a single-token instruction'],
      ['Want an intro? Send NO to skip.', 'the refusal half alone'],
      ['Want an intro? Type yes back.', 'a different verb'],
    ])('refuses %j (%s)', (body) => {
      expect(introAskRefusals(body, PROPOSAL)).toContain('instructs_keyword');
    });

    it('does not refuse the words yes and no used as English', () => {
      // The rule is about being handed a token to recite, not about a vocabulary.
      const body =
        "A Hale family near you has a toddler around Maya's age, and nothing gets shared unless you both say yes. Want an intro?";
      expect(introAskRefusals(body, PROPOSAL)).toEqual([]);
    });

    it('leaves the CASL keyword alone - STOP is a legal off-ramp, not a magic word', () => {
      // The gate appends this line; the composer is never refused for its presence, and
      // softening 'STOP' would break the word the carrier and the intake machine honour.
      const body = `Want an intro? A Hale family near you has a toddler around Maya's age.`;
      expect(introAskRefusals(`${body}\n\n${OPT_OUT_LINE}`, PROPOSAL)).toEqual([]);
    });
  });

  describe('one speaker, first person - found by the first live recording', () => {
    it.each([
      'A Hale family near you has a toddler around Maya\'s age. Hale can make an intro?',
      'A Hale family near you has a toddler around Maya\'s age. Hale will introduce you?',
      'A Hale family near you has a toddler around Maya\'s age - Hale has an intro for you?',
    ])('refuses Hale talking about Hale: %j', (body) => {
      expect(introAskRefusals(body, PROPOSAL)).toContain('third_person_self');
    });

    it('still allows the brand name where it describes the other households', () => {
      // "another Hale family nearby" is the premise of the message, not a press release.
      expect(
        introAskRefusals(
          "Another Hale family near you has a toddler around Maya's age. Want an intro?",
          PROPOSAL,
        ),
      ).toEqual([]);
    });

    it.each([
      "A Hale family near you has a toddler around Maya's age. We can make an intro?",
      "A Hale family near you has a toddler around Maya's age. Let us know if you want an intro.",
      "A Hale family near you has a toddler around Maya's age. Want us to reach out about an intro?",
    ])('refuses the royal we: %j', (body) => {
      expect(introAskRefusals(body, PROPOSAL)).toContain('first_person_plural');
    });

    it('passes the first-person singular the rest of this feature already speaks in', () => {
      expect(
        introAskRefusals(
          "Another Hale family near you has a toddler around Maya's age. Want me to introduce you?",
          PROPOSAL,
        ),
      ).toEqual([]);
    });
  });

  describe('the pinned facts', () => {
    it('refuses a card that drops the counterpart band word', () => {
      expect(
        introAskRefusals("A Hale family near you has a child around Maya's age. Want an intro?", PROPOSAL),
      ).toContain('counterpart_word_missing');
    });

    it('refuses a card that never mentions the recipients own child', () => {
      expect(
        introAskRefusals('A Hale family near you has a toddler. Want an intro?', PROPOSAL),
      ).toContain('own_child_missing');
    });

    it('accepts a possessive the model re-phrased around the same noun', () => {
      // "your kid's" handed in, "your kid" written out: the NOUN is what was pinned.
      const request: IntroAskRequest = { ...PROPOSAL, ownChildPossessive: "your kid's" };
      expect(
        introAskRefusals(
          'A Hale family near you has a toddler the same age as your kid. Want an intro?',
          request,
        ),
      ).toEqual([]);
    });

    it('refuses a card that throws the activity away', () => {
      expect(
        introAskRefusals("A Hale family near you has a toddler around Maya's age. Want an intro?", ANCHORED),
      ).toContain('anchor_missing');
    });

    it('refuses a paraphrased activity title - the dataset owns the name', () => {
      expect(
        introAskRefusals(
          "A Hale family near you has a toddler around Maya's age and is eyeing the reading group Saturday. Want an intro?",
          ANCHORED,
        ),
      ).toContain('anchor_missing');
    });

    it('does not read the digits inside a supplied title as invented', () => {
      const body =
        "A Hale family near you has a toddler around Maya's age, and you're both eyeing Ready for Reading (Ages 3-6) Saturday. Want an intro?";
      expect(introAskRefusals(body, ANCHORED)).toEqual([]);
    });

    it('refuses a number the model made up', () => {
      expect(
        introAskRefusals(
          "3 Hale families near you have a toddler around Maya's age. Want an intro?",
          PROPOSAL,
        ),
      ).toContain('invented_number');
    });

    it('refuses an ask that never says what is being agreed to', () => {
      expect(
        introAskRefusals(
          'There are other Hale families near you. Want me to connect you when someone is a good match?',
          OPTIN,
        ),
      ).toContain('introduction_word_missing');
    });
  });

  describe('the envelope', () => {
    it('leaves room for the compliance line inside two segments', () => {
      const longest = 'A'.repeat(MAX_INTRO_ASK_CHARS);
      expect(smsSegments(`${longest}\n\n${OPT_OUT_LINE}`)).toBeLessThanOrEqual(2);
      // Non-vacuity: one character more does not fit, so the cap is the real ceiling.
      expect(smsSegments(`${longest}X\n\n${OPT_OUT_LINE}`)).toBeGreaterThan(2);
    });

    it('refuses a body over the cap', () => {
      const body = `Maya's toddler intro. ${'x'.repeat(MAX_INTRO_ASK_CHARS)}`;
      expect(introAskRefusals(body, PROPOSAL)).toContain('over_char_cap');
    });

    it('refuses a curly apostrophe - one character doubles the whole message', () => {
      expect(
        introAskRefusals(
          'A Hale family near you has a toddler around Maya’s age. Want an intro?',
          { ...PROPOSAL, ownChildPossessive: 'Maya’s' },
        ),
      ).toContain('not_gsm7');
    });

    it('refuses an interrogation', () => {
      expect(
        introAskRefusals(
          "A Hale family near you has a toddler around Maya's age. Want an intro? Or not?",
          PROPOSAL,
        ),
      ).toContain('too_many_questions');
    });

    it('refuses a link and an address it could only have invented', () => {
      expect(
        introAskRefusals(
          "Maya's toddler intro is at https://hale.example/x - want it?",
          PROPOSAL,
        ),
      ).toContain('carries_link');
      expect(
        introAskRefusals("Maya's toddler intro - mail me at hi@hale.example?", PROPOSAL),
      ).toContain('carries_address');
    });

    it('refuses a fragment that does not start a sentence', () => {
      expect(
        introAskRefusals("a Hale family near you has a toddler around Maya's age. Intro?", PROPOSAL),
      ).toContain('not_a_sentence');
    });

    it('reports every problem at once, not the first', () => {
      const problems = introAskRefusals('reply YES INTRO for 2 intros?', PROPOSAL);
      expect(problems).toEqual(
        expect.arrayContaining([
          'not_a_sentence',
          'instructs_keyword',
          'counterpart_word_missing',
          'own_child_missing',
          'invented_number',
        ]),
      );
    });
  });
});

describe('introAskUserMessage', () => {
  it('sends the opt-in ask no facts at all', () => {
    expect(JSON.parse(introAskUserMessage(OPTIN))).toEqual({ kind: 'optin' });
  });

  it('sends the card exactly the three facts the fixed card carried, and no fourth', () => {
    expect(JSON.parse(introAskUserMessage(ANCHORED))).toEqual({
      kind: 'proposal',
      counterpartWord: 'toddler',
      ownChildPossessive: "Maya's",
      anchorTitle: 'Ready for Reading (Ages 3-6)',
      anchorDay: 'Saturday',
    });
  });

  it('omits the recompose payload on a first attempt', () => {
    expect(introAskUserMessage(PROPOSAL)).not.toContain('rejected');
    expect(
      introAskUserMessage(PROPOSAL, [{ ask: 'Reply YES INTRO', problems: ['instructs_keyword'] }]),
    ).toContain('instructs_keyword');
  });
});
