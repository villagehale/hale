import type { Locale } from '~/i18n/routing';
import { Phrase, tx } from './tx';
import { localeHref } from '~/i18n/navigation';
import { publishedCities } from '~/lib/activities/index';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { logoSrc, shoreSrc } from './assets';
import { TextDoor } from './text-door';

export function RedesignActivities({
  locale,
  smsNumber,
  prefill,
}: {
  locale: Locale;
  smsNumber: string;
  prefill: string;
}) {
  const t = (s: string) => tx(locale, s);
  const mode = 'sms' as const;
  
  return (
    <>
      <SiteHeader locale={locale} />
      <div className="rd">
        
<div className="stage sp-stage">
<img className="shore-art" src={shoreSrc} alt="" aria-hidden="true" />
<span className="shore-drift sky" aria-hidden="true" />
<span className="shore-drift sea" aria-hidden="true" />
<span className="shore-scrim" aria-hidden="true" />

<main id="main" className="sp-hero">
  <div className="sp-grid">
   <div className="sp-copy">
    <p className="hs-eyebrow">{t("Activities")}</p>
    <h1 className="sp-h1">{t("Things to do with your kids, near you.")}</h1>
    <p className="sp-lede">{t("Story times, drop-in play, swim, camps and rec programs. Tell Hale where you are and how old the kids are, and it finds what’s on.")}</p>
    
   </div>
   
  </div>
 </main>
</div>
<div className="hs-page">
<section className="hs hs-wash-a">
 <div className="hs-wrap">
<div className="hs-head"><p className="hs-eyebrow">{t("What Hale looks for")}</p><h2 className="hs-h2">{t("Six kinds of things worth doing.")}</h2><p className="hs-lede">{t("Hale looks them up live for your kids’ ages and where you are, then sends a short list with the source for each.")}</p></div><div className="sp-cards"><div className="hs-card sp-card"><span className="hs-ic"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2.5 12.5c1.25 0 1.9-1 3.1-1s1.9 1 3.1 1 1.9-1 3.1-1 1.9 1 3.1 1 1.6-.6 2.6-.9" /><path d="M2.5 16c1.25 0 1.9-1 3.1-1s1.9 1 3.1 1 1.9-1 3.1-1 1.9 1 3.1 1 1.6-.6 2.6-.9" /><circle cx="12.5" cy="5.5" r="1.8" /><path d="m6 9.5 3-3.2 2.2 1.9" /></svg></span><h3 className="hs-h3">{t("Swim lessons")}</h3><p className="hs-p">{t("Parent and tot, learn-to-swim levels, and when the next session opens.")}</p></div><div className="hs-card sp-card"><span className="hs-ic"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3.5 2.5 16.5h15z" /><path d="M10 3.5v13M7.5 16.5 10 11l2.5 5.5" /></svg></span><h3 className="hs-h3">{t("Camps")}</h3><p className="hs-p">{t("Summer, March break and days off school, with the date sign-ups open.")}</p></div><div className="hs-card sp-card"><span className="hs-ic"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 5.5c-1.6-1.2-3.8-1.6-6.5-1.4v11c2.7-.2 4.9.2 6.5 1.4 1.6-1.2 3.8-1.6 6.5-1.4v-11c-2.7-.2-4.9.2-6.5 1.4z" /><path d="M10 5.5v11" /></svg></span><h3 className="hs-h3">{t("Story times and drop-ins")}</h3><p className="hs-p">{t("Libraries, family centres and play mornings you can just show up to.")}</p></div><div className="hs-card sp-card"><span className="hs-ic"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 9 10 3.5 16.5 9v7.5h-13z" /><path d="M8 16.5v-4.5h4v4.5" /></svg></span><h3 className="hs-h3">{t("Rec programs")}</h3><p className="hs-p">{t("Classes at community centres, from toddler gym to art and dance.")}</p></div><div className="hs-card sp-card"><span className="hs-ic"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="6.75" /><path d="m10 6.5 3 2.2-1.1 3.6H8.1L7 8.7z" /><path d="M10 3.25V6.5M16.4 8.1l-3.4.6M13.9 15.5l-2-3.2M6.1 15.5l2-3.2M3.6 8.1l3.4.6" /></svg></span><h3 className="hs-h3">{t("Sports")}</h3><p className="hs-p">{t("Soccer, skating, gymnastics and the rest, by age and day of the week.")}</p></div><div className="hs-card sp-card"><span className="hs-ic"><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><circle cx="10" cy="10" r="3.4" /><path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" /></svg></span><h3 className="hs-h3">{t("This weekend")}</h3><p className="hs-p">{t("Free outings, parks and one‑time events, when you need an idea for Saturday.")}</p></div></div>
 </div>
</section><section className="hs hs-wash-c" id="by-city">
 <div className="hs-wrap">
  <div className="hs-head"><p className="hs-eyebrow">{t("Activities")}</p><h2 className="hs-h2">{t("By city")}</h2></div>
  <div className="sp-cards">{publishedCities.map((city) => (
    <a key={city.slug} className="hs-card sp-card" href={localeHref(locale, `/activities/${city.slug}`)}><h3 className="hs-h3">{city.city}</h3></a>
  ))}</div>
 </div>
</section><section className="hs hs-wash-b">
 <div className="hs-wrap hs-grid">
  <div className="sp-split-l"><div className="hs-head"><p className="hs-eyebrow">{t("Try it")}</p><h2 className="hs-h2">{t("Ask the way you’d ask a friend.")}</h2><p className="hs-lede">{t("Say how old the kids are and when you’re free. Hale answers with a few good options, not thirty.")}</p></div></div>
  <div className="sp-split-r"><div className="sp-example">{t("Example chat. Places and times are made up.")}</div>
  <div className="hs-card hs-art-pad hs-mini sp-preview">
   <div className="hs-msg out">{t("Anything for a 4-year-old this Saturday morning?")}</div>
   <div className="hs-msg in">{t("Three nearby:\n1. Parent & tot swim (ages 2–4), 9:15 a.m.\n2. Library story time (ages 2–5), 10:30 a.m.\n3. Free drop-in play at the community centre, 10 to noon\nWant the links?")}</div>
   <div className="hs-msg out">{t("Story time! Link please")}</div>
   <div className="hs-msg in"><Phrase locale={locale} sentence="Here’s the library page. No sign-up needed for this one." phrase="library page" /></div>
  </div></div>
 </div>
</section><section className="hs hs-close-sec" id="start">
 <div className="hs-wrap">
  <div className="hs-close-card">
   <img className="hs-close-art" src={shoreSrc} alt="" aria-hidden="true" />
   <span className="hs-close-scrim" aria-hidden="true" />
   <div className="hs-close-body">
    <span className="hs-close-brand"><img src={logoSrc} alt="" /><svg className="wordmark" viewBox="0 0 905.840370 590.701960" fill="currentColor" aria-hidden="true"><g transform="translate(-13.212024,604.064051) scale(0.100000,-0.100000)"><path d="M2672 5952 c-69 -25 -121 -68 -151 -125 -26 -52 -40 -165 -86 -722 -44 -533 -105 -1601 -105 -1847 0 -53 -4 -99 -9 -102 -5 -3 -143 -31 -307 -61 -165 -31 -414 -78 -555 -105 -141 -28 -264 -50 -274 -50 -15 0 -16 13 -11 158 4 86 11 290 16 452 24 677 99 1773 136 1985 19 104 12 142 -35 217 -42 67 -104 100 -196 106 -132 8 -228 -45 -285 -158 -37 -73 -43 -101 -74 -335 -69 -519 -118 -1161 -146 -1920 -7 -165 -15 -376 -18 -470 l-7 -170 -85 -16 c-142 -27 -207 -66 -253 -154 -51 -99 -13 -253 79 -314 65 -43 126 -49 229 -25 20 5 20 0 22 -623 2 -622 14 -1033 35 -1168 31 -205 122 -298 293 -299 101 -1 160 20 210 76 89 98 103 181 86 524 -7 142 -16 563 -18 935 -5 655 -5 677 13 683 56 17 989 200 1082 212 l52 7 0 -544 c0 -797 25 -1307 72 -1458 16 -51 31 -75 72 -116 67 -67 129 -89 230 -83 120 8 248 86 281 172 18 48 18 80 -8 301 -30 251 -39 486 -44 1156 l-6 677 29 6 c16 3 58 10 93 15 158 25 240 120 229 265 -13 152 -127 249 -273 231 l-55 -7 0 74 c0 111 28 699 45 963 18 267 31 440 76 1026 32 415 33 428 16 482 -23 73 -47 101 -115 133 -77 36 -202 43 -280 16z M6328 5839 c-47 -14 -113 -71 -139 -120 -19 -39 -39 -125 -78 -349 -204 -1162 -289 -2937 -185 -3875 70 -640 252 -925 589 -925 284 0 540 290 438 495 -38 75 -92 108 -178 109 -49 1 -69 -4 -108 -27 -27 -16 -50 -27 -52 -25 -31 36 -67 176 -94 373 -36 254 -45 451 -44 925 1 833 37 1267 203 2410 36 251 90 700 90 753 0 126 -56 209 -162 242 -64 20 -229 28 -280 14z M4447 3885 c-145 -55 -294 -167 -430 -322 -413 -469 -744 -1199 -807 -1778 -21 -197 -4 -444 41 -593 56 -181 168 -325 300 -386 91 -42 157 -56 258 -56 145 0 311 59 441 158 158 119 327 336 454 582 l63 122 7 -78 c31 -340 118 -571 257 -678 95 -74 250 -97 381 -56 68 21 214 104 261 148 162 151 33 448 -181 418 -23 -3 -57 -13 -74 -22 -30 -15 -32 -15 -45 2 -25 34 -53 171 -73 359 -18 167 -23 659 -10 875 20 301 16 328 -50 403 -92 105 -308 109 -413 9 -45 -42 -69 -100 -79 -186 -8 -76 -10 -80 -53 -120 -46 -43 -95 -133 -95 -177 0 -34 -75 -236 -163 -439 -200 -463 -387 -729 -527 -747 -36 -5 -43 -2 -74 31 -119 126 -62 599 129 1066 168 411 423 825 594 964 34 27 120 72 125 64 1 -1 11 -25 21 -53 47 -131 206 -196 362 -150 59 18 135 81 164 136 45 90 31 226 -31 302 -68 81 -166 113 -296 94 l-72 -10 -44 36 c-76 62 -144 90 -228 94 -48 2 -88 -2 -113 -12z M8179 3729 c-392 -58 -837 -524 -1049 -1099 -43 -116 -97 -325 -115 -444 -8 -54 -22 -119 -31 -143 -16 -40 -16 -59 -5 -201 37 -445 135 -724 329 -932 149 -161 337 -240 571 -240 372 0 785 232 1056 593 94 125 175 280 182 350 15 143 -71 246 -203 247 -91 0 -133 -26 -229 -146 -258 -320 -544 -506 -758 -492 -89 6 -137 29 -200 97 -82 88 -142 249 -154 416 l-5 80 63 24 c109 41 299 136 416 209 160 100 253 173 369 287 161 159 258 302 323 476 117 310 87 584 -83 753 -124 124 -314 190 -477 165z m89 -522 c31 -25 46 -73 46 -148 -1 -248 -189 -472 -557 -664 -68 -36 -129 -65 -136 -65 -15 0 -9 24 39 171 94 286 261 547 423 663 87 62 145 75 185 43z" /></g></svg></span>
    <h2>{t("What’s on this weekend?")}</h2>
    <p className="hs-close-sub">{t("Text Hale the kids’ ages and where you are. It sends a few good options the same minute.")}</p>
    <div className="hs-close-cta"><TextDoor className="btn btn-hero" placement="activities" locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.5c3.3 0 6 2.2 6 4.9s-2.7 4.9-6 4.9c-.7 0-1.3-.1-1.9-.2L3 13.5l.9-2.5C2.7 10.1 2 8.8 2 7.4 2 4.7 4.7 2.5 8 2.5z" /></svg>{t("Text Hale")}</TextDoor></div>
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
