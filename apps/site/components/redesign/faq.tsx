import type { Locale } from '~/i18n/routing';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { logoSrc, shoreSrc } from './assets';
import { TextDoor } from './text-door';
import { localeHref } from '~/i18n/navigation';

export function RedesignFaq({
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
    <p className="hs-eyebrow">Questions</p>
    <h1 className="sp-h1">Is Hale right for your&nbsp;family?</h1>
    <p className="sp-lede">Straight answers about what Hale does, what it costs and how your family’s data is handled.</p>
    
   </div>
   
  </div>
 </main>
</div>
<div className="hs-page">
<section className="hs hs-wash-a">
 <div className="hs-wrap hs-grid">
  <div className="hs-faq-l"><p className="hs-eyebrow">Jump to</p><ul className="sp-toc"><li><a href="#start">Getting started</a></li><li><a href="#groups">Group chats</a></li><li><a href="#does">What Hale does</a></li><li><a href="#cost">Cost</a></li><li><a href="#privacy">Privacy and safety</a></li></ul></div>
  <div className="hs-faq-r"><div className="sp-faq-group" id="start"><span className="sp-tag">Getting started</span><div className="hs-qa"><h3 className="hs-h3">What is Hale?</h3><p className="hs-p">A planner for your kids’ year that lives in your texts. It finds what’s on near you, watches for spots, reminds you before sign-ups and asks how it went. It answers any other question you send <span className="nw">it, too.</span></p></div><div className="hs-qa"><h3 className="hs-h3">How do I start?</h3><p className="hs-p">Text the number. Hale asks where you are and how old the kids are, then shows you what’s on this week. Anything else it asks for later, only when it needs it. Hale never texts a number that hasn’t texted <span className="nw">it first.</span></p></div><div className="hs-qa"><h3 className="hs-h3">Do I need an app or an account?</h3><p className="hs-p">No. Hale works in iMessage and regular texts. The website is only there if you want to look back at what Hale <span className="nw">has sent.</span></p></div></div><div className="sp-faq-group" id="groups"><span className="sp-tag">Group chats</span><div className="hs-qa"><h3 className="hs-h3">Can Hale join our group chat?</h3><p className="hs-p">Yes. Start a group with Hale and whoever shares the load: your co-parent, the carpool, other parents from the class. Ask in the chat and Hale <span className="nw">answers there.</span></p></div><div className="hs-qa"><h3 className="hs-h3">What does Hale do in a group?</h3><p className="hs-p">Finds a plan when someone asks, keeps track of who’s in and who’s driving, and reminds the right person the night before. Otherwise it <span className="nw">stays quiet.</span></p></div><div className="hs-qa"><h3 className="hs-h3">What do other parents in the group see?</h3><p className="hs-p">Only what’s said in that chat. Nothing from your own calendar, inbox or 1:1 texts with Hale shows up in <span className="nw">a group.</span></p></div><div className="hs-qa"><h3 className="hs-h3">Is my co-parent free?</h3><p className="hs-p">Always. Same plan, same reminders, on their <span className="nw">own phone.</span></p></div></div><div className="sp-faq-group" id="does"><span className="sp-tag">What Hale does</span><div className="hs-qa"><h3 className="hs-h3">Does Hale book or register for me?</h3><p className="hs-p">Not yet. Hale finds the class, watches for spots and texts you the link before sign-ups open. You register yourself. Signing up for you is coming later, and only when you <span className="nw">say yes.</span></p></div><div className="hs-qa"><h3 className="hs-h3">What does Hale find?</h3><p className="hs-p">Swim, camps, drop-ins, library programs, rec classes and things to do this weekend, picked for your kids’ ages and where you live. Every find comes with the page it <span className="nw">came from.</span></p></div><div className="hs-qa"><h3 className="hs-h3">Can I ask it other things?</h3><p className="hs-p">Anything. Sleep, a rainy-day idea, what’s open Monday. Hale looks it up live and answers in a line <span className="nw">or two.</span></p></div><div className="hs-qa"><h3 className="hs-h3">How often will Hale text me?</h3><p className="hs-p">Only when there’s a reason: a heads-up before sign-ups, the link the night before, a question after the first class. Reply LESS for fewer, or STOP to <span className="nw">end it.</span></p></div><div className="hs-qa"><h3 className="hs-h3">Will Hale tell me if a class is any good?</h3><p className="hs-p">Not yet. Today Hale asks how it went, and uses your answer to pick what to send <span className="nw">you next.</span></p></div></div><div className="sp-faq-group" id="cost"><span className="sp-tag">Cost</span><div className="hs-qa"><h3 className="hs-h3">Is it free?</h3><p className="hs-p">Yes. Hale is free while it’s new, and families who start now keep their founding rate. Your co-parent is <span className="nw">always free.</span></p></div><div className="hs-qa"><h3 className="hs-h3">What will Plus and Max cost?</h3><p className="hs-p">Plus will be $19 a month or $159 a year. Max will be $39 a month or $329 a year. Prices are in Canadian dollars, and neither plan is <span className="nw">open yet.</span></p></div></div><div className="sp-faq-group" id="privacy"><span className="sp-tag">Privacy and safety</span><div className="hs-qa"><h3 className="hs-h3">What happens to our data?</h3><p className="hs-p">It’s never sold or used for ads. Reply STOP and the texts stop. Our <a className="hs-link" href={localeHref(locale, "/privacy")}>privacy policy</a> covers what Hale keeps and why, and how to have <span className="nw">it deleted.</span></p></div><div className="hs-qa"><h3 className="hs-h3">Is Hale a person?</h3><p className="hs-p">No, and it never pretends to be. Hale is built by Village Hale Technologies Inc., a small parent-founded company. Write to <a className="hs-link" href="mailto:aloha@villagehale.com">aloha@villagehale.com</a> and a real person <span className="nw">reads it.</span></p></div></div></div>
 </div>
</section><section className="hs hs-close-sec" id="start">
 <div className="hs-wrap">
  <div className="hs-close-card">
   <img className="hs-close-art" src={shoreSrc} alt="" aria-hidden="true" />
   <span className="hs-close-scrim" aria-hidden="true" />
   <div className="hs-close-body">
    <span className="hs-close-brand"><img src={logoSrc} alt="" /><svg className="wordmark" viewBox="0 0 905.840370 590.701960" fill="currentColor" aria-hidden="true"><g transform="translate(-13.212024,604.064051) scale(0.100000,-0.100000)"><path d="M2672 5952 c-69 -25 -121 -68 -151 -125 -26 -52 -40 -165 -86 -722 -44 -533 -105 -1601 -105 -1847 0 -53 -4 -99 -9 -102 -5 -3 -143 -31 -307 -61 -165 -31 -414 -78 -555 -105 -141 -28 -264 -50 -274 -50 -15 0 -16 13 -11 158 4 86 11 290 16 452 24 677 99 1773 136 1985 19 104 12 142 -35 217 -42 67 -104 100 -196 106 -132 8 -228 -45 -285 -158 -37 -73 -43 -101 -74 -335 -69 -519 -118 -1161 -146 -1920 -7 -165 -15 -376 -18 -470 l-7 -170 -85 -16 c-142 -27 -207 -66 -253 -154 -51 -99 -13 -253 79 -314 65 -43 126 -49 229 -25 20 5 20 0 22 -623 2 -622 14 -1033 35 -1168 31 -205 122 -298 293 -299 101 -1 160 20 210 76 89 98 103 181 86 524 -7 142 -16 563 -18 935 -5 655 -5 677 13 683 56 17 989 200 1082 212 l52 7 0 -544 c0 -797 25 -1307 72 -1458 16 -51 31 -75 72 -116 67 -67 129 -89 230 -83 120 8 248 86 281 172 18 48 18 80 -8 301 -30 251 -39 486 -44 1156 l-6 677 29 6 c16 3 58 10 93 15 158 25 240 120 229 265 -13 152 -127 249 -273 231 l-55 -7 0 74 c0 111 28 699 45 963 18 267 31 440 76 1026 32 415 33 428 16 482 -23 73 -47 101 -115 133 -77 36 -202 43 -280 16z M6328 5839 c-47 -14 -113 -71 -139 -120 -19 -39 -39 -125 -78 -349 -204 -1162 -289 -2937 -185 -3875 70 -640 252 -925 589 -925 284 0 540 290 438 495 -38 75 -92 108 -178 109 -49 1 -69 -4 -108 -27 -27 -16 -50 -27 -52 -25 -31 36 -67 176 -94 373 -36 254 -45 451 -44 925 1 833 37 1267 203 2410 36 251 90 700 90 753 0 126 -56 209 -162 242 -64 20 -229 28 -280 14z M4447 3885 c-145 -55 -294 -167 -430 -322 -413 -469 -744 -1199 -807 -1778 -21 -197 -4 -444 41 -593 56 -181 168 -325 300 -386 91 -42 157 -56 258 -56 145 0 311 59 441 158 158 119 327 336 454 582 l63 122 7 -78 c31 -340 118 -571 257 -678 95 -74 250 -97 381 -56 68 21 214 104 261 148 162 151 33 448 -181 418 -23 -3 -57 -13 -74 -22 -30 -15 -32 -15 -45 2 -25 34 -53 171 -73 359 -18 167 -23 659 -10 875 20 301 16 328 -50 403 -92 105 -308 109 -413 9 -45 -42 -69 -100 -79 -186 -8 -76 -10 -80 -53 -120 -46 -43 -95 -133 -95 -177 0 -34 -75 -236 -163 -439 -200 -463 -387 -729 -527 -747 -36 -5 -43 -2 -74 31 -119 126 -62 599 129 1066 168 411 423 825 594 964 34 27 120 72 125 64 1 -1 11 -25 21 -53 47 -131 206 -196 362 -150 59 18 135 81 164 136 45 90 31 226 -31 302 -68 81 -166 113 -296 94 l-72 -10 -44 36 c-76 62 -144 90 -228 94 -48 2 -88 -2 -113 -12z M8179 3729 c-392 -58 -837 -524 -1049 -1099 -43 -116 -97 -325 -115 -444 -8 -54 -22 -119 -31 -143 -16 -40 -16 -59 -5 -201 37 -445 135 -724 329 -932 149 -161 337 -240 571 -240 372 0 785 232 1056 593 94 125 175 280 182 350 15 143 -71 246 -203 247 -91 0 -133 -26 -229 -146 -258 -320 -544 -506 -758 -492 -89 6 -137 29 -200 97 -82 88 -142 249 -154 416 l-5 80 63 24 c109 41 299 136 416 209 160 100 253 173 369 287 161 159 258 302 323 476 117 310 87 584 -83 753 -124 124 -314 190 -477 165z m89 -522 c31 -25 46 -73 46 -148 -1 -248 -189 -472 -557 -664 -68 -36 -129 -65 -136 -65 -15 0 -9 24 39 171 94 286 261 547 423 663 87 62 145 75 185 43z" /></g></svg></span>
    <h2>Still wondering? Just&nbsp;ask.</h2>
    <p className="hs-close-sub">Text Hale your question. It answers in a line or two, the same minute.</p>
    <div className="hs-close-cta"><TextDoor className="btn btn-hero" placement="faq" locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.5c3.3 0 6 2.2 6 4.9s-2.7 4.9-6 4.9c-.7 0-1.3-.1-1.9-.2L3 13.5l.9-2.5C2.7 10.1 2 8.8 2 7.4 2 4.7 4.7 2.5 8 2.5z" /></svg>Text Hale</TextDoor></div>
    <p className="hs-close-terms">Free to start. You text first; standard message rates apply, reply STOP any time.</p>
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
