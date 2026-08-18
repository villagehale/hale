import type { Metadata } from 'next';
import { CtaBand } from '~/components/cta-band';
import { LandingCta } from '~/components/landing-cta';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { type HeadlineSegment, WordsPullUp } from '~/components/words-pull-up';
import { buildAlternates } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { publishedAnswers } from '~/lib/answers/index';
import { chromeCta } from '~/lib/site/chrome-cta';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

// The index only lists reviewed (published) answers. Until at least one page is
// published it has nothing to index, so it stays out of search — it becomes
// indexable on its own once the first answer goes live.
export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'Answers');
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: buildAlternates(locale, '/answers'),
    robots: publishedAnswers.length > 0 ? undefined : { index: false, follow: true },
  };
}

export default async function AnswersIndexPage({ params }: PageProps) {
  const { locale } = await params;
  const t = getTranslator(locale, 'Answers');
  const stageLabels = t.raw('stageLabels') as Record<string, string>;
  const answers = publishedAnswers;
  // Texting Hale is the one front door: the app's /onboarding wizard was deleted in
  // F14, so both CTAs on this page were 308ing readers back to the homepage.
  const cta = chromeCta(locale);

  return (
    <main id="main" tabIndex={-1} className="relative">
      <SiteHeader locale={locale} />

      <section className="shell pt-10 sm:pt-16 pb-12">
        <div className="max-w-2xl">
          <span className="eyebrow">{t('eyebrow')}</span>
          <WordsPullUp className="mt-3" segments={t.raw('headline') as HeadlineSegment[]} />
          <p
            className="reading-measure mt-6 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            {t('lede')}
          </p>
        </div>
      </section>

      {answers.length > 0 ? (
        <div className="band-cream grain">
          <section className="shell py-16 lg:py-24">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
              {answers.map((page) => (
                <a
                  key={page.slug}
                  href={localeHref(locale, `/answers/${page.slug}`)}
                  className="glass-panel lift flex flex-col items-start gap-3 p-6 sm:p-7"
                >
                  <span className="pill-quiet">{stageLabels[page.stage]}</span>
                  <span
                    className="font-display"
                    style={{ fontWeight: 600, fontSize: '1.2rem', lineHeight: 1.25 }}
                  >
                    {page.question}
                  </span>
                  <span className="meta" style={{ lineHeight: 1.5 }}>
                    {page.description}
                  </span>
                </a>
              ))}
            </div>
          </section>
        </div>
      ) : (
        <section className="shell pb-20 lg:pb-28">
          <div className="glass-panel px-8 py-14 sm:px-12 max-w-2xl">
            <p className="text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
              {t('empty')}
            </p>
            <div className="mt-8">
              <a href={cta.href} className="btn-primary">
                {cta.label}
              </a>
            </div>
          </div>
        </section>
      )}

      {/* Populated index closes on the signature navy CTA (empty state carries its
          own Ask Hale panel above). SITE-10: both SEO entry surfaces need a
          conversion path beyond the header pill. */}
      {answers.length > 0 && (
        <CtaBand>
          <h2 className="mx-auto max-w-2xl font-display text-2xl">{t('ctaHeading')}</h2>
          <p className="cta-sub mx-auto mt-4 max-w-xl" style={{ lineHeight: 1.6 }}>
            {t('ctaSub')}
          </p>
          <div className="mt-8 flex justify-center">
            <LandingCta event="answers_cta_signin" href={cta.href} className="btn-on-navy">
              {cta.label}
            </LandingCta>
          </div>
        </CtaBand>
      )}

      <SiteFooter locale={locale} />
    </main>
  );
}
