import bfFridge480 from '~/assets/promo/bf-fridge-flyers-480.webp';
import bfFridge960 from '~/assets/promo/bf-fridge-flyers-960.webp';
import bfGift480 from '~/assets/promo/bf-gift-gold-480.webp';
import bfGift960 from '~/assets/promo/bf-gift-gold-960.webp';
import bfPhone480 from '~/assets/promo/bf-phone-night-480.webp';
import bfPhone960 from '~/assets/promo/bf-phone-night-960.webp';
import holFridge480 from '~/assets/promo/hol-fridge-calendar-480.webp';
import holFridge960 from '~/assets/promo/hol-fridge-calendar-960.webp';
import holKitchen480 from '~/assets/promo/hol-kitchen-texting-480.webp';
import holKitchen960 from '~/assets/promo/hol-kitchen-texting-960.webp';
import holWalk480 from '~/assets/promo/hol-winter-walk-480.webp';
import holWalk960 from '~/assets/promo/hol-winter-walk-960.webp';
import type { PromoPhase } from '~/lib/promo/holiday';

/**
 * Promo photography (AI-generated, Nov 2026). No real people, no faces, no
 * readable text, no app screens: Hale lives in texts, so a phone is only ever
 * seen from the back or with its screen softened. Each image ships as 480w and
 * 960w webp; the section is below the hero, so every one loads lazily and none
 * can be the page's LCP.
 */
export interface PromoImage {
  src: string;
  srcSet: string;
  width: number;
  height: number;
  alt: string;
}

type Asset = { src: string; width: number; height: number };

function pair(small: Asset, large: Asset, alt: string): PromoImage {
  return {
    src: small.src,
    srcSet: `${small.src} ${small.width}w, ${large.src} ${large.width}w`,
    width: large.width,
    height: large.height,
    alt,
  };
}

/** [feature, detail, detail] per phase. */
export const PROMO_IMAGES: Record<PromoPhase, [PromoImage, PromoImage, PromoImage]> = {
  black_friday: [
    pair(
      bfPhone480,
      bfPhone960,
      'A parent’s hand holding a phone beside a mug of tea on a dark kitchen counter at night.',
    ),
    pair(bfFridge480, bfFridge960, 'Flyers and a blank calendar held by magnets on a fridge door.'),
    pair(bfGift480, bfGift960, 'A black gift box tied with a gold ribbon.'),
  ],
  holiday: [
    pair(
      holKitchen480,
      holKitchen960,
      'A parent in a cozy sweater texting at the kitchen counter while snow falls outside.',
    ),
    pair(
      holFridge480,
      holFridge960,
      'A blank calendar and flyers held by ornament magnets on a fridge, with pine and berries.',
    ),
    pair(
      holWalk480,
      holWalk960,
      'A family walking down a snowy, lit-up street on winter break, seen from behind.',
    ),
  ],
};
