import type { Database } from '@hale/db';
import { parseAttribution, serializeAttribution } from '@hale/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeFunnelSender } from '~/lib/analytics/funnel.testkit';
import { hashFamilyId } from '~/lib/analytics/server-capture';
import { createFakeStripe } from '~/lib/testing/fake-stripe';
import { ATTRIBUTION_COOKIE, attributionFromRequest } from './attribution.js';
import { reportBillingPurchase } from './conversions.js';
import { stripeCheckoutClientFromEnv } from './stripe-client.js';

// The landing link's campaign reaches the paid checkout: the site's first-touch cookie
// is read by the checkout request, lands in the Stripe Checkout Session metadata, and
// comes back on the webhook's completed checkout as checkout_completed. Stripe is the
// repo's in-memory fake and PostHog is the fake funnel sender: no live call anywhere.

const resolveFamilyMock = vi.fn();
const ensureUserMock = vi.fn();
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
  requireUserIdForUser: (...a: unknown[]) => ensureUserMock(...a),
}));

import { createBillingCheckout } from './create-checkout.js';

const FLAG = 'FUNNEL_ATTRIBUTION_ENABLED';
const FAMILY = 'fam-funnel-7';
const LANDING =
  '?utm_source=google&utm_medium=cpc&utm_campaign=bf26&utm_term=kids+camps&utm_content=hero&gclid=Cj0KCQiA-landing';
const LANDING_ATTRIBUTION = {
  utm_source: 'google',
  utm_medium: 'cpc',
  utm_campaign: 'bf26',
  utm_term: 'kids camps',
  utm_content: 'hero',
  gclid: 'Cj0KCQiA-landing',
};

/** The cookie the marketing site writes after Accept (apps/site attributionCookie). */
function siteCookie(attribution: Record<string, string>): string {
  return `theme=dark; ${ATTRIBUTION_COOKIE}=${encodeURIComponent(serializeAttribution(attribution))}`;
}

function fakeDb(): Database {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            { planTier: 'free', stripeSubscriptionId: null, stripeCustomerId: null },
          ],
        }),
      }),
    }),
    insert: () => ({ values: async () => undefined }),
  } as unknown as Database;
}

function sessionMetadata(body: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body ?? '')) {
    const match = key.match(/^metadata\[([^\]]+)\]$/);
    if (match?.[1]) out[match[1]] = value;
  }
  return out;
}

async function checkoutFromLanding(
  cookieHeader: string | null,
  funnel = createFakeFunnelSender(),
  analyticsOptOut = false,
) {
  const stripe = createFakeStripe();
  stripe.intercept(
    (call) => call.method === 'POST' && call.path === '/v1/checkout/sessions',
    () => Response.json({ url: 'https://checkout.stripe.com/c/pay/cs_test_funnel' }),
  );
  const client = stripeCheckoutClientFromEnv({ STRIPE_SECRET_KEY: 'sk_test_fake' }, stripe.fetch);
  if (!client) throw new Error('fake stripe client not built');
  const attribution = attributionFromRequest({ cookieHeader, search: null, body: {} });
  const result = await createBillingCheckout({
    tier: 'plus',
    period: 'annual',
    priceId: 'price_plus_annual',
    sku: 'plus_annual',
    currency: 'CAD',
    attribution,
    externalAuthId: 'auth-funnel',
    customerEmail: null,
    database: fakeDb(),
    client,
    origin: 'https://app.example.com',
    marketingOrigin: 'https://www.example.com',
    funnel: funnel.sender,
    analyticsOptOut,
  });
  expect(result).toEqual({
    status: 'created',
    url: 'https://checkout.stripe.com/c/pay/cs_test_funnel',
  });
  const posts = stripe.calls.filter((call) => call.method === 'POST');
  expect(posts).toHaveLength(1);
  return { metadata: sessionMetadata(posts[0]?.body ?? null), funnel };
}

function completedCheckout(metadata: Record<string, string>) {
  return {
    id: 'evt_funnel_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_test_funnel',
        payment_status: 'paid',
        amount_total: 15900,
        currency: 'cad',
        customer_details: {
          email: 'parent@example.com',
          phone: '+1 555 010 0100',
          name: 'Sam Parent',
        },
        client_reference_id: FAMILY,
        metadata,
      },
    },
  };
}

