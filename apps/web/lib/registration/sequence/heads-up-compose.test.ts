import { describe, expect, it } from 'vitest';
import { headsUpRefusals } from './heads-up-compose';

describe('VIL-488 · headsUpRefusals', () => {
  it('refuses an empty draft', () => {
    expect(headsUpRefusals('  ')).toEqual(['empty']);
  });
  it.each(['Opens Tuesday. https://example.com', 'Opens Tuesday. http://richmondhill.ca/programs'])(
    'refuses an http(s) link: %s',
    (text) => {
      expect(headsUpRefusals(text)).toEqual(['link']);
    },
  );
  it.each(['Opens Tuesday, see www.richmondhill.ca', 'Opens Tuesday: WWW.example.org/register'])(
    'refuses a www. address: %s',
    (text) => {
      expect(headsUpRefusals(text)).toEqual(['link']);
    },
  );
  it.each([
    'Opens Tuesday at richmondhill.ca/programs',
    'Sign up on townofoakville.com.',
    'Details: playrichmondhill.ca',
  ])('refuses a bare domain: %s', (text) => {
    expect(headsUpRefusals(text)).toEqual(['link']);
  });
  it.each([
    'Richmond Hill fall programs open Tuesday at 6:30 a.m. for Max.',
    'Les inscriptions ouvrent mardi à 6 h 30. Je vous aide ce matin-là?',
    'Opens at 7 p.m., e.g. after dinner.',
  ])('passes a plain text: %s', (text) => {
    expect(headsUpRefusals(text)).toEqual([]);
  });
});
