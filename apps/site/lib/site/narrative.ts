/**
 * Approved site copy from the Hale narrative 2026-11-23 (VIL-769).
 * Pillar titles and the one-liner are verbatim. Chip sub-lines are the
 * shipped variant; the PR lists the other two for Sloane.
 */

export const ONE_LINER =
  'Hale is an AI agent you text that knows your family and takes the kids’ year off your plate: it finds it, signs them up, and sorts it out with the other families.';

/** Until signup is live, the third pillar carries this dated promise. */
export const GETS_THE_SPOT_UNTIL = 'starting Dec 1, with your ok';

export const PLUS_SIGNUP_LINE = 'Starting Dec 1, signs them up with your ok.';

/**
 * Shipped chip sub-lines (variant A). Titles are the approved pillar names.
 * Sub-lines only restate the one-liner and the pillar names.
 */
export const PILLARS = [
  { title: 'Knows your family', sub: 'Your family' },
  { title: 'Finds what fits', sub: 'It finds it' },
  { title: 'Gets the spot', sub: GETS_THE_SPOT_UNTIL },
  { title: 'Runs the group chat', sub: 'With the other families' },
  { title: 'Reads your Gmail and calendar', sub: 'Gmail and calendar' },
] as const;

/**
 * Shipped first-card name and body (variant A). Whether this tier stays,
 * and what it is called, is an open product decision.
 */
export const FIRST_TIER_NAME = 'Text';
export const FIRST_TIER_META = 'You text Hale';
export const FIRST_TIER_BODY =
  'An AI agent you text that knows your family and takes the kids’ year off your plate.';

export const TEXT_FIRST_TERMS =
  'You text first. Standard message rates apply, reply STOP any time.';

export const SIGNUP_ANSWER =
  'Starting Dec 1, with your ok. Hale does not sign them up before that. You say yes, and you pay.';

export const TEXTING_COST_QUESTION = 'What does texting Hale cost?';
