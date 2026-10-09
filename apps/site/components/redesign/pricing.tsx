import type { Locale } from '~/i18n/routing';
import { FaqDeepLink } from './faq-deeplink';
import { FaqItem } from './faq-item';
import { closeHeading, keepCardTail, tx } from './tx';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { logoSrc, shoreSrc } from './assets';
import { TextDoor } from './text-door';

export function RedesignPricing({
  locale,
  smsNumber,
  prefill,
  source = null,
}: {
  locale: Locale;
  smsNumber: string;
  prefill: string;
  /** A `?s=` code the page already validated. */
  source?: string | null;
}) {
  const t = (s: string) => tx(locale, s);
  const mode = 'sms' as const;
  
  return (
    <>
      <SiteHeader locale={locale} source={source} />
      <div className="rd">
        <FaqDeepLink />
<div className="stage sp-stage">
<img className="shore-art" src={shoreSrc} alt="" aria-hidden="true" />
<span className="shore-drift sky" aria-hidden="true" />
<span className="shore-drift sea" aria-hidden="true" />
<span className="shore-scrim" aria-hidden="true" />

<main id="main" className="sp-hero">
  <div className="sp-grid">
   <div className="sp-copy">
    <p className="hs-eyebrow">{t("Pricing")}</p>
    <h1 className="sp-h1">{t("Free, with unlimited chat.")}</h1>
    <p className="sp-lede">{t("Everything Hale does today is free: the finding, the watching, the reminders, the group chats and the answers. Plus and Max are on the way.")}</p>
    
   </div>
   
  </div>
 </main>
</div>
<div className="hs-page">
<section className="hs hs-wash-c" id="pricing">
 <div className="hs-wrap">
  <ol className="hs-tiers">
   <li className="hs-tier t-free">
    <div className="hs-tier-head"><span className="hs-tier-name">{t("Free")}</span><span className="hs-tier-num">01</span></div>
    <h3>{t("$0 CAD/mo")}</h3>
    <p className="hs-tier-meta">{t("Free for every family")}</p>
    <p className="hs-tier-body">{t("Unlimited chat, on your own or in your group chats. Hale finds what’s on, watches for spots and reminds you before sign-ups.")}</p>
    <ul className="hs-checks"><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Unlimited chat")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Live find")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("A text when a spot opens")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Group chats and your co-parent")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("A nudge when a weekend’s empty")}</span></li></ul>
    <div className="hs-tier-cta"><TextDoor className="hs-btn-primary" placement="pricing_tier" locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode} source={source}>{t("Text Hale")}</TextDoor></div>
   </li>
   <li className="hs-tier t-plus">
    <div className="hs-tier-head"><span className="hs-tier-name">Plus</span><span className="hs-tier-num">02</span></div>
    <h3>{t("$19 CAD/mo")}</h3>
    <p className="hs-tier-meta">{t("or $159 CAD/yr, about three months free")}</p>
    <p className="hs-tier-body">{t("More done for you, all year.")}</p>
    <ul className="hs-checks"><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Everything in Free")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Year memory, season to season")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Sign-ups done for you, when you say yes")}</span></li></ul>
    <div className="hs-tier-cta"><button type="button" className="hs-btn-soon" disabled>{t("Coming soon")}</button></div>
   </li>
   <li className="hs-tier t-max">
    <div className="hs-tier-head"><span className="hs-tier-name">Max</span><span className="hs-tier-num">03</span></div>
    <h3>{t("$39 CAD/mo")}</h3>
    <p className="hs-tier-meta">{t("or $329 CAD/yr, about three months free")}</p>
    <p className="hs-tier-body">{t("The most Hale can do.")}</p>
    <ul className="hs-checks"><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Everything in Plus")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("The highest limits on searches and spot watches")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Priority support")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{keepCardTail(t("Sign-ups for a whole season in one go"))}</span></li></ul>
    <div className="hs-tier-cta"><button type="button" className="hs-btn-soon" disabled>{t("Coming soon")}</button></div>
   </li>
  </ol>
  <p className="hs-meta hs-foot-note">{t("Only Free is available today.")}</p>
 </div>
</section><section className="hs hs-wash-d">
 <div className="hs-wrap hs-grid">
  <div className="hs-faq-l"><p className="hs-eyebrow">{t("About pricing")}</p><h2 className="hs-h2">{t("Fair questions.")}</h2></div>
  <div className="hs-faq-r"><FaqItem id="when-do-plus-and-max-open" question={t("When do Plus and Max open?")}>{t("When the parts they add are ready. Until then, everything Hale does is free.")}</FaqItem><FaqItem id="whats-the-difference-between-plus-and-max" question={t("What’s the difference between Plus and Max?")}>{t("Plus is more done for you, all year: year memory, and sign-ups when you say yes. Max is the most Hale can do: everything in Plus, the highest limits on searches and spot watches, priority support, and sign-ups for a whole season in one go.")}</FaqItem></div>
 </div>
