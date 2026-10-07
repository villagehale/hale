import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { Wordmark } from '~/components/wordmark';
import type { Locale } from '~/i18n/routing';
import { intakePrefill } from '~/lib/intake-prefill';
import { DesignQr, DesignTextDoor, type DesignTextEntry } from './shared';

/** October 2026 design handoff; source copy is a local review draft. */
export function DesignText({ locale, textEntry }: { locale: Locale; textEntry: DesignTextEntry }) {
  return (
    <main id="main" tabIndex={-1} className="design-marketing">
      <div className="stage sp-stage">
        <img
          className="shore-art"
          src="/landing-oct-2026/hale-shore-hero.webp"
          alt=""
          aria-hidden="true"
        />
        <span className="shore-drift sky" aria-hidden="true" />
        <span className="shore-drift sea" aria-hidden="true" />
        <span className="shore-scrim" aria-hidden="true" />
        <SiteHeader locale={locale} redesign />
        <section className="sp-hero">
          <div className="sp-grid">
            <div className="sp-copy">
              <p className="hs-eyebrow">{'Text Hale'}</p>
              <h1 className="sp-h1">
                {textEntry.number ? 'Text Hale like you’d text a friend.' : 'Say hello to Hale.'}
              </h1>
              <p className="sp-lede">
                {textEntry.number
                  ? 'Your first message is already written. You send it, and Hale replies the same minute.'
                  : 'The texting number hasn’t been announced yet. Email us to get in touch.'}
              </p>
              <div className="sp-cta">
                <DesignTextDoor {...textEntry} className="btn btn-hero">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M8 2.5c3.3 0 6 2.2 6 4.9s-2.7 4.9-6 4.9c-.7 0-1.3-.1-1.9-.2L3 13.5l.9-2.5C2.7 10.1 2 8.8 2 7.4 2 4.7 4.7 2.5 8 2.5z" />
                  </svg>
                  {'Text Hale'}
                </DesignTextDoor>
              </div>
            </div>
            {textEntry.number && (
              <div className="sp-aside">
                <div className="hs-glass sp-panel sp-preview">
                  <p className="sp-preview-label r">{'What you’ll send'}</p>
                  <div className="hs-mini">
                    <div className="hs-msg out">{intakePrefill(locale)}</div>
                  </div>
                  <p className="sp-preview-label" style={{ marginTop: 'var(--s4)' }}>
                    {'What you’ll get back'}
                  </p>
                  <div className="hs-mini">
                    <div className="hs-msg in">{textEntry.greeting}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
      <div className="hs-page">
        <section className="hs hs-wash-a">
          <div className="hs-wrap">
            <div className="hs-head">
              <p className="hs-eyebrow">{'Two ways to start'}</p>
              <h2 className="hs-h2">{'On your own, or in a group.'}</h2>
              <p className="hs-lede">
                {
                  'Either way, you text first. Hale never messages a number that hasn’t messaged it.'
                }
              </p>
            </div>
            <div className="sp-cards two">
              <div className="hs-glass sp-card">
                <div className="sp-card-top">
                  <span className="sp-tag">{'1:1'}</span>
                  <span className="sp-num">{'01'}</span>
                </div>
                <span className="hs-ic">
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M10 3.5c3.9 0 7 2.6 7 5.8s-3.1 5.8-7 5.8c-.8 0-1.5-.1-2.2-.3L4.3 16.3l1-2.9C4 12.4 3 10.9 3 9.3 3 6.1 6.1 3.5 10 3.5z" />
                  </svg>
                </span>
                <h3 className="hs-h3">{'Just you'}</h3>
                <p className="hs-p">
                  {'Send the message above. Hale asks where you are, then shows you what’s on '}
                  <span className="nw">{'this week.'}</span>
                </p>
              </div>
              <div className="hs-glass sp-card">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Group'}</span>
                  <span className="sp-num">{'02'}</span>
                </div>
                <span className="hs-ic">
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <circle cx="7.5" cy="7" r="2.8" />
                    <path d="M2.5 16.2c.6-2.6 2.6-4.2 5-4.2s4.4 1.6 5 4.2" />
                    <circle cx="14" cy="7.6" r="2.2" />
                    <path d="M13.6 12.1c2 .1 3.4 1.5 3.9 3.6" />
                  </svg>
                </span>
                <h3 className="hs-h3">{'With your co-parent or crew'}</h3>
                <p className="hs-p">
                  {'Start a group with them and Hale’s number, then say hi. Hale answers there, '}
                  <span className="nw">{'for everyone.'}</span>
                </p>
              </div>
            </div>
            <div className="sp-trust" style={{ marginTop: 'var(--s6)' }}>
              {'Free '}
              <i />
              {' No app '}
              <i />
              {' No account '}
              <i />
              {' You’re in control'}
            </div>
          </div>
        </section>
        <section className="hs hs-close-sec" id="start">
          <div className="hs-wrap">
            <div className="hs-close-card">
              <img
                className="hs-close-art"
                src="/landing-oct-2026/hale-shore-hero.webp"
                alt=""
                aria-hidden="true"
              />
              <span className="hs-close-scrim" aria-hidden="true" />
              <div className="hs-close-body">
                <span className="hs-close-brand">
                  <img src="/landing-oct-2026/hale-logo.jpeg" alt="" />
                  <Wordmark className="wordmark" />
                </span>
                <h2>{'Say hi to Hale.'}</h2>
                <p className="hs-close-sub">
                  {'Standard message rates apply. Your data stays in Canada, see our '}
                  <a className="hs-link" href="/privacy">
                    {'privacy policy'}
                  </a>
                  {'.'}
                </p>
                <div className="hs-close-cta">
                  <DesignTextDoor {...textEntry} className="btn btn-hero">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M8 2.5c3.3 0 6 2.2 6 4.9s-2.7 4.9-6 4.9c-.7 0-1.3-.1-1.9-.2L3 13.5l.9-2.5C2.7 10.1 2 8.8 2 7.4 2 4.7 4.7 2.5 8 2.5z" />
                    </svg>
                    {'Text Hale'}
                  </DesignTextDoor>
                </div>
                <DesignQr {...textEntry} />
              </div>
            </div>
          </div>
        </section>
        <SiteFooter locale={locale} redesign />
      </div>
    </main>
  );
}
