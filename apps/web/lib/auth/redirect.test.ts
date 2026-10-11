import { describe, expect, it } from 'vitest';
import { safeInternalRedirect, signInHref } from './redirect';

describe('safeInternalRedirect', () => {
  it('passes through an app-internal path', () => {
    expect(safeInternalRedirect('/family')).toBe('/family');
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

  it('falls back for an absolute URL', () => {
    expect(safeInternalRedirect('https://evil.com/messages')).toBe('/home');
    expect(safeInternalRedirect('http://evil.com')).toBe('/home');
  });

  it('falls back for a protocol-relative URL', () => {
    expect(safeInternalRedirect('//evil.com')).toBe('/home');
    expect(safeInternalRedirect('///evil.com')).toBe('/home');
    expect(safeInternalRedirect('/..//evil.com')).toBe('/home');
  });

  it('falls back for a backslash URL', () => {
    expect(safeInternalRedirect('/\\evil.com')).toBe('/home');
    expect(safeInternalRedirect('\\\\evil.com')).toBe('/home');
  });

  it('falls back for a javascript: URL', () => {
    expect(safeInternalRedirect('javascript:alert(1)')).toBe('/home');
    expect(safeInternalRedirect('JavaScript:alert(document.domain)')).toBe('/home');
  });

  it('falls back for encoded variants of those attacks', () => {
    expect(safeInternalRedirect('/%2F%2Fevil.com')).toBe('/home');
    expect(safeInternalRedirect('/%2f%2fevil.com')).toBe('/home');
    expect(safeInternalRedirect('%2F%2Fevil.com')).toBe('/home');
    expect(safeInternalRedirect('/%5Cevil.com')).toBe('/home');
    expect(safeInternalRedirect('/%252F%252Fevil.com')).toBe('/home');
    expect(safeInternalRedirect('/%73ign-in')).toBe('/home');
    expect(safeInternalRedirect('/%2e%2e//evil.com')).toBe('/home');
  });

  it('falls back for control characters', () => {
    expect(safeInternalRedirect('/messages\n')).toBe('/home');
    expect(safeInternalRedirect('/messages\r\nLocation: https://evil.com')).toBe('/home');
    expect(safeInternalRedirect('/messages%0A')).toBe('/home');
    expect(safeInternalRedirect('/messages%00')).toBe('/home');
  });

  it('falls back for a return to the sign-in door, which would loop', () => {
    expect(safeInternalRedirect('/sign-in')).toBe('/home');
    expect(safeInternalRedirect('/signin')).toBe('/home');
    expect(safeInternalRedirect('/sign-in?callbackUrl=%2Fmessages')).toBe('/home');
    expect(safeInternalRedirect('/SIGN-IN')).toBe('/home');
    expect(safeInternalRedirect('/signin/')).toBe('/home');
  });

  it('keeps a valid path with a query', () => {
    expect(safeInternalRedirect('/messages?thread=1')).toBe('/messages?thread=1');
    expect(safeInternalRedirect('/family/kid?stamp=swim')).toBe('/family/kid?stamp=swim');
    expect(safeInternalRedirect('/oauth/authorize?client_id=hale%20client')).toBe(
      '/oauth/authorize?client_id=hale%20client',
    );
  });

  it('builds /sign-in with the return path encoded as callbackUrl', () => {
    expect(signInHref('/messages')).toBe('/sign-in?callbackUrl=%2Fmessages');
    expect(signInHref('/messages?thread=1')).toBe('/sign-in?callbackUrl=%2Fmessages%3Fthread%3D1');
    expect(signInHref('https://evil.com')).toBe('/sign-in');
    expect(signInHref('/sign-in')).toBe('/sign-in');
    expect(signInHref('/signin')).toBe('/sign-in');
  });
});
