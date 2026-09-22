import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SiteFooter } from '~/components/site-footer.js';
import { SiteHeader } from '~/components/site-header.js';
import { localeHref } from '~/i18n/navigation.js';
import type { Locale } from '~/i18n/routing.js';
import sitemap from '../../sitemap.js';
import TextPage, { generateMetadata } from './page.js';

const meta = () => generateMetadata({ params: Promise.resolve({ locale: 'en' as const }) });

/**
 * /text is the chooser (F14): the QR cards' destination AND the header pill's —
 * but still a handoff, not a page to rank. No sitemap row, noindex, and no
 * footer link; while the number is dark nothing points at it at all. These are
 * the structural guards; the page's own behaviour lives in
 * components/text-entry.test.ts.
 */

describe('/text (unlisted entry surface)', () => {
  it('is noindex, nofollow', async () => {
    expect((await meta()).robots).toEqual({ index: false, follow: false });
  });

  it('claims its own canonical rather than inheriting the homepage’s', async () => {
    expect((await meta()).alternates?.canonical).toBe('/text');
  });

  it('is absent from the sitemap', () => {
    for (const entry of sitemap()) {
      expect(entry.url.endsWith('/text')).toBe(false);
    }
  });

  it('is the header pill’s destination — and stays out of the footer', () => {
    // F14 chooser: the chrome's one primary CTA opens this page (it is the
    // universal target that works on every device). The pill only exists while
    // the number is live; dark, the chrome degrades to email and nothing may
    // point here. The footer never links it — it is a handoff, not navigation.
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    const header = renderToStaticMarkup(createElement(SiteHeader));
    expect(header).toContain('href="/text"');
    vi.unstubAllEnvs();
    const darkHeader = renderToStaticMarkup(createElement(SiteHeader));
    expect(darkHeader).not.toContain('/text');
    expect(renderToStaticMarkup(createElement(SiteFooter))).not.toContain('/text');
  });

  it('wears the shared header and footer in en, fr, and zh — turtle lockup included', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', '+16475551234');
    for (const locale of ['en', 'fr', 'zh'] as const satisfies readonly Locale[]) {
      const html = renderToStaticMarkup(
        await TextPage({
          params: Promise.resolve({ locale }),
          searchParams: Promise.resolve({}),
        }),
      );
      const header = chrome(html, 'header');
      const footer = chrome(html, 'footer');
      expect(header, `${locale} forked the header`).toBe(
        chrome(renderToStaticMarkup(createElement(SiteHeader, { locale })), 'header'),
      );
      expect(footer, `${locale} forked the footer`).toBe(
        chrome(
          renderToStaticMarkup(createElement(SiteFooter, { locale, omitPrivacyLink: true })),
          'footer',
        ),
      );
      // One privacy-policy link on the rendered page, and it is the column's
      // Canada line — not a second copy in the footer.
      const privacyHref = localeHref(locale, '/privacy');
      const privacyAt = html.indexOf(`href="${privacyHref}"`);
      expect(privacyAt, `${locale} missing the column privacy link`).toBeGreaterThan(-1);
      expect(html.indexOf(`href="${privacyHref}"`, privacyAt + 1)).toBe(-1);
      expect(privacyAt).toBeLessThan(html.indexOf('<footer'));
      expect(footer).not.toContain(`href="${privacyHref}"`);
      // The shared bar is the glass pill, and the lockup is the turtle tile
      // beside the drawn wordmark — the same assets the landing header uses.
      expect(header).toContain('class="v4-nav v4-glass"');
      expect(header).toContain('hale-logo');
      expect(header).toContain('viewBox="0 0 905.840370 590.701960"');
      // The column under the bar is still the conversion door. Copy is the
      // warm hello (#687); this pin only checks that chrome did not replace it.
      // The sent bubble is the English prefill in every locale.
      expect(html).toContain('Hey Hale, what&#x27;s going on?');
    }
    const en = renderToStaticMarkup(
      await TextPage({
        params: Promise.resolve({ locale: 'en' }),
        searchParams: Promise.resolve({}),
      }),
    );
    const fr = renderToStaticMarkup(
      await TextPage({
        params: Promise.resolve({ locale: 'fr' }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(en).toContain('Hi, I&#x27;m Hale.');
    expect(fr).toContain('Bonjour, je suis Hale.');
    vi.unstubAllEnvs();
  });
});

function chrome(html: string, tag: 'header' | 'footer'): string {
  const found = new RegExp(`<${tag}[\\s\\S]*</${tag}>`).exec(html)?.[0];
  if (!found) throw new Error(`no <${tag}> rendered`);
  return found;
}
