import { describe, expect, it } from 'vitest';
import { draftFromQueryParam, MAX_SEEDED_DRAFT } from './ask-seed';

/**
 * WEB-02: the Home ask bar's `?q=` must reach the /coach composer (never dropped), and
 * be bounded so a crafted URL can't seed an unbounded draft.
 */
describe('draftFromQueryParam', () => {
  it('seeds a typed question as the initial draft (not dropped)', () => {
    expect(draftFromQueryParam('when do I start solids?')).toBe('when do I start solids?');
  });

  it('bounds an over-long question', () => {
    expect(draftFromQueryParam('x'.repeat(5000))).toHaveLength(MAX_SEEDED_DRAFT);
  });

  it('is empty for a missing or repeated (array) param', () => {
    expect(draftFromQueryParam(undefined)).toBe('');
    expect(draftFromQueryParam(['a', 'b'])).toBe('');
  });
});
