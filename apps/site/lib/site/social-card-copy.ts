/**
 * The words on the homepage share card, saying what the page metadata and the
 * JSON-LD graph say.
 *
 * The card is the free-traction surface — it is what renders when a parent drops
 * villagehale.com into a group chat — so copy that sells a different product than
 * the page it opens is the loudest seam there is. Pure + exported so the words are
 * asserted without rendering a PNG through satori.
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

export function socialCardCopy(): SocialCardCopy {
  return CHIEF_OF_STAFF;
}
