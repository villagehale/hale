import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The locked web auth decision: /sign-in and /sign-up offer Google + a passwordless
 * magic link only — no password fields, no Apple. (The server-side password
 * provider is untouched; /forgot-password + /reset-password stay reachable by
 * direct link but are no longer surfaced from these pages.) A source scan, because
 * both pages are server components that pull in next-auth and need a DB to render.
 */
function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../app/${rel}`, import.meta.url)), 'utf8');
}

describe('web auth pages are passwordless (Google + magic link only)', () => {
  for (const page of ['sign-in/page.tsx', 'sign-up/page.tsx']) {
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
});
