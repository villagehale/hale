import Image from 'next/image';
import heroShore from '~/assets/hale-shore-hero.webp';
import { ChooserLink } from '~/components/chooser-link';
import { LandingScrollAnalytics } from '~/components/landing-scroll-analytics';
import { PricingSection } from '~/components/pricing-section';
import { ProductFaqAccordion } from '~/components/product-faq-accordion';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import type { FaqItem } from '~/lib/faq';
import { intakePrefill } from '~/lib/intake-prefill';
import { siteJsonLd } from '~/lib/site/structured-data';
import { CONTACT_EMAIL } from '~/lib/text-entry';

/**
 * The homepage. Shore, glass, and the shared header and footer stay; the
 * page itself is a short 2026 hero (one headline, one subhead, one door, a
 * phone thread) and four product lines, then the live pricing cards and a
 * short FAQ.
 *
 * Hale finds. The bubbles do not book, register, or name a town. Copy is the
 * Landing namespace. With no number provisioned the door is email, and the
 * iMessage trust line is withheld because it would not be true.
 */

interface ThreadRow {
  dir: 'in' | 'out';
  text: string;
}

/** Latin needs a word space before the accent; Chinese sets solid. */
function accentSeparator(locale: Locale): string {
  return locale === 'zh' ? '' : ' ';
}

export function LandingV4({ locale, smsNumber }: { locale: Locale; smsNumber: string }) {
  const t = getTranslator(locale, 'Landing');
  const common = getTranslator(locale, 'Common');
  const prefill = intakePrefill(locale);
  const live = smsNumber.length > 0;

  const heroBubbles = t.raw('heroThread') as ThreadRow[];
  const loopBubbles = t.raw('loopThread') as ThreadRow[];
  const faq = t.raw('faq') as FaqItem[];
  const speaker = (dir: ThreadRow['dir']) => (dir === 'in' ? t('bubbleHale') : t('bubbleYou'));

  return (
    <main id="main" tabIndex={-1}>
      <LandingScrollAnalytics />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd(locale)) }}
      />
      <SiteHeader locale={locale} />

      <section className="v4-hero v4-hero-top">
        <Image
          src={heroShore}
          alt=""
          aria-hidden="true"
          fill
          priority
          sizes="100vw"
          className="v4-hero-art"
        />
        <span className="v4-hero-drift v4-hero-drift-sky" aria-hidden="true" />
        <span className="v4-hero-drift v4-hero-drift-sea" aria-hidden="true" />
        <span className="v4-hero-scrim" aria-hidden="true" />

        <div className="v4-hero-body">
          <div className="v4-hero-stage">
            <div className="v4-hero-copy">
              <h1 className="v4-display v4-hero-h1 text-balance">
                {t('heroH1a')}
                <br />
                {t('heroH1b')}
                {accentSeparator(locale)}
                <span className="v4-accent">{t('heroH1Accent')}</span>
              </h1>
              <p className="v4-hero-sub">{t('heroSub')}</p>
              <div className="v4-hero-offer">
                {live ? (
                  <ChooserLink
                    locale={locale}
                    placement="hero"
                    className="v4-btn-solid v4-glass"
                    smsNumber={smsNumber}
                    prefill={prefill}
                  >
                    {common('textHale')} <span aria-hidden="true">→</span>
                  </ChooserLink>
                ) : (
                  <a href={`mailto:${CONTACT_EMAIL}`} className="v4-btn-solid v4-glass">
                    {common('emailHale')}
                  </a>
                )}
                {live && (
                  <p className="v4-hero-terms">
                    {t('heroTerms')}{' '}
                    <a href={localeHref(locale, '/privacy')} className="underline underline-offset-2">
                      {t('heroTermsLink')}
                    </a>
                    .
                  </p>
                )}
              </div>
            </div>

            <div className="v4-phone-slot">
              <div className="v4-phone">
                <span className="v4-phone-island" aria-hidden="true" />
                <div className="v4-phone-screen v4-hero-thread">
                  <p className="sr-only">{t('heroThreadCap')}</p>
                  {heroBubbles.map((row) => (
                    <p key={`${row.dir}-${row.text}`} className={`v4-bubble v4-bubble-${row.dir}`}>
                      <span className="sr-only">{speaker(row.dir)} </span>
                      {row.text}
                    </p>
                  ))}
                  <p className="v4-typing">
                    <span className="sr-only">{t('typingLabel')}</span>
                    <span aria-hidden="true" />
                    <span aria-hidden="true" />
                    <span aria-hidden="true" />
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="v4-home-rest">
        <section className="shell v4-beat">
          <div>
            <h2 className="v4-display v4-h2">{t('findH2')}</h2>
            <p className="v4-lede">{t('findLine')}</p>
          </div>
          <article className="v4-card v4-glass v4-beat-card">
            <h3 className="text-spruce">{t('findCardTitle')}</h3>
            <p>{t('findCardBody')}</p>
          </article>
        </section>

        <section className="shell v4-beat v4-beat-flip">
          <div>
            <h2 className="v4-display v4-h2">{t('inboxH2')}</h2>
            <p className="v4-lede">{t('inboxLine')}</p>
          </div>
          <article className="v4-card v4-glass v4-beat-card">
            <p className="v4-beat-kicker">{t('inboxCardMeta')}</p>
            <h3 className="text-spruce">{t('inboxCard')}</h3>
          </article>
        </section>

        <section className="shell v4-beat">
          <div>
            <h2 className="v4-display v4-h2">{t('loopH2')}</h2>
            <p className="v4-lede">{t('loopLine')}</p>
          </div>
          <div className="v4-mini v4-glass">
            {loopBubbles.map((row) => (
              <p key={`${row.dir}-${row.text}`} className={`v4-bubble v4-bubble-${row.dir}`}>
                <span className="sr-only">{speaker(row.dir)} </span>
                {row.text}
              </p>
            ))}
          </div>
        </section>

        <section className="shell v4-beat v4-beat-flip">
          <div>
            <h2 className="v4-display v4-h2">{t('familyH2')}</h2>
            <p className="v4-lede">{t('familyLine')}</p>
          </div>
          <div className="v4-beat-pair">
            <article className="v4-card v4-glass v4-beat-card">
              <h3 className="text-spruce">{t('familyCardGroup')}</h3>
              <p>{t('familyCardGroupBody')}</p>
            </article>
            <article className="v4-card v4-glass v4-beat-card">
              <h3 className="text-spruce">{t('familyCardMemory')}</h3>
              <p>{t('familyCardMemoryBody')}</p>
            </article>
          </div>
        </section>
      </div>

      <PricingSection locale={locale} />

      <section className="shell v4-faq">
        <h2 className="v4-display v4-h2">{t('faqH2')}</h2>
        <div className="mt-6 max-w-2xl">
          <ProductFaqAccordion items={faq} />
        </div>
        <p className="mt-6">
          <a href={localeHref(locale, '/faq')} className="link">
            {t('faqMore')}
          </a>
        </p>
      </section>

      <SiteFooter locale={locale} />
    </main>
  );
}