beforeEach(() => {
  resolveFamilyMock.mockResolvedValue(FAMILY);
  ensureUserMock.mockResolvedValue('user-funnel');
  vi.stubEnv('CHECKOUT_SUCCESS_STATES_ENABLED', undefined);
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
  vi.stubEnv(FLAG, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('landing link → checkout session metadata', () => {
  it('carries the landing utm and gclid keys into the session metadata, and nothing else new', async () => {
    const baseline = await checkoutFromLanding(null);
    const landed = await checkoutFromLanding(siteCookie(parseAttribution(LANDING)));

    const added = Object.keys(landed.metadata).filter((key) => !(key in baseline.metadata));
    expect(added.sort()).toEqual(Object.keys(LANDING_ATTRIBUTION).sort());
    for (const [key, value] of Object.entries(LANDING_ATTRIBUTION)) {
      expect(landed.metadata[key]).toBe(value);
    }
    expect(Object.keys(baseline.metadata).sort()).toEqual(
      ['currency', 'familyId', 'priceId', 'sku', 'tier'].sort(),
    );
  });

  it('drops an attribution value that is personal data before it reaches Stripe', async () => {
    const { metadata } = await checkoutFromLanding(
      siteCookie({ utm_source: 'newsletter', utm_content: 'parent@example.com' }),
    );
    expect(metadata.utm_source).toBe('newsletter');
    expect(metadata).not.toHaveProperty('utm_content');
    expect(Object.values(metadata).join(' ')).not.toContain('@');
  });

  it('carries the card code only with the flag on', async () => {
    const cookie = siteCookie({ utm_source: 'poster', source_code: 'poster-oakville' });

    const off = await checkoutFromLanding(cookie);
    expect(off.metadata.utm_source).toBe('poster');
    expect(off.metadata).not.toHaveProperty('source_code');

    vi.stubEnv(FLAG, 'true');
    const on = await checkoutFromLanding(cookie);
    expect(on.metadata.source_code).toBe('poster-oakville');
  });
});

describe('checkout_started', () => {
  it('fires once per created session, on the hashed family id, with plan, period and attribution', async () => {
    vi.stubEnv(FLAG, 'true');
    const { funnel } = await checkoutFromLanding(siteCookie(parseAttribution(LANDING)));
    expect(funnel.sent).toEqual([
      {
        event: 'checkout_started',
        distinctId: hashFamilyId(FAMILY),
        properties: { plan: 'plus', period: 'annual', ...LANDING_ATTRIBUTION },
      },
    ]);
  });

  it('sends nothing with the flag off', async () => {
    const { funnel } = await checkoutFromLanding(siteCookie(parseAttribution(LANDING)));
    expect(funnel.sent).toEqual([]);
  });

  it('sends nothing when the request carries the analytics opt-out cookie', async () => {
    vi.stubEnv(FLAG, 'true');
    const { funnel, metadata } = await checkoutFromLanding(
      siteCookie(parseAttribution(LANDING)),
      createFakeFunnelSender(),
      true,
    );
    expect(funnel.sent).toEqual([]);
    expect(metadata.utm_campaign).toBe('bf26');
  });

  it('does not put a co-parent join tag in Stripe metadata or the event', async () => {
    vi.stubEnv(FLAG, 'true');
    const join = `join-${'ab'.repeat(16)}`;
    const { funnel, metadata } = await checkoutFromLanding(
      siteCookie({ utm_source: 'text', source_code: join }),
    );
    expect(metadata).not.toHaveProperty('source_code');
    expect(JSON.stringify(metadata)).not.toContain(join);
    expect(funnel.sent[0]?.properties).not.toHaveProperty('source_code');
    expect(JSON.stringify(funnel.sent)).not.toContain(join);
  });
});

describe('checkout_completed from the webhook', () => {
  it('captures the completed checkout once with the attribution keys, plan and period, and no contact details', async () => {
    vi.stubEnv(FLAG, 'true');
    const { metadata } = await checkoutFromLanding(siteCookie(parseAttribution(LANDING)));
    const funnel = createFakeFunnelSender();

    const report = await reportBillingPurchase(
      completedCheckout(metadata),
      { [FLAG]: 'true' },
      fetch,
      funnel.sender,
    );

    expect(report).toMatchObject({ funnel: 'sent' });
    expect(funnel.sent).toEqual([
      {
        event: 'checkout_completed',
        distinctId: hashFamilyId(FAMILY),
        properties: { plan: 'plus', period: 'annual', ...LANDING_ATTRIBUTION },
        set: { plan: 'plus' },
      },
    ]);
    const wire = JSON.stringify(funnel.sent);
    expect(wire).not.toContain('parent@example.com');
    expect(wire).not.toContain('555');
    expect(wire).not.toContain('Sam Parent');
  });

  it('captures nothing with the flag off', async () => {
    const { metadata } = await checkoutFromLanding(siteCookie(parseAttribution(LANDING)));
    const funnel = createFakeFunnelSender();
    const report = await reportBillingPurchase(
      completedCheckout(metadata),
      {},
      fetch,
      funnel.sender,
    );
    expect(report).toMatchObject({ funnel: 'flag_off' });
    expect(funnel.sent).toEqual([]);
  });
});
