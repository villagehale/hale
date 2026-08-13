import { describe, expect, it } from 'vitest';
import { ASSENT_ACK } from '~/lib/channel/intake/copy';
import { smsSegments } from '~/lib/channel/sms-segments';
import {
  MAX_ASK_CHARS,
  MAX_TAIL_ASK_CHARS,
  type IdentityAskRequest,
  askCharCap,
  identityAskRefusals,
  identityAskUserMessage,
} from './ask-voice';

/**
 * The gates, tested directly. What Hale actually SAYS is the eval's job against real
 * cached Claude (rule #8, apps/worker/evals/run-identity-ask-eval.mjs); what may never
 * leave the building is this file, and it is exhaustive because every refusal here is a
 * message that would otherwise have gone to a parent.
 */

const START: IdentityAskRequest = { reason: 'getting_started', missing: ['name'] };
const INTRO_NAME: IdentityAskRequest = { reason: 'introduction', missing: ['name'] };
const INTRO_EMAIL: IdentityAskRequest = { reason: 'introduction', missing: ['email'] };
const INTRO_BOTH: IdentityAskRequest = { reason: 'introduction', missing: ['name', 'email'] };

describe('the character budget', () => {
  /**
   * The consent turn is ONE text: the fixed acknowledgment, a space, and the composed
   * ask. This is the arithmetic that keeps it one segment, pinned rather than trusted —
   * an edit to either side that pushes it over doubles what every intake costs to send.
   */
  it('leaves the tail ask exactly what is left of one segment after the ack', () => {
    expect(ASSENT_ACK.length + 1 + MAX_TAIL_ASK_CHARS).toBe(MAX_ASK_CHARS);
    expect(smsSegments(`${ASSENT_ACK} ${'a'.repeat(MAX_TAIL_ASK_CHARS)}`)).toBe(1);
  });

  it('gives the standalone intros ask the whole segment', () => {
    expect(askCharCap(INTRO_BOTH)).toBe(MAX_ASK_CHARS);
    expect(askCharCap(START)).toBe(MAX_TAIL_ASK_CHARS);
    expect(MAX_TAIL_ASK_CHARS).toBeLessThan(MAX_ASK_CHARS);
  });

  it('refuses a tail ask that would push the consent turn into two segments', () => {
    const overrun = `What name should I use for you, and what should I put on the ${'x'.repeat(30)}`;
    expect(overrun.length).toBeGreaterThan(MAX_TAIL_ASK_CHARS);
    expect(identityAskRefusals(overrun, START)).toContain('over_char_cap');
    // The SAME sentence is fine as the intros ask, which sends on its own.
    expect(
      identityAskRefusals(overrun, { reason: 'introduction', missing: ['name'] }),
    ).not.toContain('over_char_cap');
  });
});

