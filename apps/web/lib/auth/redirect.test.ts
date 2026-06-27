import { describe, expect, it } from 'vitest';
import { safeInternalRedirect } from './redirect';

describe('safeInternalRedirect', () => {
  it('passes through an app-internal path', () => {
    expect(safeInternalRedirect('/village')).toBe('/village');
    expect(safeInternalRedirect('/onboarding?step=setup')).toBe('/onboarding?step=setup');
  });

  it('falls back for an absolute off-site URL', () => {
    expect(safeInternalRedirect('https://evil.com')).toBe('/home');
  });

  it('falls back for a protocol-relative URL that slips past startsWith("/")', () => {
    // '//evil.com'.startsWith('/') is true — the bug this guard closes.
    expect(safeInternalRedirect('//evil.com')).toBe('/home');
    expect(safeInternalRedirect('/\\evil.com')).toBe('/home');
  });

  it('falls back for a missing target', () => {
    expect(safeInternalRedirect(undefined)).toBe('/home');
    expect(safeInternalRedirect('')).toBe('/home');
  });

  it('honors a custom fallback', () => {
    expect(safeInternalRedirect('//evil.com', '/sign-in')).toBe('/sign-in');
  });
});
