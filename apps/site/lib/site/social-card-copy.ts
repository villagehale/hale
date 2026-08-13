import { f14LandingEnabled } from '~/lib/flags/landing';

/**
 * The words on the homepage share card, following the landing flag exactly like
 * the page metadata and the JSON-LD graph do.
 *
 * The card is the free-traction surface — it is what renders when a parent drops
 * villagehale.com into a group chat — so a card still selling "the village every
 * parent needs" over a page about a number you text is the pivot's loudest
 * remaining seam. Pure + exported so both variants are asserted without rendering
 * a PNG through satori.
 */
export interface SocialCardCopy {
  /** The `alt` Next serves as the og:image:alt. */
  alt: string;
  headline: string;
  subline: string;
}

const CHIEF_OF_STAFF: SocialCardCopy = {
  alt: 'Hale — your family’s quiet chief of staff',
  headline: 'A number your family texts',
  subline:
    'Registration dates watched, the week planned, nothing sent without your say-so. Your data stays in Canada.',
};

const VILLAGE: SocialCardCopy = {
  alt: 'Hale — the village every parent needs',
  headline: 'The village every parent needs',
  subline: 'Find what families near you actually do. Your data stays in Canada.',
};

export function socialCardCopy(): SocialCardCopy {
  return f14LandingEnabled() ? CHIEF_OF_STAFF : VILLAGE;
}
