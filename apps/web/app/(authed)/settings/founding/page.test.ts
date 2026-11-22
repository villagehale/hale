import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/headers', () => ({
  headers: async () => ({ get: () => 'CA' }),
  cookies: async () => ({ toString: () => '' }),
}));
vi.mock('~/lib/family', () => ({ currentFamilyId: async () => 'fam-1' }));
vi.mock('~/lib/dashboard/queries', () => ({
  loadFamilyBasics: async () => ({ planTier: 'free' as const }),
}));

describe('checkout page after the sale', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('says the holiday sale has ended, under a plain Checkout title', async () => {
    vi.stubEnv('PROMO_FOUNDING_ENDS_AT', '2026-11-16T00:00:01-05:00');
    const { default: Page, metadata } = await import('./page');
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));

    expect(metadata.title).toBe('Checkout');
    expect(html).toContain('The holiday sale has ended');
    expect(html).toContain('You haven’t been charged.');
    expect(html).not.toMatch(/founding/i);
  });
});
