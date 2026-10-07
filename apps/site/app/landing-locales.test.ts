import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Locale, routing } from '~/i18n/routing.js';
import { getMessages } from '~/i18n/server.js';
import LandingPage from './[locale]/page.js';

afterEach(() => vi.unstubAllEnvs());

describe('landing handoff locale coverage', () => {
  it('rejects unknown route locales before formatting calendar dates', async () => {
    await expect(
      LandingPage({ params: Promise.resolve({ locale: 'favicon.ico' }) }),
    ).rejects.toMatchObject({ digest: 'NEXT_HTTP_ERROR_FALLBACK;404' });
  });
  for (const locale of routing.locales.filter((locale) => locale !== 'en')) {
    it(`${locale}: complete story, named speakers, localized calendar and entry`, async () => {
      vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
      const bundle = getMessages(locale as Locale).LandingRedo;
      expect(Object.keys(bundle).sort()).toEqual(Object.keys(getMessages('en').LandingRedo).sort());
      expect(bundle.weekdays).toHaveLength(7);
      expect(new Set(bundle.weekdays).size).toBe(7);
      expect(bundle.activities).toHaveLength(3);
      expect(bundle.watchSteps).toHaveLength(3);
      expect(bundle.beats).toHaveLength(3);
      expect(bundle.steps).toHaveLength(3);
      expect(bundle.threads).toHaveLength(2);
      const html = renderToStaticMarkup(await LandingPage({ params: Promise.resolve({ locale }) }));
      expect(html).not.toContain('LandingRedo.');
      expect(html).not.toContain('Landing.privacy');
      const expectedPath = `/${locale}/text`;
      const heroDoor = html.match(/<a[^>]*data-cta-placement="hero"[^>]*>/)?.[0] ?? '';
      expect(heroDoor).toContain(`href="${expectedPath}"`);
      for (const thread of bundle.threads) {
        expect(thread.messages).toHaveLength(3);
        expect(thread.messages.filter((m) => m.hale)).toHaveLength(1);
        for (const message of thread.messages) {
          expect(message.speaker.length).toBeGreaterThan(0);
          expect(html).toContain(message.speaker);
        }
      }
      expect(html).toContain(bundle.example);
      expect(html).toContain(bundle.activities[0]);
      expect(html).toContain(bundle.watchHeading);
      expect(html).toContain(getMessages(locale).PricingSection.futureBooking);
    });
  }
});
