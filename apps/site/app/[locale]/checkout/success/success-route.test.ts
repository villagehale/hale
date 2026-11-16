import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import sitemap from '../../../sitemap.js';
import CheckoutSuccessPage, { generateMetadata } from './page.js';

const EN = {
  params: Promise.resolve({ locale: 'en' as const }),
  searchParams: Promise.resolve({}),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/checkout/success', () => {
  it('is noindex and stays out of the sitemap', async () => {
    const meta = await generateMetadata(EN);
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.alternates?.canonical).toBe('/checkout/success');
    for (const entry of sitemap()) {
      expect(entry.url.endsWith('/checkout/success')).toBe(false);
    }
  });

  it('renders the shared chrome without a conversion when Stripe is not in the query', async () => {
    const html = renderToStaticMarkup(await CheckoutSuccessPage(EN));
    expect(html).toContain('You&#x27;re in.');
    expect(html).toContain('Open Hale');
    expect(html).toContain('v4-nav v4-glass');
    expect(html).not.toContain('GooglePurchaseConversion');
  });

  it('never reads value or currency from the query string', () => {
    const page = readFileSync(fileURLToPath(new URL('./page.tsx', import.meta.url)), 'utf8');
    expect(page).toContain('checkoutSessionIdFromSearch');
    expect(page).toContain('fetchCheckoutSessionFacts');
    expect(page).toContain('googlePurchaseFromPaidSession');
    expect(page).toContain('metaPurchaseFromPaidSession');
    expect(page).not.toMatch(/search\.value|searchParams\.value/);
    expect(page).not.toMatch(/search\.currency|searchParams\.currency/);
  });
});
