import {
  type Attribution,
  analyticsDistinctId,
  checkoutPersonId,
  parseAttribution,
} from '@hale/types';
import type { ConsentChoice } from '~/lib/site/consent';
import { siteCheckoutAnalyticsEnabled } from './checkout-analytics';
import { type CapturedEvent, buildEvent } from './events';

/**
 * Server capture for the marketing site. posthog-js is not loaded here.
 * Consent stays dark unless FUNNEL_ATTRIBUTION_ENABLED is exactly `true`.
 * Checkout emits when that flag is on or when this site's web analytics flag
 * is already on (siteCheckoutAnalyticsEnabled). The product key is
 * NEXT_PUBLIC_POSTHOG_KEY; POSTHOG_PROJECT_API_KEY is the fallback only when
 * the product key is unset. A missing key is logged once and named
 * `not_configured` (rule #11). The redirect awaits the capture response,
 * including its body, before it returns. The banner does not wait on a
 * thrown client.
 */

export type SiteCaptureOutcome =
  | 'sent'
  | 'flag_off'
  | 'not_configured'
  | 'provider_error'
  | 'refused';

/** Not a visitor. Every consent_choice shares it so the count has no person profile. */
export const CONSENT_DISTINCT_ID = 'consent';

const DEFAULT_HOST = 'https://us.i.posthog.com';

let absenceLogged = false;
let checkoutOffLogged = false;

type Env = Record<string, string | undefined>;

export function resetSiteCaptureAbsenceForTests(): void {
  absenceLogged = false;
  checkoutOffLogged = false;
}

function funnelOn(env: Env): boolean {
  return env.FUNNEL_ATTRIBUTION_ENABLED === 'true';
}

function productKey(env: Env): string | null {
  const product = env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  if (product) return product;
  const project = env.POSTHOG_PROJECT_API_KEY?.trim();
  return project ? project : null;
}

function hostOf(env: Env): string {
  return (env.POSTHOG_HOST || env.NEXT_PUBLIC_POSTHOG_HOST || DEFAULT_HOST).replace(/\/$/, '');
}

function isCaptureDistinctId(value: string): boolean {
  if (value === CONSENT_DISTINCT_ID) return true;
  return value.length > 0 && value.length <= 200 && !/[\s@]|:\/\//.test(value);
}

export async function captureSiteEvent(input: {
  event: CapturedEvent;
  distinctId: string;
  properties?: Record<string, unknown>;
  personProfile?: boolean;
  env?: Env;
  fetchImpl?: typeof fetch;
}): Promise<SiteCaptureOutcome> {
  const env = input.env ?? process.env;
  if (!funnelOn(env)) return 'flag_off';
  return deliverSiteEvent(input);
}

async function deliverSiteEvent(input: {
  event: CapturedEvent;
  distinctId: string;
  properties?: Record<string, unknown>;
  personProfile?: boolean;
  env?: Env;
  fetchImpl?: typeof fetch;
}): Promise<SiteCaptureOutcome> {
  const env = input.env ?? process.env;
  const key = productKey(env);
  if (!key) {
    if (!absenceLogged) {
      absenceLogged = true;
      console.info('analytics: site capture skipped', { reason: 'not_configured' });
    }
    return 'not_configured';
  }
  if (!isCaptureDistinctId(input.distinctId)) return 'refused';
  const safe = buildEvent(input.event, input.properties ?? {}).properties;
  const properties: Record<string, unknown> = { ...safe, $geoip_disable: true };
  if (input.personProfile === false) properties.$process_person_profile = false;
  return postCapture(
    {
      api_key: key,
      event: input.event,
      distinct_id: input.distinctId,
      properties,
    },
    env,
    input.fetchImpl ?? fetch,
    input.event,
  );
}

/**
 * Links the current person (`distinctId`) to the id to use from here on
 * (`alias`). Same order as posthog-js `alias(alias, original)`.
 */
