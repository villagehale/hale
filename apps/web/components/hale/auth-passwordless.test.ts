import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The locked web auth decision: /sign-in offers Google + a passwordless magic link
 * only — no password fields, no Apple. (The server-side password provider is
 * untouched; /forgot-password + /reset-password stay reachable by direct link but
 * are no longer surfaced.) /sign-up is retired as a standalone door (founder
 * decision 2026-07-21): it permanently redirects into the public onboarding
 * wizard, whose step 6 carries the join form — one funnel, no second entrance.
 * A source scan, because these are server components that pull in next-auth and
 * need a DB to render.
 */
function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../app/${rel}`, import.meta.url)), 'utf8');
}

describe('web auth pages are passwordless (Google + magic link only)', () => {
  for (const page of ['sign-in/page.tsx']) {
    it(`${page}: Google + magic link, no password form, no Apple`, () => {
      const src = source(page);
      expect(src).toContain('Continue with Google');
      expect(src).toContain('MagicLinkRequestForm');
      // Password UI removed — no password form component, no password input.
      expect(src).not.toContain('EmailSignInForm');
      expect(src).not.toContain('EmailSignUpForm');
      expect(src).not.toContain('type="password"');
      // No Sign in with Apple on web (the doc comment naming the decision is fine).
      expect(src).not.toContain("'apple'");
      expect(src).not.toMatch(/with apple/i);
      // The forgot-password link that lived on the old sign-in form is gone from
      // the UI (the route itself stays reachable by direct link).
      expect(src).not.toContain('href="/forgot-password"');
    });
  }

  it('sign-up/page.tsx is a pure redirect into the onboarding wizard (no second join door)', () => {
    const src = source('sign-up/page.tsx');
    expect(src).toContain("redirect('/onboarding')");
    expect(src).not.toContain('MagicLinkRequestForm');
    expect(src).not.toContain('Continue with Google');
    expect(src).not.toContain('type="password"');
  });

  it('sign-in cross-link sends new parents to onboarding, not a sign-up page', () => {
    const src = source('sign-in/page.tsx');
    expect(src).toContain('href="/onboarding"');
    expect(src).not.toContain('href="/sign-up"');
  });
});