describe('identityAskRefusals', () => {
  it('passes a plain ask that names what it wants', () => {
    expect(identityAskRefusals('What name should I use for you?', START)).toEqual([]);
  });

  it('passes an intros ask that names the introduction and the gap', () => {
    expect(
      identityAskRefusals(
        "To make that introduction I need an email address - text me one and I'll use it.",
        INTRO_EMAIL,
      ),
    ).toEqual([]);
  });

  it('refuses an empty message and nothing else, so the retry is not a list of noise', () => {
    expect(identityAskRefusals('', INTRO_BOTH)).toEqual(['empty']);
  });

  /**
   * The required WORD, per gap. "What should I call you" is good English that never says
   * `name`, and nothing outside the message could prove it asked for one — so the word is
   * the contract, and the refusal says which word is missing rather than "bad message".
   */
  it('refuses an ask for a name that never says name', () => {
    expect(identityAskRefusals('What should I call you?', START)).toEqual(['name_word_missing']);
  });

  it('refuses an ask for an address that never says email', () => {
    expect(identityAskRefusals('Where should I send the introduction?', INTRO_EMAIL)).toEqual([
      'email_word_missing',
    ]);
  });

  it('requires BOTH words when both facts are missing', () => {
    expect(identityAskRefusals('What name should I use to introduce you?', INTRO_BOTH)).toEqual([
      'email_word_missing',
    ]);
  });

  /**
   * The reason word. Without it, a request for an address arriving days after the parent
   * said yes is indistinguishable from a company harvesting one — and the parent has no
   * way to tell it apart, because Hale deliberately never named the other family.
   */
  it('refuses an intros ask that never mentions the introduction', () => {
    expect(identityAskRefusals("What's your email address?", INTRO_EMAIL)).toEqual([
      'introduction_word_missing',
    ]);
  });

  it('does not require the introduction word at the start of a family', () => {
    expect(identityAskRefusals('What name should I use for you?', START)).toEqual([]);
  });

  it.each([
    ['carries_link', 'Set your name at https://villagehale.com to be introduced', INTRO_NAME],
    ['carries_address', 'Text me an email like sam@example.com for the introduction', INTRO_EMAIL],
    ['invented_number', 'I need your name for the introduction in 2 days', INTRO_NAME],
    ['too_many_questions', 'Ready for the introduction? What name should I use?', INTRO_NAME],
  ])('refuses %s', (refusal, text, request) => {
    expect(identityAskRefusals(text, request as IdentityAskRequest)).toContain(refusal);
  });

  /**
   * AT MOST one question mark, not exactly one. The sibling calendar ask learned live that
   * the model writes the better message as a statement ending in an instruction, and
   * forcing an interrogative made the copy worse. Whether it actually asks is held by the
   * required-word refusals, not by punctuation.
   */
  it('accepts a statement that asks for the thing without a question mark', () => {
    expect(
      identityAskRefusals("Text me your first name and I'll write that introduction.", INTRO_NAME),
    ).toEqual([]);
  });

  /**
   * FOUND LIVE, not reasoned about. Told the getting_started ask was "the tail of a
   * message", the model wrote the tail of a SENTENCE — and every other gate passed it,
   * because it is short, GSM-7, has one question mark and contains the word "name". Joined
   * onto the acknowledgment it reads "...STOP always works. - and your name so I know what
   * to call you.", which is a typo, not a question.
   */
  it.each([
    '- and your name so I know what to call you.',
    'and your name too, whenever you get a chance.',
    'what name should I use for you?',
  ])('refuses %s - the ask is appended after a full stop, so it must begin a sentence', (body) => {
    expect(identityAskRefusals(body, START)).toContain('not_a_sentence');
  });

  it('refuses a curly apostrophe, which doubles what the message costs to send', () => {
    expect(
      identityAskRefusals('What name should I use for you’s introduction?', INTRO_NAME),
    ).toContain('not_gsm7');
  });

  it('reports every problem at once, so one recompose can fix them all', () => {
    const refusals = identityAskRefusals('See https://x.com for the 2 options', INTRO_BOTH);
    expect(refusals).toEqual(
      expect.arrayContaining([
        'carries_link',
        'name_word_missing',
        'email_word_missing',
        'introduction_word_missing',
        'invented_number',
      ]),
    );
  });
});

describe('identityAskUserMessage', () => {
  it('sends the bare request on a first attempt, so the eval cache key stays small', () => {
    expect(identityAskUserMessage(INTRO_BOTH)).toBe(
      JSON.stringify({ reason: 'introduction', missing: ['name', 'email'] }),
    );
  });

  it('hands the model its own rejected attempt and the named problems', () => {
    const turn = JSON.parse(
      identityAskUserMessage(START, [
        { ask: 'What should I call you?', problems: ['name_word_missing'] },
      ]),
    );
    expect(turn.rejected).toEqual([
      { ask: 'What should I call you?', problems: ['name_word_missing'] },
    ]);
    expect(turn.reason).toBe('getting_started');
  });

  /** Rule #1: the request carries the GAP and the reason, never a family, a child, or one
   * fact about the counterpart household. A composer that was never handed the other
   * family cannot name them. */
  it('carries nothing but the reason and the gap', () => {
    expect(Object.keys(JSON.parse(identityAskUserMessage(INTRO_BOTH)))).toEqual([
      'reason',
      'missing',
    ]);
  });
});
