import { LegalToc } from '~/components/legal-toc';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator, isoToDate } from '~/i18n/server';
import { FRAMEWORK_SOURCES } from '~/lib/answers/frameworks';
import { guideStageFilter, headingSlug } from '~/lib/answers/guide-stage';
import { getAnswer } from '~/lib/answers/index';
import type { AnswerPage } from '~/lib/answers/types';
import { shoreSrc } from './assets';
import { GuideCard } from './guide-card';
import { ShoreClose } from './shore-close';
import { tx } from './tx';

function CrumbArrow() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13 8H3M7 4L3 8l4 4" />
    </svg>
  );
}

function SourceArrow() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 11l6-6M6 5h5v5" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="7.25" />
      <path d="M10 9v4.5M10 6.6v.1" />
    </svg>
  );
}

/**
 * The parenting-guide template. Every published guide renders through this,
 * in the legal long-form shell: shore hero, sticky contents, frosted article,
 * related cards, and the index closing band.
 */
export function RedesignGuide({
  locale,
  page,
  smsNumber,
  prefill,
}: {
  locale: Locale;
  page: AnswerPage;
  smsNumber: string;
  prefill: string;
}) {
  const t = (s: string) => tx(locale, s);
  const article = getTranslator(locale, 'AnswerArticle');
  const onThisPage = getTranslator(locale, 'Legal')('onThisPage');
  const stage = guideStageFilter(page.stage);
  const related = page.related.map(getAnswer).filter((item) => item !== undefined);

  const toc = [
    { id: 'short-answer', title: article('shortAnswer') },
    ...page.sections.map((section) => ({
      id: headingSlug(section.heading),
      title: section.heading,
    })),
    ...(page.faqs.length > 0 ? [{ id: 'parents-also-ask', title: article('parentsAlsoAsk') }] : []),
    { id: 'sources', title: article('sources') },
  ];

  return (
    <>
      <SiteHeader locale={locale} />
      <div className="rd">
        <div className="stage sp-stage sp-legal gd-stage">
          <img className="shore-art" src={shoreSrc} alt="" aria-hidden="true" />
          <span className="shore-drift sky" aria-hidden="true" />
          <span className="shore-drift sea" aria-hidden="true" />
          <span className="shore-scrim" aria-hidden="true" />
          <main id="main" className="sp-hero">
            <div className="sp-grid">
              <div className="sp-copy">
                <nav aria-label="Breadcrumb">
                  <a className="hs-eyebrow gd-crumb" href={localeHref(locale, '/answers')}>
                    <CrumbArrow />
                    {article('breadcrumb')}
                  </a>
                </nav>
                <h1 className="sp-h1 gd-h1">{page.question}</h1>
                {stage ? (
                  <p className="gd-stagerow">
                    <span className="sp-tag">{t(stage.label)}</span>
                    <span className="gd-dot" aria-hidden="true" />
                    <span className="sp-num">{t(stage.range)}</span>
                  </p>
                ) : null}
              </div>
            </div>
          </main>
        </div>
        <div className="hs-page">
          <section className="hs lg hs-wash-a">
            <div className="hs-wrap hs-grid lg-wrap">
              <LegalToc label={onThisPage} sections={toc} />
              <article className="hs-glass lg-doc gd-doc">
                <section id="short-answer" className="gd-short">
                  <h2 className="gd-sr">{article('shortAnswer')}</h2>
                  <p className="gd-answer">{page.answer}</p>
                  <p className="gd-note">
                    {article('guidanceNote', { date: isoToDate(page.updated) })}
                  </p>
                </section>
                <section className="gd-take" aria-labelledby="key-takeaways">
                  <h2 id="key-takeaways" className="hs-eyebrow">
                    {article('keyTakeaways')}
                  </h2>
                  <ol>
                    {page.keyTakeaways.map((takeaway, index) => (
                      <li key={takeaway}>
                        <span className="gd-n" aria-hidden="true">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span>{takeaway}</span>
                      </li>
                    ))}
                  </ol>
                </section>
                {page.sections.map((section) => (
                  <section
                    key={section.heading}
                    id={headingSlug(section.heading)}
                    className="gd-sec"
                  >
                    <h2>{section.heading}</h2>
                    {section.body.map((paragraph) => (
                      <p key={paragraph}>{paragraph}</p>
                    ))}
                  </section>
                ))}
                {page.faqs.length > 0 ? (
                  <section id="parents-also-ask" className="gd-sec">
                    <h2>{article('parentsAlsoAsk')}</h2>
                    <div className="gd-qas">
                      {page.faqs.map((faq) => (
                        <div key={faq.question} className="hs-qa">
                          <h3 className="hs-h3">{faq.question}</h3>
                          <p className="hs-p">{faq.answer}</p>
                        </div>
                      ))}
                    </div>
                  </section>
                ) : null}
                <section id="sources" className="gd-sec">
                  <h2>{article('sources')}</h2>
                  <p className="gd-src-lede">{article('sourcesLede')}</p>
                  <ul className="gd-sources">
                    {page.citations.map((citation) => {
                      const source = FRAMEWORK_SOURCES[citation.framework];
                      return (
                        <li key={citation.reference}>
                          {source.home ? (
                            <a
                              className="sp-link gd-src-link"
                              href={source.home}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <span>{source.label}</span>
                              <SourceArrow />
                            </a>
                          ) : (
                            <span className="gd-src-name">{source.label}</span>
                          )}
                          <p className="gd-ref">{citation.reference}</p>
                          {citation.excerpt ? (
                            <p className="gd-sum">
                              <span>{article('inSummary').trim()}</span> {citation.excerpt}
                            </p>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
                <aside className="gd-safety" aria-labelledby="please-read">
                  <span className="gd-safety-ic">
                    <InfoIcon />
                  </span>
                  <div>
                    <p id="please-read" className="hs-eyebrow">
                      {article('disclaimerEyebrow')}
                    </p>
                    <p className="gd-safety-h">{article('disclaimerHeading')}</p>
                    <p className="gd-safety-p">{article('disclaimerBody')}</p>
                  </div>
                </aside>
              </article>
            </div>
          </section>
          {related.length > 0 ? (
            <section className="hs hs-wash-b gd-related">
              <div className="hs-wrap">
                <div className="gd-related-head">
                  <p className="hs-eyebrow">{article('relatedGuides')}</p>
                </div>
                <div className="sp-cards two">
                  {related.map((item) => {
                    const itemStage = guideStageFilter(item.stage);
                    return (
                      <GuideCard
                        key={item.slug}
                        stageLabel={itemStage ? t(itemStage.label) : item.stage}
                        rangeLabel={itemStage ? t(itemStage.range) : ''}
                        question={t(item.question)}
                        description={t(item.description)}
                        href={localeHref(locale, `/answers/${item.slug}`)}
                        readLabel={t('Read the guide')}
                      />
                    );
                  })}
                </div>
              </div>
            </section>
          ) : null}
          <ShoreClose
            locale={locale}
            smsNumber={smsNumber}
            prefill={prefill}
            placement="answer_detail"
            heading={t('A question about your own child?')}
            sub={t('Text Hale. It answers with your child’s age in mind, in a line or two.')}
            cta={t('Text Hale')}
            terms={t('Free. You text first; standard message rates apply, reply STOP any time.')}
          />
        </div>
      </div>
      <SiteFooter locale={locale} />
    </>
  );
}
