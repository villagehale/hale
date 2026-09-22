import type { Metadata } from 'next';
import { CopyNumberButton } from '~/components/copy-number';
import { CtaBand } from '~/components/cta-band';
import { LandingCta } from '~/components/landing-cta';
import { ProductFaqAccordion } from '~/components/product-faq-accordion';
import { QrCode } from '~/components/qr-code';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { type HeadlineSegment, WordsPullUp } from '~/components/words-pull-up';
import { buildAlternates } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { SITE_URL } from '~/lib/app-url';
import type { FaqItem } from '~/lib/faq';
import { MUNICIPALITY_COUNT } from '~/lib/site/municipalities';
import { CONTACT_EMAIL, buildSmsHref, readSmsNumber } from '~/lib/text-entry';

/**
 * villagehale.com/for-centres — the one page on this site that is not written to
 * a parent.
 *
 * An EarlyON educator, a librarian, a community-program lead: they are the people
 * families already trust, and until now nothing here told them what Hale means
 * for the families they serve or how to point one at it. Everything a parent
 * reads elsewhere is here in staff terms — what it does, what it does not, what
 * to say when a family asks whether it is official.
 *
 * Two things this page deliberately does NOT own:
 *  - The demo exchange. The bubbles are `Landing.heroThread` verbatim, read out
 *    of the same message key the homepage renders, so the one example of a first
 *    text cannot say two different things on two pages.
 *  - The coverage count. `MUNICIPALITY_COUNT` is the number, per the module's
 *    own rule that anything stating the count reads it from there. The page
 *    names the count in the lede and does not list the towns.
 *
 * Nothing about connectors, invitations or anything else behind F14's flag is
 * mentioned: this page is handed to staff who will repeat it out loud, so it
 * names only what a family actually gets today.
 */

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'ForCentres');
  return {
    title: t('metaTitle'),
    description: t('metaDescription'),
    alternates: buildAlternates(locale, '/for-centres'),
  };
}

/**
 * The three doors, keyed rather than zipped. The copy is localized and the
 * affordance is structural — a locale that reordered its three ways used to be
 * able to put the QR under "give them the number" (the bug /contact's channels
 * already fixed the same way).
 */
const WAYS = ['number', 'poster', 'try'] as const;
type WayId = (typeof WAYS)[number];

interface Way {
  tag: string;
  title: string;
  body: string;
}
interface Fact {
  title: string;
  body: string;
}
interface ThreadRow {
  dir: 'in' | 'out';
  text: string;
}

