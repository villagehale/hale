import { describe, expect, it } from 'vitest';
import {
  afterProvisionReplyFromNotes,
  deidentifyLiveQuery,
  extractLiveLookupAnswer,
  isCheerUpAsk,
  isLeftoverFactAsk,
  isLiveLookupAsk,
  isRaisingKidsAsk,
  isTherapistFindAsk,
  liveLookupReplyFromNotes,
  liveLookupReturnLine,
  notesGroundACurrentSource,
} from './live-lookup';

/** #868: the fixed ask is gone; any pending-ask text is a fixture. */
const COLD_START_ASK = 'cold start ask (test fixture)';
/** #868: the fixed ask is gone; any pending-ask text is a fixture. */
const WATCH_OFFER_ASK = 'watch offer ask (test fixture)';

describe('live-lookup · which inbound needs a current source', () => {
  it('matches raising-kids questions mid-signup', () => {
    expect(isRaisingKidsAsk('How do I get him to nap?')).toBe(true);
    expect(isRaisingKidsAsk('When should we start solids?')).toBe(true);
    expect(isRaisingKidsAsk('How do I potty train?')).toBe(true);
    expect(isRaisingKidsAsk('She had a huge tantrum at daycare')).toBe(true);
    expect(isLiveLookupAsk('How do I get him to nap?')).toBe(true);
  });

  it('matches leftover current-source facts, not opinion trivia', () => {
    expect(isLeftoverFactAsk('Who is the US president?')).toBe(true);
    expect(isLeftoverFactAsk('who won the World Cup?')).toBe(true);
    expect(isLeftoverFactAsk("who's the goat in football")).toBe(false);
    expect(isLeftoverFactAsk('whats the capital of peru')).toBe(false);
    expect(isLiveLookupAsk('Who is the US president?')).toBe(true);
  });

  it('matches a non-crisis therapist-find, not a cheer-up', () => {
    expect(isTherapistFindAsk('I need a therapist')).toBe(true);
    expect(isTherapistFindAsk('how do I find a counsellor in Ontario?')).toBe(true);
    expect(isTherapistFindAsk('cheer me up')).toBe(false);
    expect(isLiveLookupAsk('I need a therapist')).toBe(true);
  });

  it('matches a cheer-up / burnout ask, never a crisis or a nap question', () => {
    expect(isCheerUpAsk('cheer me up')).toBe(true);
    expect(isCheerUpAsk("I'm so exhausted")).toBe(true);
    expect(isCheerUpAsk('I am burnt out')).toBe(true);
    expect(isCheerUpAsk('How do I get him to nap?')).toBe(false);
    expect(isCheerUpAsk('I want to die')).toBe(false);
    expect(isCheerUpAsk('I need a therapist')).toBe(false);
  });

  it('leaves Hale-itself, hedges, details, adult-learn, rec clocks, and safety alone', () => {
    for (const body of [
      'who is this exactly?',
      'hmm maybe, let me ask my husband',
      'thanks',
      'Maya is 4, Theo is 18 months, L3R',
      'I wanna learn swimming',
      "she's not breathing",
      'When does swim registration open near me?',
      'hi',
    ]) {
      expect(isLiveLookupAsk(body), body).toBe(false);
      expect(isCheerUpAsk(body), body).toBe(false);
    }
  });
});

describe('live-lookup · return ask is never COLD_START_ASK', () => {
  it('asks for names, ages, and postal in different words', () => {
    const line = liveLookupReturnLine(COLD_START_ASK);
    expect(line).not.toBe(COLD_START_ASK);
    // #868: no fixed return line at all; the friend voice asks next turn.
    expect(line).toBe('');
  });

  it('paraphrases the watch offer without copying it', () => {
    const line = liveLookupReturnLine(WATCH_OFFER_ASK);
    expect(line).not.toBe(WATCH_OFFER_ASK);
    // #868: no fixed return line at all; the friend voice asks next turn.
    expect(line).toBe('');
  });
});

describe('live-lookup · no current source when search cannot ground', () => {
  it('extracts a restated source sentence and refuses notes that invent nothing', () => {
    const notes =
      'Health Canada says most babies are ready for solids around 6 months. Start with iron-rich foods.';
    expect(notesGroundACurrentSource(notes)).toBe(true);
    expect(extractLiveLookupAnswer(notes)).toContain('6 months');
    expect(extractLiveLookupAnswer('NO CURRENT SOURCE')).toBeNull();
    expect(notesGroundACurrentSource('NO CURRENT SOURCE')).toBe(false);
  });

  it('answers from notes when grounded, otherwise no current source', () => {
    const grounded = liveLookupReplyFromNotes(
      'The official White House page names the current United States president.',
      COLD_START_ASK,
    );
    expect(grounded).toContain('United States president');
    expect(grounded).not.toContain(COLD_START_ASK);

    const empty = liveLookupReplyFromNotes('NO CURRENT SOURCE', COLD_START_ASK);
    // #868: no fixed fallback; null hands the turn to the model's no_source line.
    expect(empty).toBeNull();
  });

  it('after provision leftover facts get a return-to-Hale line', () => {
    const body = afterProvisionReplyFromNotes('Argentina won the 2022 World Cup.');
    expect(body).toContain('Argentina');
    expect(body).not.toContain(COLD_START_ASK);
  });
});

describe('live-lookup · what may be searched', () => {
  it('strips household names and a postal so they never cross the border', () => {
    const query = deidentifyLiveQuery('How do I nap train Maya in L3R 2T6?', [
      { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
    ]);
    expect(query.toLowerCase()).not.toContain('maya');
    expect(query).not.toMatch(/L3R/i);
    expect(query.toLowerCase()).toContain('nap');
  });
});
