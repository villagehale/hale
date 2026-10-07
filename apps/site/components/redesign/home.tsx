import type { Locale } from '~/i18n/routing';
import { Phrase, tx } from './tx';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { logoSrc, shoreSrc } from './assets';
import { TextDoor } from './text-door';
import { localeHref } from '~/i18n/navigation';
import { LandingScrollAnalytics } from '~/components/landing-scroll-analytics';

export function RedesignHome({
  locale,
  smsNumber,
  prefill,
}: {
  locale: Locale;
  smsNumber: string;
  prefill: string;
}) {
  const t = (s: string) => tx(locale, s);
  const mode = 'chooser' as const;
  
  return (
    <>
      <SiteHeader locale={locale} />
      <LandingScrollAnalytics />
      <div className="rd">
        

<div className="stage">
<img className="shore-art" src={shoreSrc} alt="" aria-hidden="true" />
<span className="shore-drift sky" aria-hidden="true" />
<span className="shore-drift sea" aria-hidden="true" />
<span className="shore-scrim" aria-hidden="true" />



<main id="main" className="hero">
  <div className="grid">
    <section className="copy">
      <span className="chip">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true"><path d="M6.5 2.5c2.5 0 4.5 1.6 4.5 3.6S9 9.7 6.5 9.7c-.45 0-.9-.05-1.3-.15L2.8 10.6l.65-1.75C2.55 8.2 2 7.2 2 6.1 2 4.1 4 2.5 6.5 2.5Z" /><path d="M12.2 6.2c1.1.6 1.8 1.6 1.8 2.7 0 .9-.45 1.7-1.2 2.3l.5 1.5-1.9-.85c-.4.1-.8.15-1.2.15-1.3 0-2.45-.45-3.25-1.2" /></svg>
        {t("Works in your group chats")}
      </span>
      <h1 className={locale === "fr" ? "h1-fr" : undefined}>{t("Your kids’ year,")}<br />{t("handled.")}</h1>
      <p className="sub">{t("Your kids’ plans already live in group chats. Add Hale, and it finds what’s on, gets everyone to a yes, and puts it on the calendar.")}</p>
      <div className="cta-row">
        <TextDoor className="btn btn-hero" placement="hero" locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode}>
          <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M10 2.75c4.28 0 7.75 2.86 7.75 6.38 0 3.53-3.47 6.38-7.75 6.38-.86 0-1.69-.11-2.46-.33L3.6 16.9a.4.4 0 0 1-.56-.46l.83-2.97C2.88 12.36 2.25 10.8 2.25 9.13c0-3.52 3.47-6.38 7.75-6.38Z" /></svg>
          {t("Text Hale")}
        </TextDoor>
        <a className="rd-textlink" href="#group-chats"><span>{t("See how it works")}</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7h8M7.5 3.5 11 7l-3.5 3.5" /></svg>
        </a>
      </div>
      <ul className="loop glass-ring" aria-label={t("What Hale does")}>
        <li>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="8.75" cy="8.75" r="5.25" /><path d="m12.75 12.75 4 4" /></svg>
          <b>{t("Finds activities")}</b><small>{t("Near you, by age")}</small>
        </li>
        <li>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1.75 10S4.75 4.5 10 4.5 18.25 10 18.25 10 15.25 15.5 10 15.5 1.75 10 1.75 10Z" /><circle cx="10" cy="10" r="2.5" /></svg>
          <b>{t("Watches for spots")}</b><small>{t("When classes open")}</small>
        </li>
        <li>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 2.75a4.75 4.75 0 0 0-4.75 4.75v3L3.75 13h12.5l-1.5-2.5v-3A4.75 4.75 0 0 0 10 2.75Z" /><path d="M8.25 16a1.85 1.85 0 0 0 3.5 0" /></svg>
          <b>{t("Reminds you")}</b><small>{t("Before registration")}</small>
        </li>
        <li>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3c4.4 0 7.5 2.7 7.5 6s-3.1 6-7.5 6c-.8 0-1.6-.1-2.3-.3L3.5 16.5l1.1-3.1C3.3 12.3 2.5 10.7 2.5 9 2.5 5.7 5.6 3 10 3Z" /><path d="M7.5 10.25c.6.75 1.5 1.15 2.5 1.15s1.9-.4 2.5-1.15" /></svg>
          <b>{t("Asks how it went")}</b><small>{t("After the first class")}</small>
        </li>
      </ul>
    </section>

    <div className="visual-col">
      <div className="visual" aria-label={t("Example: a family calendar filled in by Hale, and the text thread that added it")}>

        <article className="cal">
          <div className="cal-head">
            <div>
              <div className="cal-title">{t("This week")}</div>
            </div>
            <div className="kids"><span className="kid">Maya, 6</span><span className="kid">Leo, 3</span></div>
          </div>

          <div className="week">
            <div className="day today"><span className="dow">M</span><span className="num">12</span><span className="dot" /></div>
            <div className="day"><span className="dow">T</span><span className="num">13</span><span className="dot amber" /></div>
            <div className="day"><span className="dow">W</span><span className="num">14</span><span className="dot ink" /></div>
            <div className="day"><span className="dow">T</span><span className="num">15</span><span className="dot ink" /></div>
            <div className="day"><span className="dow">F</span><span className="num">16</span><span className="dot" /></div>
            <div className="day"><span className="dow">S</span><span className="num">17</span><span className="dot amber" /></div>
            <div className="day"><span className="dow">S</span><span className="num">18</span><span className="dot" /></div>
          </div>

          <div className="agenda">
            <div className="ev">
              <div className="d"><b>{t("TUE")}</b><span>13</span></div>
              <div>
                <div className="t">{t("Swim registration opens")}</div>
                <div className="m">
                  <svg className="bell" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M6 1a3.2 3.2 0 0 0-3.2 3.2v1.9L1.9 7.6a.5.5 0 0 0 .43.76h7.34a.5.5 0 0 0 .43-.76L9.2 6.1V4.2A3.2 3.2 0 0 0 6 1Zm-1.3 8.6a1.3 1.3 0 0 0 2.6 0H4.7Z" /></svg>
                  {t("Reminder")} <i /> <span className="mono">{t("7:00 PM")}</span>
                </div>
              </div>
            </div>
            <div className="ev">
              <div className="d"><b>{t("WED")}</b><span>14</span></div>
              <div>
                <div className="t">{t("Library playgroup")}</div>
                <div className="m">Leo <i /> <span className="mono">{t("9:30 AM")}</span></div>
              </div>
            </div>
            <div className="ev">
              <div className="d"><b>{t("THU")}</b><span>15</span></div>
              <div>
                <div className="t">{t("Leo’s soccer")}</div>
                <div className="m">Leo <i /> <span className="mono">{t("5:30 PM")}</span></div>
              </div>
            </div>
            <div className="ev new">
              <div className="d"><b>{t("SAT")}</b><span>17</span></div>
              <div>
                <div className="t">{t("Playdate: story time + park")}</div>
                <div className="m">Maya, Ava, Theo <i /> <span className="mono">{t("10:00 AM")}</span></div>
                <div className="m who-row"><span className="mini-av">J</span>{t("Jen driving")} <span className="tag">{t("Just added")}</span></div>
              </div>
            </div>
          </div>

          <div className="cal-foot">
            <div className="avs"><span className="av a">A</span><span className="av b">S</span></div>
            {t("Shared with your co-parent")}
          </div>
        </article>

        <div className="phone">
          <div className="screen">
            <div className="island" />
            <div className="status">
              <span>9:41</span>
              <span className="icons">
                <svg width="15" height="10" viewBox="0 0 17 11" fill="#000" aria-hidden="true"><rect x="0" y="7" width="3" height="4" rx="0.8" /><rect x="4.5" y="5" width="3" height="6" rx="0.8" /><rect x="9" y="2.5" width="3" height="8.5" rx="0.8" /><rect x="13.5" y="0" width="3" height="11" rx="0.8" /></svg>
                <svg width="14" height="10" viewBox="0 0 15 11" fill="#000" aria-hidden="true"><path d="M7.5 2.2c2.1 0 4 .8 5.4 2.1l1.1-1.1A9.2 9.2 0 0 0 7.5.6 9.2 9.2 0 0 0 1 3.2l1.1 1.1a7.7 7.7 0 0 1 5.4-2.1Zm0 3.1c1.2 0 2.4.5 3.2 1.3l1.1-1.1A6.2 6.2 0 0 0 7.5 3.7c-1.7 0-3.2.7-4.3 1.8l1.1 1.1c.8-.8 2-1.3 3.2-1.3Zm0 3.1c-.4 0-.8.2-1.1.5L7.5 10l1.1-1.1a1.6 1.6 0 0 0-1.1-.5Z" /></svg>
                <svg width="22" height="11" viewBox="0 0 25 12" aria-hidden="true"><rect x="0.5" y="0.5" width="21" height="11" rx="3.2" fill="none" stroke="#000" strokeOpacity="0.35" /><rect x="2" y="2" width="16" height="8" rx="2" fill="#000" /><path d="M23 4v4c.8-.3 1.3-1.1 1.3-2S23.8 4.3 23 4Z" fill="#000" fillOpacity="0.4" /></svg>
              </span>
            </div>
            <div className="ihead">
              <svg className="back" viewBox="0 0 11 19" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 2 2 9.5 9 17" /></svg>
              <div className="group-avs"><span className="gav mono-av">P</span><img className="gav hale" src={logoSrc} alt="" /><span className="gav mono-av">J</span></div>
              <span className="name">{t("Saturday crew")} <svg viewBox="0 0 5 9" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m1 1 3 3.5L1 8" /></svg></span>
              <span className="members">{t("Priya, Jen, Hale")}</span>
            </div>
            <div className="thread">
              <div className="who">Priya</div>
              <div className="row"><span className="pic show mono-av">P</span><div className="msg in tail">{t("Playdate this weekend? Ava’s free Sat morning")}</div></div>
              <div className="msg out tail">{t("Maya too!")}</div>
              <div className="who">Hale</div>
              <div className="row"><img className="pic" src={logoSrc} alt="" /><div className="msg in">{t("Story time at the library at 10, then the playground next door?")}</div></div>
              <div className="row"><img className="pic show" src={logoSrc} alt="" /><div className="msg in tail">{t("Want me to add it for everyone?")}</div></div>
              <div className="who">Jen</div>
              <div className="row"><span className="pic show mono-av">J</span><div className="msg in tail">{t("We’re in, I can drive")}</div></div>
              <div className="who">Hale</div>
              <div className="row"><img className="pic show" src={logoSrc} alt="" /><div className="msg in tail">{t("Done, it’s on everyone’s calendar. Jen’s driving.")}</div></div>
            </div>
            <div className="compose">
              <span className="plus"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M6 1v10M1 6h10" /></svg></span>
              <span className="field">iMessage <svg viewBox="0 0 12 15" fill="currentColor" aria-hidden="true"><rect x="3.5" y="0.5" width="5" height="9" rx="2.5" /><path d="M1.5 7a4.5 4.5 0 0 0 9 0" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><path d="M6 11.5V14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg></span>
            </div>
            <div className="home"><i /></div>
          </div>
        </div>

      </div>
    </div>
  </div>
</main>
</div>
<div className="hs-page">
<section className="hs hs-wash-a" id="group-chats">
 <div className="hs-wrap">
  <div className="hs-head">
   <p className="hs-eyebrow">{t("In your group chats")}</p>
   <h2 className="hs-h2">{t("Hale joins the chats you already have.")}</h2>
   <p className="hs-lede">{t("Ask in the chat. Hale answers in a line or two, keeps track of what you decided, then goes quiet.")}</p>
  </div>
  <div className="hs-chats">
   <div><div className="hs-chat-cap"><span className="n">01</span><h3 className="hs-h3">{t("A joint birthday party")}</h3></div><article className="hs-card hs-chat">
  <div className="hs-chat-head"><div className="hs-avs"><span className="hs-av">D</span><img className="hs-av hale" src={logoSrc} alt="" /><span className="hs-av">M</span></div><div><div className="hs-chat-name">{t("Room 4 parents 🍎")}</div><div className="hs-chat-members">{t("Dana, Marco + 7 more")}</div></div></div>
  <div className="hs-thread">
<div className="hs-who">Dana</div>
<div className="hs-row"><span className="hs-pic mono show">D</span><div className="hs-msg in">{t("Joint party for Leo and Aria? Somewhere indoor 🎈")}</div></div>
<div className="hs-who">Hale</div>
<div className="hs-row"><img className="hs-pic show" src={logoSrc} alt="" /><div className="hs-msg in">{t("Two nearby take Saturday groups of 8: the climbing gym (ages 3–7) or the clay café (ages 4+). Want me to track RSVPs?")}</div></div>
<div className="hs-who">Dana</div>
<div className="hs-row"><span className="hs-pic mono show">D</span><div className="hs-msg in">{t("Climbing gym! Booked Sat the 14th at 2")}</div></div>
<span className="hs-did"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>{t("6 yes, 2 to go · on everyone’s calendar")}</span>
  </div>
</article></div>
   <div><div className="hs-chat-cap"><span className="n">02</span><h3 className="hs-h3">{t("Who’s driving this week")}</h3></div><article className="hs-card hs-chat">
  <div className="hs-chat-head"><div className="hs-avs"><span className="hs-av">M</span><img className="hs-av hale" src={logoSrc} alt="" /><span className="hs-av">T</span></div><div><div className="hs-chat-name">{t("Soccer carpool 🚗")}</div><div className="hs-chat-members">{t("Mei, Tom, Hale")}</div></div></div>
  <div className="hs-thread">
<div className="hs-msg out">{t("Can’t do Tuesday pickup this week 😩")}</div>
<div className="hs-who">Tom</div>
<div className="hs-row"><span className="hs-pic mono show">T</span><div className="hs-msg in">{t("I’ll grab both Tue. You do Thu?")}</div></div>
<div className="hs-who">Hale</div>
<div className="hs-row"><img className="hs-pic show" src={logoSrc} alt="" /><div className="hs-msg in">{t("Got it. Tom on Tuesday, Mei on Thursday, 5:30 after soccer. I’ll remind whoever’s driving the night before.")}</div></div>
<span className="hs-did"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>{t("Driving · Tue Tom, Thu Mei")}</span>
  </div>
</article></div>
   <div><div className="hs-chat-cap"><span className="n">03</span><h3 className="hs-h3">{t("Same swim class, three families")}</h3></div><article className="hs-card hs-chat">
  <div className="hs-chat-head"><div className="hs-avs"><span className="hs-av">A</span><img className="hs-av hale" src={logoSrc} alt="" /><span className="hs-av">J</span></div><div><div className="hs-chat-name">{t("Swim this winter? 🏊")}</div><div className="hs-chat-members">{t("Aisha, Jordan, Kate, Hale")}</div></div></div>
  <div className="hs-thread">
<div className="hs-who">Aisha</div>
<div className="hs-row"><span className="hs-pic mono show">A</span><div className="hs-msg in">{t("Same swim class for all three kids this winter?")}</div></div>
<div className="hs-who">Hale</div>
<div className="hs-row"><img className="hs-pic show" src={logoSrc} alt="" /><div className="hs-msg in">{t("Saturdays 9:30 at the community pool has room for all three. Sign-ups open Tuesday at 7. I’ll send you each the link the night before.")}</div></div>
<span className="hs-did"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>{t("Reminder set · Mon 7 PM")}</span>
<div className="hs-msg out">{t("Got in! 🙌")}</div>
  </div>
</article></div>
  </div>
  <div className="hs-solo">
   <div className="hs-solo-l"><span className="hs-solo-ic"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true"><path d="M10 3.5c3.9 0 7 2.6 7 5.8s-3.1 5.8-7 5.8c-.8 0-1.5-.1-2.2-.3L4.3 16.3l1-2.9C4 12.4 3 10.9 3 9.3 3 6.1 6.1 3.5 10 3.5z" /></svg></span><p className="hs-p"><b>{t("Not in a group?")}</b> {t("Text Hale on your own. Same finds, same reminders, just the two of you.")}</p></div>
   <TextDoor className="btn btn-hero" placement="home_solo" locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.5c3.3 0 6 2.2 6 4.9s-2.7 4.9-6 4.9c-.7 0-1.3-.1-1.9-.2L3 13.5l.9-2.5C2.7 10.1 2 8.8 2 7.4 2 4.7 4.7 2.5 8 2.5z" /></svg>{t("Text Hale")}</TextDoor>
  </div>
 </div>
</section>
<section className="hs hs-shore" id="the-year">
 <img className="hs-shore-art" src={shoreSrc} alt="" aria-hidden="true" />
 <span className="shore-drift sea hs-shore-sea" aria-hidden="true" />
 <span className="hs-shore-scrim" aria-hidden="true" />
 <div className="hs-wrap">
  <div className="hs-head hs-glow">
   <p className="hs-eyebrow">{t("Across the kids’ year")}</p>
   <h2 className="hs-h2">{t("From finding the class to hearing how it went.")}</h2>
   <p className="hs-lede">{t("Four small jobs, all year. Each one shows up as a text.")}</p>
  </div>
  <div className="hs-beats">
   <div className="hs-beat hs-glass">
    <p className="hs-when">{t("Any week")}</p>
    <h3 className="hs-h3">{t("Finds what’s on near you")}</h3>
    <p className="hs-p">{t("Swim, camps, drop-ins, the library down the street. Picked for your kids’ ages, from the places that run them.")}</p>
    <div className="hs-art"><div className="hs-card hs-art-pad hs-mini">
     <div className="hs-msg in">{t("Here’s what’s on near you this week:\n1. Parent & tot swim (ages 2–4), Sat 9:15 a.m.\n2. Library storytime (ages 2–5), Tue 10:30 a.m.\n3. Little movers (ages 2–5), winter times not posted yet")}</div>
    </div></div>
   </div>
   <div className="hs-beat hs-glass">
    <p className="hs-when">{t("When a class fills")}</p>
    <h3 className="hs-h3">{t("Watches for a spot")}</h3>
    <p className="hs-p">{t("If the class you wanted is full, Hale keeps an eye on it and texts you when a place opens.")}</p>
    <div className="hs-art"><div className="hs-notif">
     <div className="hs-notif-top"><img src={logoSrc} alt="" /><b>Hale</b><span>{t("now")}</span></div>
     <p><b>{t("A spot just opened")}</b> {t("in Swimmer 3, Saturdays 9:30. Here’s the")} <span className="hs-link">{t("sign-up page")}</span>.</p>
    </div></div>
   </div>
   <div className="hs-beat hs-glass">
    <p className="hs-when">{t("Before sign-ups")}</p>
    <h3 className="hs-h3">{t("Reminds you before it opens")}</h3>
    <p className="hs-p">{t("A heads-up the week before, the link the night before. You register, and you’re ready when it opens.")}</p>
    <div className="hs-art"><div className="hs-card hs-rem">
     <div className="hs-rem-top"><div className="hs-rem-date"><span className="hs-rem-cal"><i>{t("Tue")}</i><b>7</b></span><div><div className="hs-rem-t">{t("Fall programs open")}</div><div className="hs-wm">{t("Tomorrow · 7:00 a.m.")}</div></div></div></div>
     <div className="hs-rem-body">{t("Tomorrow: fall programs at the rec centre open 7:00 a.m. for Mia. Sign in tonight and have the page open.")}</div>
    </div></div>
   </div>
   <div className="hs-beat hs-glass">
    <p className="hs-when">{t("After the first class")}</p>
    <h3 className="hs-h3">{t("Asks how it went")}</h3>
    <p className="hs-p">{t("One quick question after the first class. Your answer shapes what Hale sends you next.")}</p>
    <div className="hs-art"><div className="hs-card hs-art-pad hs-mini">
     <div className="hs-msg in">{t("How did swim go? One line is plenty.")}</div>
     <div className="hs-msg out">{t("She loved it. Pool was freezing 🥶")}</div>
     <div className="hs-msg in">{t("Thanks, that helps. I’ll use it when I pick what to send you next.")}</div>
     <span className="hs-did"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>{t("Remembered: Mia loves swim")}</span>
    </div></div>
   </div>
  </div>
 </div>
</section>
<section className="hs hs-wash-b" id="logistics">
 <div className="hs-wrap hs-grid hs-logi">
  <div className="hs-logi-l">
   <p className="hs-eyebrow">{t("The logistics")}</p>
   <h2 className="hs-h2">{t("Who, when and where, kept straight.")}</h2>
   <ul className="hs-list">
    <li><span className="hs-ic"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12.5" rx="2.5" /><path d="M3 8.5h14M7 2.8v3.4M13 2.8v3.4" /></svg></span><div><h3 className="hs-h3">{t("Plans on your calendar")}</h3><p className="hs-p">{t("Each plan comes as a calendar invite, so it lands in Google or Apple Calendar with one tap.")}</p></div></li>
    <li><span className="hs-ic"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="7.5" cy="7" r="2.8" /><path d="M2.5 16.2c.6-2.6 2.6-4.2 5-4.2s4.4 1.6 5 4.2" /><circle cx="14" cy="7.6" r="2.2" /><path d="M13.6 12.1c2 .1 3.4 1.5 3.9 3.6" /></svg></span><div><h3 className="hs-h3">{t("Your co-parent sees the same plan")}</h3><p className="hs-p">{t("Start a group with them and Hale. Same week, same reminders, on their own phone. Always free.")}</p></div></li>
    <li><span className="hs-ic"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 13.5V10l1.7-4.1A2 2 0 0 1 7 4.7h6a2 2 0 0 1 1.8 1.2l1.7 4.1v3.5" /><path d="M2.8 10h14.4v3.5H2.8z" /><circle cx="6.3" cy="15.3" r="1.3" /><circle cx="13.7" cy="15.3" r="1.3" /></svg></span><div><h3 className="hs-h3">{t("Who’s driving, sorted")}</h3><p className="hs-p">{t("Say who’s taking them. Hale keeps track and reminds that person the night before.")}</p></div></li>
    <li><span className="hs-ic"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 16.5s-6-3.6-6-8.1A3.4 3.4 0 0 1 10 6.3a3.4 3.4 0 0 1 6 2.1c0 4.5-6 8.1-6 8.1z" /></svg></span><div><h3 className="hs-h3">{t("It remembers each kid")}</h3><p className="hs-p">{t("Ages, what they love, what’s already on their week. Ask “what do you know” to see it all, or fix it in one text.")}</p></div></li>
   </ul>
  </div>
  <div className="hs-logi-r">
   <div className="hs-card hs-week">
    <div className="hs-week-head"><span className="t">{t("This week")}</span><span className="hs-wm">{t("Shared with Alex")}</span></div>
    <div className="hs-wrow"><div className="hs-wday">{t("Mon")}<b>9</b></div><div><div className="hs-wt">{t("Swim, Swimmer 3")}</div><div className="hs-wm">{t("Mia · 4:30 PM")}</div></div><span className="hs-driver"><i>A</i>{t("Alex driving")}</span></div><div className="hs-wrow"><div className="hs-wday">{t("Tue")}<b>10</b></div><div><div className="hs-wt">{t("Soccer")}</div><div className="hs-wm">{t("Noah, Lily · 5:30 PM")}</div></div><span className="hs-driver"><i>T</i>{t("Tom driving")}</span></div><div className="hs-wrow"><div className="hs-wday">{t("Thu")}<b>12</b></div><div><div className="hs-wt">{t("Soccer")}</div><div className="hs-wm">{t("Noah, Lily · 5:30 PM")}</div></div><span className="hs-driver"><i>M</i>{t("Mei driving")}</span></div><div className="hs-wrow"><div className="hs-wday">{t("Sat")}<b>14</b></div><div><div className="hs-wt">{t("Leo & Aria’s party")}</div><div className="hs-wm">{t("Climbing gym · 2:00 PM")}</div></div><span className="hs-driver open">{t("Who’s driving?")}</span></div>
   </div>
   <div className="hs-card hs-memory">
    <div className="hs-mini">
     <div className="hs-msg out">{t("What do you know about us?")}</div>
     <div className="hs-msg in">{t("Mia is 6 and loves swimming and drawing. Theo is 3. Thursdays I think are soccer, tell me if that changed.")}</div>
    </div>
   </div>
  </div>
 </div>
</section>
<section className="hs hs-wash-c" id="pricing">
 <div className="hs-wrap">
  <div className="hs-head">
   <p className="hs-eyebrow">{t("Pricing")}</p>
   <h2 className="hs-h2">{t("Free, with unlimited chat.")}</h2>
   <p className="hs-lede">{t("Everything Hale does today is free: the finding, the watching, the reminders and the group chats. Plus and Max are on the way.")}</p>
  </div>
  <ol className="hs-tiers">
   <li className="hs-tier t-free">
    <div className="hs-tier-head"><span className="hs-tier-name">{t("Free")}</span><span className="hs-tier-num">01</span></div>
    <h3>$0 CAD/mo</h3>
    <p className="hs-tier-meta">{t("Free for every family")}</p>
    <p className="hs-tier-body">{t("Unlimited chat, on your own or in your group chats. Hale finds what’s on, watches for spots and reminds you before sign-ups.")}</p>
    <ul className="hs-checks"><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Unlimited chat")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Live find")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("A text when a spot opens")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Group chats and your co-parent")}</span></li></ul>
    <div className="hs-tier-cta"><TextDoor className="hs-btn-primary" placement="home_pricing" locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode}>{t("Text Hale")}</TextDoor></div>
   </li>
   <li className="hs-tier t-plus">
    <div className="hs-tier-head"><span className="hs-tier-name">Plus</span><span className="hs-tier-num">02</span></div>
    <h3>$19 CAD/mo</h3>
    <p className="hs-tier-meta">{t("or $159 CAD/yr, about three months free")}</p>
    <p className="hs-tier-body">{t("Nudges when a weekend’s empty or a waitlist opens, plus year memory as it ships.")}</p>
    <ul className="hs-checks"><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Everything in Free")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("A nudge when a weekend’s empty")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Year memory, season to season")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Sign-ups done for you, when you say yes")}</span></li></ul>
    <div className="hs-tier-cta"><button type="button" className="hs-btn-soon" disabled>{t("Coming soon")}</button></div>
   </li>
   <li className="hs-tier t-max">
    <div className="hs-tier-head"><span className="hs-tier-name">Max</span><span className="hs-tier-num">03</span></div>
    <h3>$39 CAD/mo</h3>
    <p className="hs-tier-meta">{t("or $329 CAD/yr, about three months free")}</p>
    <p className="hs-tier-body">{t("Everything in Plus, for every kid and everyone who helps.")}</p>
    <ul className="hs-checks"><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Everything in Plus")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Every kid, caregivers included")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Priority support")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Sign-ups for every kid in one go")}</span></li></ul>
    <div className="hs-tier-cta"><button type="button" className="hs-btn-soon" disabled>{t("Coming soon")}</button></div>
   </li>
  </ol>
  <p className="hs-meta hs-foot-note">{t("Only Free is available today.")}</p>
 </div>
