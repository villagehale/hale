import { Fragment } from 'react';
import { LandingCta } from '~/components/landing-cta';
import { LogoMark } from '~/components/logo-mark';
import { QrCode } from '~/components/qr-code';
import { APP_URL } from '~/lib/app-url';
import { siteJsonLd } from '~/lib/site/structured-data';
import { buildSmsHref, CONTACT_EMAIL } from '~/lib/text-entry';
import { fanStyleSheet } from './choreography';
import { CopyNumberButton } from './copy-number';
import { MomentCard, PalletDeck } from './deck';
import { MOMENTS } from './moments';
import { ThemeToggle } from './theme-toggle';

/**
 * Landing v2b — the "Pallet" variant, built for side-by-side comparison against
 * v2. One signature carries the page: seven cards, each a real Hale exchange,
 * that fan across the hero, gather into a single stack (which is the argument —
 * one number handles all of it), descend, and cascade into a ladder beside the
 * section that names the seven jobs.
 *
 * Nothing here claims a capability that isn't live, and nothing invents a fact:
 * every card traces to a source in moments.ts, the municipality list is pinned
 * against the live page's own list, and with no number provisioned the page
 * offers email rather than a dead `sms:` link.
 *
 * The number's digits are never rendered. On a phone the `sms:` link opens the
 * composer; on a laptop the number travels by QR code or clipboard.
 */

const SIGN_IN = `${APP_URL}/sign-in`;

/**
 * Mirrors the municipality list on the live page (chief-of-staff.tsx) — every
 * one backed by verified registration_windows rows in prod. Duplicated rather
 * than imported because the live page keeps it as a private const, and pinned
 * against that source by pallet-v2b.test.ts so the two cannot drift.
 */
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

/** The hero teaser — the natural-replies beat, in three bubbles. */
const HERO_BUBBLES = [
  { from: 'parent', text: 'max has a bday party sat 2pm at riverdale farm' },
  { from: 'hale', text: "Add Max's birthday party - Sat, Aug 23 at 2pm, Riverdale Farm?" },
  { from: 'parent', text: 'yeah go ahead' },
] as const;

const FOOTER_LINKS = [
  { label: 'FAQ', href: '/faq' },
  { label: 'Privacy', href: '/privacy' },
  { label: 'Terms', href: '/terms' },
  { label: 'Contact', href: '/contact' },
  { label: 'Sign in', href: SIGN_IN },
] as const;

