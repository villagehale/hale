import { describe, expect, it } from 'vitest';
import { applyVerbatimGuard } from './intent';

describe('applyVerbatimGuard', () => {
  it('passes a reading through untouched when the reply was echoed exactly', () => {
    const reading = { intent: 'assent' as const, verbatim: 'yes please', interpretation: 'a yes' };
    expect(applyVerbatimGuard(reading, 'yes please')).toBe(reading);
  });

  it('collapses an ASSENT to ambiguous when the echo does not match', () => {
    // A model that paraphrased did not read the reply it was given, so its verdict is
    // not evidence — and the direction that must never survive is a false yes.
    const guarded = applyVerbatimGuard(
      { intent: 'assent', verbatim: 'Yes.', interpretation: 'a yes' },
      'yes please',
    );
    expect(guarded.intent).toBe('ambiguous');
    expect(guarded.verbatim).toBe('yes please');
  });

  it('keeps the parent’s real words on the record even when the reading is discarded', () => {
    const guarded = applyVerbatimGuard(
      { intent: 'decline', verbatim: 'no', interpretation: 'a no' },
      "  no thanks, we're good  ",
    );
    expect(guarded.verbatim).toBe("  no thanks, we're good  ");
    expect(guarded.interpretation).toContain('verbatim mismatch');
  });
});