</section>
<section className="hs hs-wash-d" id="faq">
 <div className="hs-wrap hs-grid">
  <div className="hs-faq-l">
   <p className="hs-eyebrow">{t("Questions")}</p>
   <h2 className="hs-h2">{t("What parents ask first.")}</h2>
   <a className="hs-more hs-desktop-only" href={localeHref(locale, "/faq")}><span>{t("All questions")}</span><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" /></svg></a>
  </div>
  <div className="hs-faq-r">
   <div className="hs-qa"><h3 className="hs-h3">{t("Does Hale book or register for me?")}</h3><p className="hs-p">{t("Not yet. Hale finds the class, watches for spots and texts you the link before sign-ups open. You register yourself. Signing up for you is coming later, and only when you say yes.")}</p></div><div className="hs-qa"><h3 className="hs-h3">{t("Is it free?")}</h3><p className="hs-p">{t("Yes. Hale is free while it’s new, and families who start now keep their founding rate. Your co-parent is always free.")}</p></div><div className="hs-qa"><h3 className="hs-h3">{t("Do I need an app?")}</h3><p className="hs-p">{t("No. Hale works in iMessage and regular texts. Add it to a group chat, or text it on its own.")}</p></div><div className="hs-qa"><h3 className="hs-h3">{t("What about our privacy?")}</h3><p className="hs-p"><Phrase locale={locale} sentence="Your family’s data is never sold or used for ads. Nothing from your inbox or personal calendar shows up in a group chat, and STOP ends it any time. Our privacy policy has the details." phrase="privacy policy" href={localeHref(locale, "/privacy")} /></p></div>
   <a className="hs-more hs-mobile-only" href={localeHref(locale, "/faq")}><span>{t("All questions")}</span><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 8h10M9 4l4 4-4 4" /></svg></a>
  </div>
 </div>
