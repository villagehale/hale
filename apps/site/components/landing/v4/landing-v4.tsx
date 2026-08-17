import Image from 'next/image';
import heroShore from '~/assets/hale-shore-hero.webp';
import { CopyNumberButton } from '~/components/copy-number';
import { FooterThemeSwitch } from '~/components/landing/v4/theme-switch';
import { LandingCta } from '~/components/landing-cta';
import { LogoMark } from '~/components/logo-mark';
import { APP_URL } from '~/lib/app-url';
import { CONTACT_EMAIL, buildSmsHref, buildSmsHrefForBody } from '~/lib/text-entry';

/**
 * v4 — the liquid-glass shore. A CANDIDATE at /v4, never the live landing.
 *
 * The thesis: the name is Hawaiian for home, so the page opens on the shoreline
 * the name comes from — navy-scrimmed behind frosted glass — with the display in
 * Instrument Serif. The Asme aesthetic (glass pills, a serif hero, a dark-first
 * calm) rendered entirely in our own tokens: never black, always the Prussian
 * navy + warm cream + amber, and the whole page — hero included — flips on the
 * footer switch. No third-party video (the reference's CloudFront clips are not
 * ours to ship); the shore still and the glass do the work.
 */

const NAV = [
  { label: 'Pricing', href: '/pricing' },
  { label: 'FAQ', href: '/faq' },
  { label: 'About', href: '/about' },
] as const;

/** Real questions parents send — each opens the composer already holding it, so
 * the first text costs a tap. sms: only; on a laptop the copy chip is the path. */
const CHIPS = [
  'When does swim registration open near me?',
  'My 2-year-old won’t nap — what do I try?',
  'What’s on this weekend for a toddler?',
  'Help me start solids.',
] as const;

const STEPS = [
  {
    step: 'You say hi',
    body: 'One text to my number. No app, no account, no form to fill in.',
  },
  {
    step: 'I send your radar',
    body: 'Names and ages, a postal code — then the week that actually matters near you.',
  },
  {
    step: 'I keep watch',
    body: 'A brief on Monday. A heads-up the week a window opens, the plan the night before. Quiet in between.',
  },
] as const;

const FOOTER_PRODUCT = [
  { label: 'Pricing', href: '/pricing' },
  { label: 'FAQ', href: '/faq' },
  { label: 'Activities', href: '/activities' },
] as const;

const FOOTER_RESOURCES = [
  { label: 'Parenting guides', href: '/answers' },
  { label: 'About', href: '/about' },
  { label: 'Contact', href: '/contact' },
  { label: 'Sign in', href: `${APP_URL}/sign-in` },
] as const;

