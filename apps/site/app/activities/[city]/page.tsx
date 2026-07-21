import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CtaBand } from '~/components/cta-band';
import { LandingCta } from '~/components/landing-cta';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { allCities, getCity, universalIdeas } from '~/lib/activities/index';
import { cityJsonLd } from '~/lib/activities/structured-data';
import { APP_URL } from '~/lib/app-url';

interface PageProps {
  params: Promise<{ city: string }>;
}

export function generateStaticParams(): { city: string }[] {
  return allCities.map((c) => ({ city: c.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { city: slug } = await params;
  const city = getCity(slug);
  if (!city) return {};

  const title = `Things to do with kids in ${city.city} · Hale`;
  const description = `Free and low-cost activities for babies and toddlers in ${city.city}: library story-times, drop-in play, parent-and-tot swim, parks, and ${city.provinceCode} family programs.`;
  const canonical = `/activities/${city.slug}`;
  return {
    title,
    description,
    alternates: { canonical },
    // Review-before-index gate: a city stays out of the index until a human verifies
    // its provincial-program details and flips `published`.
    robots: city.published ? undefined : { index: false, follow: true },
    openGraph: {
      type: 'article',
      title,
      description,
      url: canonical,
      siteName: 'Hale',
      locale: 'en_CA',
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function ActivityCityRoute({ params }: PageProps) {
  const { city: slug } = await params;
  const city = getCity(slug);
  if (!city) notFound();

  const ideas = universalIdeas(city);

  return (
    <main id="main" tabIndex={-1} className="relative">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(cityJsonLd(city)) }}
      />
      <SiteHeader />

      <article className="shell pt-10 sm:pt-16 pb-16 lg:pb-24">
        <div className="max-w-3xl">
          <nav aria-label="Breadcrumb" className="rise rise-1">
            <a href="/activities" className="link text-sm">
              Activities
            </a>
          </nav>

          <div className="mt-4 rise rise-1">
            <span className="eyebrow">
              {city.city} · {city.province}
            </span>
            <h1 className="mt-3">Things to do with your kids in {city.city}</h1>
          </div>

          <p className="meta mt-6 text-lg rise rise-2" style={{ lineHeight: 1.6 }}>
            {city.intro}
          </p>

          <div className="mt-12 flex flex-col gap-6">
            {ideas.map((idea) => (
              <section key={idea.title} className="panel-oat px-6 py-7 sm:px-8 rise rise-2">
                <h2 className="font-display text-xl text-spruce">{idea.title}</h2>
                <p className="meta mt-3" style={{ lineHeight: 1.6 }}>
                  {idea.body}
                </p>
              </section>
            ))}
          </div>

          {city.faqs.length > 0 ? (
            <div className="mt-16 rise rise-2">
              <h2 className="font-display text-2xl text-spruce">
                Common questions about {city.city}
              </h2>
              <dl className="mt-8 flex flex-col gap-8">
                {city.faqs.map((f) => (
                  <div key={f.question} className="border-t border-rule pt-6">
                    <dt className="font-display text-lg text-spruce">{f.question}</dt>
                    <dd className="meta mt-3" style={{ lineHeight: 1.6 }}>
                      {f.answer}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          <p className="meta mt-16 text-sm text-faded-sage rise rise-2">
            Programs and locations change — treat this as a starting point and confirm details with
            your city or the program directly. Last reviewed {city.updated}.
          </p>
        </div>
      </article>

      <CtaBand>
        <h2 className="mx-auto max-w-2xl font-display text-2xl">
          Let Hale find these for you in {city.city}
        </h2>
        <p className="cta-sub mx-auto mt-4 max-w-xl" style={{ lineHeight: 1.6 }}>
          Tell Hale your neighbourhood and what your kids love, and it gathers the classes,
          groups, and drop-ins near you worth a look. Free to start — your data stays in
          Canada.
        </p>
        <div className="mt-8 flex justify-center">
          <LandingCta
            event="activities_cta_signin"
            href={`${APP_URL}/sign-in`}
            className="btn-on-navy"
          >
            Find activities near you
          </LandingCta>
        </div>
      </CtaBand>

      <SiteFooter />
    </main>
  );
}
