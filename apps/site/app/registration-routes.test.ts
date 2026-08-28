import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REGISTRATION_GUIDES } from '~/lib/registration/index.js';
import { chromeCta } from '~/lib/site/chrome-cta.js';
import { buildSmsHrefForBody } from '~/lib/text-entry.js';
import ActivitiesHub from './[locale]/activities/page.js';
import BramptonPage, {
  generateMetadata as bramptonMeta,
} from './[locale]/brampton-swim-registration/page.js';
import TorontoFallPage, {
  generateMetadata as torontoFallMeta,
} from './[locale]/toronto-fall-recreation-registration/page.js';
import TorontoSwimPage, {
  generateMetadata as torontoSwimMeta,
} from './[locale]/toronto-swim-registration/page.js';
import YmcaPage, {
  generateMetadata as ymcaMeta,
} from './[locale]/ymca-gta-swim-registration/page.js';

const EN = () => ({ params: Promise.resolve({ locale: 'en' as const }) });
const LIVE_NUMBER = '+16475551234';

const PAGES = [
  {
    slug: 'toronto-fall-recreation-registration',
    Page: TorontoFallPage,
    meta: torontoFallMeta,
  },
  {
    slug: 'toronto-swim-registration',
    Page: TorontoSwimPage,
    meta: torontoSwimMeta,
  },
  {
    slug: 'brampton-swim-registration',
    Page: BramptonPage,
    meta: bramptonMeta,
  },
  {
    slug: 'ymca-gta-swim-registration',
    Page: YmcaPage,
    meta: ymcaMeta,
  },
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function render(
  Page: (typeof PAGES)[number]['Page'],
  locale: 'en' | 'fr' | 'zh' = 'en',
): Promise<string> {
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ locale }) }));
}

describe('city registration routes — landing chrome, not a blog', () => {
  it('renders all four English routes with About’s chrome and devices', async () => {
    for (const { slug, Page } of PAGES) {
      const html = await render(Page);
      const guide = REGISTRATION_GUIDES.find((g) => g.slug === slug);
      if (!guide) throw new Error(slug);

      expect(html).toContain('id="main"');
      expect(html).toContain('v4-nav v4-glass');
      expect(html).toContain('cta-band');
      expect(html).toContain('btn-on-navy');
      expect(html).toContain('band-cream grain');
      expect(html).toContain('glass-panel numbered-card');
      expect(html).toContain('pull-word');
      expect(html).toContain('v4-display');
      expect(html).toContain('disclosure');
      expect(html).toContain(
        guide.h1
          .map((s) => s.text)
          .join(' ')
          .split(' ')[0] ?? '',
      );
      expect(html).toContain('application/ld+json');
      expect(html).toContain('"@type":"FAQPage"');
      expect(html).toContain('"@type":"Article"');
    }
  });

  it('puts the dates table and an official URL in the cream band', async () => {
    for (const { slug, Page } of PAGES) {
      const html = await render(Page);
      const guide = REGISTRATION_GUIDES.find((g) => g.slug === slug);
      if (!guide) throw new Error(slug);
      expect(html).toContain('<table');
      expect(html).toContain('tabular');
      expect(html).toContain(guide.officialUrls[0]?.href);
      expect(html).toContain(guide.dateRows[0]?.when);
    }
  });

  it('closes on chromeCta — the site’s text-Hale path — never CopyNumber or TextEntry', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', LIVE_NUMBER);
    const expected = chromeCta().href;
    for (const { Page } of PAGES) {
      const html = await render(Page);
      expect(html).toContain(expected.replaceAll('&', '&amp;'));
      expect(html).not.toContain('CopyNumber');
      expect(html).not.toContain('text-entry');
      expect(html).not.toContain('Copy Hale');
    }
  });

  it('prefills Brampton Text Hale with Maya/Theo/L6Y — not hi, not a swim question', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', LIVE_NUMBER);
    const html = await render(BramptonPage);
    const locked = buildSmsHrefForBody(LIVE_NUMBER, 'Maya is 4, Theo is 18 months, L6Y');
    expect(html).toContain(locked.replaceAll('&', '&amp;'));
    // Header chrome still uses the global L3R prefill; the city page body must not.
    const body = html.replace(/<header[\s\S]*?<\/header>/, '').replace(/<footer[\s\S]*?<\/footer>/, '');
    expect(body).not.toContain('L3R');
    expect(html).not.toMatch(/body=When%20does%20swim/);
  });

  it('does not print Hale’s number as readable text on the page body', async () => {
    vi.stubEnv('NEXT_PUBLIC_HALE_SMS_NUMBER', LIVE_NUMBER);
    for (const { Page } of PAGES) {
      const html = await render(Page);
      const body = html
        .replace(/<header[\s\S]*?<\/header>/, '')
        .replace(/<footer[\s\S]*?<\/footer>/, '');
      expect(body).not.toContain('(647)');
      expect(body).not.toContain('647-555');
      expect(body).not.toContain('+1 (647)');
    }
  });

  it('never inbound-links /answers from the page body, and never ships the held-back city URLs', async () => {
    for (const { Page } of PAGES) {
      const html = await render(Page);
      const body = html.replace(/<footer[\s\S]*?<\/footer>/, '');
      expect(body).not.toContain('href="/answers');
      expect(html).not.toContain('/york-region-swim-registration');
      expect(html).not.toContain('/vaughan-recreation-registration');
      expect(html).not.toContain('/vaughan-swim-registration');
      expect(html).not.toContain('/mississauga-swim-registration');
    }
  });

  it('cross-links Toronto fall-rec and Toronto swim once each', async () => {
    const fall = await render(TorontoFallPage);
    const swim = await render(TorontoSwimPage);
    expect(fall).toContain('href="/toronto-swim-registration"');
    expect(swim).toContain('href="/toronto-fall-recreation-registration"');
    expect([...fall.matchAll(/href="\/toronto-swim-registration"/g)]).toHaveLength(1);
    expect([...swim.matchAll(/href="\/toronto-fall-recreation-registration"/g)]).toHaveLength(1);
  });

  it('emits a canonical without claiming FR/ZH translations that do not exist', async () => {
    for (const { slug, meta } of PAGES) {
      const metadata = await meta(EN());
      expect(metadata.alternates?.canonical).toBe(`/${slug}`);
      expect(metadata.alternates?.languages).toBeUndefined();
      expect(metadata.title).toBeTruthy();
      expect(metadata.description).toBeTruthy();
    }
  });

  it('points at the new Toronto and Brampton URLs from /activities', async () => {
    const html = renderToStaticMarkup(
      await ActivitiesHub({ params: Promise.resolve({ locale: 'en' as const }) }),
    );
    expect(html).toContain('href="/toronto-fall-recreation-registration"');
    expect(html).toContain('href="/toronto-swim-registration"');
    expect(html).toContain('href="/brampton-swim-registration"');
  });
});
