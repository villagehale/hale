import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Locale } from '~/i18n/routing';
import PricingPage from './page';

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-vercel-ip-country': 'CA' }),
  cookies: async () => ({ get: () => undefined }),
}));

const LINE: Record<Locale, string> = {
  en: 'No charge was made.',
  fr: 'Aucun montant n’a été débité.',
  zh: '你没有被扣款。',
};

async function render(locale: Locale, search: Record<string, string | string[]>) {
  const element = await PricingPage({
    params: Promise.resolve({ locale }),
    searchParams: Promise.resolve(search),
  });
  return renderToStaticMarkup(element);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('state H: a cancelled checkout back on the pricing page', () => {
  it.each(['en', 'fr', 'zh'] as const)(
    '%s shows the one quiet line above the plans, with the flag on',
    async (locale) => {
      vi.stubEnv('CHECKOUT_SUCCESS_STATES_ENABLED', 'true');
      const html = await render(locale, { checkout: 'cancelled' });
      expect(html).toContain(`<p class="hs-meta">${LINE[locale]}</p>`);
      expect(html.indexOf(LINE[locale])).toBeLessThan(html.indexOf('hs-tiers'));
    },
  );

  it.each([undefined, 'TRUE', 'true\n'])('shows nothing with the flag at %j', async (value) => {
    vi.stubEnv('CHECKOUT_SUCCESS_STATES_ENABLED', value as string);
    const html = await render('en', { checkout: 'cancelled' });
    expect(html).toContain('hs-tiers');
    expect(html).not.toContain(LINE.en);
  });

  it.each<Record<string, string | string[]>>([
    {},
    { checkout: 'success' },
    { checkout: ['cancelled', 'cancelled'] },
  ])(
    'shows nothing for %j, with the flag on',
    async (search) => {
      vi.stubEnv('CHECKOUT_SUCCESS_STATES_ENABLED', 'true');
      const html = await render('en', search);
      expect(html).toContain('hs-tiers');
      expect(html).not.toContain(LINE.en);
    },
  );
});
