import { ArrowUpRight, MapPin } from 'lucide-react';
import type { Metadata } from 'next';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { allCities, publishedCities } from '~/lib/activities/index';
import { hubJsonLd } from '~/lib/activities/structured-data';

const TITLE = 'Things to do with kids, by city · Hale';
const DESCRIPTION =
  'Free and low-cost activities for babies, toddlers, and young kids in Canadian cities — library story-times, drop-in play, parent-and-tot swim, parks, and local family programs.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: '/activities' },
  // The hub enters the index only once at least one city guide is reviewed and
  // published (the review-before-index gate); until then it's a live preview.
  robots: publishedCities.length > 0 ? undefined : { index: false, follow: true },
  openGraph: {
    type: 'website',
    title: TITLE,
    description: DESCRIPTION,
    url: '/activities',
    siteName: 'Hale',
    locale: 'en_CA',
  },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
};

export default function ActivitiesHub() {
  return (
    <main id="top" className="relative">
      {publishedCities.length > 0 ? (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(hubJsonLd(publishedCities)) }}
        />
      ) : null}
      <SiteHeader />

      <section className="shell pt-10 sm:pt-16 pb-12 lg:pb-16">
        <div className="max-w-2xl rise rise-1">
          <span className="pill-eyebrow">
            <MapPin size={14} strokeWidth={2} aria-hidden="true" />
            Near you
          </span>
          <h1 className="mt-4">
            Things to do with your kids, <span className="accent">by city</span>.
          </h1>
          <p className="meta mt-6 text-lg" style={{ lineHeight: 1.6 }}>
            The free and low-cost outings families actually use — story-times, drop-in play,
            parent-and-tot swim, parks, and local programs. Pick your city to start.
          </p>
        </div>
      </section>

      <div className="band-cream">
        <section className="shell py-16 lg:py-24">
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {allCities.map((city) => (
              <li key={city.slug} className="rise rise-2">
                <a
                  href={`/activities/${city.slug}`}
                  className="panel-oat lift px-6 py-5 flex items-center justify-between gap-4"
                >
                  <span>
                    <span className="font-display text-lg text-spruce">{city.city}</span>
                    <span className="meta block text-sm">{city.province}</span>
                  </span>
                  <ArrowUpRight className="text-apricot-deep shrink-0" size={20} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <SiteFooter />
    </main>
  );
}
