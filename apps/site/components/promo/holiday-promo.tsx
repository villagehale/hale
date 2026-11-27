import logo from '~/assets/hale-logo.jpeg';
import { FaqItem } from '~/components/redesign/faq-item';
import { TextDoor } from '~/components/redesign/text-door';
import type { Locale } from '~/i18n/routing';
import {
  type BlackFridayOffer,
  blackFridayHeardPrice,
  blackFridayRenewalCopy,
} from '~/lib/promo/black-friday';
import {
  FOUNDING_REFUND_LINE,
  type HolidayPromo,
  PROMO_OFFER_ID,
  type PromoTierPrice,
} from '~/lib/promo/holiday';
import { ONE_LINER, PLUS_SIGNUP_LINE, REFUND_EMAIL } from '~/lib/site/narrative';
import { BlackFridaySticky } from './black-friday-sticky';
import { FoundingCheckoutLink } from './founding-checkout-link';
import { PromoStickyReveal } from './promo-sticky';

/**
 * Holiday promo surfaces (Design, Nov 2026), copy aligned to the 11-23 narrative.
 *
 * Copy rules this file is held to (holiday-promo.test.ts):
 *  - the sale name leads, with the Max sale price as the big numeral under it
 *    and the regular Max price struck beside it (Barton, Nov 16 1:07 PM ET);
 *    Plus sits on the line below, also struck regular → sale;
 *  - never was / save / % off wording; the struck price says it;
 *  - plain "$" in both countries and no CAD / USD beside any price: the
 *    numbers themselves change with the visitor's country;
 *  - yearly only, no monthly option and no trial wording;
 *  - signup stays "Starting Dec 1, signs them up with your ok"; no camp-finding,
 *    no child names, no referral or gift offer.
 *
 * Look: both phases share one treatment, the Notes-app page (IG style D).
 * Ruled cream paper, brush headline, marker highlight on "Sale", and the flat
 * navy turtle. On desktop the turtle sits in the corner and a Messages phone
 * fills the right column. Phase still switches the sale name. The rules live
 * in promo.css on .promo-sec.promo-notes, so the banner, sticky bar, and price
 * cards stay as they are.
 */

interface DoorProps {
  locale: Locale;
  smsNumber: string;
  prefill: string;
  source?: string | null;
  mode: 'chooser' | 'sms';
}

function Bubble() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M10 2.75c4.28 0 7.75 2.86 7.75 6.38 0 3.53-3.47 6.38-7.75 6.38-.86 0-1.69-.11-2.46-.33L3.6 16.9a.4.4 0 0 1-.56-.46l.83-2.97C2.88 12.36 2.25 10.8 2.25 9.13c0-3.52 3.47-6.38 7.75-6.38Z" />
    </svg>
  );
}

function Arrow() {
  return (
    <svg
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
  );
}

function Check() {
  return (
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
  );
}

/** Thin strip above the header: sale name, the Max and Plus prices, a jump to the offer. */
export function PromoBanner({ promo }: { promo: HolidayPromo }) {
  return (
    <div
      className="rd promo-bar"
      data-promo-phase={promo.phase}
      data-promo-currency={promo.currency}
    >
      <p className="promo-bar-in">
        <strong className="promo-bar-sale">{promo.saleName}</strong>
        <span className="promo-bar-offer">
          Max <b>{promo.max.saleLabel}</b>
          <span className="promo-bar-long">, Plus {promo.plus.saleLabel}</span>, locked in
          <span className="promo-bar-long">. Join by Dec 31</span>.
        </span>
        <a className="promo-bar-link" href={`#${PROMO_OFFER_ID}`}>
          See<span className="promo-bar-long"> the</span> offer
          <Arrow />
        </a>
      </p>
    </div>
  );
}

