import { describe, expect, it } from 'vitest';
import { matchKeyword } from '~/lib/channel/intake/keywords';
import { MAX_LISTED_APPROVALS, matchFastPath } from './fast-path';

/**
 * The grammar table. Every row is a message a real parent could plausibly send, and
 * the assertion is the WHOLE parse (verb + index), never "it matched something".
 */

describe('matchFastPath — affirmatives', () => {
  const yeses = [
    'yes',
    'Yes',
    'YES',
    'y',
    'Y',
    'yeah',
    'yep',
    'yup',
    'ok',
    'OK',
    'okay',
    'k',
    'sure',
    'confirm',
    'confirmed',
  ];

  for (const body of yeses) {
    it(`reads ${JSON.stringify(body)} as a bare yes`, () => {
      expect(matchFastPath(body)).toEqual({ verb: 'yes', index: null });
    });
  }

  it('tolerates trailing punctuation', () => {
    expect(matchFastPath('Yes!')).toEqual({ verb: 'yes', index: null });
    expect(matchFastPath('ok.')).toEqual({ verb: 'yes', index: null });
    expect(matchFastPath('  YES  ')).toEqual({ verb: 'yes', index: null });
  });

  it('tolerates politeness around the verb', () => {
    expect(matchFastPath('yes please')).toEqual({ verb: 'yes', index: null });
    expect(matchFastPath('Yes, please!')).toEqual({ verb: 'yes', index: null });
    expect(matchFastPath('please yes')).toEqual({ verb: 'yes', index: null });
    expect(matchFastPath('ok thanks')).toEqual({ verb: 'yes', index: null });
    expect(matchFastPath('yes thank you')).toEqual({ verb: 'yes', index: null });
  });

  /**
   * VIL-260 · WS4 — the eleven words a parent was allowed to say. Every phrase below is
   * one a real parent sent to a drafted change and had silently dropped: the fast-path
   * declined it, the coach answered it conversationally, and the change never happened.
   *
   * The vocabulary widens; the AUTHORITY does not. Each of these still only resolves to
   * an approval when an action is actually drafted (handlers.ts's ownership rule), and
   * each is still matched against the WHOLE message.
   */
  const widened = [
    'sounds good',
    'Sounds good!',
    'sounds great',
    'looks good',
    'do it',
    'Do it.',
    'do that',
    'go ahead',
    'Go ahead!',
    'go for it',
    "let's do it",
    'lets do it',
    'make it',
    'that works',
    'works for me',
    'approve',
    'Approved',
    'yes do it',
    'sounds good thanks',
  ];

  for (const body of widened) {
    it(`reads ${JSON.stringify(body)} as a bare yes`, () => {
      expect(matchFastPath(body)).toEqual({ verb: 'yes', index: null });
    });
  }

  /** A phone keyboard's fastest reply is a reaction. The symbol-stripping normalizer
   * used to erase these to an empty string, so the commonest confirmation on the whole
   * channel matched nothing at all. */
  const emoji = ['👍', '👍🏽', '👍🏻', '👌', '✅', '✔️', '☑️', '👍👍', 'yes 👍', '👍 please'];

  for (const body of emoji) {
    it(`reads ${JSON.stringify(body)} as a bare yes`, () => {
      expect(matchFastPath(body)).toEqual({ verb: 'yes', index: null });
    });
  }

  it('carries an ordinal through a widened phrase', () => {
    expect(matchFastPath('do it 2')).toEqual({ verb: 'yes', index: 2 });
    expect(matchFastPath('sounds good 1')).toEqual({ verb: 'yes', index: 1 });
  });
});

