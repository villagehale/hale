import { ArrowUpRight, Check } from 'lucide-react';
import type { Metadata } from 'next';
import { CopyNumberButton } from '~/components/copy-number';
import { CtaBand } from '~/components/cta-band';
import { LandingCta } from '~/components/landing-cta';
import { LandingScrollAnalytics } from '~/components/landing-scroll-analytics';
import { ProductFaqAccordion } from '~/components/product-faq-accordion';
import { QrCode } from '~/components/qr-code';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { type HeadlineSegment, WordsPullUp } from '~/components/words-pull-up';
import { ogLocale } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator, isoToDate } from '~/i18n/server';
import { registrationJsonLd } from '~/lib/registration/structured-data';
import type { RegistrationGuide } from '~/lib/registration/types';
import { chromeCta } from '~/lib/site/chrome-cta';
import { buildSmsHrefForBody, readSmsNumber } from '~/lib/text-entry';

/**
 * Shared chrome for the city-registration landings. The visual source of truth
 * is /about: sticky SiteHeader, shell hero, cream grain band, numbered glass
 * cards, ProductFaqAccordion, navy CtaBand, SiteFooter. Content is municipal
 * dates and the rule that makes parents miss — not a blog article, not /answers.
 *
 * English-only body. Canonical is the unprefixed English path; we do not emit
 * hreflang for FR/ZH until those pages are actually translated.
 */
