import { type BillingCurrency, CHECKOUT_REGION_UNSUPPORTED_MESSAGE } from '@hale/types';
import {
  PAID_PLANS_LINE,
  maxAnnualLabel,
  orAnnualLabel,
  paidPlansCostAnswer,
  paidPlansYearlyAnswer,
  plusAnnualLabel,
  plusCloseSentence,
  plusMonthlyLabel,
  plusPriceSentence,
} from '~/lib/billing/plain-price';
import type { Locale } from '~/i18n/routing';
import { FaqDeepLink } from './faq-deeplink';
import { FaqItem } from './faq-item';
import { tx } from './tx';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import type { SitePriceSurface } from '~/lib/billing/site-price-surface';
import { logoSrc, shoreSrc } from './assets';
import { ShoreArt } from './shore-hero';
import { TextDoor } from './text-door';
import { BlackFridayBanner } from '~/components/promo/black-friday-banner';
import { BlackFridaySticky } from '~/components/promo/black-friday-sticky';
import { PromoBanner, PromoFaqItems, PromoSection, PromoStickyCta, TierSalePrice } from '~/components/promo/holiday-promo';
import { FoundingCheckoutLink } from '~/components/promo/founding-checkout-link';
import {
  type BlackFridayOffer,
  blackFridayCloseHeadline,
  blackFridayMaxHeadline,
  blackFridayPlanButton,
  blackFridayRefundLine,
  blackFridayRenewalCopy,
  blackFridayYearlyNote,
} from '~/lib/promo/black-friday';
import { type HolidayPromo, FOUNDING_REFUND_LINE } from '~/lib/promo/holiday';

/** The pricing hero type block. The success page reuses it, hidden, so the shore crop matches. */
export function PricingHeroCopy({
  locale,
  promo,
  blackFriday = null,
  priceSurface,
  currency,
  regionBlocked = false,
  noChargeLine = null,
  decorative = false,
}: {
  locale: Locale;
  promo: HolidayPromo | null;
  blackFriday?: BlackFridayOffer | null;
  priceSurface: SitePriceSurface;
  currency: BillingCurrency;
  regionBlocked?: boolean;
  noChargeLine?: string | null;
  /** A sizing copy, not a second page heading. */
  decorative?: boolean;
}) {
  const t = (s: string) => tx(locale, s);
  const list = priceSurface === 'list';
  const yearlyOnly = locale === 'fr' || locale === 'zh';
  const maxShown = blackFriday?.max?.saleLabel ?? promo?.max.saleLabel;
  const plusShown = blackFriday?.plus?.saleLabel ?? promo?.plus.saleLabel;
  const headline = blackFriday?.max
    ? blackFridayMaxHeadline(locale, blackFriday.max.saleLabel)
    : promo
      ? `${promo.saleName}: Max for ${maxShown}.`
      : list || yearlyOnly
        ? t('Plus, by the year.')
        : t('What you pay.');
  const renewal = blackFriday
    ? `${blackFridayRenewalCopy(locale, blackFriday.plus?.saleLabel ?? null, blackFriday.max?.saleLabel ?? null)} ${blackFridayRefundLine(locale)}`
    : null;
  const lede = renewal
    ?? (promo
      ? `Plus is ${plusShown}. Texting Hale costs nothing, no card. Join by Dec 31 and your price is locked in for as long as you’re a member. For this year. ${FOUNDING_REFUND_LINE}`
      : yearlyOnly
        ? t(paidPlansYearlyAnswer(currency))
        : list
          ? t(plusPriceSentence(currency))
          : t(PAID_PLANS_LINE));
  const Heading = decorative ? 'p' : 'h1';
  return (
    <div className="sp-grid">
      <div className="sp-copy">
        <p className="hs-eyebrow">{t('Pricing')}</p>
        <Heading className="sp-h1">{headline}</Heading>
        <p className="sp-lede">{lede}</p>
        {regionBlocked ? <p className="hs-meta">{CHECKOUT_REGION_UNSUPPORTED_MESSAGE}</p> : null}
        {noChargeLine ? <p className="hs-meta">{noChargeLine}</p> : null}
      </div>
    </div>
  );
}

