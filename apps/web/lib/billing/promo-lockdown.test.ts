import { describe, expect, it } from 'vitest';
import {
  type PromoLockdownApi,
  type PromoLockdownLink,
  type PromoLockdownSession,
  runPromoLockdown,
  sessionNeedsExpiry,
} from './promo-lockdown';

const FOUNDING = new Set(['price_founding_cad', 'price_founding_usd']);

function fakeApi(seed: {
  links?: PromoLockdownLink[];
  sessions?: PromoLockdownSession[];
}): {
  api: PromoLockdownApi;
  deactivated: string[];
  expired: string[];
} {
  const deactivated: string[] = [];
  const expired: string[] = [];
  return {
    deactivated,
    expired,
    api: {
      async listActivePaymentLinks() {
        return seed.links ?? [];
      },
      async listOpenCheckoutSessions() {
        return seed.sessions ?? [];
      },
      async deactivatePaymentLink(id) {
        deactivated.push(id);
      },
      async expireCheckoutSession(id) {
        expired.push(id);
      },
    },
  };
}

describe('sessionNeedsExpiry', () => {
  it('expires open sessions that are not founding, including ones with no visible price', () => {
    expect(sessionNeedsExpiry({ id: 'cs_1', priceIds: ['price_cad_mo'] }, FOUNDING)).toBe(true);
    expect(sessionNeedsExpiry({ id: 'cs_2', priceIds: [] }, FOUNDING)).toBe(true);
    expect(sessionNeedsExpiry({ id: 'cs_ok', priceIds: ['price_founding_cad'] }, FOUNDING)).toBe(
      false,
    );
  });
});

describe('runPromoLockdown', () => {
  it('dry-run lists active Payment Links and non-founding open sessions, and writes nothing', async () => {
    const { api, deactivated, expired } = fakeApi({
      links: [{ id: 'plink_1' }, { id: 'plink_2' }],
      sessions: [
        { id: 'cs_founding', priceIds: ['price_founding_usd'] },
        { id: 'cs_mo', priceIds: ['price_cad_mo'] },
        { id: 'cs_unknown', priceIds: [] },
      ],
    });

    const result = await runPromoLockdown({ api, foundingPriceIds: FOUNDING, apply: false });

    expect(result).toEqual({
      apply: false,
      paymentLinkCount: 2,
      sessionCount: 2,
      paymentLinks: [
        { id: 'plink_1', action: 'would_deactivate' },
        { id: 'plink_2', action: 'would_deactivate' },
      ],
      sessions: [
        { id: 'cs_mo', priceIds: ['price_cad_mo'], action: 'would_expire' },
        { id: 'cs_unknown', priceIds: [], action: 'would_expire' },
      ],
    });
    expect(deactivated).toEqual([]);
    expect(expired).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/sk_|rk_|whsec|Bearer/i);
  });

  it('apply deactivates those links and expires those sessions', async () => {
    const { api, deactivated, expired } = fakeApi({
      links: [{ id: 'plink_1' }],
      sessions: [
        { id: 'cs_founding', priceIds: ['price_founding_cad'] },
        { id: 'cs_mo', priceIds: ['price_usd_mo'] },
      ],
    });

    const result = await runPromoLockdown({ api, foundingPriceIds: FOUNDING, apply: true });

    expect(result.paymentLinks).toEqual([{ id: 'plink_1', action: 'deactivate' }]);
    expect(result.sessions).toEqual([
      { id: 'cs_mo', priceIds: ['price_usd_mo'], action: 'expire' },
    ]);
    expect(deactivated).toEqual(['plink_1']);
    expect(expired).toEqual(['cs_mo']);
  });
});
