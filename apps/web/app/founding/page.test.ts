import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => 'CA' }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('~/lib/channel/connect/hale-texts-href', () => ({
  haleTextsNumber: () => '+15555550100',
}));

async function renderFounding(
  search: { checkout?: string; preview?: string } = {},
): Promise<string> {
  const { default: FoundingJoinPage } = await import('./page');
  return renderToStaticMarkup(await FoundingJoinPage({ searchParams: Promise.resolve(search) }));
}

describe('/founding offer surface', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('during the window shows Free and founding annual, not monthly or list annual', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', 'true');
    const html = await renderFounding();
    expect(html).toContain('Free');
    expect(html).toContain('Join as a founding family');
    expect(html).toContain('$79/yr');
    expect(html).not.toContain('/mo');
    expect(html).not.toContain('$159/yr');
    expect(html).not.toContain('$19');
    expect(html).not.toContain('Continue ·');
    expect(html).not.toMatch(/grey|gray/i);
  });

  it('shows the same two options with a matching preview token while flags stay off', async () => {
    vi.stubEnv('PROMO_PREVIEW_TOKEN', 'secret');
    const html = await renderFounding({ preview: 'secret' });
    expect(html).toContain('Free');
    expect(html).toContain('$79/yr');
    expect(html).not.toContain('/mo');
  });

  it('after the cutoff is not found — monthly does not come back on this page', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', 'true');
    vi.stubEnv('PROMO_FOUNDING_ENDS_AT', '2020-01-01T00:00:00Z');
    await expect(renderFounding()).rejects.toThrow('NEXT_NOT_FOUND');
  });
});
