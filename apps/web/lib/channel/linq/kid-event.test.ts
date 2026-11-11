import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEEN_NAME_SHARED_MATCHER_ENABLED_ENV } from '~/lib/privacy/teen-name';
import { withoutTeenTitles } from './kid-event';

const block = (title: string) => ({ title, kidRelated: true });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('withoutTeenTitles', () => {
  it("drops the title of an unnamed event a teen who is the only child would be credited with, and keeps a younger only child's", () => {
    expect(withoutTeenTitles([block('hockey practice')], ['Kestrel'], ['Kestrel'])).toEqual([
      { title: null, kidRelated: false },
    ]);
    expect(withoutTeenTitles([block('hockey practice')], ['Maya'], [])).toEqual([
      block('hockey practice'),
    ]);
  });

  it('unlit, keeps a title that names a teen only with an accent the legacy check misses', () => {
    vi.stubEnv(TEEN_NAME_SHARED_MATCHER_ENABLED_ENV, undefined);
    expect(withoutTeenTitles([block('Támsin debate')], ['Pip', 'Tamsin'], ['Tamsin'])).toEqual([
      block('Támsin debate'),
    ]);
  });

  it('lit, drops a title that names a teen with an accent or a name part', () => {
    vi.stubEnv(TEEN_NAME_SHARED_MATCHER_ENABLED_ENV, 'true');
    expect(withoutTeenTitles([block('Támsin debate')], ['Pip', 'Tamsin'], ['Tamsin'])).toEqual([
      { title: null, kidRelated: false },
    ]);
    expect(withoutTeenTitles([block('Sofia debate')], ['Pip', 'Ana Sofia'], ['Ana Sofia'])).toEqual(
      [{ title: null, kidRelated: false }],
    );
  });
});
