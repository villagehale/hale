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
 * The homepage. The shore photograph is full strength, with a light scrim
 * only behind the type. A real iPhone frame carries the thread. Shared
 * header and footer stay. Four product lines, then pricing and a short FAQ.
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
                    <a
                      href={localeHref(locale, '/privacy')}
                      className="underline underline-offset-2"
                    >
                      {t('heroTermsLink')}
                    </a>
                    .
                  </p>
                )}
              </div>
            </div>

            <div className="v4-phone-slot">
              <div className="v4-phone">
                <div className="v4-phone-screen">
                  <div className="v4-ios-status" aria-hidden="true">
                    <span className="v4-ios-time">9:41</span>
                    <span className="v4-ios-island" />
                    <span className="v4-ios-sys">
                      <span className="v4-ios-signal" />
                      <span className="v4-ios-wifi" />
                      <span className="v4-ios-battery" />
                    </span>
                  </div>
                  <div className="v4-ios-header" aria-hidden="true">
                    <span className="v4-ios-back" />
                    <span className="v4-ios-who">
                      <span className="v4-ios-avatar">H</span>
                      <p className="v4-ios-name">Hale</p>
                    </span>
                    <span />
                  </div>
                  <div className="v4-hero-thread">
                    <p className="sr-only">{t('heroThreadCap')}</p>
                    <p className="v4-ios-stamp" aria-hidden="true">
                      {t('imessageStamp')}
                    </p>
                    {heroBubbles.map((row) => (
                      <span key={`${row.dir}-${row.text}`} className="v4-ios-msg">
                        <p className={`v4-bubble v4-bubble-${row.dir}`}>
                          <span className="sr-only">{speaker(row.dir)} </span>
                          {row.text}
                        </p>
                        {row.dir === 'out' ? (
                          <p className="v4-ios-delivered" aria-hidden="true">
                            {t('imessageDelivered')}
                          </p>
                        ) : null}
                      </span>
                    ))}
                    <p className="v4-typing">
                      <span className="sr-only">{t('typingLabel')}</span>
                      <span aria-hidden="true" />
                      <span aria-hidden="true" />
                      <span aria-hidden="true" />
                    </p>
                  </div>
                  <div className="v4-ios-composer" aria-hidden="true">
                    <span className="v4-ios-plus" />
                    <span className="v4-ios-field">{t('imessageField')}</span>
                  </div>
                  <span className="v4-ios-home" aria-hidden="true" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="v4-home-rest">
        <section className="shell v4-find">
          <h2 className="v4-display v4-h2">{t('findH2')}</h2>
          <p className="v4-lede">{t('findLine')}</p>
          <p className="v4-find-note">
            <span className="v4-beat-kicker">{t('findCardTitle')}</span>
            {t('findCardBody')}
          </p>
        </section>

        <section className="shell v4-inbox">
          <div>
            <h2 className="v4-display v4-h2">{t('inboxH2')}</h2>
            <p className="v4-lede">{t('inboxLine')}</p>
          </div>
          <p className="v4-cal-line">
            <span className="v4-beat-kicker">{t('inboxCardMeta')}</span>
            <strong>{t('inboxCard')}</strong>
          </p>
        </section>

        <section className="shell v4-loop">
          <h2 className="v4-display v4-h2">{t('loopH2')}</h2>
          <p className="v4-lede">{t('loopLine')}</p>
          <div className="v4-thread-wide v4-glass">
            {loopBubbles.map((row) => (
              <p key={`${row.dir}-${row.text}`} className={`v4-bubble v4-bubble-${row.dir}`}>
                <span className="sr-only">{speaker(row.dir)} </span>
                {row.text}
              </p>
            ))}
          </div>
        </section>

        <section className="shell v4-family">
          <h2 className="v4-display v4-h2">{t('familyH2')}</h2>
          <p className="v4-lede">{t('familyLine')}</p>
          <div className="v4-family-row">
            <article className="v4-card v4-glass">
              <h3 className="text-spruce">{t('familyCardGroup')}</h3>
              <p>{t('familyCardGroupBody')}</p>
            </article>
            <article className="v4-card v4-glass">
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
