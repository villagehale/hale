import { describe, expect, it } from 'vitest';
import { buildEvent } from './events';

/**
 * Nothing a visitor types may reach product analytics (hard rule #1). `buildEvent`
 * is the gate: it keeps the event name and coarse primitives while dropping any
 * identifying or non-primitive property. Expected values are derived from that
 * requirement.
 */

describe('site buildEvent privacy gate', () => {
  it('never lets an email or name through', () => {
    const built = buildEvent('landing_cta_signin', {
      email: 'sam@example.com',
      name: 'Sam',
      referrer: 'twitter',
    });
    expect(built.properties).toEqual({ referrer: 'twitter' });
    expect(JSON.stringify(built)).not.toContain('sam@example.com');
  });

  it('fires the landing CTA funnel events with no properties', () => {
    expect(buildEvent('landing_cta_preview')).toEqual({
      event: 'landing_cta_preview',
      properties: {},
    });
    expect(buildEvent('landing_cta_signin')).toEqual({
      event: 'landing_cta_signin',
      properties: {},
    });
  });

  it('fires the text CTA, the only conversion the site has, with its placement', () => {
    expect(buildEvent('cta_text_click', { cta_placement: 'hero' })).toEqual({
      event: 'cta_text_click',
      properties: { cta_placement: 'hero' },
    });
  });

  it('never lets the phone number ride along on the text CTA', () => {
    // The CTA's own href is an sms: deep link, so the number is the one identifying
    // value sitting closest to this capture.
    expect(buildEvent('cta_text_click', { phone: '+16475551234' }).properties).toEqual({});
  });
});
