import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlanCatalog } from '~/lib/plan/catalog';

// The mobile Plan-tiers route returns the plan catalog derived from the family's
// current tier (loadFamilyBasics). The catalog is pure @hale/types data — this route
// never touches the DB itself; the loader owns it. Read-only.
const authMock = vi.fn();
const loadFamilyBasicsMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/dashboard/queries', () => ({
  loadFamilyBasics: () => loadFamilyBasicsMock(),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile plan-tiers route must NOT touch the database');
    },
  };
});

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/plan-tiers/route');
  return GET();
}

describe('GET /api/mobile/plan-tiers', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadFamilyBasicsMock.mockReset();
    loadFamilyBasicsMock.mockResolvedValue({
      location: { country: null, province: null, city: null, postalCode: null },
      planTier: 'plus',
      intents: [],
      foundingNumber: null,
      children: [],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never calls the loader', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(loadFamilyBasicsMock).not.toHaveBeenCalled();
  });

  it('returns the plan catalog (dormant billing) for a signed-in parent', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    vi.stubEnv('STRIPE_SECRET_KEY', '');

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ catalog: buildPlanCatalog('plus', false) });
    expect(loadFamilyBasicsMock).toHaveBeenCalledTimes(1);
  });

  it('reports billingConfigured=true once Stripe checkout env is fully set', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    for (const [k, v] of Object.entries({
      STRIPE_SECRET_KEY: 'sk_test',
      STRIPE_PRICE_PLUS_MONTHLY: 'price_pm',
      STRIPE_PRICE_PLUS_ANNUAL: 'price_pa',
      STRIPE_PRICE_FAMILY_MONTHLY: 'price_fm',
      STRIPE_PRICE_FAMILY_ANNUAL: 'price_fa',
    })) {
      vi.stubEnv(k, v);
    }

    const res = await callGet();

    const body = (await res.json()) as { catalog: { billingConfigured: boolean } };
    expect(body.catalog.billingConfigured).toBe(true);
  });
});
