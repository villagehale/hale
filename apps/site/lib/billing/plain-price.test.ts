import { describe, expect, it } from 'vitest';
import {
  PAID_PLANS_LINE,
  TEXTING_COST_ANSWER,
  maxAnnualLabel,
  orAnnualLabel,
  paidPlansCostAnswer,
  plusCloseSentence,
  plusMonthlyLabel,
  plusPriceSentence,
  plusPriceStartSentence,
} from './plain-price';

const CURRENCY_LABEL = /\b(CAD|USD|C\$|US\$)\b/;

describe('plain list price copy', () => {
  it('uses the visitor row and a plain dollar sign', () => {
    expect(plusMonthlyLabel('CAD')).toBe('$19/mo');
    expect(orAnnualLabel('CAD')).toBe('or $159/yr');
    expect(maxAnnualLabel('CAD')).toBe('$329/yr');
    expect(plusMonthlyLabel('USD')).toBe('$14/mo');
    expect(orAnnualLabel('USD')).toBe('or $119/yr');
    expect(maxAnnualLabel('USD')).toBe('$259/yr');
  });

  it('states Plus and Max, and the refund line, without a currency name', () => {
    expect(PAID_PLANS_LINE).toContain('Paid plans are Plus and Max.');
    expect(PAID_PLANS_LINE).toContain('Full refund anytime if it’s not for you.');
    expect(TEXTING_COST_ANSWER).toBe(PAID_PLANS_LINE);
    expect(plusPriceSentence('USD')).toBe('Plus is $14/mo or $119/yr.');
    expect(plusPriceStartSentence('CAD')).toBe('Plus is $19/mo or $159/yr. Text Hale to start.');
    expect(plusCloseSentence('USD')).toBe(
      'Plus is $14/mo or $119/yr. Full refund anytime if it’s not for you.',
    );
    expect(paidPlansCostAnswer('CAD')).toBe(
      'Plus is $19/mo or $159/yr, and Max is $329/yr. Full refund anytime if it’s not for you.',
    );
    expect(paidPlansCostAnswer('USD')).toBe(
      'Plus is $14/mo or $119/yr, and Max is $259/yr. Full refund anytime if it’s not for you.',
    );
    expect(paidPlansCostAnswer('CAD')).not.toContain('Paid plans are Plus and Max.');
    for (const line of [
      PAID_PLANS_LINE,
      TEXTING_COST_ANSWER,
      plusPriceSentence('CAD'),
      plusPriceSentence('USD'),
      paidPlansCostAnswer('CAD'),
      paidPlansCostAnswer('USD'),
    ]) {
      expect(line).not.toMatch(CURRENCY_LABEL);
      expect(line).not.toMatch(/was |save |% off|until paid plans/i);
    }
  });
});
