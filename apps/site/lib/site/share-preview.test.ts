import { describe, expect, it } from 'vitest';
import { SITE_URL } from '~/lib/app-url';
import { homeMetadata } from '~/lib/site/home-meta';
import { notFoundMetadata } from '~/lib/site/not-found-copy';
import { SHARE_CARDS, shareCardUrl } from '~/lib/site/share-cards';

/**
 * These imports are declared below via relative paths in the test file itself.
 * The assertions live with the pages so a missing image or a leftover "Free"
 * fails here, not in a crawler.
 */

import { generateMetadata as aboutPageMetadata } from '../../app/[locale]/about/page';
import { generateMetadata as activitiesMetadata } from '../../app/[locale]/activities/page';
import { generateMetadata as answerMetadata } from '../../app/[locale]/answers/[slug]/page';
import { generateMetadata as answersMetadata } from '../../app/[locale]/answers/page';
import { generateMetadata as contactMetadata } from '../../app/[locale]/contact/page';
import { generateMetadata as faqMetadata } from '../../app/[locale]/faq/page';
import { generateMetadata as pricingMetadata } from '../../app/[locale]/pricing/page';
import { generateMetadata as privacyMetadata } from '../../app/[locale]/privacy/page';
import { generateMetadata as termsMetadata } from '../../app/[locale]/terms/page';
import { generateMetadata as textMetadata } from '../../app/[locale]/text/page';

const en = { locale: 'en' as const };

function imageUrl(meta: {
  openGraph?: { images?: unknown };
  twitter?: { images?: unknown };
}): string {
  const images = meta.openGraph?.images;
  const first = Array.isArray(images) ? images[0] : images;
  if (first && typeof first === 'object' && first && 'url' in first) return String(first.url);
  return String(first ?? '');
}

function twitterCard(meta: { twitter?: { card?: string } }): string | undefined {
  return meta.twitter?.card;
}

const BANNED = /\bfree\b|planner for your kids|helper that plans|Find what’s on|sign-up morning/i;