export function LandingV4({ smsNumber }: { smsNumber: string }) {
  const smsHref = smsNumber ? buildSmsHref(smsNumber, null) : null;

  return (
    <main id="main" tabIndex={-1}>
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
            <a href="/" className="flex items-center gap-2.5" aria-label="Hale, home">
              <LogoMark size={28} />
              <span className="font-serif text-[1.2rem] font-semibold leading-none text-navy">
                Hale
              </span>
            </a>
            <div className="flex items-center gap-6">
              <div className="v4-navlinks">
                {NAV.map((item) => (
                  <a key={item.label} href={item.href} className="v4-navlink">
                    {item.label}
                  </a>
                ))}
              </div>
              {smsHref ? (
                <LandingCta event="landing_cta_text" href={smsHref} className="v4-btn-solid">
                  Text Hale
                </LandingCta>
              ) : (
                <a href={`mailto:${CONTACT_EMAIL}`} className="v4-btn-solid">
                  Email Hale
                </a>
              )}
            </div>
          </nav>
        </header>

        <div className="v4-hero-body">
          <p className="v4-eyebrow">
            Hale · /HAH-leh/ · Hawaiian for home
          </p>
          <h1 className="v4-display v4-hero-h1 text-balance">
            Your family’s quiet
            <br />
            chief of <span className="v4-italic">staff.</span>
          </h1>
          <p className="v4-hero-sub">
            A number you text. Registration dates watched, weekends planned — and nothing sent
            without your say-so. Your data stays in Canada.
          </p>

          <div className="flex flex-wrap items-center justify-center gap-3">
            {smsHref ? (
              <LandingCta event="landing_cta_text" href={smsHref} className="v4-btn-solid v4-glass">
                Text Hale
              </LandingCta>
            ) : (
              <a href={`mailto:${CONTACT_EMAIL}`} className="v4-btn-solid v4-glass">
                Email Hale
              </a>
            )}
            <CopyNumberButton number={smsNumber} className="v4-btn v4-glass" />
          </div>

          {smsNumber && (
            <ul className="v4-chips">
              {CHIPS.map((q) => (
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

      {/* ── How it works — three glass cards ──────────────────────────────── */}
      <section className="shell py-20 lg:py-28">
        <p className="v4-eyebrow text-center">How Hale works</p>
        <h2 className="v4-display mx-auto mt-4 max-w-[16ch] text-center text-[clamp(2rem,5vw,3.4rem)] text-ink">
          Three texts, then <span className="v4-italic text-amber">quiet.</span>
        </h2>
        <div className="v4-cardgrid mt-12">
          {STEPS.map((s, i) => (
            <article key={s.step} className="v4-card v4-glass">
              <p className="v4-card-n">0{i + 1}</p>
              <h3 className="text-spruce">{s.step}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── Closing — the shore, and the founding invitation ──────────────── */}
      <section className="shell pb-24">
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
          <div className="v4-hero-body" style={{ padding: '4.5rem 1.5rem' }}>
            <span className="inline-flex items-center gap-3">
              <LogoMark size={40} />
              <span className="font-serif text-[1.5rem] font-semibold leading-none text-navy">
                Hale
              </span>
            </span>
            <h2 className="v4-display mt-4 text-[clamp(1.9rem,4vw,2.8rem)] text-ink">
              Founding families join <span className="v4-italic text-amber">free.</span>
            </h2>
            <p className="v4-hero-sub">
              I’m free while I’m new, and the families who start now keep their founding rate for
              good. No countdown, no waiting list — just the number.
            </p>
            {smsHref ? (
              <LandingCta event="landing_cta_text" href={smsHref} className="v4-btn-solid v4-glass">
                Text Hale
              </LandingCta>
            ) : (
              <a href={`mailto:${CONTACT_EMAIL}`} className="v4-btn-solid v4-glass">
                Email Hale
              </a>
            )}
          </div>
        </div>
      </section>

      {/* ── Footer — the theme switch lives here, not the header ───────────── */}
      <footer className="border-t border-rule">
        <div className="shell py-12 lg:py-16">
          <div className="flex flex-col justify-between gap-12 lg:flex-row lg:gap-16">
            <div className="lg:max-w-[22rem]">
              <a href="/" className="flex items-center gap-2.5" aria-label="Hale, home">
                <LogoMark size={28} />
                <span className="font-serif text-[1.2rem] font-semibold leading-none text-spruce">
                  Hale
                </span>
              </a>
              <p className="mt-5 text-[13px] leading-[1.6] text-slate-green">
                Hale is the quiet helper for busy families — always prepared, never acting without
                you.
              </p>
              <p className="mt-4 text-[12px] leading-[1.6] text-slate-green">
                Hale <span className="font-mono">/HAH-leh/</span> — Hawaiian for home.
              </p>
              <div className="mt-6">
                <FooterThemeSwitch />
              </div>
            </div>

            <nav aria-label="Footer" className="grid grid-cols-2 gap-8 md:gap-12 lg:w-[38%]">
              <div>
                <h2 className="mb-5 text-[14px] font-semibold text-spruce">Product</h2>
                <ul className="flex flex-col gap-3.5">
                  {FOOTER_PRODUCT.map((item) => (
                    <li key={item.label}>
                      <a
                        href={item.href}
                        className="text-[13px] text-slate-green transition-colors hover:text-spruce"
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h2 className="mb-5 text-[14px] font-semibold text-spruce">Resources</h2>
                <ul className="flex flex-col gap-3.5">
                  {FOOTER_RESOURCES.map((item) => (
                    <li key={item.label}>
                      <a
                        href={item.href}
                        className="text-[13px] text-slate-green transition-colors hover:text-spruce"
                      >
                        {item.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </nav>
          </div>

          <hr className="mb-6 mt-12 border-hair" />

          <div className="text-[13px] leading-[1.6] text-slate-green">
            <p>© {new Date().getFullYear()} Hale. All rights reserved.</p>
            <p className="mt-1">
              Village Hale Technologies Inc., Georgetown, Ontario. Your data stays in Canada.
            </p>
          </div>
        </div>
      </footer>
    </main>
  );
}