export function RedesignPricing({
  locale,
  smsNumber,
  prefill,
  source = null,
  promo = null,
  blackFriday = null,
  priceSurface = 'legacy',
  currency = 'CAD',
  regionBlocked = false,
  noChargeLine = null,
}: {
  locale: Locale;
  smsNumber: string;
  prefill: string;
  /** A `?s=` code the page already validated. */
  source?: string | null;
  /** The holiday founding promo for this request, or null when it is off. */
  promo?: HolidayPromo | null;
  /** One-day price. Null outside the window, and the current promo stays. */
  blackFriday?: BlackFridayOffer | null;
  priceSurface?: SitePriceSurface;
  currency?: BillingCurrency;
  /** Checkout is refused for this visitor's country; show the line instead of buy buttons. */
  regionBlocked?: boolean;
  /** Set when a cancelled Stripe checkout returned here. */
  noChargeLine?: string | null;
}) {
  const t = (s: string) => tx(locale, s);
  const mode = 'sms' as const;
  const list = priceSurface === 'list';
  const yearlyOnly = locale === 'fr' || locale === 'zh';
  const plusCard = blackFriday?.plus ?? promo?.plus ?? null;
  const maxCard = blackFriday?.max ?? promo?.max ?? null;
  const checkoutCurrency = blackFriday?.currency ?? promo?.currency ?? 'CAD';
  const checkoutPhase = promo?.phase ?? 'black_friday';
  const renewal = blackFriday
    ? `${blackFridayRenewalCopy(locale, blackFriday.plus?.saleLabel ?? null, blackFriday.max?.saleLabel ?? null)} ${blackFridayRefundLine(locale)}`
    : null;

  return (
    <>
      {blackFriday ? <BlackFridayBanner offer={blackFriday} locale={locale} /> : promo ? <PromoBanner promo={promo} /> : null}
      <SiteHeader locale={locale} source={source} />
      <div className="rd">
        <FaqDeepLink />
<div className="stage sp-stage">
<ShoreArt />
<main id="main" className="sp-hero">
  <PricingHeroCopy
    locale={locale}
    promo={promo}
    blackFriday={blackFriday}
    priceSurface={priceSurface}
    currency={currency}
    regionBlocked={regionBlocked}
    noChargeLine={noChargeLine}
  />
 </main>
</div>
<div className="hs-page">
{promo ? <PromoSection promo={promo} todayPlus={blackFriday?.plus} todayMax={blackFriday?.max} checkoutQuery={blackFriday?.checkoutQuery ?? ''} locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode} source={source} /> : null}
<section className="hs hs-wash-c" id="pricing">
 <div className="hs-wrap">
  <ol className="hs-tiers">
   <li className="hs-tier t-free">
    <div className="hs-tier-head"><span className="hs-tier-name">{t("Text")}</span><span className="hs-tier-num">01</span></div>
    <h3>{promo || yearlyOnly ? "$0" : t("$0/mo")}</h3>
    <p className="hs-tier-meta">{t("No card needed at all")}</p>
    <p className="hs-tier-body">{t("Unlimited chat, on your own or in your group chats. Hale finds what's on near you, and from Dec 1 signs them up with your ok.")}</p>
    <ul className="hs-checks"><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Unlimited chat")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Live find")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Finds what fits")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Group chats and your co-parent")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("A nudge when a weekend’s empty")}</span></li></ul>
    <div className="hs-tier-cta"><TextDoor className="hs-btn-primary" placement="pricing_tier" locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode} source={source}>{t("Text Hale")}</TextDoor></div>
   </li>
   <li className="hs-tier t-plus">
    <div className="hs-tier-head"><span className="hs-tier-name">Plus</span><span className="hs-tier-num">02</span></div>
    {plusCard ? (<>
    <TierSalePrice price={plusCard} locale={locale} />
    {promo ? <p className="hs-tier-meta promo-tier-refund">Billed yearly. {FOUNDING_REFUND_LINE}</p> : null}
    </>) : yearlyOnly ? (
    <h3>{t(plusAnnualLabel(currency))}</h3>
    ) : (<>
    <h3>{t(plusMonthlyLabel(currency))}</h3>
    <p className="hs-tier-meta">{t(orAnnualLabel(currency))}</p>
    </>)}
    {blackFriday?.plus ? null : promo ? <p className="promo-tier-tag" data-promo-phase={promo.phase}>{`${promo.saleName}: locked in. Join by Dec 31.`}</p> : null}
    <p className="hs-tier-body">{t("More done for you, all year.")}</p>
    <ul className="hs-checks"><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Knows your family")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Keeps them, season to season")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Signs them up Dec 1.")}</span></li></ul>
    <div className="hs-tier-cta">{plusCard ? <FoundingCheckoutLink className="hs-btn-primary" placement="pricing_plus" phase={checkoutPhase} currency={checkoutCurrency} plan="plus" query={blackFriday?.checkoutQuery ?? ''}>{blackFriday?.plus ? blackFridayPlanButton(locale, 'plus', blackFriday.plus.saleLabel) : `Lock in ${plusCard.saleLabel}`}</FoundingCheckoutLink> : list || yearlyOnly ? <TextDoor className="hs-btn-primary" placement="pricing_tier" locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode} source={source}>{t("Text Hale")}</TextDoor> : <button type="button" className="hs-btn-soon" disabled>{t("Coming soon")}</button>}</div>
   </li>
   <li className="hs-tier t-max">
    <div className="hs-tier-head"><span className="hs-tier-name">Max</span><span className="hs-tier-num">03</span></div>
    {maxCard ? (<>
    <TierSalePrice price={maxCard} locale={locale} />
    {promo ? <p className="hs-tier-meta promo-tier-refund">Billed yearly. {FOUNDING_REFUND_LINE}</p> : null}
    {blackFriday?.max ? null : promo ? <p className="promo-tier-tag" data-promo-phase={promo.phase}>{`${promo.saleName}: locked in. Join by Dec 31.`}</p> : null}
    </>) : (<>
    <h3>{t(maxAnnualLabel(currency))}</h3>
    </>)}
    <p className="hs-tier-body">{t("The most Hale can do.")}</p>
    <ul className="hs-checks"><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Everything in Plus")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("The highest limits on searches, all year long.")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Priority support")}</span></li><li><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" /></svg><span>{t("Help with sign-ups")}</span></li></ul>
    <div className="hs-tier-cta">{maxCard ? <FoundingCheckoutLink className="hs-btn-primary promo-max-btn" placement="pricing_max" phase={checkoutPhase} currency={checkoutCurrency} plan="max" query={blackFriday?.checkoutQuery ?? ''}>{blackFriday?.max ? blackFridayPlanButton(locale, 'max', blackFriday.max.saleLabel) : `Lock in ${maxCard.saleLabel}`}</FoundingCheckoutLink> : yearlyOnly ? <TextDoor className="hs-btn-primary" placement="pricing_tier" locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode} source={source}>{t("Text Hale")}</TextDoor> : <button type="button" className="hs-btn-soon" disabled>{t("Coming soon")}</button>}</div>
   </li>
  </ol>
  <p className="hs-meta hs-foot-note">{blackFriday ? blackFridayYearlyNote(locale) : promo ? "Plus and Max are billed yearly. Sale prices are for families who join by Dec 31 and stay locked in while you’re a member." : list || yearlyOnly ? t("Plus is available today.") : t("Paid plans are Plus and Max.")}</p>
 </div>
