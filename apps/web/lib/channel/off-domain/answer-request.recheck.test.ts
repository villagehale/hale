import { describe, expect, it } from 'vitest';
import { notesWithRecheck, preSendReadApplies, wantsSearchAgain } from './answer-request';

describe('the second look and the tone read', () => {
  it('searches again only on an explicit true for a searched draft', () => {
    expect(wantsSearchAgain({ search_again: true }, 'searched')).toBe(true);
    expect(wantsSearchAgain({ search_again: 'true' }, 'searched')).toBe(false);
    expect(wantsSearchAgain({}, 'searched')).toBe(false);
    expect(wantsSearchAgain({ search_again: true }, 'not_needed')).toBe(false);
  });

  it('keeps the first notes and puts the second look after them', () => {
    expect(notesWithRecheck('a', '')).toBe('a');
    expect(notesWithRecheck('a', 'b')).toBe('a\n\n[second look]\nb');
  });

  it('reads every draft, and a searched one only with notes', () => {
    expect(preSendReadApplies('not_needed', '')).toBe(true);
    expect(preSendReadApplies('searched', '')).toBe(false);
    expect(preSendReadApplies('searched', 'n')).toBe(true);
  });
});
