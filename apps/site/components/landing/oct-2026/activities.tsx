import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { Wordmark } from '~/components/wordmark';
import type { Locale } from '~/i18n/routing';
import { DesignCta } from './shared';

/** October 2026 design handoff; source copy is a local review draft. */
export function DesignActivities({ locale }: { locale: Locale }) {
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
              <p className="hs-eyebrow">{'Activities'}</p>
              <h1 className="sp-h1">{'Things to do with your kids, near you.'}</h1>
              <p className="sp-lede">
                {
                  'Story times, drop-in play, swim, camps and rec programs. Tell Hale where you are and how old the kids are, and it finds what’s on.'
                }
              </p>
            </div>
          </div>
        </section>
      </div>
      <div className="hs-page">
        <section className="hs hs-wash-a">
          <div className="hs-wrap">
            <div className="hs-head">
              <p className="hs-eyebrow">{'What Hale looks for'}</p>
              <h2 className="hs-h2">{'Six kinds of things worth doing.'}</h2>
              <p className="hs-lede">
                {
                  'Hale looks them up live for your kids’ ages and where you are, then sends a short list with the source for each.'
                }
              </p>
            </div>
            <div className="sp-cards">
              <div className="hs-card sp-card">
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
                    <path d="M2.5 12.5c1.25 0 1.9-1 3.1-1s1.9 1 3.1 1 1.9-1 3.1-1 1.9 1 3.1 1 1.6-.6 2.6-.9" />
                    <path d="M2.5 16c1.25 0 1.9-1 3.1-1s1.9 1 3.1 1 1.9-1 3.1-1 1.9 1 3.1 1 1.6-.6 2.6-.9" />
                    <circle cx="12.5" cy="5.5" r="1.8" />
                    <path d="m6 9.5 3-3.2 2.2 1.9" />
                  </svg>
                </span>
                <h3 className="hs-h3">{'Swim lessons'}</h3>
                <p className="hs-p">
                  {'Parent and tot, learn-to-swim levels, and when the next '}
                  <span className="nw">{'session opens.'}</span>
                </p>
              </div>
              <div className="hs-card sp-card">
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
                    <path d="M10 3.5 2.5 16.5h15z" />
                    <path d="M10 3.5v13M7.5 16.5 10 11l2.5 5.5" />
                  </svg>
                </span>
                <h3 className="hs-h3">{'Camps'}</h3>
                <p className="hs-p">
                  {'Summer, March break and days off school, with the date '}
                  <span className="nw">{'sign-ups open.'}</span>
                </p>
              </div>
              <div className="hs-card sp-card">
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
                    <path d="M10 5.5c-1.6-1.2-3.8-1.6-6.5-1.4v11c2.7-.2 4.9.2 6.5 1.4 1.6-1.2 3.8-1.6 6.5-1.4v-11c-2.7-.2-4.9.2-6.5 1.4z" />
                    <path d="M10 5.5v11" />
                  </svg>
                </span>
                <h3 className="hs-h3">{'Story times and drop-ins'}</h3>
                <p className="hs-p">
                  {'Libraries, family centres and play mornings you can just show '}
                  <span className="nw">{'up to.'}</span>
                </p>
              </div>
              <div className="hs-card sp-card">
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
                    <path d="M3.5 9 10 3.5 16.5 9v7.5h-13z" />
                    <path d="M8 16.5v-4.5h4v4.5" />
                  </svg>
                </span>
                <h3 className="hs-h3">{'Rec programs'}</h3>
                <p className="hs-p">
                  {'Classes at community centres, from toddler gym to art '}
                  <span className="nw">{'and dance.'}</span>
                </p>
              </div>
              <div className="hs-card sp-card">
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
                    <circle cx="10" cy="10" r="6.75" />
                    <path d="m10 6.5 3 2.2-1.1 3.6H8.1L7 8.7z" />
                    <path d="M10 3.25V6.5M16.4 8.1l-3.4.6M13.9 15.5l-2-3.2M6.1 15.5l2-3.2M3.6 8.1l3.4.6" />
                  </svg>
                </span>
                <h3 className="hs-h3">{'Sports'}</h3>
                <p className="hs-p">
                  {'Soccer, skating, gymnastics and the rest, by age and day of '}
                  <span className="nw">{'the week.'}</span>
                </p>
              </div>
              <div className="hs-card sp-card">
                <span className="hs-ic">
                  <svg
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <circle cx="10" cy="10" r="3.4" />
                    <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
                  </svg>
                </span>
                <h3 className="hs-h3">{'This weekend'}</h3>
                <p className="hs-p">
                  {'Free outings, parks and one‑time events, when you need an idea '}
                  <span className="nw">{'for Saturday.'}</span>
                </p>
              </div>
            </div>
          </div>
        </section>
        <section className="hs hs-wash-b">
          <div className="hs-wrap hs-grid">
            <div className="sp-split-l">
              <div className="hs-head">
                <p className="hs-eyebrow">{'Try it'}</p>
                <h2 className="hs-h2">{'Ask the way you’d ask a friend.'}</h2>
                <p className="hs-lede">
                  {
                    'Say how old the kids are and when you’re free. Hale answers with a few good options, not thirty.'
                  }
                </p>
              </div>
            </div>
            <div className="sp-split-r">
              <div className="sp-example">{'Example chat. Places and times are made up.'}</div>
              <div className="hs-card hs-art-pad hs-mini sp-preview">
                <div className="hs-msg out">
                  {'Anything for a 4-year-old this Saturday morning?'}
                </div>
                <div className="hs-msg in">
                  {
                    'Three nearby:\n1. Parent & tot swim (ages 2–4), 9:15 a.m.\n2. Library story time (ages 2–5), 10:30 a.m.\n3. Free drop-in play at the community centre, 10 to noon\nWant the links?'
                  }
                </div>
                <div className="hs-msg out">{'Story time! Link please'}</div>
                <div className="hs-msg in">
                  {'Here’s the '}
                  <span className="hs-link">{'library page'}</span>
                  {'. No sign-up needed for this one.'}
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
                <h2>{'What’s on this weekend?'}</h2>
                <p className="hs-close-sub">
                  {
                    'Text Hale the kids’ ages and where you are. It sends a few good options the same minute.'
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
