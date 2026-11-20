import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOGIN_PAGE_COPY, backToHaleHref } from './page-copy';

describe('provider login page copy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the saved screen wording', () => {
    expect(LOGIN_PAGE_COPY.savedHeading).toBe('saved');
    expect(LOGIN_PAGE_COPY.savedLine('haltonhills.perfectmind.com')).toBe(
      'Hale can sign in to haltonhills.perfectmind.com now',
    );
    expect(LOGIN_PAGE_COPY.backToHale).toBe('back to Hale');
  });

  it('the back-to-Hale control is an sms: link when the number is set', () => {
    vi.stubEnv('LINQ_FROM_E164', '+14165550100');
    expect(backToHaleHref()).toBe('sms:+14165550100');
  });
});
