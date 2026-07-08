import { describe, expect, it } from 'vitest';
import { registerLinkHref } from './register-link';

describe('registerLinkHref (mobile parity with web)', () => {
  it('prefers the discovered source URL when present', () => {
    expect(registerLinkHref('https://ymca.ca/swim', 'Parent & tot swim')).toBe(
      'https://ymca.ca/swim',
    );
  });

  it('falls back to a Google search for the title when the source URL is null', () => {
    expect(registerLinkHref(null, 'Parent & tot swim')).toBe(
      'https://www.google.com/search?q=Parent%20%26%20tot%20swim',
    );
  });

  it('falls back for an empty / whitespace source URL too (always resolves)', () => {
    expect(registerLinkHref('   ', 'Storytime')).toBe(
      'https://www.google.com/search?q=Storytime',
    );
  });
});
