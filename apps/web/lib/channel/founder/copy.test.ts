import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { founderNote } from './copy';

/** Barton: delete the first-families welcome clause. Do not write another one. */
const WELCOME_LINE = new RegExp(
  [
    ['one of our', 'first'].join(' '),
    ['first', 'families'].join(' '),
    ['founding', 'famil'].join('[- ]'),
    ['giving Hale', 'a try'].join(' '),
    ['thank you for', 'being'].join(' '),
  ].join('|'),
  'i',
);

describe('the founder note', () => {
  it('keeps his other words and does not welcome the family as first or founding', () => {
    expect(founderNote()).toBe(
      'A note from Barton, the dad who built Hale. If anything ever feels off, just say so right here - I read what matters. - B',
    );
    expect(founderNote()).not.toMatch(WELCOME_LINE);
  });

  it('does not leave the welcome line in the source', () => {
    const source = readFileSync(new URL('./copy.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(WELCOME_LINE);
  });
});