/** The big Max sale price, with the regular Max price struck beside it. */
function PriceLockup({
  promo,
  plus,
  max,
}: {
  promo: HolidayPromo;
  plus?: PromoTierPrice | null;
  max?: PromoTierPrice | null;
}) {
  const shownPlus = plus ?? promo.plus;
  const shownMax = max ?? promo.max;
  const maxPrice = shownMax;
  return (
    <div className="promo-offer">
      <p className="promo-offer-tier">Max</p>
      <p className="promo-price">
        <span className="promo-sr">
          Max: {maxPrice.saleLabel.replace('/yr', ' a year')}, regular price{' '}
          {maxPrice.regularLabel.replace('/yr', ' a year')}.
        </span>
        <span className="promo-price-sym" aria-hidden="true">
          {promo.symbol}
        </span>
        <span className="promo-price-num" aria-hidden="true">
          {maxPrice.sale}
        </span>
        <span className="promo-price-side" aria-hidden="true">
          <s className="promo-price-regular">{maxPrice.regularLabel}</s>
          <span className="promo-price-per">/yr</span>
        </span>
      </p>
      <p className="promo-offer-plus">
        <span className="promo-sr">
          Plus: {shownPlus.saleLabel.replace('/yr', ' a year')}, regular price{' '}
          {shownPlus.regularLabel.replace('/yr', ' a year')}.
        </span>
        <span aria-hidden="true">
          <span className="promo-offer-plus-name">Plus</span>{' '}
          <s className="promo-price-regular">{shownPlus.regularLabel}</s>{' '}
          <b>{shownPlus.saleLabel}</b>
        </span>
      </p>
    </div>
  );
}

const CHIPS = ['Knows your family', 'Finds a fit', 'Runs group chats'];

/**
 * The style-D group chat, same order as the share card: Priya, then Hale's
 * three lines, then the outgoing yes. French and Chinese are that card's lines.
 */
const PHONE_THREAD: Record<
  Locale,
  {
    label: string;
    group: string;
    delivered: string;
    priya: string;
    hale: readonly [string, string, string];
    mine: string;
  }
> = {
  en: {
    group: 'Saturday crew',
    delivered: 'Delivered',
    priya: 'we should do something saturday',
    hale: ['toddler swim', 'saturday, 10am', 'at the community centre'],
    mine: 'we’re in 🙌',
    label:
      'Saturday crew group chat. Priya: we should do something saturday. Hale: toddler swim. saturday, 10am. at the community centre. You: we’re in. Delivered.',
  },
  fr: {
    group: 'La gang du samedi',
    delivered: 'Distribué',
    priya: 'on devrait faire quelque chose samedi',
    hale: ['natation pour les tout-petits', 'samedi à 10 h', 'au centre communautaire'],
    mine: 'on est partants 🙌',
    label:
      'Conversation, La gang du samedi. Priya : on devrait faire quelque chose samedi. Hale : natation pour les tout-petits. samedi à 10 h. au centre communautaire. Vous : on est partants. Distribué.',
  },
  zh: {
    group: '周六小队',
    delivered: '已送达',
    priya: '我们周六应该做点什么',
    hale: ['幼儿游泳', '周六上午 10 点', '在社区中心'],
    mine: '我们去 🙌',
    label:
      '周六小队群聊。Priya：我们周六应该做点什么。Hale：幼儿游泳。周六上午 10 点。在社区中心。你：我们去。已送达。',
  },
};

/** iPhone-proportion Messages screen. Hidden below the desktop breakpoint. */
function PromoPhone({ locale }: { locale: Locale }) {
  const chat = PHONE_THREAD[locale];
  return (
    <div className="promo-phone" role="img" aria-label={chat.label}>
      <div className="promo-phone-bezel" aria-hidden="true">
        <div className="promo-phone-screen">
          <div className="promo-phone-status">
            <span>9:41</span>
            <span className="promo-phone-sig" />
          </div>
          <span className="promo-phone-island" />
          <div className="promo-phone-head">
            <span className="promo-phone-back">‹</span>
            <span className="promo-phone-stack">
              <span className="promo-phone-av promo-phone-av-j">J</span>
              <span className="promo-phone-av promo-phone-av-p">P</span>
              <img className="promo-phone-av" src={logo.src} alt="" />
            </span>
            <span className="promo-phone-group">{chat.group} ›</span>
          </div>
          <div className="promo-phone-thread">
            <div className="promo-phone-run">
              <span className="promo-phone-who">Priya</span>
              <div className="promo-phone-line">
                <span className="promo-phone-av promo-phone-av-p">P</span>
                <span className="promo-phone-bubble">{chat.priya}</span>
              </div>
            </div>
            <div className="promo-phone-run">
              <span className="promo-phone-who">Hale</span>
              {chat.hale.map((text, index) => (
                <div className="promo-phone-line" key={text}>
                  {index === chat.hale.length - 1 ? (
                    <img className="promo-phone-av" src={logo.src} alt="" />
                  ) : (
                    <span className="promo-phone-av promo-phone-av-gap" />
                  )}
                  <span className="promo-phone-bubble">{text}</span>
                </div>
              ))}
            </div>
            <div className="promo-phone-out">
              <span className="promo-phone-bubble promo-phone-bubble-out">{chat.mine}</span>
              <span className="promo-phone-delivered">{chat.delivered}</span>
            </div>
          </div>
          <div className="promo-phone-compose">
            <span className="promo-phone-plus">+</span>
            <span className="promo-phone-field">iMessage</span>
          </div>
          <span className="promo-phone-home" />
        </div>
      </div>
    </div>
  );
}

