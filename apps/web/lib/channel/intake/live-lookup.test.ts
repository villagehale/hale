import { describe, expect, it } from 'vitest';
import {
  afterProvisionReplyFromNotes,
  deidentifyLiveQuery,
  extractLiveLookupAnswer,
  liveLookupReplyFromNotes,
  liveLookupReturnLine,
  notesGroundACurrentSource,
} from './live-lookup';

/** #868: the fixed ask is gone; any pending-ask text is a fixture. */
const COLD_START_ASK = 'cold start ask (test fixture)';
/** #868: the fixed ask is gone; any pending-ask text is a fixture. */
const WATCH_OFFER_ASK = 'watch offer ask (test fixture)';

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
    const scrub = deidentifyLiveQuery('How do I nap train Maya in L3R 2T6?', [
      { name: 'Maya', ageMonths: 48, agePrecision: 'years' },
    ]);
    expect(scrub.ok).toBe(true);
    if (!scrub.ok) return;
    expect(scrub.text.toLowerCase()).not.toContain('maya');
    expect(scrub.text).not.toMatch(/L3R/i);
    expect(scrub.text.toLowerCase()).toContain('nap');
  });
});
