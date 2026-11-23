// VIL-735 billing-notice fixtures. Invented amounts and dates only.

const THROUGH = { date: 'November 21, 2027', year: 2027, month: 11, day: 21 };
const FULL = { refundedMinor: 15900, chargeMinor: 15900 };
const PART = { refundedMinor: 5000, chargeMinor: 15900 };

const dollars = (minor) => `$${(minor / 100).toFixed(2)}`;

/** The writer's facts and the send gate's facts, from one description, so they cannot drift. */
function pair({
  happened = 'plan_change',
  language = 'en',
  plan,
  previousPlan = null,
  ended = null,
  refunds = [],
  paidThrough = null,
  renews = true,
}) {
  return {
    facts: {
      happened,
      language,
      plan,
      previousPlan,
      ended: ended ? { why: ended } : null,
      refunds: refunds.map((refund) => ({
        amount: dollars(refund.refundedMinor),
        of: dollars(refund.chargeMinor),
        full: refund.refundedMinor === refund.chargeMinor,
      })),
      paidThrough: paidThrough ? { date: paidThrough.date, renews } : null,
    },
    claimFacts: { language, plan, previousPlan, ended: Boolean(ended), refunds, paidThrough },
  };
}

const paid = (language, plan) =>
  pair({
    happened: 'payment',
    language,
    plan,
    previousPlan: 'Free',
    paidThrough: THROUGH,
  });
const cancelled = (language) =>
  pair({ language, plan: 'Free', previousPlan: 'Plus', ended: 'cancelled' });
const refundAndCancel = (language) =>
  pair({ language, plan: 'Free', previousPlan: 'Plus', ended: 'cancelled', refunds: [FULL] });
const refundKept = (language) =>
  pair({ language, plan: 'Plus', refunds: [FULL], paidThrough: THROUGH });
const partial = (language) =>
  pair({ language, plan: 'Plus', refunds: [PART], paidThrough: THROUGH });

/** What the real writer is asked to write. Scored by the judge once recorded. */
export const BILLING_NOTICE_WRITER_CASES = [
  { id: 'payment-plus-en', ...paid('en', 'Plus') },
  { id: 'payment-plus-fr', ...paid('fr', 'Plus') },
  { id: 'payment-plus-zh', ...paid('zh', 'Plus') },
  { id: 'payment-max-en', ...paid('en', 'Max') },
  { id: 'payment-max-fr', ...paid('fr', 'Max') },
  { id: 'cancel-en', ...cancelled('en') },
  { id: 'cancel-fr', ...cancelled('fr') },
  { id: 'cancel-zh', ...cancelled('zh') },
  { id: 'refund-and-cancel-en', ...refundAndCancel('en') },
  { id: 'refund-and-cancel-fr', ...refundAndCancel('fr') },
  { id: 'refund-tier-kept-en', ...refundKept('en') },
  { id: 'refund-tier-kept-zh', ...refundKept('zh') },
  { id: 'partial-refund-en', ...partial('en') },
  { id: 'partial-refund-fr', ...partial('fr') },
  { id: 'refund-no-date-en', ...pair({ plan: 'Plus', refunds: [FULL] }) },
  {
    id: 'failed-payment-end-en',
    ...pair({ plan: 'Free', previousPlan: 'Plus', ended: 'payment_failed' }),
  },
];

/**
 * False texts that must be refused, each by the layer it names. `code_floor` and
 * `regex_floor` run for real at $0 on every replay; `check` and `reader` need a recording.
 * `control` is the true sentence on the same facts, which the same layer must let through.
 */
export const BILLING_NOTICE_PLANTED = [
  {
    id: 'wrong-plan',
    layer: 'code_floor',
    text: "You're on Max now.",
    control: "You're on Plus now.",
    ...paid('en', 'Plus'),
  },
  {
    id: 'wrong-amount',
    layer: 'code_floor',
    text: '$99.00 went back to your card.',
    control: '$159.00 went back to your card.',
    ...refundKept('en'),
  },
  {
    id: 'promise',
    layer: 'regex_floor',
    text: "I'll stop sending the one-sec messages.",
    control: "You're on Plus now.",
    ...paid('en', 'Plus'),
  },
  {
    id: 'wrong-date-in-words',
    layer: 'check',
    text: "You're on Plus through the end of next October.",
    ...paid('en', 'Plus'),
  },
  {
    id: 'still-on-plus-after-cancel',
    layer: 'check',
    text: "You're still on Plus.",
    ...cancelled('en'),
  },
  {
    id: 'back-on-free-tier-unmoved',
    layer: 'check',
    text: "You're back on Free now.",
    ...refundKept('en'),
  },
  {
    id: 'cancel-that-never-happened',
    layer: 'check_and_reader',
    text: 'Your subscription was cancelled.',
    ...paid('en', 'Plus'),
  },
  {
    id: 'registration-claim',
    layer: 'check_and_reader',
    text: "You're on Plus and she's registered for Saturday swim.",
    ...paid('en', 'Plus'),
  },
];
