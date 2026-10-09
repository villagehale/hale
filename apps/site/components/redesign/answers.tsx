import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getMessages, getTranslator } from '~/i18n/server';
import { GUIDE_STAGE_FILTERS, guideStageFilter } from '~/lib/answers/guide-stage';
import { publishedAnswers } from '~/lib/answers/index';
import { shoreSrc } from './assets';
import { GuideCard } from './guide-card';
import { GuideFilter } from './guide-filter';
import { ShoreClose } from './shore-close';
import { tx } from './tx';

export function RedesignAnswers({
  locale,
  smsNumber,
  prefill,
}: {
  locale: Locale;
  smsNumber: string;
  prefill: string;
}) {
  const t = (s: string) => tx(locale, s);
  const copy = getTranslator(locale, 'Answers');
  const messages = getMessages(locale).Answers;
  const total = publishedAnswers.length;
  const stages = GUIDE_STAGE_FILTERS.map((item) => ({
    param: item.param,
    label: t(item.label),
    count: publishedAnswers.filter((page) => page.stage === item.stage).length,
  }));

  return (
    <>
      <SiteHeader locale={locale} />
      <div className="rd">
        <div className="stage sp-stage">
          <img className="shore-art" src={shoreSrc} alt="" aria-hidden="true" />
          <span className="shore-drift sky" aria-hidden="true" />
          <span className="shore-drift sea" aria-hidden="true" />
          <span className="shore-scrim" aria-hidden="true" />
          <main id="main" className="sp-hero">
            <div className="sp-grid">
              <div className="sp-copy">
                <p className="hs-eyebrow">{t('Parenting guides')}</p>
                <h1 className="sp-h1">{t('Calm, cited guidance for every stage.')}</h1>
                <p className="sp-lede">
                  {t(
                    'Practical guides to the questions parents search, grounded in trusted parenting-health frameworks and honest about their limits.',
                  )}
                </p>
              </div>
            </div>
          </main>
        </div>
        <div className="hs-page">
          <section className="hs hs-wash-a">
            <div className="hs-wrap">
              <div className="hs-head">
                <p className="hs-eyebrow">{t('Guides')}</p>
                <h2 className="hs-h2">{copy('countHeading', { n: total })}</h2>
                <p className="hs-lede">
                  {t('General guidance, never a replacement for your provider.')}
                </p>
              </div>
              {total === 0 ? (
                <div className="sp-cards">
                  <article className="hs-card sp-card">
                    <p className="hs-p">{copy('empty')}</p>
                  </article>
                </div>
              ) : (
                <GuideFilter
                  groupLabel={messages.filterLabel}
                  allLabel={t('All stages')}
                  total={total}
                  stages={stages}
                  statusTemplate={messages.filterStatus}
                  emptyHeading={messages.filterEmpty}
                  seeAllLabel={messages.filterSeeAll}
                >
                  {publishedAnswers.map((page) => {
                    const stage = guideStageFilter(page.stage);
                    return (
                      <GuideCard
                        key={page.slug}
                        stageParam={stage?.param ?? page.stage}
                        stageLabel={stage ? t(stage.label) : page.stage}
                        rangeLabel={stage ? t(stage.range) : ''}
                        question={t(page.question)}
                        description={t(page.description)}
                        href={localeHref(locale, `/answers/${page.slug}`)}
                        readLabel={t('Read the guide')}
                      />
                    );
                  })}
                </GuideFilter>
              )}
            </div>
          </section>
          <ShoreClose
            locale={locale}
            smsNumber={smsNumber}
            prefill={prefill}
            placement="answers"
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
