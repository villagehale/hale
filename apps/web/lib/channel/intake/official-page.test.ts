import { describe, expect, it } from 'vitest';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { COLD_START_ASK, WATCH_OFFER_ASK } from './copy';
import {
  NOT_POSTED_YET,
  OFFICIAL_PAGE_RETURN_ASK,
  deidentifyOfficialQuery,
  extractOfficialAnswer,
  isOfficialPageAsk,
  notesGroundADate,
  officialPageFallbackReply,
  officialPageReplyFromNotes,
  officialPageReturnLine,
} from './official-page';

describe('official-page · which inbound is a real rec/camp clock question', () => {
  it('matches a first-text rec/camp ask that misses the city pins', () => {
    expect(isOfficialPageAsk('When does swim registration open near me?')).toBe(true);
    expect(isOfficialPageAsk('When do winter-break camps open?')).toBe(true);
    expect(isOfficialPageAsk('Hamilton fall rec dates?')).toBe(true);
    expect(isOfficialPageAsk('Newmarket swim registration?')).toBe(true);
  });

  it('leaves Hale-itself, hedges, details, and adult-learn to their own paths', () => {
    expect(isOfficialPageAsk('who is this exactly?')).toBe(false);
    expect(isOfficialPageAsk('can you book the swimming lessons for us')).toBe(false);
    expect(isOfficialPageAsk('hmm maybe, let me ask my husband')).toBe(false);
    expect(isOfficialPageAsk('thanks')).toBe(false);
    expect(isOfficialPageAsk('Maya is 4, Theo is 18 months, L3R')).toBe(false);
    expect(isOfficialPageAsk('I wanna learn swimming')).toBe(false);
    expect(isOfficialPageAsk("she's not breathing")).toBe(false);
    expect(isOfficialPageAsk('hi')).toBe(false);
  });
});

describe('official-page · the return ask is never COLD_START_ASK', () => {
  it('asks for names, ages, and postal in different words', () => {
    const line = officialPageReturnLine(COLD_START_ASK);
    expect(line).toBe(OFFICIAL_PAGE_RETURN_ASK);
    expect(line).not.toBe(COLD_START_ASK);
    expect(line.endsWith('?')).toBe(true);
    expect(line.toLowerCase()).toContain('names');
    expect(line.toLowerCase()).toContain('ages');
    expect(line.toLowerCase()).toContain('postal');
  });

  it('paraphrases the watch offer without copying it', () => {
    const line = officialPageReturnLine(WATCH_OFFER_ASK);
    expect(line).not.toBe(WATCH_OFFER_ASK);
    expect(line.endsWith('?')).toBe(true);
  });
});

describe('official-page · not posted yet when search cannot ground a date', () => {
  it('is the locked fallback, GSM-7, under 300, no URL, no I do not do that', () => {
    const body = officialPageFallbackReply(COLD_START_ASK);
    expect(body.startsWith(NOT_POSTED_YET)).toBe(true);
    expect(body).toContain(OFFICIAL_PAGE_RETURN_ASK);
    expect(body).not.toBe(COLD_START_ASK);
    expect(body).not.toContain(COLD_START_ASK);
    expect(body).not.toContain("I don't do that");
    expect(body).not.toMatch(/https?:\/\//);
    expect(smsEncoding(body)).toBe('gsm7');
    expect(smsSegments(body)).toBeLessThanOrEqual(2);
    expect(body.length).toBeLessThanOrEqual(300);
  });

  it('extracts a posted date from official notes and refuses a clock that is not there', () => {
    const notes =
      'The City of Hamilton posted swim registration for residents on September 8 at 7:00 a.m.';
    expect(notesGroundADate(notes)).toBe(true);
    expect(extractOfficialAnswer(notes)).toContain('September 8');
    expect(extractOfficialAnswer(notes)).toContain('7:00');
    expect(notesGroundADate('Their rec page lists the program. No date yet.')).toBe(false);
    expect(extractOfficialAnswer('Their rec page lists the program. No date yet.')).toBeNull();
  });

  it('answers from notes when a date is grounded, otherwise not posted yet', () => {
    const grounded = officialPageReplyFromNotes(
      'Hamilton swim opens September 8 at 7:00 a.m.',
      COLD_START_ASK,
    );
    expect(grounded).toContain('September 8');
    expect(grounded).toContain(OFFICIAL_PAGE_RETURN_ASK);
    expect(grounded).not.toContain(COLD_START_ASK);

    const empty = officialPageReplyFromNotes('Nothing on the municipal page.', COLD_START_ASK);
    expect(empty).toBe(officialPageFallbackReply(COLD_START_ASK));
  });
});

describe('official-page · what may be searched', () => {
  it('strips household names and a postal so they never cross the border', () => {
    const query = deidentifyOfficialQuery('When does swim open for Maya in L3R 2T6?', [
      { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
    ]);
    expect(query.toLowerCase()).not.toContain('maya');
    expect(query).not.toMatch(/L3R/i);
    expect(query.toLowerCase()).toContain('swim');
  });
});
