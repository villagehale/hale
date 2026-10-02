import Image from 'next/image';
import heroShore from '~/assets/hale-shore-hero.webp';
import { ChooserLink } from '~/components/chooser-link';
import { CtaBand } from '~/components/cta-band';
import { LandingScrollAnalytics } from '~/components/landing-scroll-analytics';
import { FadeInUp } from '~/components/landing/fade-in-up';
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
 * The homepage. Two columns on a full-strength shore: the promise on the left,
 * a realistic iPhone on the right. The thread plays once, then holds.
 * Text is the door. Hale finds and reminds. It does not book or sign anyone up.
 *
 * With no number provisioned the door is email, and the privacy line is
 * withheld because the live door is not there.
 */

interface ThreadRow {
  dir: 'in' | 'out';
  text: string;
}

interface Step {
  title: string;
  line: string;
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
  const steps = t.raw('steps') as Step[];
  const example = t.raw('exampleThread') as ThreadRow[];
  const memory = t.raw('memoryItems') as string[];
  const faq = t.raw('faq') as FaqItem[];
  const speaker = (dir: ThreadRow['dir']) => (dir === 'in' ? t('bubbleHale') : t('bubbleYou'));

  const firstIn = heroBubbles.findIndex((row) => row.dir === 'in');
  let outSeen = 0;
  let inSeen = 0;

  const door = live ? (
    <ChooserLink
      locale={locale}
      placement="hero"
      className="v4-btn-solid v4-btn-apricot"
      smsNumber={smsNumber}
      prefill={prefill}
    >
      {common('textHale')} <span aria-hidden="true">→</span>
    </ChooserLink>
  ) : (
    <a href={`mailto:${CONTACT_EMAIL}`} className="v4-btn-solid v4-btn-apricot">
      {common('emailHale')}
    </a>
  );

  const finalDoor = live ? (
    <ChooserLink
      locale={locale}
      placement="final"
      className="btn-on-navy"
      smsNumber={smsNumber}
      prefill={prefill}
    >
      {common('textHale')}
    </ChooserLink>
  ) : (
    <a href={`mailto:${CONTACT_EMAIL}`} className="btn-on-navy">
      {common('emailHale')}
    </a>
  );

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
              <h1 className="v4-display v4-hero-h1">
                {t('heroH1a')}
                <br />
                {t('heroH1b')}
                {accentSeparator(locale)}
                <span className="v4-accent">{t('heroH1Accent')}</span>
              </h1>
              <p className="v4-hero-sub">{t('heroSub')}</p>
              <div className="v4-hero-offer">
                {door}
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
                    {heroBubbles.map((row) => {
                      const beat =
                        row.dir === 'out' ? `v4-beat-out-${++outSeen}` : `v4-beat-in-${++inSeen}`;
                      const bubble = (
                        <p className={`v4-bubble v4-bubble-${row.dir}`}>
                          <span className="sr-only">{speaker(row.dir)} </span>
                          {row.text}
                        </p>
                      );
                      if (heroBubbles.indexOf(row) === firstIn) {
                        return (
                          <span key={`${row.dir}-${row.text}`} className={`v4-ios-swap ${beat}`}>
                            <p className="v4-typing" aria-hidden="true">
                              <span aria-hidden="true" />
                              <span aria-hidden="true" />
                              <span aria-hidden="true" />
                            </p>
                            {bubble}
                          </span>
                        );
                      }
                      return (
                        <span key={`${row.dir}-${row.text}`} className={`v4-ios-msg ${beat}`}>
                          {row.dir === 'out' ? (
                            <>
                              {bubble}
                              <p className="v4-ios-delivered" aria-hidden="true">
                                {t('imessageDelivered')}
                              </p>
                            </>
                          ) : (
                            bubble
                          )}
                        </span>
                      );
                    })}
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
        <FadeInUp>
          <section className="shell v4-steps">
            <h2 className="v4-display v4-h2">{t('stepsH2')}</h2>
            <ol>
              {steps.map((step, index) => (
                <li key={step.title}>
                  <span className="v4-step-n">{index + 1}</span>
                  <h3>{step.title}</h3>
                  <p>{step.line}</p>
                </li>
              ))}
            </ol>
          </section>
        </FadeInUp>

        <FadeInUp delayMs={60}>
          <section className="shell v4-example">
            <h2 className="v4-display v4-h2">{t('exampleH2')}</h2>
            <p className="v4-lede">{t('exampleLine')}</p>
            <div className="v4-sample">
              {example.map((row) => (
                <p key={`${row.dir}-${row.text}`} className={`v4-bubble v4-bubble-${row.dir}`}>
                  <span className="sr-only">{speaker(row.dir)} </span>
                  {row.text}
                </p>
              ))}
            </div>
          </section>
        </FadeInUp>

        <FadeInUp delayMs={60}>
          <section className="shell v4-memory">
            <h2 className="v4-display v4-h2">{t('memoryH2')}</h2>
            <p className="v4-lede">{t('memoryLine')}</p>
            <ul>
              {memory.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </section>
        </FadeInUp>

        <FadeInUp delayMs={60}>
          <section className="shell v4-trust">
            <h2 className="v4-display v4-h2">{t('trustH2')}</h2>
            <p className="v4-lede">{t('trustLine')}</p>
          </section>
        </FadeInUp>
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

      <CtaBand>
        <p
          className="mx-auto max-w-2xl font-display"
          style={{
            fontSize: 'clamp(1.6rem, 3vw, 2.4rem)',
            lineHeight: 1.25,
            letterSpacing: 'var(--tracking-display)',
            fontWeight: 560,
          }}
        >
          {t('ctaLine')}
        </p>
        <div className="mt-8 flex justify-center">{finalDoor}</div>
      </CtaBand>

      <SiteFooter locale={locale} />
    </main>
  );
}
