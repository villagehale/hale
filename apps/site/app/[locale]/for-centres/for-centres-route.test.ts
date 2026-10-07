import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routing } from '~/i18n/routing.js';
import sitemap from '../../sitemap.js';
import ForCentresPage, { generateMetadata } from './page.js';

afterEach(() => vi.unstubAllEnvs());
describe('/for-centres — supplied staff page', () => {
  it.each(routing.locales)('renders and keeps localized metadata in %s', async (locale) => {
    const params = Promise.resolve({ locale });
    const html = renderToStaticMarkup(await ForCentresPage({ params }));
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).not.toContain('ForCentres.');
    const metadata = await generateMetadata({ params });
    expect(metadata.title).toBeTruthy();
    expect(metadata.alternates?.languages?.[locale]).toBe(
      locale === 'en' ? '/for-centres' : `/${locale}/for-centres`,
    );
  });
  it('offers an actual copy button and a tracked chooser', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    const html = renderToStaticMarkup(
      await ForCentresPage({ params: Promise.resolve({ locale: 'en' }) }),
    );
    expect(html).toContain('data-cta="copy_number_click"');
    expect(html).toContain('data-cta-placement="for_centres"');
    expect(html).toContain('data-cta="cta_message_click"');
    expect(html).toContain('href="/text"');
    expect(html).not.toContain('href="sms:');
  });
  it('states the missing number and offers email when not configured', async () => {
    const html = renderToStaticMarkup(
      await ForCentresPage({ params: Promise.resolve({ locale: 'en' }) }),
    );
    expect(html).toContain('hasn’t been announced yet.');
    expect(html).toContain('mailto:aloha@villagehale.com');
    expect(html).not.toContain('data-cta="copy_number_click"');
  });
  it('remains discoverable in the sitemap', () => {
    expect(sitemap().some((item) => item.url.endsWith('/for-centres'))).toBe(true);
  });
});
