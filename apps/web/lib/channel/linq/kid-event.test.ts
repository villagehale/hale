import { describe, expect, it } from 'vitest';
import { withoutTeenTitles } from './kid-event';

const block = (title: string) => ({ title, kidRelated: true });

describe('withoutTeenTitles', () => {
  it("drops the title of an unnamed event a teen who is the only child would be credited with, and keeps a younger only child's", () => {
    expect(withoutTeenTitles([block('hockey practice')], ['Kestrel'], ['Kestrel'])).toEqual([
      { title: null, kidRelated: false },
    ]);
    expect(withoutTeenTitles([block('hockey practice')], ['Maya'], [])).toEqual([
      block('hockey practice'),
    ]);
  });
});
