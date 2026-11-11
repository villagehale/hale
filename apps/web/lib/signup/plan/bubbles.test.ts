import { describe, expect, it } from 'vitest';
import { asBubbles, withLinkBubbles } from './bubbles';

describe('plan notice bubbles', () => {
  it('inserts the Hale-owned link as its own bubble after the first', () => {
    expect(
      withLinkBubbles(
        ['They did not take that password.', 'Their rule is eight and a number.'],
        'https://app.villagehale.com/l/AbCdef1234',
      ),
    ).toEqual([
      'They did not take that password.',
      'https://app.villagehale.com/l/AbCdef1234',
      'Their rule is eight and a number.',
    ]);
  });

  it('treats a single string as one bubble', () => {
    expect(asBubbles('  hello  ')).toEqual(['hello']);
    expect(asBubbles(['', '  next  '])).toEqual(['next']);
    expect(asBubbles(null)).toBeNull();
  });
});
