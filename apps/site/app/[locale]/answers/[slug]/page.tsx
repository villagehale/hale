import { ArrowUpRight } from 'lucide-react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LandingCta } from '~/components/landing-cta';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { WordsPullUp } from '~/components/words-pull-up';
import { buildAlternates, ogLocale } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator, isoToDate } from '~/i18n/server';
import { FRAMEWORK_SOURCES } from '~/lib/answers/frameworks';
import { allAnswers, getAnswer } from '~/lib/answers/index';
import { answerJsonLd } from '~/lib/answers/structured-data';
import { chromeCta } from '~/lib/site/chrome-cta';

interface PageProps {
  params: Promise<{ locale: Locale; slug: string }>;
}

/**
 * The headline here is data — the reader's own question — so its accent segment
 * has to be chosen by a rule rather than written. The rule is the last word: the
 * subject the question lands on (…in the evening? …to my baby? …tantrums?), which
 * is the word the reader came for. A one-word question has nothing to contrast
 * with, so it stays plain.
 */
function questionSegments(question: string): { text: string; accent?: boolean }[] {
  const words = question.split(' ');
  const last = words.at(-1);
  if (words.length < 2 || !last) return [{ text: question }];
  return [{ text: words.slice(0, -1).join(' ') }, { text: last, accent: true }];
}

