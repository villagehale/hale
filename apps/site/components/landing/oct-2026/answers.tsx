import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { Wordmark } from '~/components/wordmark';
import type { Locale } from '~/i18n/routing';
import { GuideFilter } from './guide-filter';
import { DesignCta } from './shared';

/** October 2026 design handoff; source copy is a local review draft. */
export function DesignAnswers({ locale }: { locale: Locale }) {
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
              <p className="hs-eyebrow">{'Parenting guides'}</p>
              <h1 className="sp-h1">{'Calm, cited guidance for every stage.'}</h1>
              <p className="sp-lede">
                {
                  'Practical guides to the questions parents search, grounded in trusted parenting-health frameworks and honest about their limits.'
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
              <p className="hs-eyebrow">{'Guides'}</p>
              <h2 className="hs-h2">{'15 questions parents search.'}</h2>
              <p className="hs-lede">
                {'General guidance, never a replacement for your provider.'}
              </p>
            </div>
            <GuideFilter>
              <article className="hs-card sp-card sp-guide" data-stage="Newborn">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Newborn'}</span>
                  <span className="sp-num">{'0–11 months'}</span>
                </div>
                <h3 className="hs-h3">
                  {'Why does my newborn want to feed constantly in the evening?'}
                </h3>
                <p className="hs-p">
                  {
                    'Bunched evening feeds — cluster feeding — are a normal newborn pattern, not a sign of low supply. What it is, why it happens, and when to check with '
                  }
                  <span className="nw">{'your provider.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/newborn-cluster-feeding">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="Newborn">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Newborn'}</span>
                  <span className="sp-num">{'0–11 months'}</span>
                </div>
                <h3 className="hs-h3">{'Why does my newborn only sleep in short stretches?'}</h3>
                <p className="hs-p">
                  {
                    'Short, fragmented newborn sleep is developmentally normal, not a problem to fix. What to expect in the first months and what '
                  }
                  <span className="nw">{'actually helps.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/newborn-sleep-fragmented">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="Newborn">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Newborn'}</span>
                  <span className="sp-num">{'0–11 months'}</span>
                </div>
                <h3 className="hs-h3">{'What are the safe sleep basics for a newborn?'}</h3>
                <p className="hs-p">
                  {
                    'The widely recommended safe-sleep basics for babies — back to sleep, a bare crib, and room-sharing — with the Canadian guidance '
                  }
                  <span className="nw">{'behind them.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/newborn-safe-sleep-basics">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="Newborn">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Newborn'}</span>
                  <span className="sp-num">{'0–11 months'}</span>
                </div>
                <h3 className="hs-h3">{'When and how do I introduce peanuts to my baby?'}</h3>
                <p className="hs-p">
                  {
                    'Current guidance encourages introducing common allergens like peanut early, around six months, once a baby is ready for solids. What that looks like and when to talk to your '
                  }
                  <span className="nw">{'provider first.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/introducing-peanuts-to-baby">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="Newborn">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Newborn'}</span>
                  <span className="sp-num">{'0–11 months'}</span>
                </div>
                <h3 className="hs-h3">{'When is my baby ready to start solid foods?'}</h3>
                <p className="hs-p">
                  {
                    'Solids usually start around six months, once a baby can sit up without support, has good head and neck control, and shows interest in food. The readiness signs and '
                  }
                  <span className="nw">{'Canadian guidance.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/starting-solids-when-ready">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="Toddler">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Toddler'}</span>
                  <span className="sp-num">{'1–3 years'}</span>
                </div>
                <h3 className="hs-h3">{'How do I handle my toddler’s tantrums?'}</h3>
                <p className="hs-p">
                  {
                    'Tantrums are a normal part of toddler development, not misbehaviour to punish away. A calm, connection-first approach grounded in Markham, Lansbury, '
                  }
                  <span className="nw">{'and Siegel.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/toddler-tantrums-how-to-handle">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="Toddler">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Toddler'}</span>
                  <span className="sp-num">{'1–3 years'}</span>
                </div>
                <h3 className="hs-h3">{'What should I do when my toddler bites?'}</h3>
                <p className="hs-p">
                  {
                    'Biting is common in toddlers and usually about frustration, teething, or limited language — not aggression. A calm, consistent response grounded in Lansbury '
                  }
                  <span className="nw">{'and Markham.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/toddler-biting-what-to-do">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="Toddler">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Toddler'}</span>
                  <span className="sp-num">{'1–3 years'}</span>
                </div>
                <h3 className="hs-h3">
                  {'How do I ease my toddler’s separation anxiety at daycare drop-off?'}
                </h3>
                <p className="hs-p">
                  {
                    'Separation anxiety at drop-off is a normal sign of healthy attachment. A short, warm, consistent goodbye routine — and what the research-backed '
                  }
                  <span className="nw">{'frameworks suggest.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/toddler-separation-anxiety-daycare">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="Toddler">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Toddler'}</span>
                  <span className="sp-num">{'1–3 years'}</span>
                </div>
                <h3 className="hs-h3">{'How do I know my toddler is ready to potty train?'}</h3>
                <p className="hs-p">
                  {
                    'Potty training goes best when it follows a child’s readiness signs rather than a fixed age. The physical and behavioural cues, and a '
                  }
                  <span className="nw">{'low-pressure approach.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/potty-training-readiness-signs">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="Toddler">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Toddler'}</span>
                  <span className="sp-num">{'1–3 years'}</span>
                </div>
                <h3 className="hs-h3">{'How much screen time is okay for a toddler?'}</h3>
                <p className="hs-p">
                  {
                    'Canadian guidance recommends little to no screen time under two, and no more than an hour a day for ages two to five. The numbers and '
                  }
                  <span className="nw">{'the reasoning.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/toddler-screen-time-guidelines">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="School age">
                <div className="sp-card-top">
                  <span className="sp-tag">{'School age'}</span>
                  <span className="sp-num">{'4–12 years'}</span>
                </div>
                <h3 className="hs-h3">
                  {'How do I stop the nightly homework battles with my child?'}
                </h3>
                <p className="hs-p">
                  {
                    'Nightly homework standoffs usually come from a power struggle, not laziness. Shifting from enforcer to supporter, grounded in Siegel '
                  }
                  <span className="nw">{'and Markham.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/child-homework-battles">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="School age">
                <div className="sp-card-top">
                  <span className="sp-tag">{'School age'}</span>
                  <span className="sp-num">{'4–12 years'}</span>
                </div>
                <h3 className="hs-h3">{'How do I handle constant fighting between my kids?'}</h3>
                <p className="hs-p">
                  {
                    'Sibling conflict is normal and even useful for learning to negotiate. How to step back from refereeing and coach conflict-resolution skills, grounded in Markham '
                  }
                  <span className="nw">{'and Siegel.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/child-sibling-fighting">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="School age">
                <div className="sp-card-top">
                  <span className="sp-tag">{'School age'}</span>
                  <span className="sp-num">{'4–12 years'}</span>
                </div>
                <h3 className="hs-h3">
                  {'How do I set screen time limits for my school-age child?'}
                </h3>
                <p className="hs-p">
                  {
                    'For school-age children, guidance shifts from fixed hour-caps to a family plan that protects sleep, activity, and family time. What that looks like '
                  }
                  <span className="nw">{'in practice.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/child-managing-screen-time">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="Teenager">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Teenager'}</span>
                  <span className="sp-num">{'13+ years'}</span>
                </div>
                <h3 className="hs-h3">
                  {'What are warning signs of a mental health problem in my teenager?'}
                </h3>
                <p className="hs-p">
                  {
                    'Some moodiness is normal in adolescence, but certain changes warrant a professional conversation. The warning signs, and how to open the door without pushing your '
                  }
                  <span className="nw">{'teen away.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/teen-mental-health-warning-signs">
                    <span>{'Read the guide'}</span>
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
              </article>
              <article className="hs-card sp-card sp-guide" data-stage="Teenager">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Teenager'}</span>
                  <span className="sp-num">{'13+ years'}</span>
                </div>
                <h3 className="hs-h3">
                  {'How do I set boundaries with my teenager without pushing them away?'}
                </h3>
                <p className="hs-p">
                  {
                    'Teens need both autonomy and limits. How to hold clear boundaries while keeping the relationship open, grounded in Siegel’s work on the '
                  }
                  <span className="nw">{'adolescent brain.'}</span>
                </p>
                <div className="sp-guide-more">
                  <a className="sp-link" href="/answers/teen-setting-boundaries-autonomy">
                    <span>{'Read the guide'}</span>
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
              </article>
            </GuideFilter>
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
                <h2>{'A question about your own child?'}</h2>
                <p className="hs-close-sub">
                  {'Text Hale. It answers with your child’s age in mind, in a line or two.'}
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
