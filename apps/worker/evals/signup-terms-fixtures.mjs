// VIL-715 · registration pre-flight and approval binding: the corpus.
//
// Expectations come from the SPEC (packages/agent/skills/signup-plan-terms.md,
// signup-plan-read-terms.md, signup-preflight-read.md, signup-dob-read.md). Invented
// provider, family and values only (the repo is public).

const OPENS = { local: 'Tuesday, February 24, 2026 at 6:30 a.m.', timeZone: 'America/Toronto' };
const SESSION = {
  label: 'Get Ready Public Speaking Sat 9:30',
  startsAt: '2026-03-28T13:30:00.000Z',
  endsAt: '2026-03-28T14:30:00.000Z',
  priceCents: null,
};

const TERMS = {
  free: false,
  rates: [{ rate: 'resident', cents: 8488 }],
  residency: 'resident',
  tax: 'included',
  refund: null,
  ageFit: 'in_band',
  ageBand: '4 to 6',
  prerequisite: { required: 'no', quote: null },
  priorChargeUnknown: false,
  unread: ['refund'],
};

const BASE = {
  moment: 'offer',
  mode: 'auto',
  childFirstName: 'Ada',
  opensAt: OPENS,
  sessions: [SESSION],
  maxPriceCents: null,
  waiverAccepted: null,
  question: null,
  refusal: null,
  run: null,
  language: 'en',
  terms: TERMS,
};

const RUN = {
  outcome: 'needs_human',
  detail: 'cart_mismatch',
  confirmed: false,
  sessionLabel: SESSION.label,
  cartTotalCents: 9760,
  amountChargedCents: null,
  charged: 'nothing',
  liveBrowser: true,
  holdMinutes: 12,
};

const LENGTH =
  'This text carries the price, the tax, the refund policy and the age fit, so it may run to three or four short sentences. That is the job here, not a recap.';

const offer = (id, terms, watchFor, over = {}) => ({
  id,
  facts: { ...BASE, ...over, terms: { ...TERMS, ...terms } },
  watchFor: `${watchFor} ${LENGTH}`,
});

const finished = (id, run, watchFor) => ({
  id,
  facts: {
    ...BASE,
    moment: 'run_finished',
    maxPriceCents: 8488,
    run: { ...RUN, ...run },
  },
  watchFor,
});

