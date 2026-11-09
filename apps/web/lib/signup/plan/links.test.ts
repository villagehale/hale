import { describe, expect, it } from 'vitest';
import { withoutLinks } from './links';

describe('withoutLinks', () => {
  it('drops a link however it is written, read the way the shared check reads it', () => {
    for (const label of [
      'Swim https：//evil.app/x Tuesdays',
      'Swim https:／／evil.app Tuesdays',
      'Swim evil . app/x Tuesdays',
      'Swim evil [.] app Tuesdays',
    ]) {
      expect(withoutLinks(label), label).toBe('Swim Tuesdays');
    }
  });

  it('keeps a label with no link whole', () => {
    expect(withoutLinks('Swim Level 2, St. Mary pool, 10.30am')).toBe(
      'Swim Level 2, St. Mary pool, 10.30am',
    );
  });
});