export default async function ForCentresPage({ params }: PageProps) {
  const { locale } = await params;
  const t = getTranslator(locale, 'ForCentres');
  const landing = getTranslator(locale, 'Landing');
  const copy = getTranslator(locale, 'CopyNumber');
  const common = getTranslator(locale, 'Common');

  const number = readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER);
  const ways = t.raw('ways') as Record<WayId, Way>;
  const facts = t.raw('facts') as Fact[];
  const faq = t.raw('faq') as FaqItem[];
  // The landing's own hero exchange, not a second demo written beside it.
  const thread = landing.raw('heroThread') as ThreadRow[];
  const speaker = (dir: ThreadRow['dir']) =>
    dir === 'in' ? landing('bubbleHale') : landing('bubbleYou');

  return (
    <main id="main" tabIndex={-1} className="relative">
      <SiteHeader locale={locale} />

      <section className="shell pt-10 sm:pt-16 pb-14 lg:pb-20">
        <div className="max-w-2xl">
          <span className="eyebrow">{t('eyebrow')}</span>
          <WordsPullUp className="mt-3" segments={t.raw('headline') as HeadlineSegment[]} />
          <p
            className="reading-measure mt-6 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            {t('lede', { count: MUNICIPALITY_COUNT })}
          </p>
          <p
            className="reading-measure mt-4 text-[1.02rem]"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            {t('notLine')}
          </p>
        </div>
      </section>

      {/* ── The signature element: what your families will see ─────────────
          One real exchange, on its own ground, at the size a staff member can
          read across a table. The landing's own bubbles and the landing's own
          words — this page borrows the demo rather than writing a second one. */}
      <div className="band-cream grain">
        <section className="shell grid grid-cols-1 items-center gap-y-10 py-16 lg:grid-cols-12 lg:gap-x-16 lg:py-24">
          <div className="lg:col-span-5">
            <span className="eyebrow">{t('getEyebrow')}</span>
            <WordsPullUp
              as="h2"
              className="mt-3"
              segments={t.raw('getHeadline') as HeadlineSegment[]}
            />
            <p className="meta mt-5 text-lg" style={{ lineHeight: 1.6 }}>
              {t('getLede')}
            </p>
            <p className="meta mt-5" style={{ lineHeight: 1.6 }}>
              {t('getAfter')}
            </p>
          </div>

          {/* The thread is the one loud thing on the page, so it gets the wider
              half of the band and everything around it stays quiet. */}
          <div className="v4-thread glass-panel lg:col-span-7">
            <p className="v4-thread-cap">{landing('heroThreadCap')}</p>
            {thread.map((row, i) => (
              <p key={`${i}-${row.dir}`} className={`v4-bubble v4-bubble-${row.dir}`}>
                <span className="sr-only">{speaker(row.dir)} </span>
                {row.text}
              </p>
            ))}
          </div>
        </section>
      </div>

      <section className="shell py-16 lg:py-24">
        <div className="max-w-2xl">
          <span className="eyebrow">{t('waysEyebrow')}</span>
          <WordsPullUp
            as="h2"
            className="mt-3"
            segments={t.raw('waysHeadline') as HeadlineSegment[]}
          />
          <p className="meta mt-5 text-lg" style={{ lineHeight: 1.6 }}>
            {t('waysLede')}
          </p>
        </div>

        <ol className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
          {WAYS.map((id, i) => {
            const way = ways[id];
            if (!way) throw new Error(`ForCentres.ways is missing "${id}" in ${locale}`);
            return (
              <li key={id} className="glass-panel numbered-card">
                <div className="numbered-card-head">
                  <span className="eyebrow">{way.tag}</span>
                  <span className="numbered-card-num">0{i + 1}</span>
                </div>
                <h3 className="mt-5 text-[1.15rem] leading-snug">{way.title}</h3>
                <p className="mt-3" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
                  {way.body}
                </p>
                <div className="mt-auto pt-7">
                  {/* Each way carries exactly one affordance, and the two that
                      need a provisioned number say so out loud when there is
                      none rather than rendering a dead control. */}
                  {id === 'number' &&
                    (number ? (
                      <CopyNumberButton
                        number={number}
                        placement="for_centres"
                        className="btn-secondary"
                        label={copy('label')}
                        copiedLabel={copy('copied')}
                        ariaLabel={copy('aria')}
                      />
                    ) : (
                      <p className="meta">{t('numberPending')}</p>
                    ))}
                  {id === 'poster' && (
                    <QrCode value={`${SITE_URL}/text`} size={132} label={way.title} />
                  )}
                  {id === 'try' &&
                    (number ? (
                      <LandingCta
                        event="cta_text_click"
                        channel="sms"
                        placement="for_centres"
                        href={buildSmsHref(number, null)}
                        className="btn-secondary"
                      >
                        {common('textHale')}
                      </LandingCta>
                    ) : (
                      <p className="meta">{t('numberPending')}</p>
                    ))}
                </div>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="max-w-2xl">
          <span className="eyebrow">{t('knowEyebrow')}</span>
          <WordsPullUp
            as="h2"
            className="mt-3"
            segments={t.raw('knowHeadline') as HeadlineSegment[]}
          />
          <p className="meta mt-5 text-lg" style={{ lineHeight: 1.6 }}>
            {t('knowLede')}
          </p>
        </div>

        <div className="glass-panel mt-10 p-7 sm:p-9">
          <dl className="grid grid-cols-1 gap-x-10 gap-y-7 md:grid-cols-2">
            {facts.map((fact) => (
              <div key={fact.title}>
                <dt className="text-[1.02rem] leading-snug font-semibold text-spruce">
                  {fact.title}
                </dt>
                <dd className="mt-2" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
                  {fact.body}
                </dd>
              </div>
            ))}
          </dl>
        </div>

        {/* The sentence a staff member will actually have to say, set so it can
            be read off the screen and repeated. */}
        <div className="panel-apricot-tint mt-6 px-7 py-8 sm:px-9">
          <span className="eyebrow">{t('officialEyebrow')}</span>
          <p
            className="mt-4 font-display max-w-3xl"
            style={{
              fontSize: 'clamp(1.15rem, 2vw, 1.5rem)',
              lineHeight: 1.4,
              letterSpacing: 'var(--tracking-display)',
              fontWeight: 600,
            }}
          >
            {t('officialLine')}
          </p>
        </div>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="max-w-2xl">
          <span className="eyebrow">{t('faqEyebrow')}</span>
          <WordsPullUp
            as="h2"
            className="mt-3"
            segments={t.raw('faqHeadline') as HeadlineSegment[]}
          />
        </div>
        <div className="mt-10 max-w-3xl">
          <ProductFaqAccordion items={faq} />
        </div>
      </section>

      <CtaBand>
        <h2 className="mx-auto max-w-2xl font-display text-2xl">{t('ctaHeading')}</h2>
        <p className="cta-sub mx-auto mt-4 max-w-xl" style={{ lineHeight: 1.6 }}>
          {t('ctaSub')}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a href={`mailto:${CONTACT_EMAIL}`} className="btn-on-navy">
            {t('ctaButton')}
          </a>
          <a href={localeHref(locale, '/contact')} className="btn-on-navy-quiet">
            {t('ctaQuiet')}
          </a>
        </div>
      </CtaBand>

      <SiteFooter locale={locale} />
    </main>
  );
}
