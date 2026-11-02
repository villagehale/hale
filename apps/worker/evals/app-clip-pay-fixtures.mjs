/**
 * VIL-481 · Apple Pay App Clip fixtures. Each `input` is what the runtime hands
 * the skill. `situation` is for the judge. Nothing here names the right sentence.
 *
 * Axes: the parent asked in English, French, or Chinese; they were not asking;
 * they already said no; they did not name Plus or Family and the household
 * does not decide it.
 */

const asked = (parentText, extra = {}) => ({
  moment: 'card',
  audience: 'direct',
  planTier: 'free',
  parentText,
  childCount: null,
  coparent: null,
  prior: null,
  ...extra,
});

export const APP_CLIP_PAY_FIXTURES = [
  {
    id: 'en-plus',
    input: asked('can I pay for plus', { childCount: 1, coparent: false }),
    situation:
      'One child, no co-parent, free plan. The parent asked in English to pay for Plus. Offer Plus. The checkout line is English, like a friend texting, with no price, no billing period, and no pitch.',
  },
  {
    id: 'fr-family',
    input: asked('on peut payer le forfait famille?', { childCount: 2, coparent: true }),
    situation:
      'Two children, a co-parent, free plan. The parent asked in French to pay for Family. Offer Family. The checkout line is French, like a friend texting, with no price, no billing period, and no pitch.',
  },
  {
    id: 'zh-plus',
    input: asked('我想付 Plus', { childCount: 1, coparent: false }),
    situation:
      'One child, no co-parent, free plan. The parent asked in Chinese to pay for Plus. Offer Plus. The checkout line is Chinese, like a friend texting, with no price, no billing period, and no pitch.',
  },
  {
    id: 'not-asking',
    input: asked('what time is swim tomorrow'),
    situation:
      'The parent asked what time swim is. They did not ask to pay. Offer nothing. Tier, description, and line are null.',
  },
  {
    id: 'said-no',
    input: asked('ok sure', { prior: 'no', childCount: 1 }),
    situation:
      'The parent already said no. This message does not ask again. Offer nothing. Do not re-ask.',
  },
  {
    id: 'unnamed-plan',
    input: asked('I want to pay'),
    situation:
      'The parent wants to pay and did not name Plus or Family. Child count and co-parent were not given. Do not guess Plus. Offer nothing.',
  },
];
