import { LandingScrollAnalytics } from '~/components/landing-scroll-analytics';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { Wordmark } from '~/components/wordmark';
import type { Locale } from '~/i18n/routing';
import { ChatGallery } from './chat-gallery';
import { HomeMotion } from './home-motion';
import { PhoneChat, TypingBubble } from './phone-chat';
import { DesignPricing } from './pricing-section';
import { DesignCta } from './shared';

/** October 2026 design handoff; source copy is a local review draft. */
export function DesignHome({ locale }: { locale: Locale }) {
  return (
    <main id="main" tabIndex={-1} className="design-marketing">
      <LandingScrollAnalytics />
      <div className="stage">
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
        <section className="hero">
          <div className="grid">
            <section className="copy">
              <span className="chip">
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M6.5 2.5c2.5 0 4.5 1.6 4.5 3.6S9 9.7 6.5 9.7c-.45 0-.9-.05-1.3-.15L2.8 10.6l.65-1.75C2.55 8.2 2 7.2 2 6.1 2 4.1 4 2.5 6.5 2.5Z" />
                  <path d="M12.2 6.2c1.1.6 1.8 1.6 1.8 2.7 0 .9-.45 1.7-1.2 2.3l.5 1.5-1.9-.85c-.4.1-.8.15-1.2.15-1.3 0-2.45-.45-3.25-1.2" />
                </svg>
                {'\n        Works in your group chats\n      '}
              </span>
              <h1>
                {'Your kids’ year,'}
                <br />
                {'handled.'}
              </h1>
              <p className="sub">
                {
                  'Your kids’ plans already live in group chats. Add Hale, and it finds what’s on, gets everyone to a yes, and puts it on the calendar.'
                }
              </p>
              <div className="cta-row">
                <DesignCta locale={locale} className="btn btn-hero">
                  <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M10 2.75c4.28 0 7.75 2.86 7.75 6.38 0 3.53-3.47 6.38-7.75 6.38-.86 0-1.69-.11-2.46-.33L3.6 16.9a.4.4 0 0 1-.56-.46l.83-2.97C2.88 12.36 2.25 10.8 2.25 9.13c0-3.52 3.47-6.38 7.75-6.38Z" />
                  </svg>
                  {'\n          Text Hale\n        '}
                </DesignCta>
                <a className="link" href="#group-chats">
                  <span>{'See how it works'}</span>
                  <svg
                    aria-hidden="true"
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 7h8M7.5 3.5 11 7l-3.5 3.5" />
                  </svg>
                </a>
              </div>
              <ul className="loop glass-ring" aria-label="What Hale does">
                <li>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <circle cx="8.75" cy="8.75" r="5.25" />
                    <path d="m12.75 12.75 4 4" />
                  </svg>
                  <b>{'Finds activities'}</b>
                  <small>{'Near you, by age'}</small>
                </li>
                <li>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M1.75 10S4.75 4.5 10 4.5 18.25 10 18.25 10 15.25 15.5 10 15.5 1.75 10 1.75 10Z" />
                    <circle cx="10" cy="10" r="2.5" />
                  </svg>
                  <b>{'Watches for spots'}</b>
                  <small>{'When classes open'}</small>
                </li>
                <li>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10 2.75a4.75 4.75 0 0 0-4.75 4.75v3L3.75 13h12.5l-1.5-2.5v-3A4.75 4.75 0 0 0 10 2.75Z" />
                    <path d="M8.25 16a1.85 1.85 0 0 0 3.5 0" />
                  </svg>
                  <b>{'Reminds you'}</b>
                  <small>{'Before registration'}</small>
                </li>
                <li>
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 20 20"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M10 3c4.4 0 7.5 2.7 7.5 6s-3.1 6-7.5 6c-.8 0-1.6-.1-2.3-.3L3.5 16.5l1.1-3.1C3.3 12.3 2.5 10.7 2.5 9 2.5 5.7 5.6 3 10 3Z" />
                    <path d="M7.5 10.25c.6.75 1.5 1.15 2.5 1.15s1.9-.4 2.5-1.15" />
                  </svg>
                  <b>{'Asks how it went'}</b>
                  <small>{'After the first class'}</small>
                </li>
              </ul>
            </section>
            <div className="visual-col">
              <div
                className="visual"
                data-motion-scene="hero"
                aria-label="Example: a family calendar filled in by Hale, and the text thread that added it"
              >
                <article className="cal">
                  <div className="cal-head">
                    <div>
                      <div className="cal-title">{'This week'}</div>
                    </div>
                    <div className="kids">
                      <span className="kid">{'Maya, 6'}</span>
                      <span className="kid">{'Leo, 3'}</span>
                    </div>
                  </div>
                  <div className="week">
                    <div className="day today">
                      <span className="dow">{'M'}</span>
                      <span className="num">{'12'}</span>
                      <span className="dot" />
                    </div>
                    <div className="day">
                      <span className="dow">{'T'}</span>
                      <span className="num">{'13'}</span>
                      <span className="dot amber" />
                    </div>
                    <div className="day">
                      <span className="dow">{'W'}</span>
                      <span className="num">{'14'}</span>
                      <span className="dot ink" />
                    </div>
                    <div className="day">
                      <span className="dow">{'T'}</span>
                      <span className="num">{'15'}</span>
                      <span className="dot ink" />
                    </div>
                    <div className="day">
                      <span className="dow">{'F'}</span>
                      <span className="num">{'16'}</span>
                      <span className="dot" />
                    </div>
                    <div className="day">
                      <span className="dow">{'S'}</span>
                      <span className="num">{'17'}</span>
                      <span className="dot amber" />
                    </div>
                    <div className="day">
                      <span className="dow">{'S'}</span>
                      <span className="num">{'18'}</span>
                      <span className="dot" />
                    </div>
                  </div>
                  <div className="agenda">
                    <div className="ev">
                      <div className="d">
                        <b>{'TUE'}</b>
                        <span>{'13'}</span>
                      </div>
                      <div>
                        <div className="t">{'Swim registration opens'}</div>
                        <div className="m">
                          <svg
                            aria-hidden="true"
                            className="bell"
                            viewBox="0 0 12 12"
                            fill="currentColor"
                          >
                            <path d="M6 1a3.2 3.2 0 0 0-3.2 3.2v1.9L1.9 7.6a.5.5 0 0 0 .43.76h7.34a.5.5 0 0 0 .43-.76L9.2 6.1V4.2A3.2 3.2 0 0 0 6 1Zm-1.3 8.6a1.3 1.3 0 0 0 2.6 0H4.7Z" />
                          </svg>
                          {'\n                  Reminder '}
                          <i /> <span className="mono">{'7:00 PM'}</span>
                        </div>
                      </div>
                    </div>
                    <div className="ev">
                      <div className="d">
                        <b>{'WED'}</b>
                        <span>{'14'}</span>
                      </div>
                      <div>
                        <div className="t">{'EarlyON playgroup'}</div>
                        <div className="m">
                          {'Leo '}
                          <i /> <span className="mono">{'9:30 AM'}</span>
                        </div>
                      </div>
                    </div>
                    <div className="ev">
                      <div className="d">
                        <b>{'THU'}</b>
                        <span>{'15'}</span>
                      </div>
                      <div>
                        <div className="t">{'Leo’s soccer'}</div>
                        <div className="m">
                          {'Leo '}
                          <i /> <span className="mono">{'5:30 PM'}</span>
                        </div>
                      </div>
                    </div>
                    <div className="ev new" data-motion-step="2.5">
                      <div className="d">
                        <b>{'SAT'}</b>
                        <span>{'17'}</span>
                      </div>
                      <div>
                        <div className="t">{'Playdate: story time + park'}</div>
                        <div className="m">
                          {'Maya, Ava, Theo '}
                          <i /> <span className="mono">{'10:00 AM'}</span>
                        </div>
                        <div className="m who-row" data-motion-step="3.2">
                          <span className="mini-av">{'J'}</span>
                          {'Jen driving '}
                          <span className="tag">{'Just added'}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className="cal-foot" data-motion-step="4">
                    <div className="avs">
                      <span className="av a">{'A'}</span>
                      <span className="av b">{'S'}</span>
                    </div>
                    {'\n            Shared with your co-parent\n          '}
                  </div>
                </article>
                <div className="phone">
                  <div className="screen">
                    <div className="island" />
                    <div className="status">
                      <span>{'9:41'}</span>
                      <span className="icons">
                        <svg
                          aria-hidden="true"
                          width="15"
                          height="10"
                          viewBox="0 0 17 11"
                          fill="currentColor"
                        >
                          <rect x="0" y="7" width="3" height="4" rx="0.8" />
                          <rect x="4.5" y="5" width="3" height="6" rx="0.8" />
                          <rect x="9" y="2.5" width="3" height="8.5" rx="0.8" />
                          <rect x="13.5" y="0" width="3" height="11" rx="0.8" />
                        </svg>
                        <svg
                          aria-hidden="true"
                          width="14"
                          height="10"
                          viewBox="0 0 15 11"
                          fill="currentColor"
                        >
                          <path d="M7.5 2.2c2.1 0 4 .8 5.4 2.1l1.1-1.1A9.2 9.2 0 0 0 7.5.6 9.2 9.2 0 0 0 1 3.2l1.1 1.1a7.7 7.7 0 0 1 5.4-2.1Zm0 3.1c1.2 0 2.4.5 3.2 1.3l1.1-1.1A6.2 6.2 0 0 0 7.5 3.7c-1.7 0-3.2.7-4.3 1.8l1.1 1.1c.8-.8 2-1.3 3.2-1.3Zm0 3.1c-.4 0-.8.2-1.1.5L7.5 10l1.1-1.1a1.6 1.6 0 0 0-1.1-.5Z" />
                        </svg>
                        <svg aria-hidden="true" width="22" height="11" viewBox="0 0 25 12">
                          <rect
                            x="0.5"
                            y="0.5"
                            width="21"
                            height="11"
                            rx="3.2"
                            fill="none"
                            stroke="currentColor"
                            strokeOpacity="0.35"
                          />
                          <rect x="2" y="2" width="16" height="8" rx="2" fill="currentColor" />
                          <path
                            d="M23 4v4c.8-.3 1.3-1.1 1.3-2S23.8 4.3 23 4Z"
                            fill="currentColor"
                            fillOpacity="0.4"
                          />
                        </svg>
                      </span>
                    </div>
                    <div className="ihead">
                      <svg
                        aria-hidden="true"
                        className="back"
                        viewBox="0 0 11 19"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M9 2 2 9.5 9 17" />
                      </svg>
                      <div className="group-avs">
                        <span className="gav mono-av">{'P'}</span>
                        <img className="gav hale" src="/landing-oct-2026/hale-logo.jpeg" alt="" />
                        <span className="gav mono-av">{'J'}</span>
                      </div>
                      <span className="name">
                        {'Saturday crew '}
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 5 9"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="m1 1 3 3.5L1 8" />
                        </svg>
                      </span>
                      <span className="members">{'Priya, Jen, Hale'}</span>
                    </div>
                    <div className="thread">
                      <div className="who">{'Priya'}</div>
                      <div className="row">
                        <span className="pic show mono-av">{'P'}</span>
                        <div className="msg in tail">
                          {'Playdate this weekend? Ava’s free Sat morning'}
                        </div>
                      </div>
                      <div className="msg out tail">{'Maya too!'}</div>
                      <div className="who">{'Hale'}</div>
                      <div className="row">
                        <img className="pic" src="/landing-oct-2026/hale-logo.jpeg" alt="" />
                        <div className="msg in">
                          {'Story time at the library at 10, then the playground next door?'}
                        </div>
                      </div>
                      <div className="row">
                        <img className="pic show" src="/landing-oct-2026/hale-logo.jpeg" alt="" />
                        <div className="msg in tail">{'Want me to add it for everyone?'}</div>
                      </div>
                      <div className="who" data-motion-step="0.6">
                        {'Jen'}
                      </div>
                      <div className="row" data-motion-step="0.6">
                        <span className="pic show mono-av">{'J'}</span>
                        <div className="msg in tail">{'We’re in, I can drive'}</div>
                      </div>
                      <div className="who" data-motion-step="1.6">
                        {'Hale'}
                      </div>
                      <div className="row" data-motion-step="1.6">
                        <img className="pic show" src="/landing-oct-2026/hale-logo.jpeg" alt="" />
                        <div className="msg in tail">
                          {'Done, it’s on everyone’s calendar. Jen’s driving.'}
                        </div>
                      </div>
                    </div>
                    <div className="compose">
                      <span className="plus">
                        <svg
                          aria-hidden="true"
                          viewBox="0 0 12 12"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.6"
                          strokeLinecap="round"
                        >
                          <path d="M6 1v10M1 6h10" />
                        </svg>
                      </span>
                      <span className="field">
                        {'iMessage '}
                        <svg aria-hidden="true" viewBox="0 0 12 15" fill="currentColor">
                          <rect x="3.5" y="0.5" width="5" height="9" rx="2.5" />
                          <path
                            d="M1.5 7a4.5 4.5 0 0 0 9 0"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeLinecap="round"
                          />
                          <path
                            d="M6 11.5V14"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeLinecap="round"
                          />
                        </svg>
                      </span>
                    </div>
                    <div className="home">
                      <i />
                    </div>
                  </div>
                </div>
              </div>
              <HomeMotion />
            </div>
          </div>
        </section>
      </div>
      <div className="hs-page">
        <section className="hs hs-wash-a" id="group-chats">
          <div className="hs-wrap">
            <div className="hs-head">
              <p className="hs-eyebrow">{'In your group chats'}</p>
              <h2 className="hs-h2">{'Hale joins the chats you already have.'}</h2>
              <p className="hs-lede">
                {
                  'Ask in the chat. Hale answers in a line or two, keeps track of what you decided, then goes quiet.'
                }
              </p>
            </div>
            <ChatGallery>
              <div>
                <div className="hs-chat-cap">
                  <span className="n">{'01'}</span>
                  <h3 className="hs-h3">{'A joint birthday party'}</h3>
                </div>
                <PhoneChat>
                  <article className="hs-card hs-chat">
                    <header className="hs-chat-head">
                      <div className="hs-avs">
                        <span className="hs-av">{'D'}</span>
                        <img className="hs-av hale" src="/landing-oct-2026/hale-logo.jpeg" alt="" />
                        <span className="hs-av">{'M'}</span>
                      </div>
                      <div>
                        <div className="hs-chat-name">{'Room 4 parents 🍎'}</div>
                        <div className="hs-chat-members">{'Dana, Marco + 7 more'}</div>
                      </div>
                    </header>
                    <div className="hs-thread" data-motion-scene="chat">
                      <div className="hs-stamp">
                        iMessage
                        <br />
                        <b>Today</b> 9:41
                      </div>
                      <div className="hs-who">{'Dana'}</div>
                      <div className="hs-row">
                        <span className="hs-pic mono show">{'D'}</span>
                        <div className="hs-msg in">
                          {'Joint party for Leo and Aria? Somewhere indoor 🎈'}
                        </div>
                      </div>
                      <div className="hs-who" data-motion-step="0.6">
                        {'Hale'}
                      </div>
                      <div className="hs-row" data-motion-step="0.6">
                        <img
                          className="hs-pic show"
                          src="/landing-oct-2026/hale-logo.jpeg"
                          alt=""
                        />
                        <TypingBubble />
                        <div className="hs-msg in">
                          {
                            'Two nearby take Saturday groups of 8: the climbing gym (ages 3–7) or the clay café (ages 4+). Want me to track RSVPs?'
                          }
                        </div>
                      </div>
                      <div className="hs-who" data-motion-step="2.2">
                        {'Dana'}
                      </div>
                      <div className="hs-row" data-motion-step="2.2">
                        <span className="hs-pic mono show">{'D'}</span>
                        <TypingBubble />
                        <div className="hs-msg in">{'Climbing gym! Booked Sat the 14th at 2'}</div>
                      </div>
                      <span className="hs-did" data-motion-step="3">
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
                        {'6 yes, 2 to go · on everyone’s calendar'}
                      </span>
                    </div>
                  </article>
                </PhoneChat>
              </div>
              <div>
                <div className="hs-chat-cap">
                  <span className="n">{'02'}</span>
                  <h3 className="hs-h3">{'Who’s driving this week'}</h3>
                </div>
                <PhoneChat>
                  <article className="hs-card hs-chat">
                    <header className="hs-chat-head">
                      <div className="hs-avs">
                        <span className="hs-av">{'M'}</span>
                        <img className="hs-av hale" src="/landing-oct-2026/hale-logo.jpeg" alt="" />
                        <span className="hs-av">{'T'}</span>
                      </div>
                      <div>
                        <div className="hs-chat-name">{'Soccer carpool 🚗'}</div>
                        <div className="hs-chat-members">{'Mei, Tom, Hale'}</div>
                      </div>
                    </header>
                    <div className="hs-thread" data-motion-scene="chat">
                      <div className="hs-stamp">
                        iMessage
                        <br />
                        <b>Today</b> 9:41
                      </div>
                      <div className="hs-msg out">{'Can’t do Tuesday pickup this week 😩'}</div>
                      <div className="hs-who" data-motion-step="0.6">
                        {'Tom'}
                      </div>
                      <div className="hs-row" data-motion-step="0.6">
                        <span className="hs-pic mono show">{'T'}</span>
                        <TypingBubble />
                        <div className="hs-msg in">{'I’ll grab both Tue. You do Thu?'}</div>
                      </div>
                      <div className="hs-who" data-motion-step="1.6">
                        {'Hale'}
                      </div>
                      <div className="hs-row" data-motion-step="1.6">
                        <img
                          className="hs-pic show"
                          src="/landing-oct-2026/hale-logo.jpeg"
                          alt=""
                        />
                        <TypingBubble />
                        <div className="hs-msg in">
                          {
                            'Got it. Tom on Tuesday, Mei on Thursday, 5:30 after soccer. I’ll remind whoever’s driving the night before.'
                          }
                        </div>
                      </div>
                      <span className="hs-did" data-motion-step="3">
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
                        {'Driving · Tue Tom, Thu Mei'}
                      </span>
                    </div>
                  </article>
                </PhoneChat>
              </div>
              <div>
                <div className="hs-chat-cap">
                  <span className="n">{'03'}</span>
                  <h3 className="hs-h3">{'Same swim class, three families'}</h3>
                </div>
                <PhoneChat>
                  <article className="hs-card hs-chat">
                    <header className="hs-chat-head">
                      <div className="hs-avs">
                        <span className="hs-av">{'A'}</span>
                        <img className="hs-av hale" src="/landing-oct-2026/hale-logo.jpeg" alt="" />
                        <span className="hs-av">{'J'}</span>
                      </div>
                      <div>
                        <div className="hs-chat-name">{'Swim this winter? 🏊'}</div>
                        <div className="hs-chat-members">{'Aisha, Jordan, Kate, Hale'}</div>
                      </div>
                    </header>
                    <div className="hs-thread" data-motion-scene="chat">
                      <div className="hs-stamp">
                        iMessage
                        <br />
                        <b>Today</b> 9:41
                      </div>
                      <div className="hs-who">{'Aisha'}</div>
                      <div className="hs-row">
                        <span className="hs-pic mono show">{'A'}</span>
                        <div className="hs-msg in">
                          {'Same swim class for all three kids this winter?'}
                        </div>
                      </div>
                      <div className="hs-who" data-motion-step="0.6">
                        {'Hale'}
                      </div>
                      <div className="hs-row" data-motion-step="0.6">
                        <img
                          className="hs-pic show"
                          src="/landing-oct-2026/hale-logo.jpeg"
                          alt=""
                        />
                        <TypingBubble />
                        <div className="hs-msg in">
                          {
                            'Saturdays 9:30 at the community pool has room for all three. Sign-ups open Tuesday at 7. I’ll send you each the link the night before.'
                          }
                        </div>
                      </div>
                      <span className="hs-did" data-motion-step="2.2">
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
                        {'Reminder set · Mon 7 PM'}
                      </span>
                      <div className="hs-msg out" data-motion-step="3">
                        {'Got in! 🙌'}
                      </div>
                    </div>
                  </article>
                </PhoneChat>
              </div>
            </ChatGallery>
            <div className="hs-solo">
              <div className="hs-solo-l">
                <span className="hs-solo-ic">
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
                <p className="hs-p">
                  <b>{'Not in a group?'}</b>
                  {' Text Hale on your own. Same finds, same reminders, just the two of you.'}
                </p>
              </div>
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
        </section>
        <section className="hs hs-shore" id="the-year">
          <img
            className="hs-shore-art"
            src="/landing-oct-2026/hale-shore-hero.webp"
            alt=""
            aria-hidden="true"
          />
          <span className="shore-drift sea hs-shore-sea" aria-hidden="true" />
          <span className="hs-shore-scrim" aria-hidden="true" />
          <div className="hs-wrap">
            <div className="hs-head hs-glow">
              <p className="hs-eyebrow">{'Across the kids’ year'}</p>
              <h2 className="hs-h2">{'From finding the class to hearing how it went.'}</h2>
              <p className="hs-lede">{'Four small jobs, all year. Each one shows up as a text.'}</p>
            </div>
            <div className="hs-beats">
              <div className="hs-beat hs-glass">
                <p className="hs-when">{'Any week'}</p>
                <h3 className="hs-h3">{'Finds what’s on near you'}</h3>
                <p className="hs-p">
                  {
                    'Swim, camps, drop-ins, the library down the street. Picked for your kids’ ages, from the places that run them.'
                  }
                </p>
                <div className="hs-art" data-motion-scene="beat">
                  <div className="hs-card hs-art-pad hs-mini">
                    <div className="hs-msg in">
                      <span data-motion-step="0">{'Here’s what’s on near you this week:'}</span>
                      <span data-motion-step="0.3">
                        {'1. Parent & tot swim (ages 2–4), Sat 9:15 a.m.'}
                      </span>
                      <span data-motion-step="0.6">
                        {'2. Library storytime (ages 2–5), Tue 10:30 a.m.'}
                      </span>
                      <span data-motion-step="0.9">
                        {'3. Little movers (ages 2–5), winter times not posted yet'}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <div className="hs-beat hs-glass">
                <p className="hs-when">{'When a class fills'}</p>
                <h3 className="hs-h3">{'Watches for a spot'}</h3>
                <p className="hs-p">
                  {
                    'If the class you wanted is full, Hale keeps an eye on it and texts you when a place opens.'
                  }
                </p>
                <div className="hs-art" data-motion-scene="beat">
                  <div className="hs-notif" data-motion-step="0">
                    <div className="hs-notif-top">
                      <img src="/landing-oct-2026/hale-logo.jpeg" alt="" />
                      <b>{'Hale'}</b>
                      <span>{'now'}</span>
                    </div>
                    <p>
                      <b>{'A spot just opened'}</b>
                      {' in Swimmer 3, Saturdays 9:30. Here’s the '}
                      <span className="hs-link">{'sign-up page'}</span>
                      {'.'}
                    </p>
                  </div>
                </div>
              </div>
              <div className="hs-beat hs-glass">
                <p className="hs-when">{'Before sign-ups'}</p>
                <h3 className="hs-h3">{'Reminds you before it opens'}</h3>
                <p className="hs-p">
                  {
                    'A heads-up the week before, the link the night before. You register, and you’re ready when it opens.'
                  }
                </p>
                <div className="hs-art" data-motion-scene="beat">
                  <div className="hs-card hs-rem" data-motion-step="0">
                    <div className="hs-rem-top">
                      <div className="hs-rem-date">
                        <span className="hs-rem-cal">
                          <i>{'Tue'}</i>
                          <b>{'7'}</b>
                        </span>
                        <div>
                          <div className="hs-rem-t">{'Fall programs open'}</div>
                          <div className="hs-wm" data-motion-step="0.6">
                            {'Tomorrow · 7:00 a.m.'}
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="hs-rem-body">
                      {
                        'Tomorrow: fall programs at the rec centre open 7:00 a.m. for Mia. Sign in tonight and have the page open.'
                      }
                    </div>
                  </div>
                </div>
              </div>
              <div className="hs-beat hs-glass">
                <p className="hs-when">{'After the first class'}</p>
                <h3 className="hs-h3">{'Asks how it went'}</h3>
                <p className="hs-p">
                  {
                    'One quick question after the first class. Your answer shapes what Hale sends you next.'
                  }
                </p>
                <div className="hs-art" data-motion-scene="beat">
                  <div className="hs-card hs-art-pad hs-mini">
                    <div className="hs-msg in">{'How did swim go? One line is plenty.'}</div>
                    <div className="hs-msg out" data-motion-step="0">
                      {'She loved it. Pool was freezing 🥶'}
                    </div>
                    <div className="hs-msg in" data-motion-step="0.6">
                      {'Thanks, that helps. I’ll use it when I pick what to send you next.'}
                    </div>
                    <span className="hs-did" data-motion-step="1.2">
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
                      {'Remembered: Mia loves swim'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <section className="hs hs-wash-b" id="logistics">
          <div className="hs-wrap hs-grid hs-logi">
            <div className="hs-logi-l">
              <p className="hs-eyebrow">{'The logistics'}</p>
              <h2 className="hs-h2">{'Who, when and where, kept straight.'}</h2>
              <ul className="hs-list">
                <li>
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
                      <rect x="3" y="4.5" width="14" height="12.5" rx="2.5" />
                      <path d="M3 8.5h14M7 2.8v3.4M13 2.8v3.4" />
                    </svg>
                  </span>
                  <div>
                    <h3 className="hs-h3">{'Plans on your calendar'}</h3>
                    <p className="hs-p">
                      {
                        'Each plan comes as a calendar invite, so it lands in Google or Apple Calendar with one tap.'
                      }
                    </p>
                  </div>
                </li>
                <li>
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
                  <div>
                    <h3 className="hs-h3">{'Your co-parent sees the same plan'}</h3>
                    <p className="hs-p">
                      {
                        'Start a group with them and Hale. Same week, same reminders, on their own phone. Always free.'
                      }
                    </p>
                  </div>
                </li>
                <li>
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
                      <path d="M3.5 13.5V10l1.7-4.1A2 2 0 0 1 7 4.7h6a2 2 0 0 1 1.8 1.2l1.7 4.1v3.5" />
                      <path d="M2.8 10h14.4v3.5H2.8z" />
                      <circle cx="6.3" cy="15.3" r="1.3" />
                      <circle cx="13.7" cy="15.3" r="1.3" />
                    </svg>
                  </span>
                  <div>
                    <h3 className="hs-h3">{'Who’s driving, sorted'}</h3>
                    <p className="hs-p">
                      {
                        'Say who’s taking them. Hale keeps track and reminds that person the night before.'
                      }
                    </p>
                  </div>
                </li>
                <li>
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
                      <path d="M10 16.5s-6-3.6-6-8.1A3.4 3.4 0 0 1 10 6.3a3.4 3.4 0 0 1 6 2.1c0 4.5-6 8.1-6 8.1z" />
                    </svg>
                  </span>
                  <div>
                    <h3 className="hs-h3">{'It remembers each kid'}</h3>
                    <p className="hs-p">
                      {
                        'Ages, what they love, what’s already on their week. Ask “what do you know” to see it all, or fix it in one text.'
                      }
                    </p>
                  </div>
                </li>
              </ul>
            </div>
            <div className="hs-logi-r">
              <div className="hs-card hs-week">
                <div className="hs-week-head">
                  <span className="t">{'This week'}</span>
                  <span className="hs-wm">{'Shared with Alex'}</span>
                </div>
                <div className="hs-wrow">
                  <div className="hs-wday">
                    {'Mon'}
                    <b>{'9'}</b>
                  </div>
                  <div>
                    <div className="hs-wt">{'Swim, Swimmer 3'}</div>
                    <div className="hs-wm">{'Mia · 4:30 PM'}</div>
                  </div>
                  <span className="hs-driver">
                    <i>{'A'}</i>
                    {'Alex driving'}
                  </span>
                </div>
                <div className="hs-wrow">
                  <div className="hs-wday">
                    {'Tue'}
                    <b>{'10'}</b>
                  </div>
                  <div>
                    <div className="hs-wt">{'Soccer'}</div>
                    <div className="hs-wm">{'Noah, Lily · 5:30 PM'}</div>
                  </div>
                  <span className="hs-driver">
                    <i>{'T'}</i>
                    {'Tom driving'}
                  </span>
                </div>
                <div className="hs-wrow">
                  <div className="hs-wday">
                    {'Thu'}
                    <b>{'12'}</b>
                  </div>
                  <div>
                    <div className="hs-wt">{'Soccer'}</div>
                    <div className="hs-wm">{'Noah, Lily · 5:30 PM'}</div>
                  </div>
                  <span className="hs-driver">
                    <i>{'M'}</i>
                    {'Mei driving'}
                  </span>
                </div>
                <div className="hs-wrow">
                  <div className="hs-wday">
                    {'Sat'}
                    <b>{'14'}</b>
                  </div>
                  <div>
                    <div className="hs-wt">{'Leo & Aria’s party'}</div>
                    <div className="hs-wm">{'Climbing gym · 2:00 PM'}</div>
                  </div>
                  <span className="hs-driver open">{'Who’s driving?'}</span>
                </div>
              </div>
              <div className="hs-card hs-memory">
                <div className="hs-mini">
                  <div className="hs-msg out">{'What do you know about us?'}</div>
                  <div className="hs-msg in">
                    {
                      'Mia is 6 and loves swimming and drawing. Theo is 3. Thursdays I think are soccer, tell me if that changed.'
                    }
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
        <DesignPricing locale={locale} />
        <section className="hs hs-wash-d" id="faq">
          <div className="hs-wrap hs-grid">
            <div className="hs-faq-l">
              <p className="hs-eyebrow">{'Questions'}</p>
              <h2 className="hs-h2">{'What parents ask first.'}</h2>
              <a className="hs-more hs-desktop-only" href="/faq">
                <span>{'All questions'}</span>
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
            <div className="hs-faq-r">
              <div className="hs-qa">
                <h3 className="hs-h3">{'Does Hale book or register for me?'}</h3>
                <p className="hs-p">
                  {
                    'Not yet. Hale finds the class, watches for spots and texts you the link before sign-ups open. You register yourself. Signing up for you is coming later, and only when you say yes.'
                  }
                </p>
              </div>
              <div className="hs-qa">
                <h3 className="hs-h3">{'Is it free?'}</h3>
                <p className="hs-p">
                  {
                    'Yes. Hale is free while it’s new, and families who start now keep their founding rate. Your co-parent is always free.'
                  }
                </p>
              </div>
              <div className="hs-qa">
                <h3 className="hs-h3">{'Do I need an app?'}</h3>
                <p className="hs-p">
                  {
                    'No. Hale works in iMessage and regular texts. Add it to a group chat, or text it on its own.'
                  }
                </p>
              </div>
              <div className="hs-qa">
                <h3 className="hs-h3">{'Can I ask it other things?'}</h3>
                <p className="hs-p">
                  {
                    'Anything. Sleep, a rainy-day idea, what’s open Monday. Hale looks it up live and answers in a line or two.'
                  }
                </p>
              </div>
              <div className="hs-qa">
                <h3 className="hs-h3">{'What about our privacy?'}</h3>
                <p className="hs-p">
                  {
                    'Your family’s data stays in Canada and is never sold. Nothing from your inbox or personal calendar shows up in a group chat, and you can stop messages at any time.'
                  }
                </p>
              </div>
              <a className="hs-more hs-mobile-only" href="/faq">
                <span>{'All questions'}</span>
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