</section>
<section className="hs hs-close-sec" id="start">
 <div className="hs-wrap">
  <div className="hs-close-card">
   <img className="hs-close-art" src={shoreSrc} alt="" aria-hidden="true" />
   <span className="hs-close-scrim" aria-hidden="true" />
   <div className="hs-close-body">
    <span className="hs-close-brand"><img src={logoSrc} alt="" /><svg className="wordmark" viewBox="0 0 905.840370 590.701960" fill="currentColor" aria-hidden="true"><g transform="translate(-13.212024,604.064051) scale(0.100000,-0.100000)"><path d="M2672 5952 c-69 -25 -121 -68 -151 -125 -26 -52 -40 -165 -86 -722 -44 -533 -105 -1601 -105 -1847 0 -53 -4 -99 -9 -102 -5 -3 -143 -31 -307 -61 -165 -31 -414 -78 -555 -105 -141 -28 -264 -50 -274 -50 -15 0 -16 13 -11 158 4 86 11 290 16 452 24 677 99 1773 136 1985 19 104 12 142 -35 217 -42 67 -104 100 -196 106 -132 8 -228 -45 -285 -158 -37 -73 -43 -101 -74 -335 -69 -519 -118 -1161 -146 -1920 -7 -165 -15 -376 -18 -470 l-7 -170 -85 -16 c-142 -27 -207 -66 -253 -154 -51 -99 -13 -253 79 -314 65 -43 126 -49 229 -25 20 5 20 0 22 -623 2 -622 14 -1033 35 -1168 31 -205 122 -298 293 -299 101 -1 160 20 210 76 89 98 103 181 86 524 -7 142 -16 563 -18 935 -5 655 -5 677 13 683 56 17 989 200 1082 212 l52 7 0 -544 c0 -797 25 -1307 72 -1458 16 -51 31 -75 72 -116 67 -67 129 -89 230 -83 120 8 248 86 281 172 18 48 18 80 -8 301 -30 251 -39 486 -44 1156 l-6 677 29 6 c16 3 58 10 93 15 158 25 240 120 229 265 -13 152 -127 249 -273 231 l-55 -7 0 74 c0 111 28 699 45 963 18 267 31 440 76 1026 32 415 33 428 16 482 -23 73 -47 101 -115 133 -77 36 -202 43 -280 16z M6328 5839 c-47 -14 -113 -71 -139 -120 -19 -39 -39 -125 -78 -349 -204 -1162 -289 -2937 -185 -3875 70 -640 252 -925 589 -925 284 0 540 290 438 495 -38 75 -92 108 -178 109 -49 1 -69 -4 -108 -27 -27 -16 -50 -27 -52 -25 -31 36 -67 176 -94 373 -36 254 -45 451 -44 925 1 833 37 1267 203 2410 36 251 90 700 90 753 0 126 -56 209 -162 242 -64 20 -229 28 -280 14z M4447 3885 c-145 -55 -294 -167 -430 -322 -413 -469 -744 -1199 -807 -1778 -21 -197 -4 -444 41 -593 56 -181 168 -325 300 -386 91 -42 157 -56 258 -56 145 0 311 59 441 158 158 119 327 336 454 582 l63 122 7 -78 c31 -340 118 -571 257 -678 95 -74 250 -97 381 -56 68 21 214 104 261 148 162 151 33 448 -181 418 -23 -3 -57 -13 -74 -22 -30 -15 -32 -15 -45 2 -25 34 -53 171 -73 359 -18 167 -23 659 -10 875 20 301 16 328 -50 403 -92 105 -308 109 -413 9 -45 -42 -69 -100 -79 -186 -8 -76 -10 -80 -53 -120 -46 -43 -95 -133 -95 -177 0 -34 -75 -236 -163 -439 -200 -463 -387 -729 -527 -747 -36 -5 -43 -2 -74 31 -119 126 -62 599 129 1066 168 411 423 825 594 964 34 27 120 72 125 64 1 -1 11 -25 21 -53 47 -131 206 -196 362 -150 59 18 135 81 164 136 45 90 31 226 -31 302 -68 81 -166 113 -296 94 l-72 -10 -44 36 c-76 62 -144 90 -228 94 -48 2 -88 -2 -113 -12z M8179 3729 c-392 -58 -837 -524 -1049 -1099 -43 -116 -97 -325 -115 -444 -8 -54 -22 -119 -31 -143 -16 -40 -16 -59 -5 -201 37 -445 135 -724 329 -932 149 -161 337 -240 571 -240 372 0 785 232 1056 593 94 125 175 280 182 350 15 143 -71 246 -203 247 -91 0 -133 -26 -229 -146 -258 -320 -544 -506 -758 -492 -89 6 -137 29 -200 97 -82 88 -142 249 -154 416 l-5 80 63 24 c109 41 299 136 416 209 160 100 253 173 369 287 161 159 258 302 323 476 117 310 87 584 -83 753 -124 124 -314 190 -477 165z m89 -522 c31 -25 46 -73 46 -148 -1 -248 -189 -472 -557 -664 -68 -36 -129 -65 -136 -65 -15 0 -9 24 39 171 94 286 261 547 423 663 87 62 145 75 185 43z" /></g></svg></span>
    <h2>{t("Founding families join free.")}</h2>
    <p className="hs-close-sub">{t("Free while Hale is new, and families who start now keep their founding rate for good.")}</p>
    <div className="hs-close-cta"><TextDoor className="btn btn-hero" placement="closing" locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.5c3.3 0 6 2.2 6 4.9s-2.7 4.9-6 4.9c-.7 0-1.3-.1-1.9-.2L3 13.5l.9-2.5C2.7 10.1 2 8.8 2 7.4 2 4.7 4.7 2.5 8 2.5z" /></svg>{t("Text Hale")}</TextDoor></div>
    <p className="hs-close-terms">{t("Free to start. You text first; standard message rates apply, reply STOP any time.")}</p>
   </div>
  </div>
 </div>
</section>

</div>



      </div>
      <SiteFooter locale={locale} />
    </>
  );
}
