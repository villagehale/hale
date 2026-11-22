import { describe, expect, it } from 'vitest';
import { type BillingClaimFacts, billingTextConflict, namesCurrentPlan } from './billing-text';

/**
 * VIL-735 · the whole-text floor on a billing notice: a plan name the facts do not hold, or
 * a number they do not hold, cannot leave. It reads Hale's own sentence and can only refuse.
 */

const onPlus: BillingClaimFacts = {
  language: 'en',
  plan: 'Plus',
  previousPlan: 'Free',
  ended: false,
  refunds: [],
  paidThrough: { date: 'November 21, 2027', year: 2027, month: 11, day: 21 },
};

const refunded: BillingClaimFacts = {
  ...onPlus,
  previousPlan: null,
  refunds: [{ refundedMinor: 15900, chargeMinor: 15900 }],
};

describe('plan names', () => {
  it('passes the plan the facts name, and refuses one they do not', () => {
    expect(billingTextConflict("You're on Plus now.", onPlus)).toBeNull();
    expect(billingTextConflict("You're on Max now.", onPlus)).toBe('plan');
  });

  it('a previous plan may be named', () => {
    const moved = {
      ...onPlus,
      plan: 'Free' as const,
      previousPlan: 'Max' as const,
      paidThrough: null,
    };
    expect(billingTextConflict('Your Max plan ended and you are on Free.', moved)).toBeNull();
    expect(billingTextConflict('Your Plus plan ended.', moved)).toBe('plan');
  });

  it('a sentence-initial Plus is an ordinary word in English and French', () => {
    const onMax = { ...onPlus, plan: 'Max' as const, previousPlan: null };
    expect(billingTextConflict('Plus, your saved plans stay.', onMax)).toBeNull();
    expect(billingTextConflict('Plus de frais à venir.', { ...onMax, language: 'fr' })).toBeNull();
    // Positive control: the same word mid-sentence is the plan name.
    expect(billingTextConflict('You are on Plus now.', onMax)).toBe('plan');
  });

  it('reads a plan name inside Chinese text', () => {
    const zh = { ...onPlus, language: 'zh' };
    expect(billingTextConflict('你现在是Plus方案。', zh)).toBeNull();
    expect(billingTextConflict('你现在是Max方案。', zh)).toBe('plan');
  });

  it('never treats a lowercase max or plus as a plan', () => {
    expect(billingTextConflict('You can bring up to the max, plus a guest.', onPlus)).toBeNull();
  });
});

describe('numbers', () => {
  it.each([
    ['$159.00 back', refunded],
    ['$159 back', refunded],
    ['159,00 $ de retour', { ...refunded, language: 'fr' }],
    ['退款 $159.00，到2027年11月21日', { ...refunded, language: 'zh' }],
    ['Through November 21, 2027', onPlus],
    ['Through 2027-11-21', onPlus],
    ['Through 21.11.2027', onPlus],
    ['到２０２７年１１月２１日', { ...onPlus, language: 'zh' }],
  ])('passes %s', (text, facts) => {
    expect(billingTextConflict(text, facts)).toBeNull();
  });

  it.each([
    ['$99 back', refunded],
    ['$159.50 back', refunded],
    ['$1,299.00 back', refunded],
    ['Through November 22, 2027', onPlus],
    ['Through November 21, 2028', onPlus],
    ['$159.5 back', refunded],
    ['You saved 40%', onPlus],
    ['١٥٩', refunded],
  ])('refuses %s', (text, facts) => {
    expect(billingTextConflict(text, facts)).toBe('number');
  });

  it('with no date in the facts, any year is a conflict', () => {
    expect(billingTextConflict('Paid through 2027.', { ...onPlus, paidThrough: null })).toBe(
      'number',
    );
  });

  it('reads thousands in either convention', () => {
    const big = { ...onPlus, refunds: [{ refundedMinor: 129_900, chargeMinor: 129_900 }] };
    for (const text of ['$1,299.00 back', '1.299,00 $ back', '$1,299 back', '1 299,00 $']) {
      expect(billingTextConflict(text, big), text).toBeNull();
    }
  });

  it('a text with no number and no plan has no conflict', () => {
    expect(billingTextConflict('All set, thanks for sticking with us.', onPlus)).toBeNull();
  });
});

describe('namesCurrentPlan', () => {
  it.each([
    ["You're on Plus now.", 'Plus', 'en', true],
    ['Plus, your saved plans stay.', 'Plus', 'en', false],
    ["You're on Max.", 'Plus', 'en', false],
    ["You're on Max.", 'Max', 'en', true],
    ['Max is your plan.', 'Max', 'en', true],
    ['You are back on the free plan.', 'Free', 'en', true],
    ['You are on Free.', 'Free', 'en', true],
    ['Tu es maintenant sur la version gratuite.', 'Free', 'fr', true],
    ['Te voilà au forfait Gratuit.', 'Free', 'fr', true],
    ['你现在用的是免费版。', 'Free', 'zh', true],
    ["She's registered for Saturday swim.", 'Plus', 'en', false],
    ["She's registered for Saturday swim.", 'Free', 'en', false],
  ] as const)('%s / %s', (sentence, plan, locale, expected) => {
    expect(namesCurrentPlan(sentence, plan, locale)).toBe(expected);
  });
});
