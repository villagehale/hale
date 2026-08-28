import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { COLD_START_ASK, WATCH_OFFER_ASK } from './copy';
import {
  AFTER_PROVISION_RETURN_ASK,
  CHEER_UP_REPLY,
  NO_CURRENT_SOURCE_YET,
  afterProvisionFallbackReply,
  afterProvisionReplyFromNotes,
  cheerUpAfterProvisionReply,
  cheerUpIntakeReply,
  deidentifyLiveQuery,
  extractLiveLookupAnswer,
  isCheerUpAsk,
  isLeftoverFactAsk,
  isLiveLookupAsk,
  isRaisingKidsAsk,
  isTherapistFindAsk,
  liveLookupFallbackReply,
  liveLookupReplyFromNotes,
  liveLookupReturnLine,
  namesAMentalCrisis,
  notesGroundACurrentSource,
} from './live-lookup';
import { OFFICIAL_PAGE_RETURN_ASK } from './official-page';

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

describe('live-lookup · mental crisis is the reviewed safety door', () => {
  it('fires on suicide / self-harm and leaves a therapist-find alone', () => {
    expect(namesAMentalCrisis('I want to die')).toBe(true);
    expect(namesAMentalCrisis('I have been thinking about suicide')).toBe(true);
    expect(namesAMentalCrisis('self-harm tonight')).toBe(true);
    expect(namesAMentalCrisis('I need a therapist')).toBe(false);
    expect(namesAMentalCrisis('cheer me up')).toBe(false);
    expect(namesAMentalCrisis('How do I get him to nap?')).toBe(false);
  });
});

describe('live-lookup · return ask is never COLD_START_ASK', () => {
  it('asks for names, ages, and postal in different words', () => {
    const line = liveLookupReturnLine(COLD_START_ASK);
    expect(line).toBe(OFFICIAL_PAGE_RETURN_ASK);
    expect(line).not.toBe(COLD_START_ASK);
    expect(line.endsWith('?')).toBe(true);
  });

  it('paraphrases the watch offer without copying it', () => {
    const line = liveLookupReturnLine(WATCH_OFFER_ASK);
    expect(line).not.toBe(WATCH_OFFER_ASK);
    expect(line.endsWith('?')).toBe(true);
  });
});

describe('live-lookup · no current source when search cannot ground', () => {
  it('is the locked fallback, GSM-7, under 300, no URL, no I do not do that', () => {
    const body = liveLookupFallbackReply(COLD_START_ASK);
    expect(body.startsWith(NO_CURRENT_SOURCE_YET)).toBe(true);
    expect(body).toContain(OFFICIAL_PAGE_RETURN_ASK);
    expect(body).not.toContain(COLD_START_ASK);
    expect(body).not.toContain("I don't do that");
    expect(body).not.toMatch(/https?:\/\//);
    expect(body).not.toMatch(/I'?m a therapist/i);
    expect(smsEncoding(body)).toBe('gsm7');
    expect(smsSegments(body)).toBeLessThanOrEqual(2);
    expect(body.length).toBeLessThanOrEqual(300);
  });

  it('after provision still returns to the kids / the week, not trivia', () => {
    const body = afterProvisionFallbackReply();
    expect(body.startsWith(NO_CURRENT_SOURCE_YET)).toBe(true);
    expect(body).toContain(AFTER_PROVISION_RETURN_ASK);
    expect(body).not.toContain(COLD_START_ASK);
    expect(smsEncoding(body)).toBe('gsm7');
    expect(body.length).toBeLessThanOrEqual(300);
  });

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
    expect(grounded).toContain(OFFICIAL_PAGE_RETURN_ASK);
    expect(grounded).not.toContain(COLD_START_ASK);

    const empty = liveLookupReplyFromNotes('NO CURRENT SOURCE', COLD_START_ASK);
    expect(empty).toBe(liveLookupFallbackReply(COLD_START_ASK));
  });

  it('after provision leftover facts get a return-to-Hale line', () => {
    const body = afterProvisionReplyFromNotes('Argentina won the 2022 World Cup.');
    expect(body).toContain('Argentina');
    expect(body).toContain(AFTER_PROVISION_RETURN_ASK);
    expect(body).not.toContain(COLD_START_ASK);
  });
});

describe('live-lookup · cheer-up is warm and not clinical', () => {
  it('is reviewed warmth, no diagnosis, no therapist claim, then one return ask', () => {
    const intake = cheerUpIntakeReply(COLD_START_ASK);
    expect(CHEER_UP_REPLY).toBe("That's a lot to carry. You're doing the hard part.");
    expect(CHEER_UP_REPLY).not.toContain('by showing up');
    expect(intake.startsWith(CHEER_UP_REPLY)).toBe(true);
    expect(intake).toContain(OFFICIAL_PAGE_RETURN_ASK);
    expect(intake).not.toMatch(/diagnos|treatment plan|I'?m a therapist/i);
    expect(intake).not.toContain(COLD_START_ASK);
    expect(smsEncoding(intake)).toBe('gsm7');

    const after = cheerUpAfterProvisionReply();
    expect(after.startsWith(CHEER_UP_REPLY)).toBe(true);
    expect(after).toContain(AFTER_PROVISION_RETURN_ASK);
    expect(after).not.toMatch(/diagnos|treatment plan|I'?m a therapist/i);
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
