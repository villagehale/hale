import type { Locale } from '~/i18n/routing';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { logoSrc, shoreSrc } from './assets';
import { TextDoor } from './text-door';
import { localeHref } from '~/i18n/navigation';
import { CopyNumberButton } from '~/components/copy-number';

export function RedesignForCentres({
  locale,
  smsNumber,
  prefill,
}: {
  locale: Locale;
  smsNumber: string;
  prefill: string;
}) {
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
    <p className="hs-eyebrow">For centres and partners</p>
    <h1 className="sp-h1">For the people families already&nbsp;trust.</h1>
    <p className="sp-lede">Hale is a planner for a family’s year, by text. It finds activities that fit their kids, watches for spots and sign-up dates, and checks in on how it went. No app, no account, and a family’s data is never sold or used for ads.</p>
    
   </div>
   
  </div>
 </main>
</div>
<div className="hs-page">
<section className="hs hs-wash-a">
 <div className="hs-wrap hs-grid">
  <div className="sp-split-l w6"><div className="hs-head"><p className="hs-eyebrow">What a family gets</p><h2 className="hs-h2">One text, and an answer<br className="dbr" /> the same&nbsp;minute.</h2><p className="hs-lede">A parent sends the first message; Hale never texts a family first. After that it stays out of the way: the link before sign-ups, and one question after the first class. It works in parent group chats too.</p></div></div>
  <div className="sp-split-r"><div className="sp-example">Example first text and reply. Names and places are made up.</div>
  <div className="hs-card hs-art-pad hs-mini sp-preview">
   <div className="hs-msg out">Hi! Mia is 4. Swim and fall programs near us?</div>
   <div className="hs-msg in">Here’s what’s on near you:
1. Parent &amp; tot swim (ages 2–4), Saturdays 9:15 a.m., from the town’s rec guide
2. Preschool playtime (18 months to 4), drop-in, from the library’s page
3. Little movers (ages 2–5), winter times not posted yet</div>
   <span className="hs-did"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg>Watching: swim sign-ups</span>
  </div></div>
 </div>
</section><section className="hs hs-wash-b">
 <div className="hs-wrap">
<div className="hs-head"><p className="hs-eyebrow">How to point a family at Hale</p><h2 className="hs-h2">Three ways a family can&nbsp;start.</h2><p className="hs-lede">Nothing to sign, nothing to install, nothing for staff to keep track of.</p></div><div className="sp-cards"><div className="hs-glass sp-card"><div className="sp-card-top"><span className="sp-tag">Hand it over</span><span className="sp-num">01</span></div><h3 className="hs-h3">Give them the number</h3><p className="hs-p">Put it where parents look: a whiteboard, a handout, the back of a room sheet. A parent texts it when <span className="nw">they’re ready.</span></p><div className="sp-card-foot">{smsNumber ? <CopyNumberButton number={smsNumber} placement="for_centres" className="sp-btn2" label="Copy number" /> : <span className="sp-btn2">Copy number</span>}</div></div><div className="hs-glass sp-card"><div className="sp-card-top"><span className="sp-tag">Print it</span><span className="sp-num">02</span></div><h3 className="hs-h3">Put up a poster</h3><p className="hs-p">We print posters with your centre’s own code, so we can tell you how many families it brought. Email us and we’ll <span className="nw">send one.</span></p></div><div className="hs-glass sp-card"><div className="sp-card-top"><span className="sp-tag">Try it</span><span className="sp-num">03</span></div><h3 className="hs-h3">Text it yourself first</h3><p className="hs-p">Send the first message the way a parent would and read what comes back, so you know what you’re recommending. Reply STOP and <span className="nw">it ends.</span></p><div className="sp-card-foot"><TextDoor className="btn btn-hero" placement="for_centres" locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.5c3.3 0 6 2.2 6 4.9s-2.7 4.9-6 4.9c-.7 0-1.3-.1-1.9-.2L3 13.5l.9-2.5C2.7 10.1 2 8.8 2 7.4 2 4.7 4.7 2.5 8 2.5z" /></svg>Text Hale</TextDoor></div></div></div>
 </div>
</section><section className="hs hs-wash-c">
 <div className="hs-wrap">
<div className="hs-head"><p className="hs-eyebrow">What staff should know</p><h2 className="hs-h2">Plain answers about&nbsp;privacy.</h2><p className="hs-lede">A family will ask you these before they ask us.</p></div><div className="sp-cards"><div className="hs-card sp-card"><h3 className="hs-h3">What Hale asks for</h3><p className="hs-p">Where a family is and how old the kids are. First names only if the parent wants to <span className="nw">share them.</span></p></div><div className="hs-card sp-card"><h3 className="hs-h3">Nothing is sold</h3><p className="hs-p">A family’s information is never sold, never shared for advertising, and never shown to another family without <span className="nw">their say.</span></p></div><div className="hs-card sp-card"><h3 className="hs-h3">STOP ends it</h3><p className="hs-p">A parent texts STOP and the messages stop. They can ask for their data, or for it to be deleted, <span className="nw">at privacy@villagehale.com.</span></p></div><div className="hs-card sp-card"><h3 className="hs-h3">French, in French</h3><p className="hs-p">A parent can text Hale in French, and Hale answers <span className="nw">in French.</span></p></div><div className="hs-card sp-card"><h3 className="hs-h3">A child’s words stay with their parent</h3><p className="hs-p">Hale talks to parents. For a child of 13 or older, a parent sees the topic and a summary rather than the words, unless there is a safety concern, and then the teen <span className="nw">is told.</span></p></div><div className="hs-card sp-card"><h3 className="hs-h3">Who runs Hale</h3><p className="hs-p">Village Hale Technologies Inc. Our <a className="hs-link" href={localeHref(locale, "/privacy")}>privacy policy</a> covers what Hale keeps, why, and how a family can have <span className="nw">it deleted.</span></p></div></div><div className="hs-glass sp-card" style={{ marginTop: "var(--s5)" }}><span className="sp-tag">If a family asks whether Hale is official</span><p className="hs-p" style={{ color: "var(--navy)" }}>Hale is independent. It isn’t run by your centre, the town, the region or the province. Every date it sends comes with the source page, and if the two ever disagree, the source page wins.</p></div>
 </div>
</section><section className="hs hs-wash-d">
 <div className="hs-wrap hs-grid">
  <div className="hs-faq-l"><p className="hs-eyebrow">Questions we get</p><h2 className="hs-h2">Four things staff ask&nbsp;first.</h2></div>
  <div className="hs-faq-r"><div className="hs-qa"><h3 className="hs-h3">Does a family need an account?</h3><p className="hs-p">No. A parent texts a number and Hale replies. No app, no password, no <span className="nw">sign-up page.</span></p></div><div className="hs-qa"><h3 className="hs-h3">What does it cost a family?</h3><p className="hs-p">Nothing. Hale is free while it’s new, and families who join now keep the founding rate <span className="nw">for good.</span></p></div><div className="hs-qa"><h3 className="hs-h3">Do we have to sign anything?</h3><p className="hs-p">No. There’s no agreement, and nothing for staff to report or track. The only thing we’d set up with you is a poster with your <span className="nw">centre’s code.</span></p></div><div className="hs-qa"><h3 className="hs-h3">What does Hale refuse to do?</h3><p className="hs-p">It doesn’t diagnose and never names a dose; a medical question goes back to the family’s care provider. It never fills in a registration form or holds a spot. It finds and reminds; the <span className="nw">parent registers.</span></p></div></div>
 </div>
</section><section className="hs hs-close-sec" id="start">
 <div className="hs-wrap">
  <div className="hs-close-card">
   <img className="hs-close-art" src={shoreSrc} alt="" aria-hidden="true" />
   <span className="hs-close-scrim" aria-hidden="true" />
   <div className="hs-close-body">
    <span className="hs-close-brand"><img src={logoSrc} alt="" /><svg className="wordmark" viewBox="0 0 905.840370 590.701960" fill="currentColor" aria-hidden="true"><g transform="translate(-13.212024,604.064051) scale(0.100000,-0.100000)"><path d="M2672 5952 c-69 -25 -121 -68 -151 -125 -26 -52 -40 -165 -86 -722 -44 -533 -105 -1601 -105 -1847 0 -53 -4 -99 -9 -102 -5 -3 -143 -31 -307 -61 -165 -31 -414 -78 -555 -105 -141 -28 -264 -50 -274 -50 -15 0 -16 13 -11 158 4 86 11 290 16 452 24 677 99 1773 136 1985 19 104 12 142 -35 217 -42 67 -104 100 -196 106 -132 8 -228 -45 -285 -158 -37 -73 -43 -101 -74 -335 -69 -519 -118 -1161 -146 -1920 -7 -165 -15 -376 -18 -470 l-7 -170 -85 -16 c-142 -27 -207 -66 -253 -154 -51 -99 -13 -253 79 -314 65 -43 126 -49 229 -25 20 5 20 0 22 -623 2 -622 14 -1033 35 -1168 31 -205 122 -298 293 -299 101 -1 160 20 210 76 89 98 103 181 86 524 -7 142 -16 563 -18 935 -5 655 -5 677 13 683 56 17 989 200 1082 212 l52 7 0 -544 c0 -797 25 -1307 72 -1458 16 -51 31 -75 72 -116 67 -67 129 -89 230 -83 120 8 248 86 281 172 18 48 18 80 -8 301 -30 251 -39 486 -44 1156 l-6 677 29 6 c16 3 58 10 93 15 158 25 240 120 229 265 -13 152 -127 249 -273 231 l-55 -7 0 74 c0 111 28 699 45 963 18 267 31 440 76 1026 32 415 33 428 16 482 -23 73 -47 101 -115 133 -77 36 -202 43 -280 16z M6328 5839 c-47 -14 -113 -71 -139 -120 -19 -39 -39 -125 -78 -349 -204 -1162 -289 -2937 -185 -3875 70 -640 252 -925 589 -925 284 0 540 290 438 495 -38 75 -92 108 -178 109 -49 1 -69 -4 -108 -27 -27 -16 -50 -27 -52 -25 -31 36 -67 176 -94 373 -36 254 -45 451 -44 925 1 833 37 1267 203 2410 36 251 90 700 90 753 0 126 -56 209 -162 242 -64 20 -229 28 -280 14z M4447 3885 c-145 -55 -294 -167 -430 -322 -413 -469 -744 -1199 -807 -1778 -21 -197 -4 -444 41 -593 56 -181 168 -325 300 -386 91 -42 157 -56 258 -56 145 0 311 59 441 158 158 119 327 336 454 582 l63 122 7 -78 c31 -340 118 -571 257 -678 95 -74 250 -97 381 -56 68 21 214 104 261 148 162 151 33 448 -181 418 -23 -3 -57 -13 -74 -22 -30 -15 -32 -15 -45 2 -25 34 -53 171 -73 359 -18 167 -23 659 -10 875 20 301 16 328 -50 403 -92 105 -308 109 -413 9 -45 -42 -69 -100 -79 -186 -8 -76 -10 -80 -53 -120 -46 -43 -95 -133 -95 -177 0 -34 -75 -236 -163 -439 -200 -463 -387 -729 -527 -747 -36 -5 -43 -2 -74 31 -119 126 -62 599 129 1066 168 411 423 825 594 964 34 27 120 72 125 64 1 -1 11 -25 21 -53 47 -131 206 -196 362 -150 59 18 135 81 164 136 45 90 31 226 -31 302 -68 81 -166 113 -296 94 l-72 -10 -44 36 c-76 62 -144 90 -228 94 -48 2 -88 -2 -113 -12z M8179 3729 c-392 -58 -837 -524 -1049 -1099 -43 -116 -97 -325 -115 -444 -8 -54 -22 -119 -31 -143 -16 -40 -16 -59 -5 -201 37 -445 135 -724 329 -932 149 -161 337 -240 571 -240 372 0 785 232 1056 593 94 125 175 280 182 350 15 143 -71 246 -203 247 -91 0 -133 -26 -229 -146 -258 -320 -544 -506 -758 -492 -89 6 -137 29 -200 97 -82 88 -142 249 -154 416 l-5 80 63 24 c109 41 299 136 416 209 160 100 253 173 369 287 161 159 258 302 323 476 117 310 87 584 -83 753 -124 124 -314 190 -477 165z m89 -522 c31 -25 46 -73 46 -148 -1 -248 -189 -472 -557 -664 -68 -36 -129 -65 -136 -65 -15 0 -9 24 39 171 94 286 261 547 423 663 87 62 145 75 185 43z" /></g></svg></span>
    <h2>Want a poster for your&nbsp;centre?</h2>
    <p className="hs-close-sub">Email us and we’ll send one with your centre’s own code on it. A real person answers.</p>
    <div className="hs-close-cta"><a className="btn btn-hero" href="mailto:aloha@villagehale.com"><svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="2.75" y="4.5" width="14.5" height="11" rx="2" /><path d="m3.5 5.5 6.5 5 6.5-5" /></svg>Email aloha@villagehale.com</a></div>
    
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
