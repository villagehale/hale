import { REGISTRATION_COURSE_URL_MAX_CHARS } from '@hale/db';
import { describe, expect, it } from 'vitest';
import * as fetchModule from './fetch';
import { registrationPageUrl } from './page';
import * as sweep from './verify-sweep';

describe('registration page fetch', () => {
  it('verify-sweep re-exports the one fetcher rather than defining its own', () => {
    expect(sweep.createFetchBody).toBe(fetchModule.createFetchBody);
    expect(sweep.createFetchPage).toBe(fetchModule.createFetchPage);
    expect(sweep.pageCache).toBe(fetchModule.pageCache);
  });

  it('bounds a course URL at 2048 characters', () => {
    expect(REGISTRATION_COURSE_URL_MAX_CHARS).toBe(2048);
  });

  it('accepts a 2048-character URL and refuses a 2049-character one', () => {
    const atLimit = `https://example.com/${'a'.repeat(2028)}`;
    expect(atLimit).toHaveLength(2048);
    expect(registrationPageUrl(atLimit)).toBe(atLimit);
    expect(() => registrationPageUrl(`${atLimit}a`)).toThrow('registration page: unsafe URL');
  });
});