export function PalletLandingV2b({ smsNumber }: { smsNumber: string }) {
  const smsHref = smsNumber ? buildSmsHref(smsNumber, null) : null;
  const mailHref = `mailto:${CONTACT_EMAIL}`;

  return (
    <PalletDeck>
      <style
        // biome-ignore lint/security/noDangerouslySetInnerHtml: generated from the choreography's own tables (no user input) so the fan's first painted frame needs no JavaScript.
        dangerouslySetInnerHTML={{ __html: fanStyleSheet(MOMENTS.length) }}
      />

      <header data-v2b="header" className="v2b-header">
        <a href="/" className="v2b-brand">
          <LogoMark size={30} />
          <span className="v2b-wordmark">Hale</span>
        </a>
        <div className="v2b-header-right">
          <ThemeToggle />
          {smsHref ? (
            <LandingCta
              event="landing_cta_text"
              href={smsHref}
              className="v2b-btn v2b-btn-compact"
            >
              Text Hale
            </LandingCta>
          ) : (
            <a href={mailHref} className="v2b-btn v2b-btn-compact">
              Email Hale
            </a>
          )}
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(siteJsonLd()) }}
        />

        {/* ── The pinned stage: hero → gather → descend → cascade ─────────── */}
        <div data-v2b="track" className="v2b-track">
          <div className="v2b-pin">
            <div className="v2b-layer v2b-layer-copy" data-v2b="hero">
              <div className="v2b-hero">
                <div className="v2b-hero-grid">
                  <div>
                    <span
                      className="v2b-eyebrow v2b-word"
                      style={{ animationDelay: '80ms' }}
                    >
                      Toronto and the GTA
                    </span>
                    <h1 className="v2b-h1">
                      <RevealWords text="Hi, I’m Hale —" baseMs={220} />
                      <span className="v2b-word v2b-serif" style={{ animationDelay: '420ms' }}>
                        your family’s quiet chief of staff.
                      </span>
                    </h1>
                    <p className="v2b-sub">
                      <RevealWords
                        text="I keep watch over your week — registrations, programs, checkups, weather — and text you before things matter."
                        baseMs={620}
                        stepMs={20}
                      />
                    </p>

                    {smsHref ? (
                      <>
                        <div className="v2b-ctarow">
                          <LandingCta
                            event="landing_cta_text"
                            href={smsHref}
                            className="v2b-btn"
                          >
                            Text Hale
                          </LandingCta>
                          <p className="v2b-meta" style={{ maxWidth: '19rem' }}>
                            Your message is already written. You send it; I never text first.
                          </p>
                        </div>

                        <div className="v2b-qr">
                          <span className="v2b-qr-tile">
                            <QrCode value={smsHref} size={104} />
                          </span>
                          <div>
                            <p className="v2b-meta" style={{ marginTop: 0 }}>
                              On a laptop? Scan this with your phone’s camera, or take my number
                              with you.
                            </p>
                            <div style={{ marginTop: '0.7rem' }}>
                              <CopyNumberButton number={smsNumber} />
                            </div>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="v2b-ctarow">
                        <a href={mailHref} className="v2b-btn">
                          Email Hale
                        </a>
                        <p className="v2b-meta" style={{ maxWidth: '19rem' }}>
                          The number’s coming. Until it answers, email is the honest way to reach
                          me.
                        </p>
                      </div>
                    )}
                  </div>

                  <ol className="v2b-bubbles" aria-label="An example exchange">
                    {HERO_BUBBLES.map((bubble, i) => (
                      <li
                        key={bubble.text}
                        className={`v2b-bubble v2b-bubble-${bubble.from}`}
                        style={
                          {
                            '--v2b-jelly-delay': `${900 + i * 620}ms`,
                          } as React.CSSProperties
                        }
                      >
                        <span className="sr-only">
                          {bubble.from === 'parent' ? 'Parent: ' : 'Hale: '}
                        </span>
                        {bubble.text}
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            </div>

            <div
              className="v2b-deck"
              data-v2b="deck"
              data-intro="running"
              data-phase="fan"
              aria-label="Seven things Hale does, as example messages"
            >
              {MOMENTS.map((moment) => (
                <MomentCard key={moment.id} moment={moment} />
              ))}
            </div>

            <div className="v2b-stackcap" data-v2b="cap" aria-hidden="true">
              <p>One number handles all of it.</p>
              <span>Example messages — the names, dates and places change with your family.</span>
            </div>

            <div className="v2b-layer v2b-layer-copy" data-v2b="s2">
              <div className="v2b-s2">
                <div className="v2b-s2-copy">
                  <span className="v2b-eyebrow">What I take off your plate</span>
                  <h2 className="v2b-h2">
                    <span>Seven jobs.</span>
                    <span>
                      <span className="v2b-highlight">One number.</span>
                    </span>
                    <span>Nothing sent without you.</span>
                  </h2>
                  <p className="v2b-body">
                    Registration windows, coaching plans, calendar invites, introductions, the
                    Monday brief. I prepare each one and wait — nothing reaches the outside world
                    until you say so.
                  </p>

                  <div className="v2b-ctarow">
                    {smsHref ? (
                      <LandingCta event="landing_cta_text" href={smsHref} className="v2b-btn">
                        Text Hale
                      </LandingCta>
                    ) : (
                      <a href={mailHref} className="v2b-btn">
                        Email Hale
                      </a>
                    )}
                    <a href="/faq" className="v2b-btn v2b-btn-ghost">
                      The answers parents ask for most
                    </a>
                  </div>

                  <div className="v2b-tags" data-v2b="tags">
                    <span className="v2b-tag v2b-tag-amber" style={{ '--v2b-jelly-delay': '0ms' } as React.CSSProperties}>
                      {MUNICIPALITIES.length} municipalities, by name
                    </span>
                    <span className="v2b-tag v2b-tag-navy" style={{ '--v2b-jelly-delay': '220ms' } as React.CSSProperties}>
                      Your data stays in Canada
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Coverage, by name ───────────────────────────────────────────── */}
        <section className="v2b-section v2b-band">
          <div className="v2b-shell">
            <span className="v2b-eyebrow">What I watch</span>
            <h2 className="v2b-h2" style={{ maxWidth: '34rem' }}>
              {MUNICIPALITIES.length} municipalities,{' '}
              <span className="v2b-serif" style={{ display: 'inline' }}>
                by name.
              </span>
            </h2>
            <p className="v2b-body" style={{ maxWidth: '38rem' }}>
              Registration opens at 7 a.m. on a Tuesday and fills before breakfast. I follow the
              calendars where you live, so nobody has to keep a tab open.
            </p>
            <ul className="v2b-pills">
              {MUNICIPALITIES.map((city) => (
                <li key={city} className="v2b-pill">
                  {city}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── The close ───────────────────────────────────────────────────── */}
        <section className="v2b-section">
          <div className="v2b-close">
            <h2>Founding families</h2>
            <p>
              I’m free while I’m new, and the families who start now keep their founding rate for
              good. No countdown, no waiting list — just the number.
            </p>
            <div
              className="v2b-ctarow"
              style={{ justifyContent: 'center', marginTop: '2rem' }}
            >
              {smsHref ? (
                <>
                  <LandingCta event="landing_cta_text" href={smsHref} className="v2b-btn">
                    Text Hale
                  </LandingCta>
                  <CopyNumberButton number={smsNumber} />
                </>
              ) : (
                <a href={mailHref} className="v2b-btn">
                  Email Hale
                </a>
              )}
            </div>
            <p className="v2b-close-note">
              Standard message rates apply; reply STOP any time.
            </p>
          </div>
        </section>

        <p className="v2b-meta" style={{ textAlign: 'center', paddingBottom: '4rem' }}>
          More questions?{' '}
          <a href="/faq" className="v2b-link">
            The answers parents ask for most
          </a>
          .
        </p>
      </main>

      <footer className="v2b-footer">
        <div className="v2b-footer-in">
          <div>
            <span className="v2b-wordmark">Hale</span>
            <p className="v2b-meta" style={{ marginTop: '0.75rem' }}>
              Village Hale Technologies Inc., Georgetown, Ontario. Your data stays in Canada.
            </p>
            <p className="v2b-meta">© {new Date().getFullYear()} Hale.</p>
          </div>
          <nav aria-label="Footer">
            {FOOTER_LINKS.map((item) => (
              <a key={item.label} href={item.href}>
                {item.label}
              </a>
            ))}
          </nav>
        </div>
      </footer>

      {/* The #453 conversion rule, kept: on a phone the way in is always one tap
          away, at every scroll position. */}
      {smsHref && (
        <div className="v2b-sticky-cta">
          <span className="v2b-meta" style={{ maxWidth: '11rem' }}>
            No app. No account.
          </span>
          <LandingCta
            event="landing_cta_text"
            href={smsHref}
            className="v2b-btn v2b-btn-compact"
          >
            Text Hale
          </LandingCta>
        </div>
      )}
    </PalletDeck>
  );
}

/**
 * Word-by-word rise for the hero copy. The words stay real text in the DOM, each
 * carrying a staggered delay; `.v2b-word` holds still under reduced motion.
 */
function RevealWords({
  text,
  baseMs,
  stepMs = 42,
}: {
  text: string;
  baseMs: number;
  stepMs?: number;
}) {
  return (
    <>
      {text.split(' ').map((word, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a static word split that never reorders — the index disambiguates repeated words.
        <Fragment key={`${word}-${i}`}>
          <span className="v2b-word" style={{ animationDelay: `${baseMs + i * stepMs}ms` }}>
            {word}
          </span>{' '}
        </Fragment>
      ))}
    </>
  );
}
