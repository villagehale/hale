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
    ]) {
      expect(care(body), body).toBe('daycare');
    }
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

    it('may be a person, which is why it never leaves the family', () => {
      expect(readWeekdayCare("she's at Nana's during the week")).toMatchObject({
        care: 'daycare',
        provider: "Nana's",
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
