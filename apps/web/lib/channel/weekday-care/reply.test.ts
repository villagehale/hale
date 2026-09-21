import { describe, expect, it } from 'vitest';
import { segmentsOf, words } from '~/lib/channel/stated-state';
import { readWeekdayCare } from './reply';

/**
 * A spec-derived corpus, not a transcript-fitted one: every message below is one a
 * parent could plausibly send in answer to "Is Mia home with you during the week, or at
 * daycare?", and the expected reading comes from the grammar's rules rather than from
 * what the code happens to return.
 *
 * The load-bearing set is the LAST one. The question is an either/or, so a bare
 * polarity settles nothing, and a grammar that guessed one would write a durable fact
 * off a single word.
 */

function care(body: string) {
  const reading = readWeekdayCare(body);
  return reading.status === 'read' ? reading.care : reading.status;
}

describe('readWeekdayCare', () => {
  it('reads home, in the ways a parent says it', () => {
    for (const body of [
      'home with me',
      "she's with me",
      'at home',
      'no daycare',
      'not in daycare',
      'my mom has him three days',
      'sahm here',
    ]) {
      expect(care(body), body).toBe('home');
    }
  });

  it('reads daycare', () => {
    for (const body of [
      'daycare',
      "she's in daycare",
      'yes, daycare',
      'he goes to Little Sprouts',
      'childcare 3 days a week',
      // Ontario's own word for it, and the commonest answer for a three-year-old -
      // which is squarely inside the band the ask targets.
      'she is in preschool',
      'he does pre-school mornings',
    ]) {
      expect(care(body), body).toBe('daycare');
    }
  });

  /**
   * A NEGATION ONLY COUNTS WHEN IT GOVERNS THE CARE WORD.
   *
   * The ask is an either/or, so the answers that mean `daycare` are full of negatives:
   * the parent is refusing the first half of the question before naming the second.
   * A rule that asked only whether a negative and a care word appear ANYWHERE in the
   * same sentence filed `home` for every one of these — the wrong DURABLE fact, which
   * switches the weekday find off and stops the daycare follow-up ever firing for a
   * household that said daycare.
   *
   * Two things separate the two sets, and each one is decidable from the text:
   * ADJACENCY (a negation reaches its care word across determiners and prepositions
   * and nothing else) and the CLAUSE BOUNDARY a parent typed (a comma is the only
   * evidence a text message gives that "no" was an answer rather than a determiner).
   * "nope" and "nah" are answer particles that cannot modify a noun at all, which is
   * what tells "nope daycare" from "no daycare".
   */
  it('reads daycare through a negation that governs something else', () => {
    for (const body of [
      'no, daycare',
      'nope daycare',
      "no she's at daycare",
      'daycare, not home',
      'not home, daycare',
      'at daycare not with me',
      "she's in daycare, no complaints",
    ]) {
      expect(care(body), body).toBe('daycare');
    }
  });

  it('still reads home when the negation does govern the care word', () => {
    for (const body of ['home, not daycare', 'not daycare, home', "we don't do daycare"]) {
      expect(care(body), body).toBe('home');
    }
  });

  /**
   * A NEGATED HOME PHRASE SETTLES NOTHING, and this is the SYMMETRIC half of the rule
   * above. The ask literally offers "home with you" as one side of an either/or, so the
   * ordinary way to refuse that side is to negate it — and a reader that saw only the
   * word "home" filed `home` for every one of these: the exact OPPOSITE of what the
   * parent said, for a household that is at daycare. The cost is a durable fact, so
   * these fail CLOSED rather than guessing the other side: the coach answers in its own
   * voice and the question can be asked again by a person.
   */
  it('settles nothing when the negation governs the home phrase', () => {
    for (const body of [
      'not home',
      'not with me',
      "she's not home",
      'no, not with me',
      "she's not at home",
      "she isn't home with me",
      "he's not with us during the week",
      'not with my mom',
    ]) {
      expect(care(body), body).toBe('nothing_stated');
    }
    // The positive control, without which this is an absence test that passes by not
    // looking: strip the negation and the same words DO read.
    expect(care('home with me')).toBe('home');
    expect(care('with my mom')).toBe('home');
  });

  /** A negation reaches no further than the clause the parent typed it in, and a later
   * sentence still settles the question. */
  it('lets a care word in the same breath answer the question anyway', () => {
    expect(care("she's not home, she's at daycare")).toBe('daycare');
    expect(care("not home. she's in daycare.")).toBe('daycare');
  });

  describe('starting_soon', () => {
    it('reads a start that has not happened', () => {
      for (const body of [
        'she starts in September',
        "not yet, we're on a waitlist",
        "we're looking for daycare",
      ]) {
        expect(care(body), body).toBe('starting_soon');
      }
    });

    /**
     * THE PRECEDENCE PAIR. Both of these contain a negated care word, so a grammar that
     * ran the negation rule first would file `home` — the wrong DURABLE fact for a
     * family six weeks from a start date, and one whose only visible difference is what
     * the follow-up does.
     */
    it('outranks the negated care word', () => {
      expect(care('no daycare yet')).toBe('starting_soon');
      expect(care('not in daycare yet, starts Sept')).toBe('starting_soon');
    });

    it('never fires on a bare "looking"', () => {
      expect(care("we're looking for a swim class")).toBe('nothing_stated');
    });

    /**
     * "start" IS ONLY A CARE WORD NEXT TO ONE. A parent answering the ask names the
     * rest of their week in the same breath — "we start swimming Saturday" — and
     * reading that as a daycare start files the wrong durable fact for a household
     * that just said it is home. `starts` and `starting` are the inflections a start
     * DATE comes in; bare `start` is the one that collides with every other activity.
     */
    it('reads a bare "start" as care only when the sentence is about care', () => {
      expect(care("she's home with me, we start swimming Saturday")).toBe('home');
      expect(care('we start daycare next month')).toBe('starting_soon');
    });
  });

  /**
   * THE LOAD-BEARING NEGATIVE SET. An either/or question makes a bare polarity
   * meaningless; the caller names this turn `unreadable` and logs it, and the coach
   * answers in its own voice.
   */
  it('settles nothing on a bare polarity or a change of subject', () => {
    for (const body of ['yes', 'no', 'what do you mean?', 'can you find swimming instead']) {
      expect(care(body), body).toBe('nothing_stated');
    }
  });

  describe('the provider', () => {
    it('is captured only when the parent named one, in capitals', () => {
      const named = readWeekdayCare('he goes to Little Sprouts');
      expect(named).toEqual({ status: 'read', care: 'daycare', provider: 'Little Sprouts' });
    });

    it('is never guessed', () => {
      expect(readWeekdayCare('at little sprouts')).toEqual({ status: 'nothing_stated' });
      const vague = readWeekdayCare("she's at the one on Bayview, it's daycare");
      expect(vague).toEqual({ status: 'read', care: 'daycare', provider: null });
    });

    /**
     * TERMINAL PUNCTUATION MUST NOT EAT THE LAST WORD. A rule that required every
     * captured word to be followed by WHITESPACE kept only "Little" out of "Little
     * Sprouts." — and that truncation is durable twice over: it is persisted in the
     * fact and then pinned verbatim into the follow-up's voice ("How is Little
     * going?"), where the subject the model is told to name no longer exists.
     */
    it('keeps the whole name when the sentence ends or a comma follows', () => {
      expect(readWeekdayCare('She goes to Little Sprouts.')).toMatchObject({
        provider: 'Little Sprouts',
      });
      expect(readWeekdayCare("She's at Little Sprouts, three days a week")).toMatchObject({
        provider: 'Little Sprouts',
      });
      expect(readWeekdayCare('he goes to Little Sprouts!')).toMatchObject({
        provider: 'Little Sprouts',
      });
    });

    it('may be a person, which is why it never leaves the family', () => {
      expect(readWeekdayCare("she's at Nana's during the week")).toMatchObject({
        care: 'daycare',
        provider: "Nana's",
      });
    });

    /**
     * A CURLY APOSTROPHE IS WHAT AN iPHONE TYPES, and U+2019 is not in the GSM-7 basic
     * alphabet. Persisting it would hand the follow-up voice a subject it can only
     * refuse — `not_gsm7` if it echoes the character, `subject_missing` if it
     * straightens it — three compose calls a tick until the window passes. Decided at
     * capture instead: straighten what can be straightened, and drop the pin (ask
     * generically) for anything left that a phone cannot print.
     */
    it('is straightened to something a phone can print, or dropped', () => {
      expect(readWeekdayCare('she’s at Nana’s during the week')).toMatchObject({
        care: 'daycare',
        provider: "Nana's",
      });
      // The name is still evidence of daycare; only the PIN is dropped. (`é` IS in the
      // GSM-7 basic alphabet and survives; `â` is not, which is the whole difference.)
      expect(readWeekdayCare('she goes to Café Enfants')).toEqual({
        status: 'read',
        care: 'daycare',
        provider: 'Café Enfants',
      });
      expect(readWeekdayCare('she goes to Château Enfants')).toEqual({
        status: 'read',
        care: 'daycare',
        provider: null,
      });
    });

    /**
     * ONE SEGMENT'S NAME NEVER ATTACHES TO ANOTHER'S ANSWER. Reading the provider off
     * the WHOLE body while the care word was read off one sentence let a refused
     * sentence — somebody else's child — hand its daycare to the sentence that
     * answered the question.
     */
    it('never crosses a sentence boundary', () => {
      expect(
        readWeekdayCare('My sister put hers in daycare at Little Sprouts. Mine is home with me.'),
      ).toEqual({ status: 'read', care: 'home', provider: null });
      expect(readWeekdayCare("My sister's kid goes to Little Sprouts. Mine is home with me.")).toEqual(
        { status: 'read', care: 'home', provider: null },
      );
    });

    /**
     * A CAPITALISED WORD AFTER A BARE "at" IS THE WEAKEST EVIDENCE THIS READER HAS, so
     * a home phrase in the same sentence outranks it. "at Shopify" is where a parent
     * works, not where their child is.
     */
    it('never outranks a home phrase in the same sentence', () => {
      expect(readWeekdayCare('home with me, I work at Shopify')).toEqual({
        status: 'read',
        care: 'home',
        provider: null,
      });
    });

    /**
     * IT BELONGS TO THE CLAUSE THAT NAMED THE CARE. "I work at Shopify, she is at
     * daycare" carries a care word and a capitalised `at` phrase, and reading the name
     * off the whole sentence pinned the PARENT'S EMPLOYER to the child - persisted in
     * the fact, then handed verbatim to the follow-up voice ("How is Shopify going?").
     * Fail closed: a clause that did not name the care names nobody, and the follow-up
     * asks generically, which it already knows how to do.
     */
    it('is read from the clause that carries the care word, never a neighbour', () => {
      expect(readWeekdayCare('I work at Shopify, she is at daycare')).toEqual({
        status: 'read',
        care: 'daycare',
        provider: null,
      });
      // The positive control: the naming clause is the care clause, and the name lands.
      expect(readWeekdayCare('I work from home, she goes to Little Sprouts')).toEqual({
        status: 'read',
        care: 'daycare',
        provider: 'Little Sprouts',
      });
    });
  });

  it('refuses a question, a report, an instruction and somebody else', () => {
    for (const body of [
      'did we ever sort out daycare?',
      'my sister put hers in daycare',
      'you said daycare',
    ]) {
      expect(care(body), body).toBe('nothing_stated');
    }
    // The positive control: strip the blocker and the same sentence DOES read, so these
    // are refusals rather than a grammar that never saw the word.
    expect(care('we sorted out daycare')).toBe('daycare');
  });

  it('says nothing about an ordinary message', () => {
    expect(care('thanks! the library thing was great')).toBe('nothing_stated');
  });
});

/**
 * One normaliser, two readers. A private copy in either file is how they start
 * disagreeing about what "it's" is, and the disagreement would be invisible: both would
 * keep passing their own tests.
 */
describe('the shared normaliser', () => {
  it('is the same function `stated-state` reads its own corpus with', () => {
    expect(words("she's not in daycare - yet!")).toBe('shes not in daycare yet');
    expect(segmentsOf('Is she home? No daycare.')).toEqual([
      { words: 'is she home', question: true },
      { words: 'no daycare', question: false },
    ]);
  });
});
