import { describe, expect, it } from 'vitest';
import { OPT_OUT_LINE } from '~/lib/channel/opt-out';
import { isPrintableGsm7Basic, smsSegments } from '~/lib/channel/sms-segments';
import {
  GENERIC_WEEKDAY_CHILD_PHRASE,
  weekdayCareAsk,
  weekdayChildPhrase,
} from './weekday-care-copy';

/**
 * The one sentence, byte-asserted.
 *
 * It is sent once per family, ever, and the reading of the answer changes what Hale
 * offers that household for months — so the wording is a reviewable artefact rather
 * than a string somebody may improve in passing.
 */

const NAMED = weekdayCareAsk('Mia');
const GENERIC = weekdayCareAsk(GENERIC_WEEKDAY_CHILD_PHRASE);

describe('weekdayCareAsk', () => {
  it('is exactly this sentence', () => {
    expect(NAMED).toBe(
      'Those are all weekend finds. Is Mia home with you during the week, or at daycare? There are weekday drop-ins near you too.',
    );
  });

  it('is GSM-7 printable and fits ONE segment with the opt-out line appended', () => {
    // The conservative bound: the gate appends the CASL line at most once per period,
    // and the message has to fit on the periods when it does ride.
    for (const ask of [NAMED, GENERIC]) {
      expect(isPrintableGsm7Basic(ask)).toBe(true);
      expect(smsSegments(`${ask}\n\n${OPT_OUT_LINE}`)).toBe(1);
    }
    // The generic path has two characters of headroom, so this is the test that stops a
    // future word doubling the bill rather than a note asking somebody not to.
    expect(`${GENERIC}\n\n${OPT_OUT_LINE}`.length).toBe(158);
  });

  it('asks exactly one question', () => {
    // A second question is the failure this class of message is most likely to grow,
    // and it is also what would make the answer unreadable.
    for (const ask of [NAMED, GENERIC]) {
      expect(ask.split('?')).toHaveLength(2);
    }
  });

  /**
   * D23's corollary, as a lint rather than a style note. "Those are all weekend finds"
   * survives: `all` there quantifies the deictic `those` - the finds just sent - and
   * not Hale's output. Every token below turns the sentence into a claim about every
   * message Hale has ever sent, which is unverifiable and false.
   */
  it('makes no universal claim about what Hale has ever sent', () => {
    for (const forbidden of ['everything', 'anything i', 'so far', 'always', 'every time']) {
      expect(NAMED.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('puts the either/or last, so a bare affirmative settles nothing', () => {
    const question = NAMED.slice(NAMED.indexOf('Is'), NAMED.indexOf('?') + 1);
    expect(question).toContain(' or ');
    // The payoff sentence follows the question, so the parent reads the choice before
    // they read the offer.
    expect(NAMED.indexOf('?')).toBeLessThan(NAMED.indexOf('weekday drop-ins'));
  });
});

describe('weekdayChildPhrase', () => {
  it('prints the name a parent gave', () => {
    expect(weekdayChildPhrase('Mia')).toBe('Mia');
  });

  it('falls back to the generic phrase for a name SMS cannot spell cheaply', () => {
    expect(weekdayChildPhrase('Zoë')).toBe(GENERIC_WEEKDAY_CHILD_PHRASE);
    expect(weekdayChildPhrase(null)).toBe(GENERIC_WEEKDAY_CHILD_PHRASE);
  });
});
