import Image from 'next/image';
import heroShore from '~/assets/hale-shore-hero.webp';
import { ChooserLink } from '~/components/chooser-link';
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
import { type Find, FindList } from './find-list';
import { type LoopBeat, LoopThread } from './loop-thread';
import { ScrollRail } from './scroll-rail';

/**
 * v5 — the loop as the hero.
 *
 * v4 opened on the shoreline the name comes from and proved the product with two
 * conversations and seven carded sections. It was a good page about WHAT Hale is.
 * v5 is a page about what Hale DOES, which is a loop: it finds what is on, it
 * watches the sign-up morning, it hands over the town's own link, and it comes
 * back that evening and asks. Four beats the product already ships, in the
 * product's own sentences, on a spine that draws the days between them.
 *
 * Three subtractions carry the departure, and each is one line of code:
 *   - the tracked ALL-CAPS eyebrow drops from seven sections to TWO, where it
 *     marks a real change of subject rather than decorating every heading;
 *   - the middle-dot pronunciation string leaves the hero and lives once, in the
 *     footer, where it is brand and not chrome;
 *   - the `→` comes off the CTA label. The label already says the verb.
 * The 01/02/03 numerals went with the how-it-works card grid: the sequence is the
 * spine now, and numbering it twice is the same conversation printed twice. Ten
 * identical-radius cards become ONE grid — the four watched things, which are
 * genuinely four peer things.
 *
 * THE SHORE LEAVES THE HERO and survives in the closing band, where the argument
 * IS home — which is what it was always for. Five beats and a spine over a
 * scrimmed photograph means re-measuring a contrast ladder tuned for three
 * bubbles, for a background arguing a different point. The hero's LCP element
 * becomes the h1, and one priority image leaves the critical path.
 *
 * No palette change, no new face, no new size, and the theme mechanism is
 * untouched: every themed value is still one `light-dark()` pair. The one new
 * token is `--v5-spine`, a hairline, which is a fill and therefore legal amber.
 */

interface Card {
  title: string;
  body: string;
}

