import { ArrowLeft, ArrowUpRight, MessageCircle } from 'lucide-react';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { Wordmark } from '~/components/wordmark';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator, isoToDate } from '~/i18n/server';
import { FRAMEWORK_SOURCES } from '~/lib/answers/frameworks';
import { getAnswer } from '~/lib/answers/index';
import { answerJsonLd } from '~/lib/answers/structured-data';
import type { AnswerPage } from '~/lib/answers/types';
import { DesignCta } from './shared';

/** October design shell; published guidance and review dates come from the existing corpus. */
export function DesignAnswerArticle({ locale, page }: { locale: Locale; page: AnswerPage }) {
  const t = getTranslator(locale, 'AnswerArticle');
  const stageLabels = getTranslator(locale, 'Answers').raw('stageLabels') as Record<string, string>;
  const related = page.related.map(getAnswer).filter((answer) => answer !== undefined);

  return (
    <main id="main" tabIndex={-1} className="design-marketing sp-article">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: Serialized in-repo article data, without user input.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(answerJsonLd(page)) }}
      />
      <div className="stage sp-stage">
        <img
          className="shore-art"
          src="/landing-oct-2026/hale-shore-hero.webp"
          alt=""
          aria-hidden="true"
        />
        <span className="shore-drift sky" aria-hidden="true" />
        <span className="shore-drift sea" aria-hidden="true" />
        <span className="shore-scrim" aria-hidden="true" />
        <SiteHeader locale={locale} redesign />
        <section className="sp-hero">
          <div className="sp-grid">
            <div className="sp-copy">
              <nav aria-label="Breadcrumb" className="guide-breadcrumb">
                <a href={localeHref(locale, '/answers')} className="sp-link">
                  <ArrowLeft size={14} aria-hidden="true" />
                  {t('breadcrumb')}
                </a>
              </nav>
              <p className="hs-eyebrow">{stageLabels[page.stage]}</p>
              <h1 className="sp-h1">{page.question}</h1>
              <p className="sp-lede">{page.answer}</p>
              <p className="hs-meta guide-reviewed">
                {t('guidanceNote', { date: isoToDate(page.updated) })}
              </p>
            </div>
          </div>
        </section>
      </div>
      <div className="hs-page">
        <section className="hs hs-wash-a">
          <div className="hs-wrap">
            <article className="lg-doc hs-card guide-doc" aria-label={page.question}>
              <section aria-labelledby="key-takeaways" className="guide-takeaways">
                <h2 id="key-takeaways">{t('keyTakeaways')}</h2>
                <ul>
                  {page.keyTakeaways.map((takeaway) => (
                    <li key={takeaway}>{takeaway}</li>
                  ))}
                </ul>
              </section>
              {page.sections.map((section) => (
                <section key={section.heading}>
                  <h2>{section.heading}</h2>
                  {section.body.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </section>
              ))}
              {page.faqs.length > 0 && (
                <section>
                  <h2>{t('parentsAlsoAsk')}</h2>
                  <dl className="guide-faqs">
                    {page.faqs.map((faq) => (
                      <div key={faq.question}>
                        <dt className="hs-h3">{faq.question}</dt>
                        <dd>
                          <p>{faq.answer}</p>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )}
              <section>
                <h2>{t('sources')}</h2>
                <p>{t('sourcesLede')}</p>
                <ul className="guide-sources">
                  {page.citations.map((citation) => {
                    const source = FRAMEWORK_SOURCES[citation.framework];
                    return (
                      <li key={citation.reference}>
                        {source.home ? (
                          <a href={source.home} target="_blank" rel="noreferrer">
                            {source.label}
                            <ArrowUpRight size={14} aria-hidden="true" />
                          </a>
                        ) : (
                          <span>{source.label}</span>
                        )}
                        <p>{citation.reference}</p>
                        {citation.excerpt && (
                          <p>
                            {t('inSummary')}
                            {citation.excerpt}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
              <aside className="guide-disclaimer">
                <span className="hs-eyebrow">{t('disclaimerEyebrow')}</span>
                <h2>{t('disclaimerHeading')}</h2>
                <p>{t('disclaimerBody')}</p>
              </aside>
            </article>
          </div>
        </section>
        {related.length > 0 && (
          <section className="hs hs-wash-b guide-related">
            <div className="hs-wrap">
              <h2 className="hs-h2">{t('relatedGuides')}</h2>
              <div className="sp-cards two">
                {related.map((answer) => (
                  <a
                    key={answer.slug}
                    href={localeHref(locale, `/answers/${answer.slug}`)}
                    className="hs-card sp-card sp-guide"
                  >
                    <span className="sp-tag">{stageLabels[answer.stage]}</span>
                    <h3 className="hs-h3">{answer.question}</h3>
                    <span className="sp-link">
                      Read the guide <ArrowUpRight size={14} aria-hidden="true" />
                    </span>
                  </a>
                ))}
              </div>
            </div>
          </section>
        )}
        <section className="hs hs-close-sec" id="start">
          <div className="hs-wrap">
            <div className="hs-close-card">
              <img
                className="hs-close-art"
                src="/landing-oct-2026/hale-shore-hero.webp"
                alt=""
                aria-hidden="true"
              />
              <span className="hs-close-scrim" aria-hidden="true" />
              <div className="hs-close-body">
                <span className="hs-close-brand">
                  <img src="/landing-oct-2026/hale-logo.jpeg" alt="" />
                  <Wordmark className="wordmark" />
                </span>
                <h2>A question about your own child?</h2>
                <p className="hs-close-sub">
                  Text Hale. It answers with your child’s age in mind, in a line or two.
                </p>
                <div className="hs-close-cta">
                  <DesignCta locale={locale} className="btn btn-hero">
                    <MessageCircle size={16} aria-hidden="true" />
                    Text Hale
                  </DesignCta>
                </div>
                <p className="hs-close-terms">
                  Free to start. You text first; standard message rates apply.
                </p>
              </div>
            </div>
          </div>
        </section>
        <SiteFooter locale={locale} redesign />
      </div>
    </main>
  );
}
