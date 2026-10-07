import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { Wordmark } from '~/components/wordmark';
import type { Locale } from '~/i18n/routing';
import { DesignCta } from './shared';

/** October 2026 design handoff; source copy is a local review draft. */
export function DesignAbout({ locale }: { locale: Locale }) {
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
              <p className="hs-eyebrow">{'About Hale'}</p>
              <h1 className="sp-h1">{'A planner for your kids’ year.'}</h1>
              <p className="sp-lede">
                {
                  'Hale lives in your texts and your group chats. It finds what’s on, watches for spots, reminds you before sign-ups and asks how it went.'
                }
              </p>
            </div>
          </div>
        </section>
      </div>
      <div className="hs-page">
        <section className="hs hs-wash-a">
          <div className="hs-wrap">
            <div className="hs-glass sp-quote">
              <span className="sp-tag">{'Our mission'}</span>
              <p>
                {
                  'Every parent should have someone who knows what’s on near them, remembers the date that fills in two minutes, and asks how it went. Across every stage of childhood, from the first months to almost grown.'
                }
              </p>
            </div>
          </div>
        </section>
        <section className="hs hs-wash-b">
          <div className="hs-wrap">
            <div className="hs-head">
              <p className="hs-eyebrow">{'How Hale behaves'}</p>
              <h2 className="hs-h2">{'A good friend with a calendar.'}</h2>
              <p className="hs-lede">
                {'Four rules Hale keeps, in your texts and in your group chats.'}
              </p>
            </div>
            <div className="sp-cards four">
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
                    <circle cx="8.75" cy="8.75" r="5.25" />
                    <path d="m12.75 12.75 4 4" />
                  </svg>
                </span>
                <h3 className="hs-h3">{'Three things, not thirty'}</h3>
                <p className="hs-p">
                  {'Hale picks a few that fit your kids’ ages and your week, and tells '}
                  <span className="nw">{'you why.'}</span>
                </p>
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
                    <circle cx="7.5" cy="7" r="2.8" />
                    <path d="M2.5 16.2c.6-2.6 2.6-4.2 5-4.2s4.4 1.6 5 4.2" />
                    <circle cx="14" cy="7.6" r="2.2" />
                    <path d="M13.6 12.1c2 .1 3.4 1.5 3.9 3.6" />
                  </svg>
                </span>
                <h3 className="hs-h3">{'You stay in charge'}</h3>
                <p className="hs-p">
                  {'Hale finds and reminds. You register, and nothing happens without a yes '}
                  <span className="nw">{'from you.'}</span>
                </p>
              </div>
              <div className="hs-glass sp-card">
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
                <h3 className="hs-h3">{'It speaks when spoken to'}</h3>
                <p className="hs-p">
                  {'Hale never texts a number first. In a group, it answers when '}
                  <span className="nw">{'someone asks.'}</span>
                </p>
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
                <h3 className="hs-h3">{'Your data stays in Canada'}</h3>
                <p className="hs-p">
                  {'Never sold, and Hale shows no ads. You can stop messages '}
                  <span className="nw">{'at any time.'}</span>
                </p>
              </div>
            </div>
          </div>
        </section>
        <section className="hs hs-wash-c">
          <div className="hs-wrap hs-grid">
            <div className="sp-split-l">
              <div className="hs-head">
                <p className="hs-eyebrow">{'The people'}</p>
                <h2 className="hs-h2">{'Parent-built in Georgetown, Ontario.'}</h2>
                <p className="hs-lede">
                  {
                    'Hale is made by Village Hale Technologies Inc. We’re small and early, and a real person reads every note.'
                  }
                </p>
              </div>
            </div>
            <div className="sp-split-r">
              <div className="sp-cards two" style={{ marginTop: '0' }}>
                <div className="hs-card sp-card">
                  <div className="sp-person">
                    <span className="sp-avatar">{'BD'}</span>
                    <div>
                      <h3 className="hs-h3">{'Barton Dong'}</h3>
                      <p className="hs-p">
                        {'CEO · '}
                        <a
                          className="hs-link"
                          href="https://linkedin.com/in/anzhe-dong"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {'LinkedIn'}
                        </a>
                      </p>
                    </div>
                  </div>
                </div>
                <div className="hs-card sp-card">
                  <div className="sp-person">
                    <span className="sp-avatar">{'ES'}</span>
                    <div>
                      <h3 className="hs-h3">{'Eugene Song'}</h3>
                      <p className="hs-p">
                        {'CTO · '}
                        <a
                          className="hs-link"
                          href="https://www.linkedin.com/in/yuhang-eugene-song-53b692172"
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {'LinkedIn'}
                        </a>
                      </p>
                    </div>
                  </div>
                </div>
                <div className="hs-card sp-card" style={{ gridColumn: '1/-1' }}>
                  <div className="sp-person">
                    <img
                      src="/landing-oct-2026/hale-logo.jpeg"
                      alt=""
                      style={{ width: '56px', height: '56px', borderRadius: '30%' }}
                    />
                    <div>
                      <h3 className="hs-h3">{'Why “Hale”'}</h3>
                      <p className="hs-p">
                        {'Hale '}
                        <code style={{ fontFamily: 'var(--font-mono)', fontSize: '14px' }}>
                          {'/HAH-leh/'}
                        </code>
                        {' is Hawaiian for home. The mark is a honu, a sea turtle.'}
                      </p>
                    </div>
                  </div>
                </div>
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
