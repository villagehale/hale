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
  vi.unstubAllGlobals();
});

describe('/checkout/success', () => {
  it('is noindex and stays out of the sitemap', async () => {
    const meta = await generateMetadata(EN);
    expect(meta.title).toBe('Checkout · Hale');
    expect(meta.robots).toEqual({ index: false, follow: false });
    expect(meta.alternates?.canonical).toBe('/checkout/success');
    for (const entry of sitemap()) {
      expect(entry.url.endsWith('/checkout/success')).toBe(false);
    }
  });

  it('renders a neutral unpaid state without a purchase claim or conversion', async () => {
    const html = renderToStaticMarkup(await CheckoutSuccessPage(EN));
    expect(html).not.toContain('You&#x27;re in.');
    expect(html).toContain('Checkout');
    expect(html).toContain('This page confirms a payment after Stripe has taken it.');
    expect(html).toContain('Open Hale');
    expect(html).toContain('v4-nav v4-glass');
    expect(html).not.toContain('GooglePurchaseConversion');
    expect(html).not.toContain('Text Hale');
  });

  it('shows You\'re in and Text Hale only after a paid session', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16462352164');
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          transactionId: 'cs_test_1',
          value: 79,
          currency: 'CAD',
          paid: true,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const html = renderToStaticMarkup(
      await CheckoutSuccessPage({
        params: Promise.resolve({ locale: 'en' as const }),
        searchParams: Promise.resolve({ session_id: 'cs_test_1' }),
      }),
    );
    expect(html).toContain('You&#x27;re in.');
    expect(html).toContain('Text Hale');
    expect(html).toContain('sms:+16462352164');
  });

  it('stays unpaid when Stripe says the session is not paid', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          transactionId: 'cs_test_unpaid',
          value: 79,
          currency: 'CAD',
          paid: false,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchImpl);
    const html = renderToStaticMarkup(
      await CheckoutSuccessPage({
        params: Promise.resolve({ locale: 'en' as const }),
        searchParams: Promise.resolve({ session_id: 'cs_test_unpaid' }),
      }),
    );
    expect(html).not.toContain('You&#x27;re in.');
    expect(html).toContain('Checkout');
    expect(html).not.toContain('Text Hale');
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
