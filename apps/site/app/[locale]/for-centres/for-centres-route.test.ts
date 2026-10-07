import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteFooter } from '~/components/site-footer.js';
import { type Locale, routing } from '~/i18n/routing.js';
import { SITE_URL } from '~/lib/app-url.js';
import { MUNICIPALITIES, MUNICIPALITY_COUNT } from '~/lib/site/municipalities.js';
import sitemap from '../../sitemap.js';
import ContactPage from '../contact/page.js';
import ForCentresPage, { generateMetadata } from './page.js';

/**
 * /for-centres — the page written to staff rather than to a parent.
 *
 * What these pin is honesty, because this page is read out loud to families by
 * people who are lending Hale their own credibility:
 *
 *  - the demo exchange is the LANDING's, word for word, so the one example of a
 *    first text cannot say two different things on two pages;
 *  - the towns and the count come from lib/site/municipalities, never prose;
 *  - nothing dark behind the F14 flag is named. A parent who is told too much
 *    can be corrected by the next text; a room of educators who repeated it
 *    cannot.
 *
 * Plus the plumbing a new page silently loses: three locales, key parity, the
 * sitemap entry, and the links in.
 */

const NUMBER = '+16475551234';

/** Only the keys these assertions name — the rest of the namespace rides along
 * untyped, so adding a fact or a way never touches this declaration. */
interface Bundle {
  ForCentres: {
    metaTitle: string;
    metaDescription: string;
    eyebrow: string;
    knowLede: string;
    officialLine: string;
    numberPending: string;
  };
  Footer: { linkForCentres: string };
}

const bundles = Object.fromEntries(
  routing.locales.map((locale) => [
    locale,
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL(`../../../messages/${locale}.json`, import.meta.url)),
        'utf8',
      ),
    ) as Bundle,
  ]),
) as Record<Locale, Bundle>;

function centres(locale: Locale): Bundle['ForCentres'] {
  return bundles[locale].ForCentres;
}

async function render(locale: Locale): Promise<string> {
  vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', NUMBER);
  return renderToStaticMarkup(await ForCentresPage({ params: Promise.resolve({ locale }) }));
}

