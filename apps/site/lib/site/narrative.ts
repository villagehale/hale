/**
 * Approved site copy. The homepage headline, the line under it, and the
 * one-liner are three different sentences. The older headline stays only as
 * the group-chat section heading. The homepage share card paints H1. Pillar
 * titles stay the 11-23 names.
 */

export const H1 = "Every family has a default parent. Now it’s Hale.";

export const PAGE_TITLE = `Hale: ${H1}`;

/**
 * The first sentence of the hero sub. og:description and twitter:description
 * use this one line. The second sentence, about how to reach Hale, stays on
 * the page.
 */
export const HERO_SHARE =
  'It knows your kids, finds what fits, signs them up with your ok, and handles the schedule, the driving and the other parents.';

/** The line under the homepage H1. Longer than the one-liner, and not the search snippet. */
export const HERO_SUB = `${HERO_SHARE} Text it one-on-one or add it to a group chat.`;

export const ONE_LINER =
  'Hale is the AI agent for family life. It knows your kids, finds what fits, signs them up with your ok, and handles the schedule, the driving and the other parents.';

/** Mission quote with the retired plate clause removed. The age span stays. */
export const MISSION =
  'Every parent should have someone who knows the family. Across every stage of childhood, from the first months to almost grown.';

/** About bullet with the retired year clause removed. */
export const AGE_SPAN = 'From the first months to almost grown, not one season or one app.';

/** Until signup is live, the third pillar carries this dated promise. */
export const GETS_THE_SPOT_UNTIL = 'starting Dec 1, with your ok';

export const PLUS_SIGNUP_LINE = 'Starting Dec 1, signs them up with your ok.';

/** The refund address. One constant, so the mailto and the visible address stay the same sentence. */
export const REFUND_EMAIL = 'aloha@villagehale.com';

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