describe('share previews', () => {
  it('gives every listed page a large card, an absolute image, and a canonical og:url', async () => {
    const pages: Array<{
      name: string;
      url: string;
      image: string;
      meta: {
        openGraph?: { url?: string; description?: string; title?: string; images?: unknown };
        twitter?: { card?: string; description?: string; images?: unknown };
        description?: string;
      };
    }> = [
      { name: 'home', url: `${SITE_URL}/`, image: shareCardUrl('home'), meta: homeMetadata('en') },
      {
        name: 'pricing',
        url: `${SITE_URL}/pricing`,
        image: shareCardUrl('pricing'),
        meta: await pricingMetadata({ params: Promise.resolve(en) }),
      },
      {
        name: 'faq',
        url: `${SITE_URL}/faq`,
        image: shareCardUrl('faq'),
        meta: await faqMetadata({ params: Promise.resolve(en) }),
      },
      {
        name: 'about',
        url: `${SITE_URL}/about`,
        image: shareCardUrl('about'),
        meta: await aboutPageMetadata({ params: Promise.resolve(en) }),
      },
      {
        name: 'activities',
        url: `${SITE_URL}/activities`,
        image: shareCardUrl('activities'),
        meta: await activitiesMetadata({ params: Promise.resolve(en) }),
      },
      {
        name: 'answers',
        url: `${SITE_URL}/answers`,
        image: shareCardUrl('answers'),
        meta: await answersMetadata({ params: Promise.resolve(en) }),
      },
      {
        name: 'contact',
        url: `${SITE_URL}/contact`,
        image: shareCardUrl('contact'),
        meta: await contactMetadata({ params: Promise.resolve(en) }),
      },
      {
        name: 'privacy',
        url: `${SITE_URL}/privacy`,
        image: shareCardUrl('privacy'),
        meta: await privacyMetadata({ params: Promise.resolve(en) }),
      },
      {
        name: 'terms',
        url: `${SITE_URL}/terms`,
        image: shareCardUrl('terms'),
        meta: await termsMetadata({ params: Promise.resolve(en) }),
      },
      {
        name: 'text',
        url: `${SITE_URL}/text`,
        image: shareCardUrl('text'),
        meta: await textMetadata({ params: Promise.resolve(en) }),
      },
      {
        name: '404',
        url: SITE_URL,
        image: shareCardUrl('not-found'),
        meta: notFoundMetadata('en'),
      },
    ];

    for (const page of pages) {
      expect(twitterCard(page.meta), page.name).toBe('summary_large_image');
      expect(imageUrl(page.meta), page.name).toBe(page.image);
      expect(imageUrl(page.meta), page.name).toMatch(/^https:\/\//);
      expect(page.meta.openGraph?.url, page.name).toBe(page.url);
      expect(String(page.meta.openGraph?.url)).toMatch(/^https:\/\//);
    }
  });

  it('uses the approved home, pricing, faq, and about preview copy', async () => {
    const home = homeMetadata('en');
    expect(home.openGraph?.description).toBe(
      SHARE_CARDS.home &&
        'Hale is an AI agent you text that knows your family. It finds what fits, signs them up with your ok, and runs the group chat.',
    );
    expect(home.twitter && 'description' in home.twitter ? home.twitter.description : '').toBe(
      home.openGraph?.description,
    );
    expect(SHARE_CARDS.home.alt).toBe('Hale, an AI agent you text for your kids’ year');
    expect(SHARE_CARDS.home.headline).toBe('Your kids’ year, handled.');
    expect(SHARE_CARDS.pricing.eyebrow).toBe('BIGGEST SALE OF THE YEAR');
    expect(SHARE_CARDS.pricing.subline).toBe(
      'Lowest price of the year, locked in. Join by Dec 31.',
    );

    const pricing = await pricingMetadata({ params: Promise.resolve(en) });
    expect(pricing.title).toBe('Pricing · Hale');
    expect(pricing.openGraph?.description).toBe(
      'An AI agent you text that knows your family and takes the kids’ year off your plate. Biggest sale of the year, join by Dec 31.',
    );

    const faq = await faqMetadata({ params: Promise.resolve(en) });
    expect(faq.title).toBe('Questions about Hale · Hale');
    expect(faq.openGraph?.description).toBe(
      'What Hale does, what it reads, how it keeps your family’s data private, and why it never signs up or pays without your ok.',
    );

    const about = await aboutPageMetadata({ params: Promise.resolve(en) });
    expect(about.openGraph?.description).toContain('Barton Dong');
    expect(about.openGraph?.description).toContain('takes the kids’ year off your plate');
  });

  it('does not sell Hale as free, a planner, or a helper in the new preview copy', async () => {
    const blobs = [
      JSON.stringify(homeMetadata('en').openGraph),
      JSON.stringify(homeMetadata('en').twitter),
      JSON.stringify((await pricingMetadata({ params: Promise.resolve(en) })).openGraph),
      JSON.stringify((await faqMetadata({ params: Promise.resolve(en) })).openGraph),
      JSON.stringify((await aboutPageMetadata({ params: Promise.resolve(en) })).openGraph),
      JSON.stringify(SHARE_CARDS),
    ];
    for (const blob of blobs) expect(blob).not.toMatch(BANNED);
  });

  it('points an article card at an absolute image and keeps the article description', async () => {
    const meta = await answerMetadata({
      params: Promise.resolve({ locale: 'en' as const, slug: 'newborn-cluster-feeding' }),
    });
    expect(meta.openGraph && 'url' in meta.openGraph ? meta.openGraph.url : '').toBe(
      `${SITE_URL}/answers/newborn-cluster-feeding`,
    );
    expect(imageUrl(meta)).toBe(`${SITE_URL}/og/answers/newborn-cluster-feeding`);
    expect(twitterCard(meta)).toBe('summary_large_image');
    expect(String(meta.description)).toContain('cluster feeding');
  });
});