export function registrationMetadata(guide: RegistrationGuide, locale: Locale): Metadata {
  const { title, description, path } = guide;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: 'article',
      title,
      description,
      url: path,
      siteName: 'Hale',
      locale: ogLocale(locale),
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export function RegistrationGuidePage({
  locale,
  guide,
}: {
  locale: Locale;
  guide: RegistrationGuide;
}) {
  const t = getTranslator(locale, 'Registration');
  const copy = getTranslator(locale, 'CopyNumber');
  const textNs = getTranslator(locale, 'Text');
  const cta = chromeCta(locale);
  const number = readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER);
  const href =
    number && guide.smsPrefill ? buildSmsHrefForBody(number, guide.smsPrefill) : cta.href;

  return (
    <main id="main" tabIndex={-1} className="relative">
      {/* Renders nothing — how far down this money page an ad click actually got,
          `landing_scroll` with a coarse `page` naming which city guide. */}
      <LandingScrollAnalytics page={guide.placement} />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(registrationJsonLd(guide)) }}
      />
      <SiteHeader locale={locale} />

      <section className="shell pt-10 sm:pt-16 pb-8 lg:pb-12">
        <div className="max-w-2xl">
          <span className="eyebrow">{guide.eyebrow}</span>
          <WordsPullUp className="mt-3" segments={guide.h1} />
          <p
            className="reading-measure mt-6 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            {guide.lede}
          </p>
          <p className="meta mt-4">{t('updated', { date: isoToDate(guide.updated) })}</p>
        </div>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="band-cream grain rounded-[24px] px-8 py-8 sm:px-14 sm:py-20 lg:px-20">
          <span className="eyebrow">{guide.datesEyebrow}</span>
          <WordsPullUp as="h2" className="mt-3" segments={guide.datesHeading} />
          <p className="meta mt-5 max-w-2xl text-base" style={{ lineHeight: 1.6 }}>
            {guide.dateNote}
          </p>
          <div className="mt-8 overflow-x-auto">
            <table className="w-full min-w-[20rem] text-left">
              <caption className="sr-only">
                {guide.datesHeading.map((s) => s.text).join(' ')}
              </caption>
              <thead>
                <tr className="border-b border-rule">
                  <th className="pb-3 pr-6 font-display text-spruce">{t('when')}</th>
                  <th className="pb-3 font-display text-spruce">{t('what')}</th>
                </tr>
              </thead>
              <tbody>
                {guide.dateRows.map((row) => (
                  <tr key={`${row.when}-${row.what}`} className="border-b border-rule">
                    <td className="tabular py-3 pr-6 align-top text-spruce">{row.when}</td>
                    <td
                      className="py-3 align-top"
                      style={{ color: 'var(--color-slate-green)', lineHeight: 1.5 }}
                    >
                      {row.what}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* The CTA where the reading happens: the dates table is what the ad
              promised, so the composer is offered right under it rather than only
              eight sections down in the closing band. Same event, its own
              placement, so the two doors stay separable in the one funnel. */}
          <div className="glass-panel mt-8 flex flex-col items-start gap-4 px-6 py-6 sm:flex-row sm:items-center sm:gap-6 sm:px-8">
            <LandingCta
              event="cta_text_click"
              placement={`${guide.placement}_dates`}
              href={href}
              className="btn-primary"
            >
              {cta.label}
            </LandingCta>
            {number ? (
              <CopyNumberButton
                number={number}
                placement={`${guide.placement}_dates`}
                className="link font-medium"
                label={copy('label')}
                copiedLabel={copy('copied')}
                ariaLabel={copy('aria')}
              />
            ) : null}
          </div>
          <p className="meta mt-8 max-w-2xl" style={{ lineHeight: 1.6 }}>
            {guide.unofficialNote}
          </p>
          <ul className="mt-6 flex flex-col gap-3">
            {guide.officialUrls.map((url) => (
              <li key={url.href}>
                <a
                  href={url.href}
                  className="link inline-flex items-center gap-1.5"
                  rel="noreferrer"
                >
                  {url.label}
                  <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="max-w-2xl">
          <span className="eyebrow">{guide.rulesEyebrow}</span>
          <WordsPullUp as="h2" className="mt-3" segments={guide.rulesHeading} />
        </div>
        <ol className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-3 lg:gap-8">
          {guide.ruleCards.map((card, i) => (
            <li key={card.tag} className="glass-panel numbered-card">
              <div className="numbered-card-head">
                <span className="eyebrow">{card.tag}</span>
                <span className="numbered-card-num">0{i + 1}</span>
              </div>
              <h3 className="mt-5 text-[1.15rem] leading-snug">{card.title}</h3>
              <p className="mt-3" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
                {card.line}
              </p>
              <ul className="numbered-card-list">
                {card.checks.map((check) => (
                  <li key={check}>
                    <Check size={16} strokeWidth={2.5} aria-hidden="true" />
                    <span>{check}</span>
                  </li>
                ))}
              </ul>
              {card.linkHref && card.linkLabel ? (
                <a href={localeHref(locale, card.linkHref)} className="quiet-link mt-auto pt-7">
                  {card.linkLabel}
                  <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
                </a>
              ) : null}
            </li>
          ))}
        </ol>
      </section>

      {guide.sections.map((section) => (
        <section key={section.id} className="shell pb-16 lg:pb-24" id={section.id}>
          <div className="max-w-2xl">
            <WordsPullUp as="h2" segments={section.headline} />
            {section.lede ? (
              <p className="meta mt-5 text-lg" style={{ lineHeight: 1.6 }}>
                {section.lede}
              </p>
            ) : null}
            {section.paragraphs.map((paragraph) => (
              <p
                key={paragraph}
                className="reading-measure mt-5 text-lg"
                style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
              >
                {paragraph}
              </p>
            ))}
            {section.bullets && section.bullets.length > 0 ? (
              <ul className="numbered-card-list mt-8">
                {section.bullets.map((bullet) => (
                  <li key={bullet}>
                    <Check size={16} strokeWidth={2.5} aria-hidden="true" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {section.groups?.map((group) => (
              <div key={group.title} className="glass-panel mt-8 px-6 py-7 sm:px-8">
                <h3 className="font-display text-xl text-spruce">{group.title}</h3>
                <ul
                  className="mt-4 flex flex-col gap-3"
                  style={{ color: 'var(--color-slate-green)', lineHeight: 1.5 }}
                >
                  {group.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ))}
            {section.links && section.links.length > 0 ? (
              <ul className="mt-7 flex flex-col gap-3">
                {section.links.map((url) => (
                  <li key={url.href}>
                    <a
                      href={url.href.startsWith('/') ? localeHref(locale, url.href) : url.href}
                      className="link inline-flex items-center gap-1.5"
                      rel={url.href.startsWith('/') ? undefined : 'noreferrer'}
                    >
                      {url.label}
                      <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>
      ))}

      <section className="shell pb-16 lg:pb-24">
        <div className="max-w-2xl">
          <span className="eyebrow">{t('questionsEyebrow')}</span>
          <WordsPullUp
            as="h2"
            className="mt-3"
            segments={t.raw('questionsHeadline') as HeadlineSegment[]}
          />
        </div>
        <div className="mt-10 max-w-3xl">
          <ProductFaqAccordion items={guide.faqs} />
        </div>
      </section>

      <section className="shell pb-16 lg:pb-24">
        <div className="max-w-2xl">
          <span className="eyebrow">{t('officialEyebrow')}</span>
          <WordsPullUp
            as="h2"
            className="mt-3"
            segments={t.raw('officialHeadline') as HeadlineSegment[]}
          />
          <p
            className="reading-measure mt-5 text-lg"
            style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}
          >
            {guide.unofficialNote}
          </p>
          <ul className="mt-7 flex flex-col gap-3">
            {guide.officialUrls.map((url) => (
              <li key={`end-${url.href}`}>
                <a
                  href={url.href}
                  className="link inline-flex items-center gap-1.5"
                  rel="noreferrer"
                >
                  {url.label}
                  <ArrowUpRight size={14} strokeWidth={2.25} aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
          <p className="meta reading-measure mt-8" style={{ lineHeight: 1.6 }}>
            {guide.footerNote}
          </p>
        </div>
      </section>

      <CtaBand>
        <p
          className="mx-auto max-w-2xl font-display"
          style={{
            fontSize: 'clamp(1.4rem, 2.6vw, 2rem)',
            lineHeight: 1.3,
            letterSpacing: 'var(--tracking-display)',
            fontWeight: 600,
          }}
        >
          {guide.ctaHeading}
        </p>
        <p className="cta-sub mx-auto mt-4 max-w-xl" style={{ lineHeight: 1.6 }}>
          {guide.ctaSub}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <LandingCta
            event="cta_text_click"
            placement={guide.placement}
            href={href}
            className="btn-on-navy"
          >
            {cta.label}
          </LandingCta>
          {number ? (
            <CopyNumberButton
              number={number}
              placement={guide.placement}
              className="btn-on-navy-quiet"
              label={copy('label')}
              copiedLabel={copy('copied')}
              ariaLabel={copy('aria')}
            />
          ) : null}
        </div>
        {/* The desktop path made visible: `sms:` is a silent no-op on a laptop
            (rule #11 applied to the funnel), so the band also offers the same URI
            as a scannable code. Hidden on phones, where the button IS the path. */}
        {number ? (
          <div className="mx-auto mt-10 hidden max-w-md items-center gap-6 text-left sm:flex">
            <QrCode value={href} label={textNs('qrAria')} />
            <div>
              <p className="cta-sub font-semibold">{textNs('onLaptop')}</p>
              <p className="cta-sub mt-2 text-sm" style={{ lineHeight: 1.6 }}>
                {textNs('scanHint')}
              </p>
            </div>
          </div>
        ) : null}
      </CtaBand>

      <SiteFooter locale={locale} />
    </main>
  );
}
