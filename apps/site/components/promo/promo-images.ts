import bfCar480 from '~/assets/promo/bf-car-pickup-480.webp';
import bfCar960 from '~/assets/promo/bf-car-pickup-960.webp';
import bfCounter480 from '~/assets/promo/bf-counter-flyers-480.webp';
import bfCounter960 from '~/assets/promo/bf-counter-flyers-960.webp';
import bfHall480 from '~/assets/promo/bf-hallway-boots-480.webp';
import bfHall960 from '~/assets/promo/bf-hallway-boots-960.webp';
import holFort480 from '~/assets/promo/hol-blanket-fort-480.webp';
import holFort960 from '~/assets/promo/hol-blanket-fort-960.webp';
import holFridge480 from '~/assets/promo/hol-fridge-december-480.webp';
import holFridge960 from '~/assets/promo/hol-fridge-december-960.webp';
import holWalk480 from '~/assets/promo/hol-snow-walk-480.webp';
import holWalk960 from '~/assets/promo/hol-snow-walk-960.webp';
import type { PromoPhase } from '~/lib/promo/holiday';

/**
 * Promo photography (AI-generated, Nov 2026), shot to read as candid phone
 * photos of everyday parent life. No faces, no readable text, no app screens:
 * Hale lives in texts, so a phone is only ever seen dark or from behind. Each
 * image ships as 480w and 960w webp; the section sits below the hero, so every
 * one loads lazily and none can be the page's LCP.
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
      bfCounter480,
      bfCounter960,
      'A kitchen counter after school: an open lunchbox, activity flyers, a signed form and a parent’s hand on a phone.',
    ),
    pair(bfHall480, bfHall960, 'Kids’ snowy boots, backpacks and mittens piled in a front hallway.'),
    pair(bfCar480, bfCar960, 'A parent waiting in the car at school pickup, seen from the back seat.'),
  ],
  holiday: [
    pair(
      holFridge480,
      holFridge960,
      'A family fridge in December covered in kids’ drawings, a paper calendar and a paper snowflake.',
    ),
    pair(holFort480, holFort960, 'Kids in pyjamas inside a blanket fort with fairy lights on winter break.'),
    pair(holWalk480, holWalk960, 'A parent and a small child pulling a sled down a snowy street, seen from behind.'),
  ],
};
