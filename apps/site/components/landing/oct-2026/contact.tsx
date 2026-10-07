import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { Wordmark } from '~/components/wordmark';
import type { Locale } from '~/i18n/routing';
import { DesignCta } from './shared';

/** October 2026 design handoff; source copy is a local review draft. */
export function DesignContact({ locale }: { locale: Locale }) {
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
              <p className="hs-eyebrow">{'Contact'}</p>
              <h1 className="sp-h1">{'Say hello.'}</h1>
              <p className="sp-lede">
                {
                  'We’re small, parent-built and early, so a real person reads what you send. Email is the fastest way to reach us.'
                }
              </p>
            </div>
          </div>
        </section>
      </div>
      <div className="hs-page">
        <section className="hs hs-wash-a">
          <div className="hs-wrap">
            <div className="sp-cards two" style={{ marginTop: '0' }}>
              <div className="hs-glass sp-card">
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
                    <rect x="2.75" y="4.5" width="14.5" height="11" rx="2" />
                    <path d="m3.5 5.5 6.5 5 6.5-5" />
                  </svg>
                </span>
                <span className="sp-tag">{'Anything at all'}</span>
                <p className="hs-p">
                  {
                    'Questions, feedback, a class other families should know about. We read every note.'
                  }
                </p>
                <div className="sp-card-foot">
                  <a className="sp-mail" href="mailto:aloha@villagehale.com">
                    <span>{'aloha@villagehale.com'}</span>
                  </a>
                </div>
              </div>
              <div className="hs-glass sp-card">
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
                    <rect x="4" y="9" width="12" height="8" rx="2" />
                    <path d="M6.75 9V6.75a3.25 3.25 0 0 1 6.5 0V9" />
                  </svg>
                </span>
                <span className="sp-tag">{'Privacy and your data'}</span>
                <p className="hs-p">
                  {
                    'Access, correction or deletion requests, and anything about how we handle your family’s data.'
                  }
                </p>
                <div className="sp-card-foot">
                  <a className="sp-mail" href="mailto:privacy@villagehale.com">
                    <span>{'privacy@villagehale.com'}</span>
                  </a>
                </div>
              </div>
            </div>
            <div className="hs-card sp-card" style={{ marginTop: 'var(--s5)' }}>
              <div
                className="sp-person"
                style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--s4)' }}
              >
                <p className="hs-p" style={{ margin: '0', color: 'var(--navy)' }}>
                  <b style={{ fontWeight: '600' }}>
                    {'Work at a centre, a library or a community program?'}
                  </b>
                  {' See what Hale means for the families you serve.'}
                </p>
                <a className="sp-link" href="/for-centres">
                  <span>{'For centres'}</span>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 8h10M9 4l4 4-4 4" />
                  </svg>
                </a>
              </div>
            </div>
            <p className="hs-meta sp-note">
              {'Hale is built by Village Hale Technologies Inc., Georgetown, Ontario, Canada.'}
            </p>
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
                <h2>{'Or just text Hale.'}</h2>
                <p className="hs-close-sub">
                  {'Questions about your kids’ year get an answer the same minute.'}
                </p>
                <div className="hs-close-cta">
                  <DesignCta locale={locale} className="btn btn-hero">
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
                  </DesignCta>
                </div>
                <p className="hs-close-terms">
                  {'Free to start. You text first; standard message rates apply.'}
                </p>
              </div>
            </div>
          </div>
        </section>
        <SiteFooter locale={locale} redesign />
      </div>
    </main>
  );
}
