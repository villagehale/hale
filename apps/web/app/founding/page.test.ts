import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROMO_PREVIEW_COOKIE, signPromoPreviewCookie } from '~/lib/billing/promo-preview';
import { PORTAL_TITLE, resolveDocumentTitle } from '~/lib/portal/document-title';

const { cookieJar, sessionBox } = vi.hoisted(() => ({
  cookieJar: { value: undefined as string | undefined },
  sessionBox: { userId: null as string | null },
}));

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => 'CA' }),
  cookies: async () => ({
    get: (name: string) =>
      name === PROMO_PREVIEW_COOKIE && cookieJar.value ? { value: cookieJar.value } : undefined,
    set: (name: string, value: string) => {
      if (name === PROMO_PREVIEW_COOKIE) cookieJar.value = value;
    },
  }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));
vi.mock('~/auth', () => ({
  auth: async () => (sessionBox.userId ? { user: { id: sessionBox.userId } } : null),
}));
vi.mock('~/lib/channel/connect/hale-texts-href', () => ({
  haleTextsNumber: () => '+15555550100',
}));

async function renderFounding(
  search: Record<string, string | string[] | undefined> = {},
): Promise<string> {
  const { default: FoundingJoinPage } = await import('./page');
  return renderToStaticMarkup(await FoundingJoinPage({ searchParams: Promise.resolve(search) }));
}

describe('/founding offer surface', () => {
  afterEach(() => {
    cookieJar.value = undefined;
    sessionBox.userId = null;
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('during the window shows Free, Plus annual, and Max annual, not monthly or list annual', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', 'true');
    const html = await renderFounding();
    expect(html).toContain('Free');
    expect(html).toContain('Join Hale');
    expect(html).not.toMatch(/founding famil/i);
    expect(html).toContain('$59/yr');
    expect(html).toContain('$99/yr');
    expect(html).not.toContain('/mo');
    expect(html).not.toContain('$159/yr');
    expect(html).not.toContain('$19');
    expect(html).not.toContain('Continue ·');
    expect(html).not.toMatch(/grey|gray/i);
    expect(html).not.toMatch(/\bCAD\b/);
  });

  it('titles the tab Join Hale, with no second Hale from the layout suffix', async () => {
    const { metadata } = await import('./page');
    expect(resolveDocumentTitle(metadata.title, PORTAL_TITLE.template, PORTAL_TITLE.default)).toBe(
      'Join Hale',
    );
  });

  it('shows the same three options with a matching preview token while flags stay off', async () => {
    vi.stubEnv('PROMO_PREVIEW_TOKEN', 'secret');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    const html = await renderFounding({ preview: 'secret' });
    expect(html).toContain('Free');
    expect(html).toContain('$59/yr');
    expect(html).toContain('$99/yr');
    expect(html).not.toContain('/mo');
    expect(cookieJar.value).toBeTruthy();
  });

  it('keeps the page open after Stripe cancel via the preview cookie, without ?preview=', async () => {
    vi.stubEnv('PROMO_PREVIEW_TOKEN', 'secret');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    cookieJar.value =
      signPromoPreviewCookie({
        AUTH_SECRET: 'test-secret',
        PROMO_PREVIEW_TOKEN: 'secret',
      }) ?? undefined;
    const html = await renderFounding({ checkout: 'cancelled' });
    expect(html).toContain('$59/yr');
    expect(html).toContain('cancelled');
  });

  it('keeps a signed-out visitor on the join form when auth is configured', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', 'true');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    const html = await renderFounding({ plan: 'max' });
    expect(html).toContain('Join Hale');
    expect(html).toContain('$59/yr');
    expect(html).toContain('$99/yr');
  });

  it('sends a signed-in family to the signed-in checkout, keeping attribution', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', 'true');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    sessionBox.userId = 'user-1';
    await expect(
      renderFounding({
        checkout: 'cancelled',
        utm_source: 'meta',
        fbclid: 'abc',
        preview: 'not-the-token',
      }),
    ).rejects.toThrow(
      'NEXT_REDIRECT:/settings/founding?checkout=cancelled&utm_source=meta&fbclid=abc',
    );
  });

  it('keeps a signed-in parent on the join form when the preview cookie is still valid', async () => {
    vi.stubEnv('PROMO_PREVIEW_TOKEN', 'secret');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    sessionBox.userId = 'user-1';
    cookieJar.value =
      signPromoPreviewCookie({
        AUTH_SECRET: 'test-secret',
        PROMO_PREVIEW_TOKEN: 'secret',
      }) ?? undefined;
    const html = await renderFounding({ checkout: 'cancelled' });
    expect(html).toContain('cancelled');
    expect(html).toContain('$99/yr');
  });

  it('leaves a signed-in preview unlock on the new-visitor join', async () => {
    vi.stubEnv('PROMO_PREVIEW_TOKEN', 'secret');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    sessionBox.userId = 'user-1';
    const html = await renderFounding({ preview: 'secret' });
    expect(html).toContain('$59/yr');
    expect(html).toContain('$99/yr');
  });

  it('sends a signed-out visitor to sign-in when the sale is on and new-visitor checkout is off', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', '');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    try {
      await renderFounding({ utm_source: 'meta' });
      expect.fail('expected a sign-in redirect');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message.startsWith('NEXT_REDIRECT:')).toBe(true);
      const target = new URL(message.slice('NEXT_REDIRECT:'.length), 'https://app.example.com');
      expect(target.pathname).toBe('/sign-in');
      expect(target.searchParams.get('callbackUrl')).toBe('/settings/founding?utm_source=meta');
    }
  });

  it('is not found when both promo flags are off', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', '');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', '');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    await expect(renderFounding()).rejects.toThrow('NEXT_NOT_FOUND');
  });

  it('after the cutoff is not found — monthly does not come back on this page', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', 'true');
    vi.stubEnv('PROMO_FOUNDING_ENDS_AT', '2020-01-01T00:00:00Z');
    await expect(renderFounding()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
