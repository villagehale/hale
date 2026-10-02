import Image from 'next/image';
import heroShore from '~/assets/hale-shore-hero.webp';
import { ChooserLink } from '~/components/chooser-link';
import { CtaBand } from '~/components/cta-band';
import { LandingScrollAnalytics } from '~/components/landing-scroll-analytics';
import { LogoMark } from '~/components/logo-mark';
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
 * The homepage. The shore stays full strength. The hero is a paper calendar
 * on the fridge — hale is home — filling itself with what Hale found. A small
 * iPhone sits beside the calendar: text is the door, the filled year is the outcome.
 *
 * No city, no booking. With no number provisioned the door is email, and the
 * iMessage line is withheld because it would not be true.
 */

interface ThreadRow {
  dir: 'in' | 'out';
  text: string;
}

interface SeasonCard {
  name: string;
  note: string;
}

/** Sunday-first pads. Sliced to the weekday the month opens on — not index keys. */
const PAD_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri'] as const;

/** The month on the fridge is the one a parent is in, in Toronto. */
function fridgeMonth(locale: Locale): { name: string; firstWeekday: number; days: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  // Noon-free UTC anchors: the month number already came from Toronto, and a
  // local midnight on the 1st would fall on the previous evening there.
  const anchor = new Date(Date.UTC(year, month - 1, 1));
  const firstWeekday = anchor.getUTCDay();
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const tag = locale === 'fr' ? 'fr-CA' : locale === 'zh' ? 'zh-CN' : 'en-CA';
  const raw = new Intl.DateTimeFormat(tag, { month: 'long', timeZone: 'UTC' }).format(anchor);
  const name = locale === 'zh' ? raw : raw.charAt(0).toLocaleUpperCase(tag) + raw.slice(1);
  return { name, firstWeekday, days };
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
  const dows = t.raw('boardDow') as string[];
  const seasons = t.raw('seasons') as SeasonCard[];
  const faq = t.raw('faq') as FaqItem[];
  const speaker = (dir: ThreadRow['dir']) => (dir === 'in' ? t('bubbleHale') : t('bubbleYou'));
  const fridge = fridgeMonth(locale);
  const chipLabels = [t('chipSwim'), t('chipSkate'), t('chipCamp')];
  const chips = new Map<number, { label: string; n: number }>();
  let placed = 0;
  for (let day = 1; day <= fridge.days && placed < chipLabels.length; day++) {
    if ((fridge.firstWeekday + day - 1) % 7 !== 6) continue;
    const label = chipLabels[placed];
    if (!label) break;
    placed += 1;
    chips.set(day, { label, n: placed });
  }

  const door = live ? (
    <ChooserLink
      locale={locale}
      placement="hero"
      className="v4-btn-solid v4-btn-apricot"
      smsNumber={smsNumber}
      prefill={prefill}
    >
      {common('textHale')}
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
          width={2200}
          height={943}
          priority
          unoptimized
          className="v4-hero-art"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'center',
          }}
        />
        <div className="v4-hero-body">
          <div className="v4-hero-stage shell">
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
                  <>
                    <p className="v4-hero-channel">{t('heroChannel')}</p>
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
                  </>
                )}
              </div>
            </div>

            <div className="v4-board-slot">
              <p className="sr-only">{t('boardCap', { month: fridge.name })}</p>
              <div className="v4-board" aria-hidden="true">
                <div className="v4-board-head">
                  <LogoMark size={26} />
                  <p className="v4-board-month">{fridge.name}</p>
                </div>
                <div className="v4-board-dows">
                  <span>{dows[0]}</span>
                  <span>{dows[1]}</span>
                  <span>{dows[2]}</span>
                  <span>{dows[3]}</span>
                  <span>{dows[4]}</span>
                  <span>{dows[5]}</span>
                  <span>{dows[6]}</span>
                </div>
                <div className="v4-board-grid">
                  {PAD_KEYS.slice(0, fridge.firstWeekday).map((key) => (
                    <span key={key} className="v4-board-day is-empty" />
                  ))}
                  {Array.from({ length: fridge.days }, (_, i) => {
                    const day = i + 1;
                    const weekday = (fridge.firstWeekday + day - 1) % 7;
                    const weekend = weekday === 0 || weekday === 6;
                    const chip = chips.get(day);
                    return (
                      <span
                        key={day}
                        className={weekend ? 'v4-board-day is-weekend' : 'v4-board-day'}
                      >
                        <span className="v4-board-num">{day}</span>
                        {chip ? (
                          <span className={`v4-board-chip v4-board-chip-${chip.n}`}>
                            {chip.label}
                          </span>
                        ) : null}
                      </span>
                    );
                  })}
                </div>
              </div>
              <div className="v4-phone-overlap">
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
                      {heroBubbles.map((row) => (
                        <span key={`${row.dir}-${row.text}`} className="v4-ios-msg">
                          <p className={`v4-bubble v4-bubble-${row.dir}`}>
                            <span className="sr-only">{speaker(row.dir)} </span>
                            {row.text}
                          </p>
                        </span>
                      ))}
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
        </div>
      </section>

      <div className="v4-home-rest">
        <section className="shell v4-pair">
          <div>
            <h2 className="v4-display v4-h2">{t('findH2')}</h2>
            <p className="v4-lede">{t('findLine')}</p>
          </div>
          <article className="v4-result">
            <p className="v4-beat-kicker">{t('findKicker')}</p>
            <h3>{t('findTitle')}</h3>
            <p>{t('findMeta')}</p>
          </article>
        </section>

        <section className="shell v4-pair v4-pair-flip">
          <div>
            <h2 className="v4-display v4-h2">{t('remindH2')}</h2>
            <p className="v4-lede">{t('remindLine')}</p>
          </div>
          <article className="v4-remind">
            <p className="v4-remind-when">{t('remindWhen')}</p>
            <h3>{t('remindTitle')}</h3>
            <p>{t('remindWhere')}</p>
          </article>
        </section>

        <section className="shell v4-pair">
          <div>
            <h2 className="v4-display v4-h2">{t('yearH2')}</h2>
            <p className="v4-lede">{t('yearLine')}</p>
          </div>
          <div className="v4-seasons">
            {seasons.map((season) => (
              <article key={season.name} className="v4-season">
                <h3>{season.name}</h3>
                <p>{season.note}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="shell v4-pair v4-pair-flip">
          <div>
            <h2 className="v4-display v4-h2">{t('memoryH2')}</h2>
            <p className="v4-lede">{t('memoryLine')}</p>
          </div>
          <article className="v4-memory">
            <h3>{t('memoryName')}</h3>
            <p>{t('memoryNote')}</p>
            <h3>{t('memoryName2')}</h3>
            <p>{t('memoryNote2')}</p>
          </article>
        </section>

        <section className="shell">
          <article className="v4-trust-card">
            <h2 className="v4-display v4-h2">{t('trustH2')}</h2>
            <p className="v4-lede">{t('trustLine')}</p>
          </article>
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
