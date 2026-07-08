import { describe, expect, it } from 'vitest';
import { appleIdentityToken } from './apple-credential';

describe('appleIdentityToken', () => {
  it('returns the identity token when present', () => {
    expect(appleIdentityToken({ identityToken: 'header.payload.sig' })).toBe('header.payload.sig');
  });

  it('throws when the credential carries no identity token (fail closed)', () => {
    expect(() => appleIdentityToken({ identityToken: null })).toThrow();
  });
});