export const SIGNUP_TERMS_WRITER_FIXTURES = [
  offer(
    'offer-price-unstated',
    { rates: [], unread: ['refund', 'price'] },
    'Says Hale could not find the price and will stop at checkout for them to finish. States no price or limit, and does not call the class free. Says plainly that Hale could not find a refund policy.',
  ),
  offer(
    'offer-resident-no-refund',
    {},
    'States $84.88. Says plainly that Hale could not find a refund policy. Does not say the child is registered.',
  ),
  offer(
    'offer-resident-pair',
    {
      residency: 'unknown',
      rates: [
        { rate: 'resident', cents: 8488 },
        { rate: 'non_resident', cents: 9760 },
      ],
    },
    'States both $84.88 and $97.60, and that the site picks from their account.',
  ),
  offer(
    'offer-plus-tax-fr',
    { tax: 'plus_tax' },
    'In French with tu. States the price and that tax is added.',
    { language: 'fr' },
  ),
  offer(
    'offer-refund-quoted-zh',
    { refund: 'Refunds are available until 7 days before the first class.', unread: [] },
    'In Chinese. States the price and the refund policy in substance: up to 7 days before the first class.',
    { language: 'zh' },
  ),
  offer(
    'offer-prerequisite',
    {
      prerequisite: { required: 'yes', quote: 'Must have completed Level 1.' },
      unread: ['refund'],
    },
    'Names the requirement (Level 1) and asks whether the child has done it.',
  ),
  offer(
    'offer-free',
    { free: true, rates: [{ rate: 'flat', cents: 0 }], unread: ['refund'] },
    'Says the class is free. States no price.',
  ),
  offer(
    'offer-age-unconfirmed',
    { ageFit: 'unknown', unread: ['refund', 'age'] },
    'Says Hale could not confirm the age fit and will stop at checkout for them to finish.',
  ),
  offer(
    'offer-free-or-paid',
    {
      residency: 'unknown',
      rates: [
        { rate: 'resident', cents: 0 },
        { rate: 'non_resident', cents: 4000 },
      ],
    },
    'Says it is free for residents and $40.00 for non-residents, and that the site picks from their account.',
  ),
  offer(
    'offer-prior-charge',
    { priorChargeUnknown: true },
    'Says an earlier try may have gone through, to check their card and email first, and that Hale will stop at checkout this time.',
  ),
  {
    id: 'clarify-stated-price',
    facts: {
      ...BASE,
      moment: 'clarify',
      question: 'They put an amount of their own beside their yes. May Hale pay the stated price?',
    },
    watchFor:
      'Asks whether Hale may pay $84.88. States no other amount, does not say the child is registered, and does not restate the refund or age terms.',
  },
  {
    id: 'ack-runs-now',
    facts: { ...BASE, moment: 'approved', maxPriceCents: 8488, terms: { ...TERMS, runsNow: true } },
    watchFor:
      'Says Hale is starting now and will text when done. Gives no time or estimate, and does not restate the terms.',
  },
  {
    id: 'ack-held',
    facts: {
      ...BASE,
      moment: 'approved',
      maxPriceCents: 8488,
      terms: { ...TERMS, runsNow: true, hold: 'age_unconfirmed' },
    },
    watchFor: 'Says Hale will go as far as checkout and stop there for them to finish.',
  },
  finished(
    'run-cart-price',
    { cartDifferences: ['price'] },
    'Says the total differed: the site showed $97.60 against the approved $84.88. Nothing was charged. The browser is open for them.',
  ),
  finished(
    'run-cart-fees',
    { cartDifferences: ['fees'], cartTotalCents: 9488 },
    'Says a fee was added, so Hale stopped before paying. Nothing was charged.',
  ),
  finished(
    'run-cart-session',
    { cartDifferences: ['session'], cartTotalCents: 8488 },
    'Says the cart held a different class, day or time, so Hale stopped. Nothing was charged.',
  ),
  finished(
    'run-cart-kid',
    { cartDifferences: ['kid'], cartTotalCents: 8488 },
    'Says the registration was for a different child, so Hale stopped. Nothing was charged.',
  ),
  finished(
    'run-cart-quantity',
    { cartDifferences: ['quantity'], cartTotalCents: 16976 },
    'Says the cart held more than one, so Hale stopped. Nothing was charged. It may state the $169.76 the site showed.',
  ),
  finished(
    'run-cart-unread',
    { cartDifferences: ['unread'], cartTotalCents: null },
    'Says Hale could not read the cart to confirm it, so it did not pay. Nothing was charged.',
  ),
  finished(
    'run-hold-age',
    { detail: 'age_unconfirmed', cartTotalCents: 8488 },
    'Says Hale could not confirm the age fit, so it stopped at checkout. Nothing was charged. They finish in the browser.',
  ),
  finished(
    'run-hold-site-option',
    { detail: 'site_option', cartTotalCents: 8488 },
    'Says this was a different option from the site, so Hale stopped at checkout. Nothing was charged. They finish in the browser.',
  ),
  finished(
    'run-hold-prior-charge',
    { detail: 'prior_charge_unknown', cartTotalCents: 8488 },
    'Says an earlier try may have gone through, so Hale stopped rather than risk paying twice. Nothing was charged this time. They check their card and email.',
  ),
  {
    id: 'run-hold-price',
    facts: {
      ...BASE,
      moment: 'run_finished',
      maxPriceCents: null,
      run: { ...RUN, detail: 'price_unstated', cartTotalCents: 12300 },
      terms: { ...TERMS, rates: [], unread: ['refund', 'price'], hold: 'price_unstated' },
    },
    watchFor:
      'Says Hale could not find the price, so it stopped at checkout. Nothing was charged. They finish in the browser, where they see the real price. It may state the $123.00 the site showed.',
  },
  {
    id: 'refused-age',
    facts: { ...BASE, moment: 'refused', refusal: 'age_outside_band' },
    watchFor:
      'Says the child is outside the ages (4 to 6) and this class does not fit. Hale did not register them.',
  },
  {
    id: 'refused-season',
    facts: { ...BASE, moment: 'refused', refusal: 'season_cap' },
    watchFor:
      "Says Hale has used this season's sign-ups so it is not registering this one, and they can register at the link.",
  },
];