</section><section className="hs hs-close-sec" id="start">
 <div className="hs-wrap">
  <div className="hs-close-card">
   <img className="hs-close-art" src={shoreSrc} alt="" aria-hidden="true" />
   <span className="hs-close-scrim" aria-hidden="true" />
   <div className="hs-close-body">
    <span className="hs-close-brand"><img src={logoSrc} alt="" /><svg className="wordmark" viewBox="0 0 905.840370 590.701960" fill="currentColor" aria-hidden="true"><g transform="translate(-13.212024,604.064051) scale(0.100000,-0.100000)"><path d="M2672 5952 c-69 -25 -121 -68 -151 -125 -26 -52 -40 -165 -86 -722 -44 -533 -105 -1601 -105 -1847 0 -53 -4 -99 -9 -102 -5 -3 -143 -31 -307 -61 -165 -31 -414 -78 -555 -105 -141 -28 -264 -50 -274 -50 -15 0 -16 13 -11 158 4 86 11 290 16 452 24 677 99 1773 136 1985 19 104 12 142 -35 217 -42 67 -104 100 -196 106 -132 8 -228 -45 -285 -158 -37 -73 -43 -101 -74 -335 -69 -519 -118 -1161 -146 -1920 -7 -165 -15 -376 -18 -470 l-7 -170 -85 -16 c-142 -27 -207 -66 -253 -154 -51 -99 -13 -253 79 -314 65 -43 126 -49 229 -25 20 5 20 0 22 -623 2 -622 14 -1033 35 -1168 31 -205 122 -298 293 -299 101 -1 160 20 210 76 89 98 103 181 86 524 -7 142 -16 563 -18 935 -5 655 -5 677 13 683 56 17 989 200 1082 212 l52 7 0 -544 c0 -797 25 -1307 72 -1458 16 -51 31 -75 72 -116 67 -67 129 -89 230 -83 120 8 248 86 281 172 18 48 18 80 -8 301 -30 251 -39 486 -44 1156 l-6 677 29 6 c16 3 58 10 93 15 158 25 240 120 229 265 -13 152 -127 249 -273 231 l-55 -7 0 74 c0 111 28 699 45 963 18 267 31 440 76 1026 32 415 33 428 16 482 -23 73 -47 101 -115 133 -77 36 -202 43 -280 16z M6328 5839 c-47 -14 -113 -71 -139 -120 -19 -39 -39 -125 -78 -349 -204 -1162 -289 -2937 -185 -3875 70 -640 252 -925 589 -925 284 0 540 290 438 495 -38 75 -92 108 -178 109 -49 1 -69 -4 -108 -27 -27 -16 -50 -27 -52 -25 -31 36 -67 176 -94 373 -36 254 -45 451 -44 925 1 833 37 1267 203 2410 36 251 90 700 90 753 0 126 -56 209 -162 242 -64 20 -229 28 -280 14z M4447 3885 c-145 -55 -294 -167 -430 -322 -413 -469 -744 -1199 -807 -1778 -21 -197 -4 -444 41 -593 56 -181 168 -325 300 -386 91 -42 157 -56 258 -56 145 0 311 59 441 158 158 119 327 336 454 582 l63 122 7 -78 c31 -340 118 -571 257 -678 95 -74 250 -97 381 -56 68 21 214 104 261 148 162 151 33 448 -181 418 -23 -3 -57 -13 -74 -22 -30 -15 -32 -15 -45 2 -25 34 -53 171 -73 359 -18 167 -23 659 -10 875 20 301 16 328 -50 403 -92 105 -308 109 -413 9 -45 -42 -69 -100 -79 -186 -8 -76 -10 -80 -53 -120 -46 -43 -95 -133 -95 -177 0 -34 -75 -236 -163 -439 -200 -463 -387 -729 -527 -747 -36 -5 -43 -2 -74 31 -119 126 -62 599 129 1066 168 411 423 825 594 964 34 27 120 72 125 64 1 -1 11 -25 21 -53 47 -131 206 -196 362 -150 59 18 135 81 164 136 45 90 31 226 -31 302 -68 81 -166 113 -296 94 l-72 -10 -44 36 c-76 62 -144 90 -228 94 -48 2 -88 -2 -113 -12z M8179 3729 c-392 -58 -837 -524 -1049 -1099 -43 -116 -97 -325 -115 -444 -8 -54 -22 -119 -31 -143 -16 -40 -16 -59 -5 -201 37 -445 135 -724 329 -932 149 -161 337 -240 571 -240 372 0 785 232 1056 593 94 125 175 280 182 350 15 143 -71 246 -203 247 -91 0 -133 -26 -229 -146 -258 -320 -544 -506 -758 -492 -89 6 -137 29 -200 97 -82 88 -142 249 -154 416 l-5 80 63 24 c109 41 299 136 416 209 160 100 253 173 369 287 161 159 258 302 323 476 117 310 87 584 -83 753 -124 124 -314 190 -477 165z m89 -522 c31 -25 46 -73 46 -148 -1 -248 -189 -472 -557 -664 -68 -36 -129 -65 -136 -65 -15 0 -9 24 39 171 94 286 261 547 423 663 87 62 145 75 185 43z" /></g></svg></span>
    <h2>{closeHeading(t("Founding families join free."))}</h2>
    <p className="hs-close-sub">{t("Founding families get everything free until paid plans start.")}</p>
    <div className="hs-close-cta"><TextDoor className="btn btn-hero" placement="pricing" locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode} source={source}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.5c3.3 0 6 2.2 6 4.9s-2.7 4.9-6 4.9c-.7 0-1.3-.1-1.9-.2L3 13.5l.9-2.5C2.7 10.1 2 8.8 2 7.4 2 4.7 4.7 2.5 8 2.5z" /></svg>{t("Text Hale")}</TextDoor></div>
    <p className="hs-close-terms">{t("Free. You text first; standard message rates apply, reply STOP any time.")}</p>
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
