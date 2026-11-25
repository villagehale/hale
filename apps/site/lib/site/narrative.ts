/**
 * Approved site copy. The 11-23 one-liner and H1 were retired by Sloane:
 * the homepage headline, the line under it, and the one-liner are three
 * different sentences. Pillar titles stay the 11-23 names.
 */

export const H1 = 'From "we should" to "we\'re in."';

export const PAGE_TITLE = `Hale: ${H1}`;

/** The line under the homepage H1. Longer than the one-liner, and not a meta description. */
export const HERO_SUB =
  "Hale joins the parent group chat, finds real classes and plans near you for your kids' ages, and gets every family to a yes.";

export const ONE_LINER =
  "Hale finds real classes and plans near you for your kids' ages, and gets the group chat to a yes.";

/** Mission quote with the retired plate clause removed. The age span stays. */
export const MISSION =
  'Every parent should have someone who knows the family. Across every stage of childhood, from the first months to almost grown.';

/** About bullet with the retired year clause removed. */
export const AGE_SPAN = 'From the first months to almost grown, not one season or one app.';

/** Until signup is live, the third pillar carries this dated promise. */
export const GETS_THE_SPOT_UNTIL = 'starting Dec 1, with your ok';

export const PLUS_SIGNUP_LINE = 'Starting Dec 1, signs them up with your ok.';

/** Pillar titles are the approved names. Sub-lines are the shipped lines. */
export const PILLARS = [
  { title: 'Knows your family', sub: 'Your family' },
  { title: 'Finds what fits', sub: 'It finds it' },
  { title: 'Gets the spot', sub: GETS_THE_SPOT_UNTIL },
  { title: 'Runs the group chat', sub: 'With the other families' },
] as const;

export const TEXT_FIRST_TERMS = 'You text first. Standard message rates apply.';

export const SIGNUP_ANSWER =
  'Starting Dec 1, with your ok. Hale does not sign them up before that. You say yes, and you pay.';

export const TEXTING_COST_QUESTION = 'What does texting Hale cost?';
