import { describe, expect, it } from 'vitest';
import { pricingCheckoutQuery } from './founding-checkout-link';

describe('pricingCheckoutQuery', () => {
  it('passes the validated card code and msclkid, and a consented distinct id', () => {
    const query = pricingCheckoutQuery({
      stored: 'utm_source=google&source_code=forged-code',
      search: '?msclkid=msclk&source_code=also-forged',
      sourceCode: 'poster-oakville',
      distinctId: '0123456789abcdef',
    });
    const params = new URLSearchParams(query);
    expect(params.get('utm_source')).toBe('google');
    expect(params.get('msclkid')).toBe('msclk');
    expect(params.get('source_code')).toBe('poster-oakville');
    expect(params.get('ph_distinct_id')).toBe('0123456789abcdef');
  });

  it('drops a forged card code, an email, and a checkout session id', () => {
    const query = pricingCheckoutQuery({
      stored: 'source_code=forged-code',
      search: '?source_code=also-forged',
      sourceCode: 'parent@example.com',
      distinctId: 'parent@example.com',
    });
    expect(query).toBe('');
    expect(
      pricingCheckoutQuery({
        stored: null,
        sourceCode: null,
        distinctId: 'cs_test_session_id',
      }),
    ).toBe('');
  });
});
