import { describe, expect, it } from 'vitest';
import { distinctiveWords, mentionsActivity, mentionsIntro } from './screen';

/**
 * The screen errs toward ASKING, and these tests are mostly about that direction. A
 * missed mention costs one slightly redundant text; a false hit drops the message
 * entirely and silently, and the parent never learns they were skipped.
 */

describe('distinctiveWords', () => {
  it('keeps the word that says which activity this is', () => {
    expect(distinctiveWords('Swim class')).toEqual(['swim']);
    expect(distinctiveWords('Saturday Storytime at Riverdale')).toEqual([
      'saturday',
      'storytime',
      'riverdale',
    ]);
  });

  /** A title with nothing specific in it CANNOT be screened, and that is a real state
   * rather than a bug: screening on "class" would drop a follow-up because the parent
   * mentioned some other class entirely. */
  it('finds nothing to screen on in an all-generic title', () => {
    expect(distinctiveWords('Drop-in class')).toEqual([]);
    expect(mentionsActivity(['the drop-in class was great'], 'Drop-in class')).toBe(false);
  });
});

describe('mentionsActivity', () => {
  it('sees the parent raise the subject in their own words', () => {
    expect(mentionsActivity(['storytime was packed but she loved it'], 'Saturday Storytime')).toBe(
      true,
    );
  });

  it('does not fire on an unrelated message', () => {
    expect(mentionsActivity(['can you move thursday to friday'], 'Swim class')).toBe(false);
  });

  it('does not fire on a generic word the title happens to contain', () => {
    expect(mentionsActivity(['his art class got cancelled'], 'Swim class')).toBe(false);
  });

  it('reads nothing at all as nothing said', () => {
    expect(mentionsActivity([], 'Swim class')).toBe(false);
  });
});

describe('mentionsIntro', () => {
  /** Sentiment is not the question. A parent who says it went nowhere has answered just
   * as fully as one who says it went well, and asking either of them again is the
   * redundancy this prevents. */
  it.each([
    ['it went well', 'we met up for coffee on saturday, lovely people'],
    ['it went nowhere', 'we never heard back from them'],
    ['it is named plainly', 'thanks for the intro'],
  ])('sees the introduction already answered when %s', (_label, body) => {
    expect(mentionsIntro([body])).toBe(true);
  });

  /** The two messages that broke the first draft of this list, kept as its guard: a bare
   * `connected` and a bare `met` each cost a family their follow-up on a sentence about
   * something else entirely. */
  it.each([
    'the wifi never connected at the library',
    'we met the new teacher today',
    'can you move thursday to friday',
  ])('does not fire on an ordinary message: %s', (body) => {
    expect(mentionsIntro([body])).toBe(false);
  });
});