/** Text with the tags removed and NOTHING put in their place. */
function rawText(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('/for-centres renders in every locale', () => {
  it('renders the English staff page from the approved copy', async () => {
    const text = rawText(await render('en'));
    expect(text).toContain('For the people families already');
    expect(text).toContain('Village Hale Technologies Inc.');
    expect(text).not.toContain('Georgetown');
    expect(text).toContain(
      'Hale is independent. It isn’t run by your centre, the town, the region or the province.',
    );
  });

  it.each(['fr', 'zh'] as const)('renders the staff page in %s', async (locale) => {
    const text = rawText(await render(locale));
    const copy = centres(locale);
    expect(text).toContain(copy.eyebrow);
    expect(text).toContain(copy.knowLede);
    expect(text).toContain(copy.officialLine);
  });

  it.each(routing.locales)('emits metadata and hreflang alternates in %s', async (locale) => {
    const meta = await generateMetadata({ params: Promise.resolve({ locale }) });
    expect(meta.title).toBe(centres(locale).metaTitle);
    expect(meta.description).toBe(centres(locale).metaDescription);
    const languages = meta.alternates?.languages ?? {};
    for (const other of routing.locales) {
      expect(languages[other]).toBe(other === 'en' ? '/for-centres' : `/${other}/for-centres`);
    }
  });
});

describe('the message bundles agree key for key', () => {
  /** The bundle's shape — keys, nesting and array lengths — with the leaf strings
   * replaced by their type, so a locale that dropped a fact or renamed a way is
   * a diff rather than a page that silently renders a hole. */
  function shape(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(shape);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, inner]) => [key, shape(inner)]),
      );
    }
    return typeof value;
  }

  it('gives ForCentres the same key set in en, fr and zh', () => {
    const en = shape(bundles.en.ForCentres);
    for (const locale of ['fr', 'zh'] as const) {
      expect(shape(bundles[locale].ForCentres), `${locale}.json ForCentres drifted`).toEqual(en);
    }
    // Positive control: the comparison is reading a populated namespace, not two
    // matching undefineds.
    expect(Object.keys(bundles.en.ForCentres).length).toBeGreaterThan(15);
  });

  it('carries the footer label in every locale', () => {
    for (const locale of routing.locales) {
      const label = bundles[locale].Footer.linkForCentres;
      expect(label, `${locale}.json has no Footer.linkForCentres`).toBeTypeOf('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('the exchange on this page is the approved example', () => {
  it('shows the approved example, and the parent speaks first', async () => {
    const html = await render('en');
    expect(html).toContain('Example first text and reply.');
    expect(html.indexOf('hs-msg out')).toBeLessThan(html.indexOf('hs-msg in'));
    expect(html).toContain('Hi! Mia is 4.');
    expect(html).not.toContain('v4-bubble');
  });

  it('does not list towns or a GTA count', async () => {
    const text = rawText(await render('en'));
    expect(text).not.toContain('GTA');
    expect(text).not.toContain(`${MUNICIPALITY_COUNT} `);
    const html = await render('en');
    for (const town of MUNICIPALITIES) {
      expect(html).not.toContain(`>${town}</li>`);
    }
  });
});

describe('the page promises nothing that is not live', () => {
  /**
   * The connectors are merged but dark behind the F14 flag, and there is no cold
   * invitation to a co-parent. This page is the one surface whose over-claim
   * cannot be walked back in the next text.
   */
  const FORBIDDEN = ['gmail', 'google', 'calendar', 'agenda', 'co-parent', 'inbox'];

  it.each(routing.locales)('names no dark feature in %s', async (locale) => {
    const text = rawText(await render(locale)).toLowerCase();
    for (const word of FORBIDDEN) {
      expect(text, `the page promises "${word}"`).not.toContain(word);
    }
  });

  it('really would catch one — the same scan finds the words the page DOES say', async () => {
    // Every assertion above is satisfied by an empty page, so prove the scan is
    // reading real copy through the identical path.
    const text = rawText(await render('en')).toLowerCase();
    for (const present of ['stop', 'privacy@villagehale.com', 'village hale technologies']) {
      expect(text).toContain(present);
    }
  });
});

describe('the three ways out are wired, and degrade honestly', () => {
  it('offers the copy chip and the composer, each named for the funnel', async () => {
    const html = await render('en');
    expect(html).toContain(`href="sms:${NUMBER}`);
    expect(html).toMatch(/data-cta="cta_text_click"[^>]*data-cta-placement="for_centres"/);
    expect(html).toMatch(/data-cta="copy_number_click"[^>]*data-cta-placement="for_centres"/);
  });

  it('asks for a poster by email — the redesign has no QR of /text', async () => {
    const html = await render('en');
    expect(html).toContain('mailto:aloha@villagehale.com');
    expect(html).toContain('Want a poster for your');
    expect(html).not.toContain('role="img"');
  });

  it('says the number is unannounced rather than rendering a dead control', async () => {
    const html = renderToStaticMarkup(
      await ForCentresPage({ params: Promise.resolve({ locale: 'en' as const }) }),
    );
    expect(html).not.toContain('href="sms:');
    expect(html).not.toContain('data-cta="copy_number_click"');
    expect(html).toContain('mailto:aloha@villagehale.com');
    expect(html).toContain('>Copy number</span>');
  });
});

describe('the page is reachable', () => {
  it('rides in the sitemap', () => {
    expect(sitemap().map((entry) => entry.url)).toContain(`${SITE_URL}/for-centres`);
  });

  it('is linked from the footer, locale-aware, on every page', () => {
    const en = renderToStaticMarkup(createElement(SiteFooter, { locale: 'en' as const }));
    expect(en).toContain('href="/for-centres"');
    const fr = renderToStaticMarkup(createElement(SiteFooter, { locale: 'fr' as const }));
    expect(fr).toContain('href="/fr/for-centres"');
    expect(fr).not.toContain('href="/for-centres"');
  });

  it('is linked from /contact, where a centre looking for us lands', async () => {
    const html = renderToStaticMarkup(
      await ContactPage({ params: Promise.resolve({ locale: 'en' as const }) }),
    );
    expect(html).toContain('href="/for-centres"');
  });
});