/** The sale offer. The id is what the banner and sticky bar jump to. */
export function PromoSection({
  promo,
  todayPlus = null,
  todayMax = null,
  checkoutQuery = '',
  ...door
}: {
  promo: HolidayPromo;
  todayPlus?: PromoTierPrice | null;
  todayMax?: PromoTierPrice | null;
  checkoutQuery?: string;
} & DoorProps) {
  const plusPrice = todayPlus ?? promo.plus;
  const maxPrice = todayMax ?? promo.max;
  const oneDay = plusPrice.sale !== promo.plus.sale || maxPrice.sale !== promo.max.sale;
  return (
    <section
      className="hs promo-sec promo-notes"
      id={PROMO_OFFER_ID}
      aria-labelledby={`${PROMO_OFFER_ID}-h`}
      data-promo-phase={promo.phase}
      data-promo-currency={promo.currency}
    >
      <div className="hs-wrap">
        <div className="promo-card">
          <div className="promo-notes-bar" aria-hidden="true">
            <span className="promo-notes-back" />
            <span className="promo-notes-done" />
          </div>
          <div className="promo-sheet">
            <div className="promo-main">
              <p className="promo-kicker">Our holiday sale this season</p>
              <h2 className="promo-sale" id={`${PROMO_OFFER_ID}-h`}>
                <span>{promo.saleName.replace(/ Sale$/, '')}</span>{' '}
                <span className="promo-sale-word">Sale</span>
              </h2>
              <PriceLockup promo={promo} plus={plusPrice} max={maxPrice} />
              <p className="promo-price-note">{FOUNDING_REFUND_LINE}</p>
              <p className="promo-lede">
                {oneDay
                  ? `${blackFridayRenewalCopy('en', plusPrice.saleLabel, maxPrice.saleLabel)} Refund anytime.`
                  : 'Your price for the rest of the year, locked in for as long as you’re a member. Join by Dec 31. Refund anytime.'}
              </p>
              <ul className="promo-chips">
                {CHIPS.map((chip) => (
                  <li key={chip}>{chip}</li>
                ))}
              </ul>
              <div className="promo-ctas">
                <TextDoor className="btn btn-hero promo-btn" placement="promo_section" {...door}>
                  <Bubble />
                  Text Hale to start
                </TextDoor>
                <FoundingCheckoutLink
                  className="promo-lockin"
                  placement="promo_section"
                  phase={promo.phase}
                  currency={promo.currency}
                  plan="max"
                  query={checkoutQuery}
                >
                  {oneDay
                    ? `Get Max, ${maxPrice.saleLabel}`
                    : `Already texting Hale? Lock in Max at ${maxPrice.saleLabel}`}
                  <Arrow />
                </FoundingCheckoutLink>
              </div>
              <p className="promo-fine">
                {oneDay
                  ? 'Billed once a year. This price stays when you renew.'
                  : 'Billed once a year. Sale prices are for families who join by Dec 31, 2026.'}
              </p>
            </div>
            <div className="promo-notes-aside" aria-hidden="true">
              <img
                className="promo-notes-mark"
                src={logo.src}
                width={logo.width}
                height={logo.height}
                alt=""
              />
            </div>
            <PromoPhone locale={door.locale} />
          </div>
          <ol className="promo-points">
            <li>
              <span className="promo-pt-ic" aria-hidden="true">
                <Check />
              </span>
              <div>
                <h3>{oneDay ? 'When you renew' : 'Locked in'}</h3>
                <p>
                  {oneDay
                    ? `${blackFridayRenewalCopy('en', plusPrice.saleLabel, maxPrice.saleLabel)} If you cancel, it ends with the membership.`
                    : `Join by Dec 31 and your price (${promo.max.saleLabel} for Max, ${promo.plus.saleLabel} for Plus) stays the same for as long as you’re a member. It doesn’t go up at renewal. If you cancel, the sale price ends with the membership.`}
                </p>
              </div>
            </li>
            <li>
              <span className="promo-pt-ic" aria-hidden="true">
                <Check />
              </span>
              <div>
                <h3>Refund anytime</h3>
                <p>
                  Changed your mind? Email <a href={`mailto:${REFUND_EMAIL}`}>{REFUND_EMAIL}</a> and
                  we’ll refund you, any time.
                </p>
              </div>
            </li>
            <li>
              <span className="promo-pt-ic" aria-hidden="true">
                <Check />
              </span>
              <div>
                <h3>What Hale does</h3>
                <p>
                  Hale finds real classes and plans near you, by text. Send a flyer or a screenshot
                  and it keeps the dates. From Dec 1, with your ok, it signs them up, and then the
                  plan stays with everyone in the chat for good.
                </p>
              </div>
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}

/** The FAQ's neutral "after Dec 31" fact. Exported for the tests. */
export function foundingAfterLine(promo: HolidayPromo): string {
  return `Families who join by Dec 31 keep ${promo.max.saleLabel} for Max or ${promo.plus.saleLabel} for Plus for as long as they’re members. Families who join after that pay the regular price.`;
}

/** The promo questions, in the site's FAQ rows. */
export function PromoFaqItems({
  promo,
  oneDay = false,
}: {
  promo: HolidayPromo;
  oneDay?: boolean;
}) {
  return (
    <>
      {oneDay ? (
        <FaqItem id="what-happens-when-you-renew" question="What happens when you renew?">
          This price stays when you renew.
        </FaqItem>
      ) : (
        <FaqItem id="what-happens-after-dec-31" question="What happens after Dec 31?">
          {foundingAfterLine(promo)}
        </FaqItem>
      )}
      <FaqItem id="can-i-get-a-refund" question="Can I get a refund?">
        Yes, any time. Email {REFUND_EMAIL} and we’ll refund you and end the membership.
      </FaqItem>
      <FaqItem id="what-does-hale-do" question="What does Hale do?">
        {ONE_LINER} {PLUS_SIGNUP_LINE} No app to download.
      </FaqItem>
      <FaqItem id="why-this-currency" question="Why do I see this currency?">
        Prices follow where you are: Canadian dollars in Canada, US dollars in the US. Checkout
        charges the same currency.
      </FaqItem>
    </>
  );
}

/** Card price for a paid tier on the pricing page: regular struck, sale beside it. */
export function TierSalePrice({
  price,
  locale = 'en',
}: {
  price: PromoTierPrice;
  locale?: 'en' | 'fr' | 'zh';
}) {
  return (
    <h3 className="promo-tier-price">
      <span className="promo-sr">
        {blackFridayHeardPrice(locale, price.saleLabel, price.regularLabel)}
      </span>
      <span className="promo-tier-pair" aria-hidden="true">
        <s className="promo-tier-regular">{price.regularLabel}</s>
        <span className="promo-tier-sale">{price.saleLabel}</span>
      </span>
    </h3>
  );
}

/** Mobile-only bar pinned to the bottom once the hero is gone, hidden over the offer itself. */
export function PromoStickyCta({
  promo,
  blackFriday = null,
  ...door
}: { promo: HolidayPromo; blackFriday?: BlackFridayOffer | null } & DoorProps) {
  if (blackFriday) {
    return <BlackFridaySticky offer={blackFriday} phase={promo.phase} {...door} />;
  }
  return (
    <PromoStickyReveal phase={promo.phase}>
      <div className="promo-sticky-copy">
        <strong>{promo.saleName}</strong>
        <span>
          Max {promo.max.saleLabel}, Plus {promo.plus.saleLabel}. Join by Dec&nbsp;31
        </span>
      </div>
      <TextDoor className="promo-sticky-btn" placement="promo_sticky" {...door}>
        Text Hale
      </TextDoor>
    </PromoStickyReveal>
  );
}