</section><section className="hs hs-wash-d">
 <div className="hs-wrap hs-grid">
  <div className="hs-faq-l"><p className="hs-eyebrow">{t("About pricing")}</p><h2 className="hs-h2">{t("Fair questions.")}</h2></div>
  <div className="hs-faq-r">{promo ? <PromoFaqItems promo={promo} oneDay={blackFriday != null} /> : blackFriday ? <FaqItem id="when-do-plus-and-max-open" question={t("What do Plus and Max cost?")}>{renewal}</FaqItem> : <FaqItem id="when-do-plus-and-max-open" question={t("What do Plus and Max cost?")}>{t(yearlyOnly ? paidPlansYearlyAnswer(currency) : paidPlansCostAnswer(currency))}</FaqItem>}<FaqItem id="whats-the-difference-between-plus-and-max" question={t("What’s the difference between Plus and Max?")}>{t("Plus is more done for you, all year: remembers your family, season to season, and, starting Dec 1, signs them up with your ok. Max is the most Hale can do: everything in Plus, the highest limits on searches, and priority support.")}</FaqItem></div>
 </div>
</section><section className="hs hs-close-sec" id="start">
 <div className="hs-wrap">
  <div className="hs-close-card">
   <img className="hs-close-art" src={shoreSrc} alt="" aria-hidden="true" />
   <span className="hs-close-scrim" aria-hidden="true" />
   <div className="hs-close-body">
    <span className="hs-close-brand"><img src={logoSrc} alt="" /><svg className="wordmark" viewBox="0 0 905.840370 590.701960" fill="currentColor" aria-hidden="true"><g transform="translate(-13.212024,604.064051) scale(0.100000,-0.100000)"><path d="M2672 5952 c-69 -25 -121 -68 -151 -125 -26 -52 -40 -165 -86 -722 -44 -533 -105 -1601 -105 -1847 0 -53 -4 -99 -9 -102 -5 -3 -143 -31 -307 -61 -165 -31 -414 -78 -555 -105 -141 -28 -264 -50 -274 -50 -15 0 -16 13 -11 158 4 86 11 290 16 452 24 677 99 1773 136 1985 19 104 12 142 -35 217 -42 67 -104 100 -196 106 -132 8 -228 -45 -285 -158 -37 -73 -43 -101 -74 -335 -69 -519 -118 -1161 -146 -1920 -7 -165 -15 -376 -18 -470 l-7 -170 -85 -16 c-142 -27 -207 -66 -253 -154 -51 -99 -13 -253 79 -314 65 -43 126 -49 229 -25 20 5 20 0 22 -623 2 -622 14 -1033 35 -1168 31 -205 122 -298 293 -299 101 -1 160 20 210 76 89 98 103 181 86 524 -7 142 -16 563 -18 935 -5 655 -5 677 13 683 56 17 989 200 1082 212 l52 7 0 -544 c0 -797 25 -1307 72 -1458 16 -51 31 -75 72 -116 67 -67 129 -89 230 -83 120 8 248 86 281 172 18 48 18 80 -8 301 -30 251 -39 486 -44 1156 l-6 677 29 6 c16 3 58 10 93 15 158 25 240 120 229 265 -13 152 -127 249 -273 231 l-55 -7 0 74 c0 111 28 699 45 963 18 267 31 440 76 1026 32 415 33 428 16 482 -23 73 -47 101 -115 133 -77 36 -202 43 -280 16z M6328 5839 c-47 -14 -113 -71 -139 -120 -19 -39 -39 -125 -78 -349 -204 -1162 -289 -2937 -185 -3875 70 -640 252 -925 589 -925 284 0 540 290 438 495 -38 75 -92 108 -178 109 -49 1 -69 -4 -108 -27 -27 -16 -50 -27 -52 -25 -31 36 -67 176 -94 373 -36 254 -45 451 -44 925 1 833 37 1267 203 2410 36 251 90 700 90 753 0 126 -56 209 -162 242 -64 20 -229 28 -280 14z M4447 3885 c-145 -55 -294 -167 -430 -322 -413 -469 -744 -1199 -807 -1778 -21 -197 -4 -444 41 -593 56 -181 168 -325 300 -386 91 -42 157 -56 258 -56 145 0 311 59 441 158 158 119 327 336 454 582 l63 122 7 -78 c31 -340 118 -571 257 -678 95 -74 250 -97 381 -56 68 21 214 104 261 148 162 151 33 448 -181 418 -23 -3 -57 -13 -74 -22 -30 -15 -32 -15 -45 2 -25 34 -53 171 -73 359 -18 167 -23 659 -10 875 20 301 16 328 -50 403 -92 105 -308 109 -413 9 -45 -42 -69 -100 -79 -186 -8 -76 -10 -80 -53 -120 -46 -43 -95 -133 -95 -177 0 -34 -75 -236 -163 -439 -200 -463 -387 -729 -527 -747 -36 -5 -43 -2 -74 31 -119 126 -62 599 129 1066 168 411 423 825 594 964 34 27 120 72 125 64 1 -1 11 -25 21 -53 47 -131 206 -196 362 -150 59 18 135 81 164 136 45 90 31 226 -31 302 -68 81 -166 113 -296 94 l-72 -10 -44 36 c-76 62 -144 90 -228 94 -48 2 -88 -2 -113 -12z M8179 3729 c-392 -58 -837 -524 -1049 -1099 -43 -116 -97 -325 -115 -444 -8 -54 -22 -119 -31 -143 -16 -40 -16 -59 -5 -201 37 -445 135 -724 329 -932 149 -161 337 -240 571 -240 372 0 785 232 1056 593 94 125 175 280 182 350 15 143 -71 246 -203 247 -91 0 -133 -26 -229 -146 -258 -320 -544 -506 -758 -492 -89 6 -137 29 -200 97 -82 88 -142 249 -154 416 l-5 80 63 24 c109 41 299 136 416 209 160 100 253 173 369 287 161 159 258 302 323 476 117 310 87 584 -83 753 -124 124 -314 190 -477 165z m89 -522 c31 -25 46 -73 46 -148 -1 -248 -189 -472 -557 -664 -68 -36 -129 -65 -136 -65 -15 0 -9 24 39 171 94 286 261 547 423 663 87 62 145 75 185 43z" /></g></svg></span>
    {promo && !blackFriday ? (<>
    <h2>{`Max for ${promo.max.saleLabel}, locked in.`}</h2>
    <p className="hs-close-sub">{`${promo.saleName}. Plus is ${promo.plus.saleLabel}. Join by Dec 31. Refund anytime.`}</p>
    </>) : (<>
    <h2>{blackFriday?.max ? blackFridayCloseHeadline(locale, blackFriday.max.saleLabel) : t("Start with a text.")}</h2>
    <p className="hs-close-sub">{blackFriday ? renewal : yearlyOnly ? t(paidPlansYearlyAnswer(currency)) : list ? t(plusCloseSentence(currency)) : t(PAID_PLANS_LINE)}</p>
    </>)}
    <div className="hs-close-cta"><TextDoor className="btn btn-hero" placement="pricing" locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode} source={source}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M8 2.5c3.3 0 6 2.2 6 4.9s-2.7 4.9-6 4.9c-.7 0-1.3-.1-1.9-.2L3 13.5l.9-2.5C2.7 10.1 2 8.8 2 7.4 2 4.7 4.7 2.5 8 2.5z" /></svg>{t("Text Hale")}</TextDoor></div>
    <p className="hs-close-terms">{t("You text first.")}</p>
   </div>
  </div>
 </div>
</section>

</div>


      </div>
      {blackFriday ? <BlackFridaySticky offer={blackFriday} locale={locale} /> : promo ? <PromoStickyCta promo={promo} locale={locale} smsNumber={smsNumber} prefill={prefill} mode={mode} source={source} /> : null}
      <SiteFooter locale={locale} />
    </>
  );
}
