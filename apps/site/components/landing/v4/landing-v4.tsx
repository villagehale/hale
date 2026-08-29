import Image from 'next/image';
import heroShore from '~/assets/hale-shore-hero.webp';
import { CopyNumberButton } from '~/components/copy-number';
import { LandingCta } from '~/components/landing-cta';
import { LandingScrollAnalytics } from '~/components/landing-scroll-analytics';
import { LogoMark } from '~/components/logo-mark';
import { QrCode } from '~/components/qr-code';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { Wordmark } from '~/components/wordmark';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { MUNICIPALITIES } from '~/lib/site/municipalities';
import { siteJsonLd } from '~/lib/site/structured-data';
import { CONTACT_EMAIL, buildSmsHref } from '~/lib/text-entry';
import { ScrollRail } from './scroll-rail';

/**
 * v4 — the liquid-glass shore. The live landing, and the design the whole
 * marketing site now wears: the shared chrome (SiteHeader/SiteFooter) and every
 * subpage speak this idiom, so a visitor never crosses from here into the old look.
 *
 * The thesis: the name is Hawaiian for home, so the page opens on the shoreline
 * the name comes from — navy-scrimmed behind frosted glass — with the display in
 * Instrument Serif. The Asme aesthetic (glass pills, a serif hero, a dark-first
 * calm) rendered entirely in our own tokens: never black, always the Prussian
 * navy + warm cream + amber, and the whole page — hero included — flips on the
 * footer switch. No third-party video (the reference's CloudFront clips are not
 * ours to ship); the shore still and the glass do the work.
 *
 * All copy is keyed by locale (`Landing` namespace); the 15 municipalities are
 * proper nouns and stay as data.
 */

interface Card {
  title: string;
  body: string;
}
interface Step {
  step: string;
  body: string;
}
/** A step that also says WHEN it happens — the how-it-works trio only. */
interface TimedStep extends Step {
  when: string;
}
/** A thread row: a message from either side, or the timestamp that separates two
 * legs of the registration sequence. */
interface ThreadRow {
  dir: 'in' | 'out' | 'time';
  text: string;
}