const READ_OFFER = {
  status: 'pending',
  activity: 'Get Ready Public Speaking',
  host: 'cityofexample.perfectmind.test',
  opensAt: new Date('2026-02-24T11:30:00.000Z'),
  approvedPriceCents: null,
  plan: null,
  asksWaiver: false,
  sessions: [
    {
      id: 's-1',
      label: SESSION.label,
      startsAt: SESSION.startsAt,
      endsAt: SESSION.endsAt,
      full: false,
      priceCents: null,
    },
  ],
};
const READ_TERMS = {
  sessionPrices: [{ sessionId: 's-1', cents: [8488] }],
  freeSessionIds: [],
  prerequisiteRequired: false,
  prerequisiteQuote: null,
  prerequisiteAsked: false,
};

export const SIGNUP_TERMS_READ_FIXTURES = [
  {
    id: 'read-bare-yes',
    text: 'yes please',
    offer: { ...READ_OFFER, terms: READ_TERMS },
    expect: { verdict: 'approve', maxPriceCents: 8488 },
  },
  {
    id: 'read-yes-with-limit',
    text: 'yes, up to $100',
    offer: { ...READ_OFFER, terms: READ_TERMS },
    expect: { verdict: 'unclear' },
  },
  {
    id: 'read-yes-french',
    text: 'oui, vas-y',
    offer: { ...READ_OFFER, terms: READ_TERMS },
    expect: { verdict: 'approve', maxPriceCents: 8488 },
  },
  {
    id: 'read-prerequisite-met',
    text: 'yes, she finished Level 1 last spring',
    offer: {
      ...READ_OFFER,
      terms: {
        ...READ_TERMS,
        prerequisiteRequired: true,
        prerequisiteQuote: 'Must have completed Level 1.',
      },
    },
    expect: { verdict: 'approve', prerequisiteMet: true },
  },
  {
    id: 'read-prerequisite-silent',
    text: 'yes',
    offer: {
      ...READ_OFFER,
      terms: {
        ...READ_TERMS,
        prerequisiteRequired: true,
        prerequisiteQuote: 'Must have completed Level 1.',
      },
    },
    expect: { verdict: 'approve', prerequisiteMet: null },
  },
  {
    id: 'read-prerequisite-asked-yes',
    text: 'yes',
    offer: {
      ...READ_OFFER,
      terms: {
        ...READ_TERMS,
        prerequisiteRequired: true,
        prerequisiteQuote: 'Must have completed Level 1.',
        prerequisiteAsked: true,
      },
    },
    expect: { verdict: 'approve', prerequisiteMet: true },
  },
  {
    id: 'read-prerequisite-asked-no',
    text: "no she hasn't done it",
    offer: {
      ...READ_OFFER,
      terms: {
        ...READ_TERMS,
        prerequisiteRequired: true,
        prerequisiteQuote: 'Must have completed Level 1.',
        prerequisiteAsked: true,
      },
    },
    expect: { verdict: 'take_back' },
  },
  {
    id: 'read-limit-french-comma',
    text: 'oui, pas plus de 90,50 $',
    offer: { ...READ_OFFER, terms: READ_TERMS },
    expect: { verdict: 'unclear' },
  },
  {
    id: 'read-limit-bare-number',
    text: 'yes but no more than 60',
    offer: { ...READ_OFFER, terms: READ_TERMS },
    expect: { verdict: 'unclear' },
  },
  {
    id: 'read-past-price-asks',
    text: 'yes please, last year it was $40 so this is fine',
    offer: { ...READ_OFFER, terms: READ_TERMS },
    expect: { verdict: 'unclear' },
  },
  {
    id: 'read-credit-asks',
    text: 'yes go ahead, we got a $20 credit from them',
    offer: { ...READ_OFFER, terms: READ_TERMS },
    expect: { verdict: 'unclear' },
  },
  {
    id: 'read-limit-beside-a-level',
    text: 'yes for level 3, 100 dollars max',
    offer: { ...READ_OFFER, terms: READ_TERMS },
    expect: { verdict: 'unclear' },
  },
  {
    id: 'read-price-echoed',
    text: 'yes, $84.88 is fine',
    offer: { ...READ_OFFER, terms: READ_TERMS },
    expect: { verdict: 'unclear' },
  },
  {
    id: 'read-level-is-no-condition',
    text: 'yes, she just finished level 3',
    offer: { ...READ_OFFER, terms: READ_TERMS },
    expect: { verdict: 'approve', maxPriceCents: 8488 },
  },
  {
    id: 'read-unpriced-money',
    text: 'yes, up to $150',
    offer: {
      ...READ_OFFER,
      terms: { ...READ_TERMS, sessionPrices: [{ sessionId: 's-1', cents: [] }] },
    },
    expect: { verdict: 'approve', maxPriceCents: 0 },
  },
  {
    id: 'read-unpriced-yes',
    text: 'yes please',
    offer: {
      ...READ_OFFER,
      terms: { ...READ_TERMS, sessionPrices: [{ sessionId: 's-1', cents: [] }] },
    },
    expect: { verdict: 'approve', maxPriceCents: 0 },
  },
  {
    id: 'read-free',
    text: 'yes sign her up',
    offer: {
      ...READ_OFFER,
      terms: {
        ...READ_TERMS,
        sessionPrices: [{ sessionId: 's-1', cents: [0] }],
        freeSessionIds: ['s-1'],
      },
    },
    expect: { verdict: 'approve', maxPriceCents: 0 },
  },
];

