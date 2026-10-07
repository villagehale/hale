import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { Wordmark } from '~/components/wordmark';
import type { Locale } from '~/i18n/routing';
import { DesignPricing } from './pricing-section';
import { DesignCta } from './shared';

/** October 2026 design handoff; source copy is a local review draft. */
export function DesignPricingPage({ locale }: { locale: Locale }) {
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
              <p className="hs-eyebrow">{'Pricing'}</p>
              <h1 className="sp-h1">{'Free while Hale is new.'}</h1>
              <p className="sp-lede">
                {
                  'Everything Hale does today is free, for every kid: the finding, the watching, the reminders, the group chats and the answers. Plus and Max are on the way.'
                }
              </p>
            </div>
          </div>
        </section>
      </div>
      <div className="hs-page">
        <DesignPricing showHeading={false} locale={locale} />
        <section className="hs hs-wash-d">
          <div className="hs-wrap hs-grid">
            <div className="hs-faq-l">
              <p className="hs-eyebrow">{'About pricing'}</p>
              <h2 className="hs-h2">{'Fair questions.'}</h2>
            </div>
            <div className="hs-faq-r">
              <div className="hs-qa">
                <h3 className="hs-h3">{'Is Free really free?'}</h3>
                <p className="hs-p">
                  {
                    'Yes. Everything Hale does today is free while it’s new, with unlimited chat. Group chats and your co-parent '
                  }
                  <span className="nw">{'are included.'}</span>
                </p>
              </div>
              <div className="hs-qa">
                <h3 className="hs-h3">{'When do Plus and Max open?'}</h3>
                <p className="hs-p">
                  {'When the parts they add are ready. Until then, everything Hale does '}
                  <span className="nw">{'is free.'}</span>
                </p>
              </div>
              <div className="hs-qa">
                <h3 className="hs-h3">{'What’s the difference between Plus and Max?'}</h3>
                <p className="hs-p">
                  {
                    'Plus adds nudges when a weekend’s empty or a waitlist opens, and year memory. Max is everything in Plus, for every kid and everyone who helps, with '
                  }
                  <span className="nw">{'priority support.'}</span>
                </p>
              </div>
              <div className="hs-qa">
                <h3 className="hs-h3">{'Does any plan book classes for me?'}</h3>
                <p className="hs-p">
                  {
                    'Not today. Hale finds the class, watches for a spot and sends you the link, and you register yourself. Sign-ups done for you, when you say yes, are planned for Plus '
                  }
                  <span className="nw">{'and Max.'}</span>
                </p>
              </div>
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
                <h2>
                  <span style={{ whiteSpace: 'nowrap' }}>{'Founding families'}</span>
                  {' join free.'}
                </h2>
                <p className="hs-close-sub">
                  {
                    'Free while Hale is new, and families who start now keep their founding rate for good.'
                  }
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
                  {
                    'Free to start. You text first; standard message rates apply, reply STOP any time.'
                  }
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
