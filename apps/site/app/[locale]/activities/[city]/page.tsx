import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CtaBand } from '~/components/cta-band';
import { LandingCta } from '~/components/landing-cta';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { WordsPullUp } from '~/components/words-pull-up';
import { buildAlternates, ogLocale } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator, isoToDate } from '~/i18n/server';
import { allCities, getCity, universalIdeas } from '~/lib/activities/index';
import { cityJsonLd } from '~/lib/activities/structured-data';
import { chromeCta } from '~/lib/site/chrome-cta';

interface PageProps {
  params: Promise<{ locale: Locale; city: string }>;
}

export function generateStaticParams(): { city: string }[] {
  return allCities.map((c) => ({ city: c.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, city: slug } = await params;
  const city = getCity(slug);
  if (!city) return {};
  const t = getTranslator(locale, 'ActivityCity');

  const title = t('metaTitle', { city: city.city });
  const description = t('metaDescription', { city: city.city, provinceCode: city.provinceCode });
  const canonical = `/activities/${city.slug}`;
  return {
    title,
    description,
    alternates: buildAlternates(locale, canonical),
    // Review-before-index gate: a city stays out of the index until a human verifies
    // its provincial-program details and flips `published`.
    robots: city.published ? undefined : { index: false, follow: true },
    openGraph: {
      type: 'article',
      title,
      description,
      url: localeHref(locale, canonical),
      siteName: 'Hale',
      locale: ogLocale(locale),
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function ActivityCityRoute({ params }: PageProps) {
  const { locale, city: slug } = await params;
  const city = getCity(slug);
  if (!city) notFound();
  const t = getTranslator(locale, 'ActivityCity');

  const ideas = universalIdeas(city);
  const cta = chromeCta(locale);

  return (
    <main id="main" tabIndex={-1} className="relative">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(cityJsonLd(city)) }}
      />
      <SiteHeader locale={locale} />

      <article className="shell pt-10 sm:pt-16 pb-16 lg:pb-24">
        <div className="max-w-3xl">
          <nav aria-label="Breadcrumb">
            <a href={localeHref(locale, '/activities')} className="link text-sm">
              {t('breadcrumb')}
            </a>
          </nav>

          <div className="mt-5">
            <span className="pill-quiet">
              {city.city} · {city.province}
            </span>
            {/* The same editorial scale the answer pages use — these two are
                articles, and the hero clamp is built for a landing headline. */}
            <WordsPullUp
              className="mt-4 text-[clamp(2rem,3.6vw,3.1rem)]"
              segments={[{ text: t('headlineLead') }, { text: city.city, accent: true }]}
            />
          </div>

          <p className="meta reading-measure mt-6 text-lg" style={{ lineHeight: 1.7 }}>
            {city.intro}
          </p>

          <div className="mt-12 flex flex-col gap-6">
            {ideas.map((idea) => (
              <section key={idea.title} className="glass-panel px-6 py-7 sm:px-8">
                <h2 className="font-display text-xl text-spruce">{idea.title}</h2>
                <p
                  className="reading-measure mt-3 text-base text-slate-green md:text-lg"
                  style={{ lineHeight: 1.7 }}
                >
                  {idea.body}
                </p>
              </section>
            ))}
          </div>

          {city.faqs.length > 0 ? (
            <div className="mt-16">
              <h2 className="font-display text-2xl text-spruce">
                {t('commonQuestions', { city: city.city })}
              </h2>
              <dl className="mt-8 flex flex-col gap-8">
                {city.faqs.map((f) => (
                  <div key={f.question} className="border-t border-rule pt-6">
                    <dt className="font-display text-lg text-spruce">{f.question}</dt>
                    <dd
                      className="reading-measure mt-3 text-base text-slate-green md:text-lg"
                      style={{ lineHeight: 1.7 }}
                    >
                      {f.answer}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          <p className="meta reading-measure mt-16 text-sm text-faded-sage">
            {t('disclaimer', { date: isoToDate(city.updated) })}
          </p>
        </div>
      </article>

      <CtaBand>
        <h2 className="mx-auto max-w-2xl font-display text-2xl">
          {t('ctaHeading', { city: city.city })}
        </h2>
        <p className="cta-sub mx-auto mt-4 max-w-xl" style={{ lineHeight: 1.6 }}>
          {t('ctaSub')}
        </p>
        <div className="mt-8 flex justify-center">
          <LandingCta
            event="cta_text_click"
            channel="sms"
            placement="activities_city"
            href={cta.href}
            className="btn-on-navy"
          >
            {cta.label}
          </LandingCta>
        </div>
      </CtaBand>

      <SiteFooter locale={locale} />
    </main>
  );
}