const PAGE =
  'Pottery for kids. Ages 5 to 8. Fee: $120.00 plus tax. Must have completed Pottery 1. Withdrawals up to 7 days before the first class are refunded less a $10.00 fee.';

export const SIGNUP_TERMS_PREFLIGHT_FIXTURES = [
  {
    id: 'preflight-all',
    page: PAGE,
    expect: {
      refund: 'Withdrawals up to 7 days before the first class are refunded less a $10.00 fee.',
      prerequisite: 'yes',
      rates: [{ rate: 'flat', cents: 12000 }],
      tax: 'plus_tax',
    },
  },
  {
    id: 'preflight-silent',
    page: 'Pottery for kids. Ages 5 to 8. Saturdays at 10.',
    expect: { refund: null, prerequisite: 'unknown', rates: [], tax: 'unknown' },
  },
];

export const SIGNUP_TERMS_DOB_FIXTURES = [
  { id: 'dob-full', text: 'She was born March 21, 2022', expect: '2022-03-21' },
  { id: 'dob-iso', text: '2021-11-05', expect: '2021-11-05' },
  { id: 'dob-age-only', text: 'she is about four', expect: null },
  { id: 'dob-no-year', text: 'her birthday is March 21', expect: null },
  { id: 'dob-sibling', text: 'her brother was born March 21, 2019', expect: null },
  {
    id: 'dob-named-with-sibling',
    text: 'Ada was born March 21, 2022 and her brother Leo on June 2, 2019',
    expect: '2022-03-21',
  },
];
