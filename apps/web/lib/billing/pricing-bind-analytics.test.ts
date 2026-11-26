import { checkoutPersonId } from '@hale/types';
import { describe, expect, it } from 'vitest';
import { createFakeFunnelSender } from '~/lib/analytics/funnel.testkit';
import { hashFamilyId } from '~/lib/analytics/server-capture';
import { recordPricingBindAnalytics } from './pricing-bind-analytics';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-25T18:00:00.000Z');

describe('recordPricingBindAnalytics', () => {
  it('aliases the checkout person and the consented id onto the family, then records signup', async () => {
    const aliases: Array<[string, string]> = [];
    const funnel = createFakeFunnelSender();
    await recordPricingBindAnalytics(
      {
        sessionId: 'cs_test_bind',
        familyId: FAMILY,
        tier: 'plus',
        attribution: { utm_source: 'google', msclkid: 'msclk', source_code: 'poster-oakville' },
        analyticsDistinctId: '0123456789abcdef',
        signup: true,
        now: NOW,
      },
      {
        env: { FUNNEL_ATTRIBUTION_ENABLED: 'true' },
        alias: async (canonical, previous) => {
          aliases.push([canonical, previous]);
        },
        sender: funnel.sender,
      },
    );
    const family = hashFamilyId(FAMILY);
    const checkoutId = checkoutPersonId('cs_test_bind');
    expect(checkoutId).not.toContain('cs_test_bind');
    expect(aliases).toEqual([
      [checkoutId, family],
      ['0123456789abcdef', family],
    ]);
    expect(funnel.sent).toEqual([
      {
        event: 'signup_completed',
        distinctId: family,
        properties: {
          surface: 'pricing',
          plan: 'plus',
          utm_source: 'google',
          msclkid: 'msclk',
          source_code: 'poster-oakville',
        },
        setOnce: { signup_date: '2026-11-25' },
      },
    ]);
  });

  it('aliases an existing family and does not record a second signup', async () => {
    const funnel = createFakeFunnelSender();
    const aliases: string[] = [];
    await recordPricingBindAnalytics(
      {
        sessionId: 'cs_test_bind',
        familyId: FAMILY,
        tier: 'family',
        attribution: {},
        analyticsDistinctId: null,
        signup: false,
        now: NOW,
      },
      {
        env: { FUNNEL_ATTRIBUTION_ENABLED: 'true' },
        alias: async (distinctId) => {
          aliases.push(distinctId);
        },
        sender: funnel.sender,
      },
    );
    expect(aliases).toEqual([checkoutPersonId('cs_test_bind')]);
    expect(funnel.sent).toEqual([]);
  });

  it('does nothing while the funnel flag is off', async () => {
    const funnel = createFakeFunnelSender();
    const aliases: unknown[] = [];
    await recordPricingBindAnalytics(
      {
        sessionId: 'cs_test_bind',
        familyId: FAMILY,
        tier: 'plus',
        attribution: { source_code: 'poster-oakville' },
        analyticsDistinctId: '0123456789abcdef',
        signup: true,
        now: NOW,
      },
      {
        env: {},
        alias: async () => {
          aliases.push('called');
        },
        sender: funnel.sender,
      },
    );
    expect(aliases).toEqual([]);
    expect(funnel.sent).toEqual([]);
  });
});
