import { describe, expect, it } from 'vitest';
import { asBubbles, withLinkBubbles } from './bubbles';

describe('plan notice bubbles', () => {
  it('inserts the Hale-owned link as its own part after the first bubble', () => {
    expect(
      withLinkBubbles(['They did not take that password.', 'Their rule is eight and a number.'], {
        url: 'https://app.villagehale.com/l/AbCdef1234',
        id: 'link-1',
      }),
    ).toEqual([
      { type: 'text', body: 'They did not take that password.' },
      { type: 'link', url: 'https://app.villagehale.com/l/AbCdef1234', loginLinkId: 'link-1' },
      { type: 'text', body: 'Their rule is eight and a number.' },
    ]);
    expect(withLinkBubbles(['Saved.'], null)).toEqual([{ type: 'text', body: 'Saved.' }]);
  });

  it('treats a single string as one bubble', () => {
    expect(asBubbles('  hello  ')).toEqual(['hello']);
    expect(asBubbles(['', '  next  '])).toEqual(['next']);
    expect(asBubbles(null)).toBeNull();
  });
});
