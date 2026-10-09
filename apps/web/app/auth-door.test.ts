import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

/**
 * The email doors share the sign-in shore. Headings, buttons, and messages stay
 * the ones each page already had. The retired side panel does not. Actions are
 * stubbed so a render never spends a token or opens a database.
 */

vi.mock('~/lib/auth/auth-actions', () => ({
  requestPasswordResetAction: vi.fn(),
  resetPasswordAction: vi.fn(() => vi.fn()),
  confirmEmailAction: vi.fn(),
}));
vi.mock('~/lib/auth/magic-link-actions', () => ({
  redeemMagicLinkAction: vi.fn(() => vi.fn()),
}));

import ForgotPasswordPage from './forgot-password/page';
import MobileMagicPage from './m/magic/page';
import MagicLinkPage from './magic-link/page';
import ResetPasswordPage from './reset-password/page';
import VerifyPage from './verify/page';

const PANEL = 'every parent needs';

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

describe('auth doors use the sign-in shore', () => {
  it('/forgot-password keeps its form and drops the side panel', () => {
    process.env.AUTH_SECRET = 'test-secret';
    const body = renderToStaticMarkup(ForgotPasswordPage());

    expect(body).toContain('Reset your password');
    expect(body).toContain('Send reset link');
    expect(body).toContain('>Email<');
    expect(body).toContain('Remembered it? Back to sign in');
    expect(body).toContain('/connect/hale-shore-hero.webp');
    expect(body).toContain('Never sold.');
    expect(body).not.toContain(PANEL);
    expect(source('../components/hale/forgot-password-form.tsx')).toContain(
      'requestPasswordResetAction',
    );
  });

  it('/magic-link keeps its missing-link message', async () => {
    process.env.AUTH_SECRET = 'test-secret';
    const body = renderToStaticMarkup(await MagicLinkPage({ searchParams: Promise.resolve({}) }));

    expect(body).toContain('Sign in to Hale');
    expect(body).toContain('This sign-in link is missing or incomplete.');
    expect(body).toContain('Request a new link');
    expect(body).toContain('href="/sign-in"');
    expect(body).toContain('/connect/hale-shore-hero.webp');
    expect(body).not.toContain(PANEL);
  });

  it('/magic-link still passes callbackUrl through and does not render the token', async () => {
    process.env.AUTH_SECRET = 'test-secret';
    const page = source('./magic-link/page.tsx');
    expect(page).toContain('safeInternalRedirect(callbackUrl)');
    expect(page).toContain('redirectTo={redirectTo}');

    const body = renderToStaticMarkup(
      await MagicLinkPage({
        searchParams: Promise.resolve({
          token: 'preview-token',
          callbackUrl: '/oauth/authorize?client_id=hale',
        }),
      }),
    );

    expect(body).toContain('Signing you in');
    expect(body).not.toContain('preview-token');
    expect(body).not.toContain(PANEL);
  });

  it('/m/magic keeps the app hand-off', async () => {
    const body = renderToStaticMarkup(
      await MobileMagicPage({ searchParams: Promise.resolve({ token: 'preview-token' }) }),
    );

    expect(body).toContain('Open Hale');
    expect(body).toContain('Open the Hale app');
    expect(body).toContain('href="hale://magic-link?token=preview-token"');
    expect(body).toContain('Continue on this device');
    expect(body).toContain('/connect/hale-shore-hero.webp');
    expect(body).not.toContain(PANEL);
  });

  it('/reset-password keeps its form', async () => {
    process.env.AUTH_SECRET = 'test-secret';
    const page = source('./reset-password/page.tsx');
    expect(page).toContain('ResetPasswordForm token={token}');

    const body = renderToStaticMarkup(
      await ResetPasswordPage({ searchParams: Promise.resolve({ token: 'preview-token' }) }),
    );

    expect(body).toContain('Choose a new password');
    expect(body).toContain('New password');
    expect(body).toContain('Set new password');
    expect(body).toContain('Need a new link? Start over');
    expect(body).toContain('minLength="10"');
    expect(body).not.toContain('preview-token');
    expect(body).toContain('/connect/hale-shore-hero.webp');
    expect(body).not.toContain(PANEL);
  });

  it('/verify has no side panel', async () => {
    const body = renderToStaticMarkup(await VerifyPage({ searchParams: Promise.resolve({}) }));

    expect(body).toContain('This confirmation link is missing or incomplete.');
    expect(body).not.toContain(PANEL);
    expect(body).not.toContain('calm AI co-pilot');
    expect(body).not.toContain('/connect/hale-shore-hero.webp');
  });
});
