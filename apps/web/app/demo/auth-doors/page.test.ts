import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/auth/auth-actions', () => ({
  requestPasswordResetAction: vi.fn(),
  resetPasswordAction: vi.fn(() => vi.fn()),
}));
vi.mock('~/lib/auth/magic-link-actions', () => ({
  redeemMagicLinkAction: vi.fn(() => vi.fn()),
}));

import {
  MAGIC_LINK_INVALID,
  PASSWORD_RESET_INVALID,
  PASSWORD_RESET_UNAVAILABLE,
} from '~/lib/auth/door-messages';
import DemoAuthDoorsPage from './page';

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

async function body(view: string): Promise<string> {
  return renderToStaticMarkup(await DemoAuthDoorsPage({ searchParams: Promise.resolve({ view }) }));
}

describe('/demo/auth-doors', () => {
  it('lives under the demo layout that 404s on production', () => {
    const layout = source('../layout.tsx');
    expect(layout).toContain('portalDemoEnabled()');
    expect(layout).toContain('notFound()');
    const page = source('./page.tsx');
    expect(page).toContain('demoForgotAction');
    expect(page).toContain('demoResetAction');
    expect(page).toContain('demoMagicAction');
    expect(page).toContain('demoConsentAction');
    expect(page).not.toContain('requestPasswordResetAction');
    expect(page).not.toContain('redeemMagicLinkAction');
    expect(source('./stubs.ts')).not.toContain('db()');
  });

  it('shows the forgot form, its error, and the sent confirmation', async () => {
    const form = await body('forgot');
    expect(form).toContain('Reset your password');
    expect(form).toContain('Send reset link');
    expect(form).toContain('>Email<');
    expect(form).not.toContain(PASSWORD_RESET_UNAVAILABLE);

    const error = await body('forgot-error');
    expect(error).toContain(PASSWORD_RESET_UNAVAILABLE);
    expect(error).toContain('field-error');

    const sent = await body('forgot-sent');
    expect(sent).toContain('If that email has an account');
    expect(sent).not.toContain('Send reset link');
  });

  it('shows the reset form and its error without the token', async () => {
    const form = await body('reset');
    expect(form).toContain('Choose a new password');
    expect(form).toContain('Set new password');
    expect(form).toContain('minLength="10"');
    expect(form).not.toContain('preview');

    const error = await body('reset-error');
    expect(error).toContain(PASSWORD_RESET_INVALID);
    expect(error).toContain('field-error');
    expect(error).not.toContain('value="preview"');
  });

  it('shows the magic-link redeem states without the token', async () => {
    const pending = await body('magic');
    expect(pending).toContain('Signing you in');
    expect(pending).not.toContain('preview');

    const error = await body('magic-error');
    expect(error).toContain(MAGIC_LINK_INVALID);
    expect(error).toContain('field-error');
    expect(error).toContain('Request a new link');
    expect(error).not.toContain('preview');
  });

  it('shows the consent screen and the unavailable door', async () => {
    const consent = await body('oauth');
    expect(consent).toContain('Connect Assistant');
    expect(consent).toContain('Allow selected access');
    expect(consent).toContain('Before you connect');
    expect(consent).toContain('panel-oat');
    expect(consent).not.toContain('/api/oauth/authorize');

    const unavailable = await body('oauth-unavailable');
    expect(unavailable).toContain('Connection unavailable');
    expect(unavailable).toContain('Return to Hale');
    expect(unavailable).toContain('The assistant sent an invalid connection request.');
    expect(unavailable).toContain('panel-oat');
  });
});

describe('door spacing', () => {
  it('uses the sign-in lede under headings and keeps the button note as meta', () => {
    for (const file of [
      '../../forgot-password/page.tsx',
      '../../magic-link/page.tsx',
      '../../reset-password/page.tsx',
      '../../sign-in/page.tsx',
      '../../m/magic/page.tsx',
    ]) {
      expect(source(file)).toContain('stage.lede');
    }
    const mobile = source('../../m/magic/page.tsx');
    expect(mobile).toContain('className="meta"');
    expect(mobile).toContain('stage.lede');
  });

  it('spaces meta, field errors, the oauth panel, and Return to Hale', () => {
    const css = source('../../../components/portal/signin.module.css');
    expect(css).toContain('.stack > :global(.meta)');
    expect(css).toContain('margin-top: 12px;');
    expect(css).toContain('.stack :global(.field-error)');
    expect(css).toContain('.stack > .stack > :global(.field-error):first-child');
    expect(css).toContain('margin-top: 16px;');
    expect(css).toContain('.stack :global(.panel-oat)');
    expect(css).toContain('.returnHome');
    expect(css).toContain('margin-top: 24px !important;');

    const door = source('../../../components/hale/oauth-door.tsx');
    expect(door).toContain('${stage.btn} ${door.full} ${door.returnHome}');
    expect(door).toContain('Return to Hale');
    expect(door).not.toContain('btn-secondary self-start');
  });
});
