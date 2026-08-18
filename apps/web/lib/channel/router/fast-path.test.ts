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
  it('never claims a CASL keyword, in either official language', () => {
    for (const word of [
      'stop',
      'STOP',
      'unsubscribe',
      'end',
      'quit',
      'cancel',
      'help',
      'info',
      'start',
      // The French half the carriers mandate. Same rule, same reason: the keyword is
      // claimed upstream, so a second reading here could only disagree with the first.
      'ARRET',
      'arrêt',
      'AIDE',
      'DEBUT',
    ]) {
      expect(matchKeyword(word), word).not.toBeNull();
      expect(matchFastPath(word), word).toBeNull();
    }
  });
});

/**
 * The French and Chinese half of the same vocabulary.
 *
 * Hale already REPLIES in both languages, and its French replies keep the literal token
 * YES in the sentence precisely because nothing on the reading side could hear "oui".
 * Two separate defects made that true, and a longer word list alone would have fixed
 * neither:
 *
 *   CJK WAS ERASED. `normalizeReply` reduced a body to /[a-z0-9]/, so every Chinese reply
 *   normalized to the empty string — "好" and silence were the same input. Adding 好 to the
 *   set without widening the character class is a no-op that reads as a fix.
 *
 *   ACCENTS SPLIT WORDS. "bien sûr" normalized to "bien s r" and "arrête" to "arr te", so
 *   an accented phrase could not be spelled in the set at all except by writing the
 *   mangling down. Folding the diacritic collapses both spellings onto one entry.
 *
 * The two properties from affirmative.ts survive untouched, and the tail cases below are
 * the proof: whole-string still means whole-string in a script that has no spaces.
 */
describe('matchFastPath — French and Chinese', () => {
  const yeses = [
    'oui',
    'Oui',
    'OUI',
    'oui!',
    'ouais',
    "d'accord",
    "D'accord.",
    'daccord',
    "c'est bon",
    'parfait',
    'Parfait!',
    'allons-y',
    'vas-y',
    'absolument',
    'certainement',
    'bien sûr',
    'bien sur',
    '好',
    '好的',
    '好啊',
    '好的。',
    '可以',
    '行',
    '嗯',
    '是',
    '是的',
    '要',
    '确认',
    '没问题',
  ];

  for (const body of yeses) {
    it(`reads ${JSON.stringify(body)} as a bare yes`, () => {
      expect(matchFastPath(body)).toEqual({ verb: 'yes', index: null });
    });
  }

  const noes = [
    'non',
    'Non',
    'Non!',
    'pas maintenant',
    'pas cette fois',
    '不',
    '不要',
    '不用',
    '不行',
    '别',
    '算了',
  ];

  for (const body of noes) {
    it(`reads ${JSON.stringify(body)} as a bare no`, () => {
      expect(matchFastPath(body)).toEqual({ verb: 'no', index: null });
    });
  }

  /** The ordinal is split off the NORMALIZED string, so a Han character has to survive as
   * a phrase on the left of it — otherwise "好 2" resolves to nothing, or to an approval
   * of a row the parent never named. */
  it('carries an ordinal through a French or Chinese phrase', () => {
    expect(matchFastPath('oui 2')).toEqual({ verb: 'yes', index: 2 });
    expect(matchFastPath('好 2')).toEqual({ verb: 'yes', index: 2 });
    expect(matchFastPath('non 1')).toEqual({ verb: 'no', index: 1 });
  });

  /**
   * Widening the alphabet must not widen what counts as a whole string. Chinese is
   * written without spaces, so a sentence that merely BEGINS 好的 or CONTAINS 不要 arrives
   * as a single token — which is exactly why it must not be claimed by a prefix. Each of
   * these is the French or Chinese twin of a row in the English table above.
   */
  const sentences = [
    // An affirmative head with a tail — the shape of "sounds good but can we do Thursday
    // instead". The tail is a second instruction the parent is still waiting on.
    'oui mais pas cette semaine',
    'oui déplace la natation à mardi',
    "d'accord pour jeudi seulement",
    // "ça va" is as often a question as an agreement, so it is deliberately not a word.
    'ça va?',
    'ça va',
    // Lukewarm is not consent, and a longer sentence is not its first two glyphs.
    '还好',
    '好的但是星期四可以吗',
    '好 但是星期四',
    '不要担心',
    '我不要去',
  ];

  for (const body of sentences) {
    it(`declines ${JSON.stringify(body)}`, () => {
      expect(matchFastPath(body)).toBeNull();
    });
  }

  /**
   * The 'cancel' rule, in the other two languages.
   *
   * affirmative.ts refuses to put 'cancel' in the NO set because it is a natural refusal
   * AND an unsubscribe, and reading it as an approval decline would answer a parent asking
   * to be left alone with a calendar message. "annuler", "arrête" and 取消 are that same
   * word, and the reasoning does not weaken for being written in French or Chinese — it
   * gets stronger, because `matchKeyword` claims only the keyword the carriers mandate
   * (ARRET), so nothing upstream would catch the mistake on these either.
   *
   * They stay unread, which is not silence: an unmatched body goes to the coach, which
   * answers in the parent's language and can ask what they meant.
   */
  it('never reads a French or Chinese unsubscribe as an approval decline', () => {
    for (const word of ['annule', 'annuler', 'arrête', 'arrete', '取消']) {
      expect(matchFastPath(word)).toBeNull();
    }
    // The positive control for those nulls: real refusals in the same two languages DO
    // resolve, through this same call, so the assertion above is about those five words
    // and not about French and Chinese being unreadable.
    expect(matchFastPath('non')).toEqual({ verb: 'no', index: null });
    expect(matchFastPath('不')).toEqual({ verb: 'no', index: null });
  });
});
