import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKETING_SITE_URL } from '~/lib/legal-links';

/**
 * What /sign-in offers, and — since F14 — what it stops offering.
 *
 * FLAG OFF is today's page, unchanged: Google + a passwordless magic link, no
 * password fields, no Apple. FLAG ON is the flip-day page: the phone you text Hale
 * on is the ONLY door. Not an addition to the others — a replacement, because a
 * family Hale can actually reach is one it has a number for, and every remaining
 * email/Google account belongs to a test family.
 *
 * The flag branch is exercised by RENDERING the page both ways rather than scanning
 * its source: the source contains both branches by construction, so only a render can
 * tell which affordances a parent is actually shown.
 */

vi.mock('~/auth', () => ({ signIn: vi.fn() }));
// The phone form's server action reaches next-auth, which the page render has no
// business pulling in — the question here is which affordances appear, not what
// submitting one does (that is claim-phone-authorize.test.ts's job).
vi.mock('~/lib/auth/claim-phone-actions', () => ({ claimByPhoneAction: vi.fn() }));

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(`../../app/${rel}`, import.meta.url)), 'utf8');
}

async function renderSignIn(): Promise<string> {
  vi.resetModules();
  const { default: SignInPage } = await import('~/app/sign-in/page');
  return renderToStaticMarkup(await SignInPage({ searchParams: Promise.resolve({}) }));
}

beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'test-secret';
  process.env.AUTH_SECRET = 'test-auth-secret';
  process.env.F14_RECEIPTS_IA = '';
});
afterEach(() => {
  process.env.F14_RECEIPTS_IA = '';
});

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

  it('sign-up/page.tsx is a pure redirect off the app (no second join door)', () => {
    const src = source('sign-up/page.tsx');
    // The onboarding wizard it used to forward into is gone (F14): a family born on
    // the web has no phone, and Hale cannot reach a family it cannot text.
    expect(src).not.toContain("redirect('/onboarding')");
    expect(src).toContain('MARKETING_SITE_URL');
    expect(src).not.toContain('MagicLinkRequestForm');
    expect(src).not.toContain('Continue with Google');
    expect(src).not.toContain('type="password"');
  });
});

describe('/sign-in with the F14 flag OFF — today’s page, unchanged', () => {
  it('offers Google, the magic link, and the join cross-link', async () => {
    const html = await renderSignIn();

    expect(html).toContain('Continue with Google');
    expect(html).toContain('magic-email');
    expect(html).toContain('Join the village');
    expect(html).not.toContain('claim-phone');
  });

  it('sends new parents to the marketing site, not a deleted app route', async () => {
    const html = await renderSignIn();

    expect(html).toContain(`href="${MARKETING_SITE_URL}"`);
    expect(html).not.toContain('href="/onboarding"');
    expect(html).not.toContain('href="/sign-up"');
  });
});

describe('/sign-in with the F14 flag ON — the phone is the only door', () => {
  beforeEach(() => {
    process.env.F14_RECEIPTS_IA = 'true';
  });

  it('offers the phone path', async () => {
    const html = await renderSignIn();

    expect(html).toContain('claim-phone');
    expect(html).toMatch(/type="tel"/);
  });

  it('offers NO Google button', async () => {
    const html = await renderSignIn();

    expect(html).not.toContain('Continue with Google');
    expect(html).not.toContain('auth-google');
  });

  it('offers NO email/magic-link form', async () => {
    const html = await renderSignIn();

    expect(html).not.toContain('magic-email');
    expect(html).not.toContain('magic sign-in link');
    expect(html).not.toContain('type="email"');
  });

  it('offers NO create-account affordance — there is no web way to be born', async () => {
    const html = await renderSignIn();

    expect(html).not.toContain('Join the village');
    expect(html).not.toContain('href="/onboarding"');
    expect(html).not.toContain('href="/sign-up"');
  });

  it('shows no "or" divider, because there is nothing to choose between', async () => {
    const html = await renderSignIn();

    expect(html).not.toContain('auth-or');
  });

  it('is the phone path even when Google is fully configured', async () => {
    // The flag decides the door, not the provider env: a configured Google client
    // must not reintroduce a second entrance on flip day.
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'very-configured';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'very-configured';

    const html = await renderSignIn();

    expect(html).not.toContain('Continue with Google');
    expect(html).toContain('claim-phone');
  });
});