export function LandingV4({ locale, smsNumber }: { locale: Locale; smsNumber: string }) {
  const t = getTranslator(locale, 'Landing');
  const common = getTranslator(locale, 'Common');
  const copy = getTranslator(locale, 'CopyNumber');
  const textNs = getTranslator(locale, 'Text');
  const smsHref = smsNumber ? buildSmsHref(smsNumber, null) : null;

  const bubbles = t.raw('threadBubbles') as ThreadRow[];
  const steps = t.raw('steps') as TimedStep[];
  const contrast = t.raw('contrast') as Card[];
  const watched = t.raw('watched') as Card[];
  const coaching = t.raw('coaching') as Step[];
  const caregivers = t.raw('caregivers') as Card[];

  return (
    <main id="main" tabIndex={-1}>
      {/* Renders nothing — how far down this long page a reader actually got, which is
          the only signal it has about whether the scroll earns the closing CTA. */}
      <LandingScrollAnalytics />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd(locale)) }}
      />
      {/* The landing wears the SHARED sticky bar, byte-identical to every subpage
          (site-chrome.test.ts pins it) rather than a second copy of the same pill
          inline in the hero. It keeps the over-hero look because the hero below
          runs UNDER it: .v4-hero-top pulls the section up by the bar's height and
          pads it back, so the shore still fills the viewport from y=0. */}
      <SiteHeader locale={locale} />

      {/* ── Hero — the shore behind glass ─────────────────────────────────── */}
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
        <span className="v4-hero-scrim" aria-hidden="true" />

        <div className="v4-hero-body">
          <p className="v4-eyebrow v4-pronounce">{t('eyebrow')}</p>
          <h1 className="v4-display v4-hero-h1 text-balance">
            {t('heroH1a')}
            <br />
            {t('heroH1b')} <span className="v4-accent">{t('heroH1Accent')}</span>
          </h1>
          <p className="v4-hero-sub">{t('heroSub', { count: MUNICIPALITIES.length })}</p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            {smsHref ? (
              <LandingCta
                event="cta_text_click"
                placement="hero"
                href={smsHref}
                className="v4-btn-solid v4-glass"
              >
                {common('textHale')}
              </LandingCta>
            ) : (
              <a href={`mailto:${CONTACT_EMAIL}`} className="v4-btn-solid v4-glass">
                {common('emailHale')}
              </a>
            )}
            {smsNumber && (
              <CopyNumberButton
                number={smsNumber}
                placement="hero"
                className="v4-btn v4-glass"
                label={copy('label')}
                copiedLabel={copy('copied')}
                ariaLabel={copy('aria')}
              />
            )}
          </div>
        </div>
      </section>

      {/*
        ── The thread — ONE registration, start to finish ───────────────────
        Not a montage of what Hale can do: the single conversation the flagship
        job produces, from the warning a week out to the receipt. The bubbles are
        the sentences apps/web/lib/registration/sequence/copy.ts actually renders
        for the verified Halton Hills row, and the timestamps between them are
        that sequence's own intervals (schedule.ts: HEADS_UP_LEAD_DAYS,
        BATTLE_PLAN_MINUTE_LOCAL, GO_LEAD_MINUTES, CHECK_IN_LEAD_HOURS).

        Two deliberate departures from the live renderer, both so a page that
        outlives one registration cycle stays true: the demo prints the row's
        published WEEKDAY where the real heads-up prints "Sep 1, 7:00 a.m.", and
        a bare season where it prints the "Fall 2026" cycle label.

        The coaching exchange that used to share this slot moved out rather than
        being kept alongside — breadth is already claimed above it (the hero
        sub), so the product shot can afford depth.
      */}
      <section className="shell pt-12 sm:pt-20 lg:pt-28">
        <p className="v4-eyebrow text-center">{t('threadEyebrow')}</p>
        <h2 className="v4-display mx-auto mt-4 max-w-[18ch] text-center text-[clamp(1.9rem,4.4vw,3rem)] text-ink">
          {t('threadH2a')} <span className="v4-accent">{t('threadH2Accent')}</span>
        </h2>
        <p className="v4-lede mx-auto text-center">{t('threadLede')}</p>

        <div className="v4-thread v4-glass mt-6 sm:mt-10">
          <p className="v4-thread-cap">{t('threadCap')}</p>
          {bubbles.map((row, i) => (
            <p
              key={`${i}-${row.dir}`}
              className={row.dir === 'time' ? 'v4-thread-time' : `v4-bubble v4-bubble-${row.dir}`}
            >
              {row.text}
            </p>
          ))}
        </div>
      </section>

      {/* ── How it works — three glass cards ──────────────────────────────── */}
      <section className="shell py-12 sm:py-20 lg:py-28">
        <p className="v4-eyebrow text-center">{t('howEyebrow')}</p>
        <h2 className="v4-display v4-h2-wide mx-auto mt-4 max-w-[16ch] text-center">
          {t('howH2a')} <span className="v4-accent">{t('howH2Accent')}</span>
        </h2>
        <ScrollRail className="v4-cardgrid mt-7 sm:mt-12" label={t('howRail')}>
          {steps.map((s, i) => (
            <article key={s.step} className="v4-card v4-glass">
              {/* The numeral already carries the order, so the empty half of its
               * line carries the first-week contract instead: when each step
               * actually happens. Step three is "then every week" rather than a
               * named day — the body names Sunday, the day weekly_plan ships
               * (VIL-218 / F11). */}
              <p className="v4-card-n">
                0{i + 1}
                <span className="v4-when">{s.when}</span>
              </p>
              <h3 className="text-spruce">{s.step}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </ScrollRail>

        {/* The consent ladder, in one breath — the full three rungs live on /about. */}
        <div className="v4-panel v4-glass mt-8 sm:mt-14">
          <p className="text-[1.05rem] leading-[1.6] text-spruce">{t('consentLine')}</p>
        </div>
      </section>

      {/* ── What I watch — the radar, by name ─────────────────────────────── */}
      <section className="shell py-12 sm:py-20 lg:py-28">
        <p className="v4-eyebrow">{t('watchEyebrow')}</p>
        <h2 className="v4-display v4-h2 mt-4">
          {t('watchH2Count', { count: MUNICIPALITIES.length })}{' '}
          <span className="v4-accent">{t('watchH2Accent')}</span>
        </h2>
        <p className="v4-lede">{t('watchLede', { count: MUNICIPALITIES.length })}</p>
        {/* The four sourced facts used to run together in that lede as one
         * 55-word sentence. They are the same four, word for word — only now
         * they sit on the side of a contrast, which is the shape an argument
         * about a 7:02 sell-out wants. The with-me cell deliberately does NOT
         * restate the ladder: the thread above shows it and step three sums it
         * up, and a third telling is what makes a landing page long. */}
        <div className="v4-contrast v4-panel v4-glass mt-5 sm:mt-8">
          {contrast.map((cell) => (
            <div key={cell.title}>
              <h3 className="text-spruce">{cell.title}</h3>
              <p>{cell.body}</p>
            </div>
          ))}
        </div>
        <ul className="v4-pills mt-5 sm:mt-8">
          {MUNICIPALITIES.map((city) => (
            <li key={city} className="v4-pill v4-glass">
              {city}
            </li>
          ))}
        </ul>
        <ScrollRail className="v4-cardgrid-4 mt-7 sm:mt-12" label={t('watchRail')}>
          {watched.map((item) => (
            <article key={item.title} className="v4-card v4-glass">
              <h3 className="text-spruce">{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </ScrollRail>
      </section>

      {/* ── Coaching — the questions that aren't scheduling ───────────────── */}
      <section className="shell py-12 sm:py-20 lg:py-28">
        <p className="v4-eyebrow">{t('coachingEyebrow')}</p>
        <h2 className="v4-display v4-h2 mt-4">
          {t('coachingH2a')} <span className="v4-accent">{t('coachingH2Accent')}</span>
        </h2>
        <p className="v4-lede">{t('coachingLede')}</p>
        <ScrollRail as="ol" className="v4-cardgrid mt-7 sm:mt-12" label={t('coachingRail')}>
          {coaching.map((item, i) => (
            <li key={item.step} className="v4-card v4-glass">
              <p className="v4-card-n">0{i + 1}</p>
              <h3 className="text-spruce">{item.step}</h3>
              <p>{item.body}</p>
            </li>
          ))}
        </ScrollRail>
        {/* The medical boundary keeps its own card — the topic list moved to the FAQ. */}
        <article className="v4-card v4-glass mt-4 sm:mt-6">
          <h3 className="text-spruce">{t('coachingStopTitle')}</h3>
          <p>{t('coachingStopBody')}</p>
        </article>
      </section>

      {/* ── The caregivers, scoped ────────────────────────────────────────── */}
      <section className="shell py-12 sm:py-20 lg:py-28">
        <p className="v4-eyebrow">{t('helpersEyebrow')}</p>
        <h2 className="v4-display v4-h2 mt-4">
          {t('helpersH2a')} <span className="v4-accent">{t('helpersH2Accent')}</span>
        </h2>
        <ScrollRail className="v4-cardgrid-2 mt-6 sm:mt-10" label={t('helpersRail')}>
          {caregivers.map((item) => (
            <article key={item.title} className="v4-card v4-glass">
              <h3 className="text-spruce">{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </ScrollRail>
      </section>

      {/* ── Privacy, the Canadian way ─────────────────────────────────────── */}
      <section className="shell py-12 sm:py-20 lg:py-28">
        <p className="v4-eyebrow">{t('privacyEyebrow')}</p>
        <h2 className="v4-display v4-h2 mt-4">
          {t('privacyH2a')} <span className="v4-accent">{t('privacyH2Accent')}</span>
        </h2>
        <div className="v4-lede">
          <p>{t('privacyBody1')}</p>
          <p className="mt-5">
            <a href={localeHref(locale, '/privacy')} className="link">
              {t('privacyLink')}
            </a>
          </p>
        </div>
      </section>

      {/* ── Closing — the shore, and the founding invitation ──────────────── */}
      <section className="shell pb-14 sm:pb-24">
        <div className="v4-hero" style={{ minHeight: 'auto', borderRadius: 'var(--r-xl)' }}>
          <Image
            src={heroShore}
            alt=""
            aria-hidden="true"
            fill
            sizes="(max-width: 1100px) 100vw, 1100px"
            className="v4-hero-art"
            style={{ borderRadius: 'var(--r-xl)' }}
          />
          <span
            className="v4-hero-scrim"
            aria-hidden="true"
            style={{ borderRadius: 'var(--r-xl)' }}
          />
          <div className="v4-hero-body v4-closing-body">
            <span className="inline-flex items-center gap-3">
              <LogoMark size={40} />
              <Wordmark className="h-[1.6rem] text-navy" />
            </span>
            <h2 className="v4-display mt-4 text-[clamp(1.9rem,4vw,2.8rem)] text-ink">
              {t('closingH2a')} <span className="v4-accent">{t('closingH2Accent')}</span>
            </h2>
            <p className="v4-hero-sub">{t('closingSub')}</p>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {smsHref ? (
                <LandingCta
                  event="cta_text_click"
                  placement="closing"
                  href={smsHref}
                  className="v4-btn-solid v4-glass"
                >
                  {common('textHale')}
                </LandingCta>
              ) : (
                <a href={`mailto:${CONTACT_EMAIL}`} className="v4-btn-solid v4-glass">
                  {common('emailHale')}
                </a>
              )}
              {smsNumber && (
                <CopyNumberButton
                  number={smsNumber}
                  placement="closing"
                  className="v4-btn v4-glass"
                  label={copy('label')}
                  copiedLabel={copy('copied')}
                  ariaLabel={copy('aria')}
                />
              )}
            </div>
            {/* The desktop path made visible: `sms:` is a silent no-op on a laptop
                (rule #11 applied to the funnel), so the close also offers the same
                URI as a scannable code. Hidden on phones, where the button IS the
                path. */}
            {smsHref && (
              <div className="mt-8 hidden items-center gap-6 text-left sm:flex">
                <QrCode value={smsHref} label={textNs('qrAria')} />
                <div className="max-w-sm">
                  <p className="font-semibold">{textNs('onLaptop')}</p>
                  <p className="meta mt-2 text-sm" style={{ lineHeight: 1.6 }}>
                    {textNs('scanHint')}
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ── Footer — shared with every subpage; the theme switch lives here ── */}
      <SiteFooter locale={locale} />
    </main>
  );
}
