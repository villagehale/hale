import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { encode } from 'uqr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteFooter } from '~/components/site-footer.js';
import { type Locale, routing } from '~/i18n/routing.js';
import { SITE_URL } from '~/lib/app-url.js';
import { MUNICIPALITIES, MUNICIPALITY_COUNT } from '~/lib/site/municipalities.js';
import sitemap from '../../sitemap.js';
import ContactPage from '../contact/page.js';
import LandingPage from '../page.js';
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
  it.each(routing.locales)('renders the staff page in %s', async (locale) => {
    const text = rawText(await render(locale));
    const copy = centres(locale);
    expect(text).toContain(copy.eyebrow);
    expect(text).toContain(copy.knowLede);
    // The sentence a staff member repeats when a family asks whose service this
    // is — present, in the reader's own language, on all three.
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

describe('the exchange on this page is the landing’s, not a second one', () => {
  /** Every bubble in a rendered thread, as `<side> <text>` — read through the
   * shared landing primitives, so a page that grew its own bubble style returns
   * nothing here rather than passing. */
  function bubbles(html: string): string[] {
    return [
      ...html.matchAll(
        /<p class="v4-bubble v4-bubble-(in|out)"><span class="sr-only">[^<]*<\/span>([\s\S]*?)<\/p>/g,
      ),
    ].map((match) => `${match[1]} ${match[2]}`);
  }

  it('renders the same exchange the homepage hero does, bubble for bubble', async () => {
    // Compared against the LANDING's own render rather than against a literal:
    // the failure this exists for is a second copy of the demo on this page,
    // which only shows up the day the homepage's changes and this one's does not.
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', NUMBER);
    const landing = renderToStaticMarkup(
      await LandingPage({ params: Promise.resolve({ locale: 'en' as const }) }),
    );
    const heroStart = landing.indexOf('v4-hero-thread');
    expect(heroStart, 'the homepage hero no longer carries a thread').toBeGreaterThan(-1);
    const hero = bubbles(landing.slice(heroStart, landing.indexOf('</div>', heroStart)));

    expect(hero.length).toBeGreaterThan(0);
    const centres = await render('en');
    expect(centres).not.toContain('v5-beat');
    expect(bubbles(centres), 'this page is showing a second exchange').toEqual(hero);
  });

  it('names every speaker, and lets the parent speak first', async () => {
    const html = await render('en');
    // Direction is drawn with align-self and a fill, so a reader who cannot see
    // the alignment needs the prefix the landing gives them too.
    expect(html).toContain('<span class="sr-only">You: </span>');
    expect(html).toContain('<span class="sr-only">Hale: </span>');
    expect(html.indexOf('v4-bubble-out')).toBeLessThan(html.indexOf('v4-bubble-in'));
  });

  it('states the town count from the data, and names every town', async () => {
    const text = rawText(await render('en'));
    expect(text).toContain(`${MUNICIPALITY_COUNT} GTA municipalities`);
    const html = await render('en');
    for (const town of MUNICIPALITIES) {
      expect(html, `${town} is missing from the pills`).toContain(`>${town}</li>`);
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
    for (const present of ['stop', 'postal code', 'privacy@villagehale.com', 'pipeda']) {
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

  it('draws the QR over the chooser URL — the page that writes the first message', async () => {
    // The code is a path of module rects, so the URL never appears as text. The
    // only way to know it points at /text is to encode the URL the same way and
    // compare the grid.
    const html = await render('en');
    const { size, data } = encode(`${SITE_URL}/text`, { ecc: 'M', border: 2 });
    let path = '';
    for (const [y, row] of data.entries()) {
      for (const [x, dark] of row.entries()) {
        if (dark) path += `M${x} ${y}h1v1h-1z`;
      }
    }
    expect(html).toContain(path);
    // Positive control: a different destination produces a different grid, so
    // the match above is about this URL rather than about any QR at all.
    const other = encode(`${SITE_URL}/about`, { ecc: 'M', border: 2 });
    expect(other.size).toBe(size);
    expect(other.data).not.toEqual(data);
  });

  it('says the number is unannounced rather than rendering a dead control', async () => {
    // With no number provisioned an `sms:` link is a silent no-op on a laptop and
    // the chip copies nothing. The absence is stated in words, in both cards that
    // need a number — never a card that just quietly loses its action.
    const html = renderToStaticMarkup(
      await ForCentresPage({ params: Promise.resolve({ locale: 'en' as const }) }),
    );
    expect(html).not.toContain('href="sms:');
    expect(html).not.toContain('data-cta="copy_number_click"');
    expect(rawText(html).split(centres('en').numberPending)).toHaveLength(3);
    // Positive control: the poster card, which needs no number, still renders
    // its code — the degradation is scoped to the two cards that need one.
    expect(html).toContain('role="img"');
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
