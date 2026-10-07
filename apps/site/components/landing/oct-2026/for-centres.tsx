import { CopyNumberButton } from '~/components/copy-number';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { Wordmark } from '~/components/wordmark';
import type { Locale } from '~/i18n/routing';
import { readSmsNumber } from '~/lib/text-entry';
import { DesignCta } from './shared';

/** October 2026 design handoff; source copy is a local review draft. */
export function DesignForCentres({ locale }: { locale: Locale }) {
  const number = readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER);
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
              <p className="hs-eyebrow">{'For centres and partners'}</p>
              <h1 className="sp-h1">{'For the people families already trust.'}</h1>
              <p className="sp-lede">
                {
                  'Hale is a planner for a family’s year, by text. It finds activities that fit their kids, watches for spots and sign-up dates, and checks in on how it went. No app, no account, and a family’s data stays in Canada.'
                }
              </p>
            </div>
          </div>
        </section>
      </div>
      <div className="hs-page">
        <section className="hs hs-wash-a">
          <div className="hs-wrap hs-grid">
            <div className="sp-split-l w6">
              <div className="hs-head">
                <p className="hs-eyebrow">{'What a family gets'}</p>
                <h2 className="hs-h2">
                  {'One text, and an answer'}
                  <br className="dbr" />
                  {' the same minute.'}
                </h2>
                <p className="hs-lede">
                  {
                    'A parent sends the first message; Hale never texts a family first. After that it stays out of the way: the link before sign-ups, and one question after the first class. It works in parent group chats too.'
                  }
                </p>
              </div>
            </div>
            <div className="sp-split-r">
              <div className="sp-example">
                {'Example first text and reply. Names and places are made up.'}
              </div>
              <div className="hs-card hs-art-pad hs-mini sp-preview">
                <div className="hs-msg out">{'Hi! Mia is 4. Swim and fall programs near us?'}</div>
                <div className="hs-msg in">
                  {
                    'Here’s what’s on near you:\n1. Parent & tot swim (ages 2–4), Saturdays 9:15 a.m., from the town’s rec guide\n2. Preschool playtime (18 months to 4), drop-in, from the library’s page\n3. Little movers (ages 2–5), winter times not posted yet'
                  }
                </div>
                <span className="hs-did">
                  <svg
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3.5 8.5l3 3 6-7" />
                  </svg>
                  {'Watching: swim sign-ups'}
                </span>
              </div>
            </div>
          </div>
        </section>
        <section className="hs hs-wash-b">
          <div className="hs-wrap">
            <div className="hs-head">
              <p className="hs-eyebrow">{'How to point a family at Hale'}</p>
              <h2 className="hs-h2">{'Three ways a family can start.'}</h2>
              <p className="hs-lede">
                {'Nothing to sign, nothing to install, nothing for staff to keep track of.'}
              </p>
            </div>
            <div className="sp-cards">
              <div className="hs-glass sp-card">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Hand it over'}</span>
                  <span className="sp-num">{'01'}</span>
                </div>
                <h3 className="hs-h3">{'Give them the number'}</h3>
                <p className="hs-p">
                  {
                    'Put it where parents look: a whiteboard, a handout, the back of a room sheet. A parent texts it when '
                  }
                  <span className="nw">{'they’re ready.'}</span>
                </p>
                <div className="sp-card-foot">
                  {number ? (
                    <CopyNumberButton
                      number={number}
                      placement="for_centres"
                      className="sp-btn2"
                      label="Copy number"
                      copiedLabel="Copied"
                      ariaLabel="Copy Hale’s phone number"
                    />
                  ) : (
                    <p className="hs-meta">The texting number hasn’t been announced yet.</p>
                  )}
                </div>
              </div>
              <div className="hs-glass sp-card">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Print it'}</span>
                  <span className="sp-num">{'02'}</span>
                </div>
                <h3 className="hs-h3">{'Put up a poster'}</h3>
                <p className="hs-p">
                  {
                    'We print posters with your centre’s own code, so we can tell you how many families it brought. Email us and we’ll '
                  }
                  <span className="nw">{'send one.'}</span>
                </p>
              </div>
              <div className="hs-glass sp-card">
                <div className="sp-card-top">
                  <span className="sp-tag">{'Try it'}</span>
                  <span className="sp-num">{'03'}</span>
                </div>
                <h3 className="hs-h3">{'Text it yourself first'}</h3>
                <p className="hs-p">
                  {
                    'Send the first message the way a parent would and read what comes back, so you know what you’re recommending. You can stop messages '
                  }
                  <span className="nw">{'at any time.'}</span>
                </p>
                <div className="sp-card-foot">
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
              </div>
            </div>
          </div>
        </section>
        <section className="hs hs-wash-c">
          <div className="hs-wrap">
            <div className="hs-head">
              <p className="hs-eyebrow">{'What staff should know'}</p>
              <h2 className="hs-h2">{'Plain answers about privacy.'}</h2>
              <p className="hs-lede">{'A family will ask you these before they ask us.'}</p>
            </div>
            <div className="sp-cards">
              <div className="hs-card sp-card">
                <h3 className="hs-h3">{'What Hale asks for'}</h3>
                <p className="hs-p">
                  {
                    'Where a family is and how old the kids are. First names only if the parent wants to '
                  }
                  <span className="nw">{'share them.'}</span>
                </p>
              </div>
              <div className="hs-card sp-card">
                <h3 className="hs-h3">{'Nothing is sold'}</h3>
                <p className="hs-p">
                  {
                    'A family’s information is never sold, never shared for advertising, and never shown to another family without '
                  }
                  <span className="nw">{'their say.'}</span>
                </p>
              </div>
              <div className="hs-card sp-card">
                <h3 className="hs-h3">{'You control the messages'}</h3>
                <p className="hs-p">
                  {
                    'A parent can stop messages at any time. They can ask for their data, or for it to be deleted, '
                  }
                  <span className="nw">{'at privacy@villagehale.com.'}</span>
                </p>
              </div>
              <div className="hs-card sp-card">
                <h3 className="hs-h3">{'French, in French'}</h3>
                <p className="hs-p">
                  {'A parent can text Hale in French, and Hale answers '}
                  <span className="nw">{'in French.'}</span>
                </p>
              </div>
              <div className="hs-card sp-card">
                <h3 className="hs-h3">{'A child’s words stay with their parent'}</h3>
                <p className="hs-p">
                  {
                    'Hale talks to parents. For a child of 13 or older, a parent sees the topic and a summary rather than the words, unless there is a safety concern, and then the teen '
                  }
                  <span className="nw">{'is told.'}</span>
                </p>
              </div>
              <div className="hs-card sp-card">
                <h3 className="hs-h3">{'Built and kept in Canada'}</h3>
                <p className="hs-p">
                  {
                    'Village Hale Technologies Inc., Georgetown, Ontario. Family data stays in Canada, under PIPEDA and Quebec’s '
                  }
                  <span className="nw">{'Law 25.'}</span>
                </p>
              </div>
            </div>
            <div className="hs-glass sp-card" style={{ marginTop: 'var(--s5)' }}>
              <span className="sp-tag">{'If a family asks whether Hale is official'}</span>
              <p className="hs-p" style={{ color: 'var(--navy)' }}>
                {
                  'Hale is independent. It isn’t run by your centre, the town, the region or the province. Every date it sends comes with the source page, and if the two ever disagree, the source page wins.'
                }
              </p>
            </div>
          </div>
        </section>
        <section className="hs hs-wash-d">
          <div className="hs-wrap hs-grid">
            <div className="hs-faq-l">
              <p className="hs-eyebrow">{'Questions we get'}</p>
              <h2 className="hs-h2">{'Four things staff ask first.'}</h2>
            </div>
            <div className="hs-faq-r">
              <div className="hs-qa">
                <h3 className="hs-h3">{'Does a family need an account?'}</h3>
                <p className="hs-p">
                  {'No. A parent texts a number and Hale replies. No app, no password, no '}
                  <span className="nw">{'sign-up page.'}</span>
                </p>
              </div>
              <div className="hs-qa">
                <h3 className="hs-h3">{'What does it cost a family?'}</h3>
                <p className="hs-p">
                  {
                    'Nothing. Hale is free while it’s new, and families who join now keep the founding rate '
                  }
                  <span className="nw">{'for good.'}</span>
                </p>
              </div>
              <div className="hs-qa">
                <h3 className="hs-h3">{'Do we have to sign anything?'}</h3>
                <p className="hs-p">
                  {
                    'No. There’s no agreement, and nothing for staff to report or track. The only thing we’d set up with you is a poster with your '
                  }
                  <span className="nw">{'centre’s code.'}</span>
                </p>
              </div>
              <div className="hs-qa">
                <h3 className="hs-h3">{'What are Hale’s limits today?'}</h3>
                <p className="hs-p">
                  {
                    'It doesn’t diagnose and never names a dose; a medical question goes back to the family’s care provider. Today, Hale finds and reminds. You book or register yourself. Signing up for you is a future paid feature, only when you '
                  }
                  <span className="nw">{'say yes.'}</span>
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
                <h2>{'Want a poster for your centre?'}</h2>
                <p className="hs-close-sub">
                  {
                    'Email us and we’ll send one with your centre’s own code on it. A real person answers.'
                  }
                </p>
                <div className="hs-close-cta">
                  <a className="btn btn-hero" href="mailto:aloha@villagehale.com">
                    <svg
                      width="16"
                      height="16"
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
                    {'Email aloha@villagehale.com'}
                  </a>
                </div>
              </div>
            </div>
          </div>
        </section>
        <SiteFooter locale={locale} redesign />
      </div>
    </main>
  );
}