export function generateStaticParams(): { slug: string }[] {
  return allAnswers.map((a) => ({ slug: a.slug }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale, slug } = await params;
  const page = getAnswer(slug);
  if (!page) return {};

  const canonical = `/answers/${page.slug}`;
  const title = `${page.title} · Hale`;
  return {
    title,
    description: page.description,
    alternates: buildAlternates(locale, canonical),
    // Review-before-index gate: a draft stays out of the index until a human
    // flips `published`. Published pages get the default (indexable) directive.
    robots: page.published ? undefined : { index: false, follow: true },
    openGraph: {
      type: 'article',
      title,
      description: page.description,
      url: localeHref(locale, canonical),
      siteName: 'Hale',
      locale: ogLocale(locale),
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: page.description,
    },
  };
}

export default async function AnswerRoute({ params }: PageProps) {
  const { locale, slug } = await params;
  const page = getAnswer(slug);
  if (!page) notFound();
  const t = getTranslator(locale, 'AnswerArticle');
  const stageLabels = getTranslator(locale, 'Answers').raw('stageLabels') as Record<string, string>;

  const related = page.related.map(getAnswer).filter((p) => p !== undefined);
  const cta = chromeCta(locale);

  return (
    <main id="main" tabIndex={-1} className="relative">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(answerJsonLd(page)) }}
      />
      <SiteHeader locale={locale} />

      <article className="shell pt-10 sm:pt-16 pb-16 lg:pb-24">
        <div className="max-w-3xl">
          <nav aria-label="Breadcrumb">
            <a href={localeHref(locale, '/answers')} className="link text-sm">
              {t('breadcrumb')}
            </a>
          </nav>

          <div className="mt-5">
            <span className="pill-quiet">{stageLabels[page.stage]}</span>
            {/* An editorial scale, not the hero one: a parent's question is often
                a dozen words, and the site's h1 clamp tops out at 4.75rem — which
                set this page's title as four lines of 76px display type. */}
            <WordsPullUp
              className="mt-4 text-[clamp(2rem,3.6vw,3.1rem)]"
              segments={questionSegments(page.question)}
            />
          </div>

          <p
            className="reading-measure mt-7 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.7 }}
          >
            {page.answer}
          </p>

          <p className="meta mt-4">{t('guidanceNote', { date: isoToDate(page.updated) })}</p>

          <section aria-labelledby="key-takeaways" className="glass-panel mt-8 px-6 py-6 sm:px-8">
            <h2 id="key-takeaways" className="eyebrow" style={{ marginBottom: 0 }}>
              {t('keyTakeaways')}
            </h2>
            <ul className="mt-4 flex flex-col gap-3">
              {page.keyTakeaways.map((takeaway) => (
                <li
                  key={takeaway.slice(0, 48)}
                  className="flex gap-3"
                  style={{ color: 'var(--color-slate-green)', lineHeight: 1.55 }}
                >
                  <span aria-hidden="true" style={{ color: 'var(--color-apricot)' }}>
                    —
                  </span>
                  <span>{takeaway}</span>
                </li>
              ))}
            </ul>
          </section>

          <div className="mt-12 flex flex-col gap-12">
            {page.sections.map((section) => (
              <section key={section.heading}>
                <h2 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.1rem)' }}>{section.heading}</h2>
                <div className="reading-measure mt-4 flex flex-col gap-4">
                  {section.body.map((paragraph) => (
                    <p
                      key={paragraph.slice(0, 48)}
                      className="text-lg"
                      style={{ color: 'var(--color-slate-green)', lineHeight: 1.7 }}
                    >
                      {paragraph}
                    </p>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {page.faqs.length > 0 && (
            <section className="mt-14">
              <h2 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.1rem)' }}>{t('parentsAlsoAsk')}</h2>
              <dl className="mt-6 flex flex-col gap-6">
                {page.faqs.map((faq) => (
                  <div key={faq.question} className="glass-panel px-6 py-6 sm:px-8">
                    <dt className="font-display" style={{ fontWeight: 600, fontSize: '1.15rem' }}>
                      {faq.question}
                    </dt>
                    <dd className="mt-3" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
                      {faq.answer}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <section className="mt-14">
            <h2 style={{ fontSize: 'clamp(1.5rem, 3vw, 2.1rem)' }}>{t('sources')}</h2>
            <p className="meta reading-measure mt-3">{t('sourcesLede')}</p>
            <ul className="mt-6 flex flex-col gap-5">
              {page.citations.map((citation) => (
                <li key={citation.reference}>
                  {/* A source with no publisher page is NAMED, never linked to a
                      stand-in: a YMYL citation list that sends a reader to
                      Wikipedia for the book it cites is worse than plain text. */}
                  {FRAMEWORK_SOURCES[citation.framework].home ? (
                    <a
                      href={FRAMEWORK_SOURCES[citation.framework].home}
                      target="_blank"
                      rel="noreferrer"
                      className="link inline-flex items-center gap-1.5"
                    >
                      {FRAMEWORK_SOURCES[citation.framework].label}
                      <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
                    </a>
                  ) : (
                    <span>{FRAMEWORK_SOURCES[citation.framework].label}</span>
                  )}
                  <p className="meta mt-1.5">{citation.reference}</p>
                  {citation.excerpt && (
                    <p
                      className="mt-1.5"
                      style={{
                        color: 'var(--color-slate-green)',
                        lineHeight: 1.55,
                      }}
                    >
                      <span className="meta">{t('inSummary')}</span>
                      {citation.excerpt}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </div>
      </article>

      <section className="shell pb-16 lg:pb-24">
        <div
          className="night px-8 py-12 sm:px-14 sm:py-16 max-w-3xl"
          style={{ borderRadius: 'var(--r-xl)' }}
        >
          <span className="eyebrow" style={{ color: 'var(--color-on-spruce-soft)' }}>
            {t('disclaimerEyebrow')}
          </span>
          <h2
            className="mt-3"
            style={{ color: 'var(--color-on-spruce)', fontSize: 'clamp(1.5rem, 3vw, 2.1rem)' }}
          >
            {t('disclaimerHeading')}
          </h2>
          <p className="mt-4" style={{ color: 'var(--color-on-spruce-soft)', lineHeight: 1.6 }}>
            {t('disclaimerBody')}
          </p>
        </div>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="panel-apricot-tint px-8 py-14 sm:px-12 flex flex-col sm:flex-row sm:items-center gap-6 sm:gap-10 max-w-3xl">
          <p
            className="font-display"
            style={{
              fontSize: 'clamp(1.25rem, 2.4vw, 1.75rem)',
              lineHeight: 1.3,
              letterSpacing: 'var(--tracking-display)',
              fontWeight: 600,
              color: 'var(--color-spruce)',
            }}
          >
            {t('askCta')}
          </p>
          <LandingCta
            event="cta_text_click"
            placement="answer_detail"
            href={cta.href}
            className="btn-primary shrink-0"
          >
            {cta.label}
          </LandingCta>
        </div>
      </section>

      {related.length > 0 && (
        <div className="band-cream grain">
          <section className="shell py-16 lg:py-24">
            <span className="eyebrow">{t('relatedGuides')}</span>
            <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6 lg:gap-8">
              {related.map((rel) => (
                <a
                  key={rel.slug}
                  href={localeHref(locale, `/answers/${rel.slug}`)}
                  className="glass-panel lift flex flex-col items-start gap-3 p-6 sm:p-7"
                >
                  <span className="pill-quiet">{stageLabels[rel.stage]}</span>
                  <span
                    className="font-display"
                    style={{ fontWeight: 600, fontSize: '1.2rem', lineHeight: 1.25 }}
                  >
                    {rel.question}
                  </span>
                </a>
              ))}
            </div>
          </section>
        </div>
      )}

      <SiteFooter locale={locale} />
    </main>
  );
}