export function LandingV5({ locale, smsNumber }: { locale: Locale; smsNumber: string }) {
  const t = getTranslator(locale, 'Landing');
  const common = getTranslator(locale, 'Common');
  const textNs = getTranslator(locale, 'Text');
  const smsHref = smsNumber ? buildSmsHref(smsNumber, null) : null;

  const beats = t.raw('heroLoop') as LoopBeat[];
  const finds = t.raw('finds') as Find[];
  const contrast = t.raw('contrast') as Card[];
  const watched = t.raw('watched') as Card[];
  const howLines = t.raw('howLines') as string[];

  /**
   * Who said it. A bubble's side is drawn with `align-self` and a fill, so
   * direction is a visual cue only, and a reader who cannot see the alignment
   * gets a bare "YES" with no idea whose turn it was.
   */
  const speaker = (dir: 'in' | 'out') => (dir === 'in' ? t('bubbleHale') : t('bubbleYou'));

  const cta = (placement: 'hero' | 'closing') =>
    smsHref ? (
      <ChooserLink locale={locale} placement={placement} className="v4-btn-solid v4-glass">
        {common('textHale')}
      </ChooserLink>
    ) : (
      <a href={`mailto:${CONTACT_EMAIL}`} className="v4-btn-solid v4-glass">
        {common('emailHale')}
      </a>
    );

  return (
    <main id="main" tabIndex={-1}>
      {/* Renders nothing — how far down this page a reader actually got, which is
          the only signal it has about whether the scroll earns the closing CTA.
          Mounted bare: an absent `page` keeps meaning "the landing" in the
          historical rows. */}
      <LandingScrollAnalytics />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd(locale)) }}
      />
      <SiteHeader locale={locale} />

      {/* ── Hero — the loop on its spine ──────────────────────────────────
          Still pulled up under the shared glass pill (.v4-hero-top) so the page
          ground meets the top of the viewport and the bar floats over it, as it
          has since v4. What changed underneath is that there is no artwork to
          meet: the hero is the page's own canvas now, and the type is
          left-aligned, because a message does not centre. */}
      <section className="v5-hero v4-hero-top shell">
        <h1 className="v4-display v4-hero-h1">
          {t('heroH1a')}
          <br />
          {t('heroH1b')} <span className="v4-accent">{t('heroH1Accent')}</span>
        </h1>
        <p className="v4-hero-sub v5-hero-sub">{t('heroSub')}</p>

        <LoopThread beats={beats} cap={t('heroLoopCap')} speaker={speaker} />

        <div className="v5-hero-offer">
          <p className="v4-hero-founding">{t('heroFounding')}</p>
          <div className="flex flex-wrap items-center gap-3">{cta('hero')}</div>
          {smsHref && (
            <p className="v4-hero-terms">
              {t('heroTerms')}{' '}
              <a href={localeHref(locale, '/privacy')} className="underline underline-offset-2">
                {t('heroTermsLink')}
              </a>
              .
            </p>
          )}
        </div>
      </section>

      {/* ── §1 Find — three things, not thirty ───────────────────────────── */}
      <section className="shell py-12 sm:py-20 lg:py-28">
        <p className="v4-eyebrow">{t('findEyebrow')}</p>
        <h2 className="v4-display v4-h2 mt-4">
          {t('findH2a')} <span className="v4-accent">{t('findH2Accent')}</span>
        </h2>
        <p className="v4-lede">{t('findLede')}</p>
        <p className="sr-only">{t('findCap')}</p>
        <FindList finds={finds} noTime={t('findNoTime')} />
        {/* The section's whole point, and it is the tool's own contract: a null
            `when` is the source not having published one, and the honest move is
            to say so rather than guess a day. */}
        <p className="v5-honesty">{t('findHonesty')}</p>
      </section>

      {/* ── §2 Never miss it — the radar, by name ─────────────────────────── */}
      <section className="shell py-12 sm:py-20 lg:py-28">
        <p className="v4-eyebrow">{t('watchEyebrow')}</p>
        <h2 className="v4-display v4-h2 mt-4">
          {t('watchH2a')} <span className="v4-accent">{t('watchH2Accent')}</span>
        </h2>
        <p className="v4-lede">{t('watchLede', { count: MUNICIPALITIES.length })}</p>
        {/* The four sourced facts, word for word from v4. They are the best
            writing on the site and they are already policed against invention;
            the layout stacks and never rails, because a before/after that rails
            on a phone shows only the "before". */}
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
        {/* The page's ONE card grid: four peer things, which is what a grid is
            for. Everything else on this page is thread, list or prose. */}
        <ScrollRail className="v4-cardgrid-4 mt-7 sm:mt-12" label={t('watchRail')}>
          {watched.map((item) => (
            <article key={item.title} className="v4-card v4-glass">
              <h3 className="text-spruce">{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </ScrollRail>
        <p className="v5-honesty">{t('watchSpots')}</p>
      </section>

      {/* ── §3 See how it goes — the beat nobody else has ─────────────────── */}
      <section className="shell py-12 sm:py-20 lg:py-28">
        <h2 className="v4-display v4-h2">
          {t('seeH2a')} <span className="v4-accent">{t('seeH2Accent')}</span>
        </h2>
        {/* What a day note is FOR, and what it is not: family_check_in_notes is
            read by nothing but the rights export and the thirty-day purge, so the
            page claims the retention rule the code keeps and claims nothing about
            the note shaping a later suggestion. */}
        <p className="v4-lede">{t('seeBody')}</p>
      </section>

      {/* ── §4 How it works — prose, no numerals ──────────────────────────── */}
      <section className="shell py-12 sm:py-20 lg:py-28">
        <h2 className="v4-display v4-h2">
          {t('howH2a')} <span className="v4-accent">{t('howH2Accent')}</span>
        </h2>
        <div className="v5-prose">
          {howLines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <p>
            {t('howConnectors')}{' '}
            <a href={localeHref(locale, '/privacy')} className="link">
              {t('privacyLink')}
            </a>
            .
          </p>
        </div>
        <div className="v4-panel v4-glass mt-8 sm:mt-12">
          <p className="text-[1.05rem] leading-[1.6] text-spruce">{t('consentLine')}</p>
        </div>
      </section>

      {/* ── §5 For centres — one line and a link, never a band ────────────
          The landing has exactly one audience and one job. A card band for a
          second audience at the bottom is what makes a landing page long, and
          the full argument already has its own page. */}
      <section className="shell pb-12 sm:pb-16">
        <p className="v5-aside">
          {t('centresLine')}{' '}
          <a href={localeHref(locale, '/for-centres')} className="link">
            {t('centresLink')}
          </a>
          .
        </p>
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
            <div className="flex flex-wrap items-center justify-center gap-3">{cta('closing')}</div>
            {/* The desktop path made visible: `sms:` is a silent no-op on a
                laptop, so the close also offers the same URI as a scannable code.
                On glass, not straight on the water, where `.meta` measured
                4.09:1 on rendered pixels. */}
            {smsHref && (
              <div className="v4-glass mt-8 hidden items-center gap-6 rounded-[var(--r-lg)] p-5 text-left sm:flex">
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

      <SiteFooter locale={locale} />
    </main>
  );
}
