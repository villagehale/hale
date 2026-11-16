import type { Locale } from '~/i18n/routing';
import type { HolidayPromo } from '~/lib/promo/holiday';
import { FaqItem } from '~/components/redesign/faq-item';
import { TextDoor } from '~/components/redesign/text-door';
import { FoundingCheckoutLink } from './founding-checkout-link';
import { PromoStickyReveal } from './promo-sticky';

/**
 * Holiday founding-family promo surfaces (Design, Nov 2026).
 *
 * Copy rules this file is held to (holiday-promo.test.ts):
 *  - the sale name leads; the founding price sits beside it in the amber block;
 *  - never was / save / % off / strikethrough anywhere near "Sale";
 *  - every Canadian surface carries "Plus is C$159/yr after Dec 31.";
 *  - registration stays "helps you get registered"; no camp-finding, no child
 *    names, no referral or gift offer.
 * Same hook, price and type as the v2 ad creatives (05 founding price).
 */

const REFUND_EMAIL = 'aloha@villagehale.com';

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

/** Thin strip above the header: sale name, price, the CA line, a jump to the offer. */
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
          <span className="promo-bar-long">Founding families: </span>
          <b>{promo.price}</b>, locked in<span className="promo-bar-long">. Join by Dec 31</span>.
        </span>
        {promo.afterLine ? <span className="promo-bar-after">{promo.afterLine}</span> : null}
        <a className="promo-bar-link" href="#founding">
          See<span className="promo-bar-long"> the</span> offer
          <Arrow />
        </a>
      </p>
    </div>
  );
}

/** The amber price block, the same lockup as the ads. */
function PriceLockup({ promo }: { promo: HolidayPromo }) {
  return (
    <p className="promo-price" aria-label={`${promo.price.replace('/yr', ' a year')}`}>
      <span className="promo-price-sym" aria-hidden="true">
        {promo.symbol}
      </span>
      <span className="promo-price-num" aria-hidden="true">
        {promo.amount}
      </span>
      <span className="promo-price-per" aria-hidden="true">
        /yr
      </span>
    </p>
  );
}

const CHIPS = ['Watches the dates', 'Reads flyers', 'Plans winter break', 'Lives in your texts'];

/** The founding-family offer. `id="founding"` is what the banner and sticky bar jump to. */
export function PromoSection({ promo, ...door }: { promo: HolidayPromo } & DoorProps) {
  const currencyName = promo.currency === 'USD' ? 'USD' : 'CAD';
  return (
    <section
      className="hs promo-sec"
      id="founding"
      aria-labelledby="founding-h"
      data-promo-phase={promo.phase}
      data-promo-currency={promo.currency}
    >
      <div className="hs-wrap">
        <div className="promo-card">
          <div className="promo-main">
            <p className="promo-kicker">Founding families</p>
            <h2 className="promo-sale" id="founding-h">
              <span>{promo.saleName.replace(/ Sale$/, '')}</span> <span>Sale</span>
            </h2>
            <PriceLockup promo={promo} />
            <p className="promo-lede">
              Founding families: locked in for as long as you’re a member. Join by Dec 31. Refund
              anytime.
            </p>
            {promo.afterLine ? <p className="promo-after">{promo.afterLine}</p> : null}
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
              >
                Already texting Hale? Lock in {promo.price}
                <Arrow />
              </FoundingCheckoutLink>
            </div>
            <p className="promo-fine">
              Billed once a year in {currencyName}. The founding price is for families who join by
              Dec 31, 2026.
            </p>
          </div>
          <ol className="promo-points">
            <li>
              <span className="promo-pt-ic" aria-hidden="true">
                <Check />
              </span>
              <div>
                <h3>Locked in for life</h3>
                <p>
                  Join by Dec 31 and {promo.price} stays your price for as long as you’re a member.
                  It doesn’t go up at renewal. If you cancel, the founding price ends with the
                  membership.
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
                  Hale is a planner for your kids’ year, by text. Send it a flyer or a screenshot
                  and it keeps the dates. It watches when sign-ups open, gets everything ready and
                  helps you get registered, then asks how it went.
                </p>
              </div>
            </li>
          </ol>
        </div>
      </div>
    </section>
  );
}

/** The three promo questions, in the site's FAQ rows. */
export function PromoFaqItems({ promo }: { promo: HolidayPromo }) {
  const after =
    promo.currency === 'USD'
      ? `New members pay the regular Plus price after Dec 31. If you joined as a founding family, you keep ${promo.price} for as long as you’re a member.`
      : `New members pay the regular price: Plus is C$159/yr after Dec 31. If you joined as a founding family, you keep ${promo.price} for as long as you’re a member.`;
  return (
    <>
      <FaqItem id="what-happens-after-dec-31" question="What happens after Dec 31?">
        {after}
      </FaqItem>
      <FaqItem id="can-i-get-a-refund" question="Can I get a refund?">
        Yes, any time. Email {REFUND_EMAIL} and we’ll refund you and end the membership.
      </FaqItem>
      <FaqItem id="what-does-hale-do" question="What does Hale do?">
        Hale is a planner for your kids’ year, and it lives in your texts. Send it a flyer or a
        screenshot and it keeps the dates. It watches when sign-ups open, gets everything ready and
        helps you get registered, and it plans winter break with you. No app to download.
      </FaqItem>
      <FaqItem id="why-this-currency" question="Why do I see this currency?">
        Prices follow where you are: CAD in Canada, USD in the US. Checkout charges the same
        currency you see here.
      </FaqItem>
    </>
  );
}

/** Mobile-only bar pinned to the bottom once the hero is gone, hidden over the offer itself. */
export function PromoStickyCta({ promo, ...door }: { promo: HolidayPromo } & DoorProps) {
  return (
    <PromoStickyReveal>
      <div className="promo-sticky-copy">
        <strong>{promo.saleName}</strong>
        <span>
          {promo.price}, locked in{promo.afterLine ? '' : '. Join by Dec 31'}
        </span>
        {promo.afterLine ? <small>{promo.afterLine}</small> : null}
      </div>
      <TextDoor className="promo-sticky-btn" placement="promo_sticky" {...door}>
        Text Hale
      </TextDoor>
    </PromoStickyReveal>
  );
}
