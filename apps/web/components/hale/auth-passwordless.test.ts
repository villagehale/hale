import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /sign-in is the phone door. It does not read F14_RECEIPTS_IA. The flag-off
 * branch was a Google button plus a magic-link form, and that form posted to
 * an email sender that is gone.
 */

vi.mock('~/auth', () => ({ signIn: vi.fn() }));
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
  process.env.AUTH_SECRET = 'test-auth-secret';
});

describe('the sign-in form gets NO_STOP_KEYWORD_COPY_ENABLED from the server (VIL-744)', () => {
  const formProps = async (load: () => Promise<unknown>) => {
    const stage = (await load()) as { props: { children: { props: { noStopKeyword?: boolean } } } };
    return stage.props.children.props;
  };

  it.each([
    [
      '/sign-in',
      async () =>
        (await import('~/app/sign-in/page')).default({ searchParams: Promise.resolve({}) }),
    ],
    [
      '/demo/sign-in',
      async () =>
        (await import('~/app/demo/sign-in/page')).default({ searchParams: Promise.resolve({}) }),
    ],
  ])('%s passes the flag state', async (_path, page) => {
    try {
      vi.stubEnv('NO_STOP_KEYWORD_COPY_ENABLED', 'false');
      expect((await formProps(page)).noStopKeyword).toBe(false);
      vi.stubEnv('NO_STOP_KEYWORD_COPY_ENABLED', 'true');
      expect((await formProps(page)).noStopKeyword).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('the form renders the note from the flag, with no keyword sentence of its own', () => {
    const form = readFileSync(
      fileURLToPath(new URL('./claim-by-phone-form.tsx', import.meta.url)),
      'utf8',
    );
    expect(form).toContain('{claimCodeNote(noStopKeyword)}');
    expect(form).not.toContain('reply START');
  });
});

describe('/sign-in is the phone door', () => {
  it('does not render an email form or a Google button', () => {
    const src = source('sign-in/page.tsx');
    expect(src).toContain('<ClaimByPhoneForm');
    expect(src).not.toContain('MagicLinkRequestForm');
    expect(src).not.toContain('Continue with Google');
    expect(src).not.toContain("signIn('google'");
    expect(src).not.toContain('type="password"');
    expect(src).not.toContain('href="/forgot-password"');
    expect(src).not.toContain('receiptsIaEnabled');
  });

  it('sign-up/page.tsx is a pure redirect off the app (no second join door)', () => {
    const src = source('sign-up/page.tsx');
    expect(src).not.toContain("redirect('/onboarding')");
    expect(src).toContain('MARKETING_SITE_URL');
    expect(src).not.toContain('MagicLinkRequestForm');
    expect(src).not.toContain('Continue with Google');
    expect(src).not.toContain('type="password"');
  });

  it('renders the phone field', async () => {
    const html = await renderSignIn();
    expect(html).toContain('claim-phone');
    expect(html).toMatch(/type="tel"/);
    expect(html).not.toContain('Continue with Google');
    expect(html).not.toContain('auth-google');
    expect(html).not.toContain('magic-email');
    expect(html).not.toContain('type="email"');
    expect(html).not.toContain('auth-or');
    expect(html).not.toContain('Join the village');
  });
});
