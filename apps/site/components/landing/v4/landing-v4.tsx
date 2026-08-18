import Image from 'next/image';
import heroShore from '~/assets/hale-shore-hero.webp';
import { CopyNumberButton } from '~/components/copy-number';
import { LandingCta } from '~/components/landing-cta';
import { LogoMark } from '~/components/logo-mark';
import { SiteFooter } from '~/components/site-footer';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { siteJsonLd } from '~/lib/site/structured-data';
import { CONTACT_EMAIL, buildSmsHref, buildSmsHrefForBody } from '~/lib/text-entry';
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

/** The 15 municipalities the radar tracks by name — every one backed by verified
 * registration_windows rows in prod. Kept in sync with the v3 landing. */
const MUNICIPALITIES = [
  'Toronto',
  'Mississauga',
  'Brampton',
  'Markham',
  'Vaughan',
  'Richmond Hill',
  'Oakville',
  'Burlington',
  'Halton Hills',
  'Caledon',
  'Ajax',
  'Pickering',
  'Whitby',
  'Oshawa',
  'Aurora',
] as const;

interface Card {
  title: string;
  body: string;
}
interface Step {
  step: string;
  body: string;
}

export function LandingV4({ locale, smsNumber }: { locale: Locale; smsNumber: string }) {
  const t = getTranslator(locale, 'Landing');
  const common = getTranslator(locale, 'Common');
  const header = getTranslator(locale, 'Header');
  const copy = getTranslator(locale, 'CopyNumber');
  const smsHref = smsNumber ? buildSmsHref(smsNumber, null) : null;

  const nav = [
    { label: header('navPricing'), href: localeHref(locale, '/pricing') },
    { label: header('navFaq'), href: localeHref(locale, '/faq') },
    { label: header('navAbout'), href: localeHref(locale, '/about') },
  ];
  const chips = t.raw('chips') as string[];
  const bubbles = t.raw('threadBubbles') as { dir: 'in' | 'out'; text: string }[];
  const steps = t.raw('steps') as Step[];
  const ladder = t.raw('ladder') as { rung: string; body: string }[];
  const watched = t.raw('watched') as Card[];
  const coaching = t.raw('coaching') as Step[];
  const caregivers = t.raw('caregivers') as Card[];

  return (
    <main id="main" tabIndex={-1}>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd(locale)) }}
      />
      {/* ── Hero — the shore behind glass ─────────────────────────────────── */}
      <section className="v4-hero">
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

        <header>
          <nav className="v4-nav v4-glass" aria-label="Primary">
            <a
              href={localeHref(locale, '/')}
              className="flex items-center gap-2.5"
              aria-label="Hale, home"
            >
              <LogoMark size={28} />
              <span
                className="font-serif text-[1.2rem] font-semibold leading-none text-navy"
                translate="no"
              >
                Hale
              </span>
            </a>
            <div className="flex items-center gap-6">
              <div className="v4-navlinks">
                {nav.map((item) => (
                  <a key={item.label} href={item.href} className="v4-navlink">
                    {item.label}
                  </a>
                ))}
              </div>
              {smsHref ? (
                <LandingCta event="landing_cta_text" href={smsHref} className="v4-btn-solid">
                  {common('textHale')}
                </LandingCta>
              ) : (
                <a href={`mailto:${CONTACT_EMAIL}`} className="v4-btn-solid">
                  {common('emailHale')}
                </a>
              )}
            </div>
          </nav>
        </header>

        <div className="v4-hero-body">
          <p className="v4-eyebrow">{t('eyebrow')}</p>
          <h1 className="v4-display v4-hero-h1 text-balance">
            {t('heroH1a')}
            <br />
            {t('heroH1b')} <span className="v4-italic">{t('heroH1Accent')}</span>
          </h1>
          <p className="v4-hero-sub">{t('heroSub')}</p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            {smsHref ? (
              <LandingCta event="landing_cta_text" href={smsHref} className="v4-btn-solid v4-glass">
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
                className="v4-btn v4-glass"
                label={copy('label')}
                copiedLabel={copy('copied')}
                ariaLabel={copy('aria')}
              />
            )}
          </div>

          {smsNumber && (
            <ul className="v4-chips">
              {chips.map((q) => (
                <li key={q}>
                  <a href={buildSmsHrefForBody(smsNumber, q)} className="v4-chip v4-glass">
                    {q}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ── What texting Hale is like — the thread, made concrete ─────────── */}
      <section className="shell pt-12 sm:pt-20 lg:pt-28">
        <p className="v4-eyebrow text-center">{t('threadEyebrow')}</p>
        <h2 className="v4-display mx-auto mt-4 max-w-[18ch] text-center text-[clamp(1.9rem,4.4vw,3rem)] text-ink">
          {t('threadH2a')} <span className="v4-italic text-amber">{t('threadH2Accent')}</span>
        </h2>
        <p className="v4-lede mx-auto text-center">{t('threadLede')}</p>

        <div className="v4-thread v4-glass mt-6 sm:mt-10">
          <p className="v4-thread-cap">{t('threadCap')}</p>
          {bubbles.map((bubble, i) => (
            <p
              key={`${i}-${bubble.dir}`}
              className={`v4-bubble v4-bubble-${bubble.dir}`}
            >
              {bubble.text}
            </p>
          ))}
        </div>
      </section>

      {/* ── How it works — three glass cards ──────────────────────────────── */}
      <section className="shell py-12 sm:py-20 lg:py-28">
        <p className="v4-eyebrow text-center">{t('howEyebrow')}</p>
        <h2 className="v4-display mx-auto mt-4 max-w-[16ch] text-center text-[clamp(2rem,5vw,3.4rem)] text-ink">
          {t('howH2a')} <span className="v4-italic text-amber">{t('howH2Accent')}</span>
        </h2>
        <ScrollRail className="v4-cardgrid mt-7 sm:mt-12" label={t('howRail')}>
          {steps.map((s, i) => (
            <article key={s.step} className="v4-card v4-glass">
              <p className="v4-card-n">0{i + 1}</p>
              <h3 className="text-spruce">{s.step}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </ScrollRail>

        <div className="v4-panel v4-glass mt-8 sm:mt-14">
          <p className="v4-eyebrow">{t('ladderEyebrow')}</p>
          <ul className="mt-5 flex flex-col gap-3 sm:mt-6 sm:gap-4">
            {ladder.map((item) => (
              <li key={item.rung} className="text-[1.05rem] leading-snug text-spruce">
                <strong className="font-semibold">{item.rung}</strong>{' '}
                <span className="text-slate-green">{item.body}</span>
              </li>
            ))}
          </ul>
          <p className="mt-5 text-[15px] leading-[1.6] text-slate-green sm:mt-6">{t('receipts')}</p>
        </div>
      </section>

      {/* ── What I watch — the radar, by name ─────────────────────────────── */}
      <section className="shell py-12 sm:py-20 lg:py-28">
        <p className="v4-eyebrow">{t('watchEyebrow')}</p>
        <h2 className="v4-display v4-h2 mt-4">
          {t('watchH2Count', { count: MUNICIPALITIES.length })}{' '}
          <span className="v4-italic text-amber">{t('watchH2Accent')}</span>
        </h2>
        <p className="v4-lede">{t('watchLede')}</p>
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
          {t('coachingH2a')} <span className="v4-italic text-amber">{t('coachingH2Accent')}</span>
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
        <ScrollRail className="v4-cardgrid-2 mt-4 sm:mt-6" label={t('coachingCardsRail')}>
          <article className="v4-card v4-glass">
            <h3 className="text-spruce">{t('coachingPlanTitle')}</h3>
            <p>{t('coachingPlanBody')}</p>
          </article>
          <article className="v4-card v4-glass">
            <h3 className="text-spruce">{t('coachingStopTitle')}</h3>
            <p>{t('coachingStopBody')}</p>
          </article>
        </ScrollRail>
      </section>

      {/* ── The caregivers, scoped ────────────────────────────────────────── */}
      <section className="shell py-12 sm:py-20 lg:py-28">
        <p className="v4-eyebrow">{t('helpersEyebrow')}</p>
        <h2 className="v4-display v4-h2 mt-4">
          {t('helpersH2a')} <span className="v4-italic text-amber">{t('helpersH2Accent')}</span>
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
          {t('privacyH2a')} <span className="v4-italic text-amber">{t('privacyH2Accent')}</span>
        </h2>
        <div className="v4-lede">
          <p>{t('privacyBody1')}</p>
          <p className="mt-5">
            {t('privacyBody2Pre')}{' '}
            <a href={localeHref(locale, '/privacy')} className="link">
              {t('privacyLink')}
            </a>
            .
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
              <span
                className="font-serif text-[1.5rem] font-semibold leading-none text-navy"
                translate="no"
              >
                Hale
              </span>
            </span>
            <h2 className="v4-display mt-4 text-[clamp(1.9rem,4vw,2.8rem)] text-ink">
              {t('closingH2a')} <span className="v4-italic text-amber">{t('closingH2Accent')}</span>
            </h2>
            <p className="v4-hero-sub">{t('closingSub')}</p>
            {smsHref ? (
              <LandingCta event="landing_cta_text" href={smsHref} className="v4-btn-solid v4-glass">
                {common('textHale')}
              </LandingCta>
            ) : (
              <a href={`mailto:${CONTACT_EMAIL}`} className="v4-btn-solid v4-glass">
                {common('emailHale')}
              </a>
            )}
          </div>
        </div>
      </section>

      {/* ── Footer — shared with every subpage; the theme switch lives here ── */}
      <SiteFooter locale={locale} />
    </main>
  );
}