export async function aliasSitePerson(input: {
  distinctId: string;
  alias: string;
  /** Checkout aliases while site checkout analytics is on, not only the funnel flag. */
  purpose?: 'funnel' | 'checkout';
  env?: Env;
  fetchImpl?: typeof fetch;
}): Promise<SiteCaptureOutcome> {
  const env = input.env ?? process.env;
  const allowed = input.purpose === 'checkout' ? siteCheckoutAnalyticsEnabled(env) : funnelOn(env);
  if (!allowed) return 'flag_off';
  if (
    !input.distinctId ||
    !input.alias ||
    input.distinctId === input.alias ||
    !isCaptureDistinctId(input.distinctId) ||
    !isCaptureDistinctId(input.alias)
  ) {
    return 'refused';
  }
  const key = productKey(env);
  if (!key) return 'not_configured';
  return postCapture(
    {
      api_key: key,
      event: '$create_alias',
      distinct_id: input.distinctId,
      properties: {
        distinct_id: input.distinctId,
        alias: input.alias,
        $geoip_disable: true,
      },
    },
    env,
    input.fetchImpl ?? fetch,
    '$create_alias',
  );
}

export async function captureSiteCheckoutStarted(input: {
  sessionId: string;
  /** Billing tier: plus or family. */
  tier: string;
  /** Parent-facing plan: plus or max. */
  plan: string;
  sku: string;
  /** annual or monthly. */
  interval: string;
  currency: string;
  /** CA or US, matching the charged currency. */
  region: string;
  /** Major units. Omitted when Stripe did not return an amount. */
  amount?: number | null;
  attribution?: Attribution;
  analyticsDistinctId?: string | null;
  env?: Env;
  fetchImpl?: typeof fetch;
}): Promise<SiteCaptureOutcome> {
  const env = input.env ?? process.env;
  if (!siteCheckoutAnalyticsEnabled(env)) {
    if (!checkoutOffLogged) {
      checkoutOffLogged = true;
      console.info('analytics: checkout_started skipped', { reason: 'flag_off' });
    }
    return 'flag_off';
  }
  const person = checkoutPersonId(input.sessionId);
  if (!person) {
    console.info('analytics: checkout_started skipped', { reason: 'invalid_session' });
    return 'refused';
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const browser = analyticsDistinctId(input.analyticsDistinctId);
  if (browser) {
    await aliasSitePerson({
      distinctId: browser,
      alias: person,
      purpose: 'checkout',
      env,
      fetchImpl,
    });
  }
  const properties: Record<string, unknown> = {
    plan: input.plan,
    tier: input.tier,
    sku: input.sku,
    interval: input.interval,
    currency: input.currency,
    region: input.region,
    ...parseAttribution(input.attribution),
  };
  if (typeof input.amount === 'number' && Number.isFinite(input.amount) && input.amount >= 0) {
    properties.amount = input.amount;
    properties.value = input.amount;
  }
  return deliverSiteEvent({
    event: 'checkout_started',
    distinctId: person,
    properties,
    env,
    fetchImpl,
  });
}

export async function captureConsentChoice(
  choice: ConsentChoice,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<SiteCaptureOutcome> {
  return captureSiteEvent({
    event: 'consent_choice',
    distinctId: CONSENT_DISTINCT_ID,
    properties: { choice },
    personProfile: false,
    env,
    fetchImpl,
  });
}

async function postCapture(
  body: Record<string, unknown>,
  env: Env,
  fetchImpl: typeof fetch,
  event: string,
): Promise<SiteCaptureOutcome> {
  try {
    const res = await fetchImpl(`${hostOf(env)}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4_000),
    });
    if (!res.ok) {
      await res.text().catch(() => undefined);
      console.warn('analytics: site capture provider_error', { event, status: res.status });
      return 'provider_error';
    }
    // Read the body before the caller redirects. A 303 that returns while this
    // socket is still open is the drop serverless runtimes are known for.
    await res.text().catch(() => undefined);
    return 'sent';
  } catch (err) {
    console.warn('analytics: site capture provider_error', {
      event,
      name: err instanceof Error ? err.name : 'unknown',
    });
    return 'provider_error';
  }
}