describe('matchFastPath — negatives and undo', () => {
  for (const body of ['no', 'No', 'n', 'nope', 'nah', 'skip', 'SKIP']) {
    it(`reads ${JSON.stringify(body)} as a bare no`, () => {
      expect(matchFastPath(body)).toEqual({ verb: 'no', index: null });
    });
  }

  it('tolerates politeness on a refusal', () => {
    expect(matchFastPath('no thanks')).toEqual({ verb: 'no', index: null });
    expect(matchFastPath('No, thank you.')).toEqual({ verb: 'no', index: null });
  });

  /** M6's refusals, which the shared vocabulary brings to approvals too (VIL-260). A
   * parent who declines a draft in the words they already use to drop an invite should
   * not have to learn a second one. */
  for (const body of ['never mind', 'nevermind', "don't", 'Never mind!', '👎']) {
    it(`reads ${JSON.stringify(body)} as a bare no`, () => {
      expect(matchFastPath(body)).toEqual({ verb: 'no', index: null });
    });
  }

  for (const body of ['undo', 'UNDO', 'undo that', 'undo it', 'revert']) {
    it(`reads ${JSON.stringify(body)} as undo`, () => {
      expect(matchFastPath(body)).toEqual({ verb: 'undo', index: null });
    });
  }
});

describe('matchFastPath — the index', () => {
  it('reads an explicit ordinal', () => {
    expect(matchFastPath('YES 2')).toEqual({ verb: 'yes', index: 2 });
    expect(matchFastPath('yes 2')).toEqual({ verb: 'yes', index: 2 });
    expect(matchFastPath('Yes #2')).toEqual({ verb: 'yes', index: 2 });
    expect(matchFastPath('yes2')).toEqual({ verb: 'yes', index: 2 });
    expect(matchFastPath('yes 2.')).toEqual({ verb: 'yes', index: 2 });
    expect(matchFastPath('no 1')).toEqual({ verb: 'no', index: 1 });
    expect(matchFastPath(`y ${MAX_LISTED_APPROVALS}`)).toEqual({
      verb: 'yes',
      index: MAX_LISTED_APPROVALS,
    });
  });

  it('reads an ordinal through politeness', () => {
    expect(matchFastPath('yes 2 please')).toEqual({ verb: 'yes', index: 2 });
  });

  /** An ordinal Hale never printed cannot be resolved to the action the parent meant,
   * so it is refused outright rather than clamped onto a neighbouring row. */
  it('refuses a zero or past-the-list ordinal rather than guessing', () => {
    expect(matchFastPath('yes 0')).toBeNull();
    expect(matchFastPath(`yes ${MAX_LISTED_APPROVALS + 1}`)).toBeNull();
    expect(matchFastPath('yes 100')).toBeNull();
  });

  it('refuses an ordinal on undo — undo names no list', () => {
    expect(matchFastPath('undo 2')).toBeNull();
  });
});

describe('matchFastPath — what it must NOT claim', () => {
  const sentences = [
    'no rush, next week is fine',
    'ok so what about Tuesday?',
    'yes please move swim to Tuesday',
    'skip the park, what else is on?',
    'undo the swim class and book the other one',
    'confirm what time it starts',
    'anything indoors this weekend?',
    'not done yet',
    '',
    '   ',
    '2',
    // The widened vocabulary carries a TAIL as often as it carries a yes, and a tail is
    // a second instruction the parent is still waiting on. Every one of these is a
    // conversation the coach must answer, not a calendar write.
    'sounds good but can we do Thursday instead',
    'do it tomorrow',
    'do it after work',
    "don't do it",
    'go ahead and cancel swim too',
    'that works for the first one',
    'approve what?',
    'looks good, what time does it start?',
    'sounds good 👍 and can you also find something Saturday',
  ];

  for (const body of sentences) {
    it(`declines ${JSON.stringify(body)}`, () => {
      expect(matchFastPath(body)).toBeNull();
    });
  }

  /**
   * The CASL words are a legal instrument handled upstream and must never be read as
   * conversation here. 'cancel' is the trap: it is a natural refusal in English AND a
   * carrier-recognised STOP synonym, so a NO-set that contained it would turn an
   * unsubscribe into an approval decline.
   */
  it('never claims a CASL keyword', () => {
    for (const word of ['stop', 'STOP', 'unsubscribe', 'end', 'quit', 'cancel', 'help', 'start']) {
      expect(matchKeyword(word)).not.toBeNull();
      expect(matchFastPath(word)).toBeNull();
    }
  });
});
