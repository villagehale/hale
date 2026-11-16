import { describe, expect, it } from 'vitest';
import {
  type PromoLockdownApi,
  type PromoLockdownLink,
  type PromoLockdownPrice,
  type PromoLockdownSession,
  priceNeedsArchive,
  runPromoLockdown,
  sessionNeedsExpiry,
} from './promo-lockdown';

const KEEP = new Set(['price_plus_cad', 'price_plus_usd', 'price_max_cad', 'price_max_usd']);

function fakeApi(seed: {
  links?: PromoLockdownLink[];
  sessions?: PromoLockdownSession[];
  prices?: PromoLockdownPrice[];
}): {
  api: PromoLockdownApi;
  deactivated: string[];
  expired: string[];
  archived: string[];
} {
  const deactivated: string[] = [];
  const expired: string[] = [];
  const archived: string[] = [];
  return {
    deactivated,
    expired,
    archived,
    api: {
      async listActivePaymentLinks() {
        return seed.links ?? [];
      },
      async listOpenCheckoutSessions() {
        return seed.sessions ?? [];
      },
      async listActivePrices() {
        return seed.prices ?? [];
      },
      async deactivatePaymentLink(id) {
        deactivated.push(id);
      },
      async expireCheckoutSession(id) {
        expired.push(id);
      },
      async archivePrice(id) {
        archived.push(id);
      },
    },
  };
}

describe('sessionNeedsExpiry', () => {
  it('expires open sessions that are not promo, including leftover founding', () => {
    expect(sessionNeedsExpiry({ id: 'cs_1', priceIds: ['price_cad_mo'] }, KEEP)).toBe(true);
    expect(sessionNeedsExpiry({ id: 'cs_2', priceIds: [] }, KEEP)).toBe(true);
    expect(sessionNeedsExpiry({ id: 'cs_ok', priceIds: ['price_plus_cad'] }, KEEP)).toBe(false);
    expect(sessionNeedsExpiry({ id: 'cs_old', priceIds: ['price_founding_cad'] }, KEEP)).toBe(true);
  });
});

describe('priceNeedsArchive', () => {
  it('archives leftover founding ids and founding-2026 metadata, never promo ids', () => {
    expect(
      priceNeedsArchive(
        { id: 'price_founding_cad', lookupKey: null, metadata: { promo: 'founding-2026' } },
        KEEP,
        new Set(),
      ),
    ).toBe(true);
    expect(
      priceNeedsArchive(
        {
          id: 'price_founding_usd',
          lookupKey: 'hale_founding_annual_usd',
          metadata: {},
        },
        KEEP,
        new Set(),
      ),
    ).toBe(true);
    expect(
      priceNeedsArchive(
        { id: 'price_env_old', lookupKey: null, metadata: {} },
        KEEP,
        new Set(['price_env_old']),
      ),
    ).toBe(true);
    expect(
      priceNeedsArchive(
        { id: 'price_plus_cad', lookupKey: null, metadata: { promo: 'founding-2026' } },
        KEEP,
        new Set(['price_plus_cad']),
      ),
    ).toBe(false);
    expect(
      priceNeedsArchive(
        { id: 'price_max_cad', lookupKey: null, metadata: { promo: 'holiday-2026' } },
        KEEP,
        new Set(),
      ),
    ).toBe(false);
  });
});

describe('runPromoLockdown', () => {
  it('dry-run lists links, non-promo sessions, and leftover founding prices', async () => {
    const { api, deactivated, expired, archived } = fakeApi({
      links: [{ id: 'plink_1' }, { id: 'plink_2' }],
      sessions: [
        { id: 'cs_promo', priceIds: ['price_plus_usd'] },
        { id: 'cs_mo', priceIds: ['price_cad_mo'] },
        { id: 'cs_old', priceIds: ['price_founding_cad'] },
      ],
      prices: [
        { id: 'price_plus_cad', lookupKey: null, metadata: { promo: 'holiday-2026' } },
        {
          id: 'price_founding_cad',
          lookupKey: null,
          metadata: { promo: 'founding-2026' },
        },
      ],
    });

    const result = await runPromoLockdown({
      api,
      foundingPriceIds: KEEP,
      leftoverFoundingPriceIds: new Set(['price_founding_cad']),
      apply: false,
    });

    expect(result).toEqual({
      apply: false,
      paymentLinkCount: 2,
      sessionCount: 2,
      priceCount: 1,
      paymentLinks: [
        { id: 'plink_1', action: 'would_deactivate' },
        { id: 'plink_2', action: 'would_deactivate' },
      ],
      sessions: [
        { id: 'cs_mo', priceIds: ['price_cad_mo'], action: 'would_expire' },
        { id: 'cs_old', priceIds: ['price_founding_cad'], action: 'would_expire' },
      ],
      prices: [{ id: 'price_founding_cad', action: 'would_archive' }],
    });
    expect(deactivated).toEqual([]);
    expect(expired).toEqual([]);
    expect(archived).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/sk_|rk_|whsec|Bearer/i);
  });

  it('apply deactivates links, expires stale sessions, and archives leftover founding prices', async () => {
    const { api, deactivated, expired, archived } = fakeApi({
      links: [{ id: 'plink_1' }],
      sessions: [
        { id: 'cs_promo', priceIds: ['price_plus_cad'] },
        { id: 'cs_mo', priceIds: ['price_usd_mo'] },
      ],
      prices: [
        {
          id: 'price_founding_usd',
          lookupKey: 'hale_founding_annual_usd',
          metadata: {},
        },
      ],
    });

    const result = await runPromoLockdown({ api, foundingPriceIds: KEEP, apply: true });

    expect(result.paymentLinks).toEqual([{ id: 'plink_1', action: 'deactivate' }]);
    expect(result.sessions).toEqual([
      { id: 'cs_mo', priceIds: ['price_usd_mo'], action: 'expire' },
    ]);
    expect(result.prices).toEqual([{ id: 'price_founding_usd', action: 'archive' }]);
    expect(deactivated).toEqual(['plink_1']);
    expect(expired).toEqual(['cs_mo']);
    expect(archived).toEqual(['price_founding_usd']);
  });
});
