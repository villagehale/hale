import type { AdsCheckoutContext } from '~/lib/billing/ads-context';
import { metaPixelIdFromEnv } from './meta-pixel';

/**
 * Marketing-site Conversions API for InitiateCheckout and Lead.
 *
 * Purchase stays on the app webhook. This posts to the first pixel id only.
 * Email and phone are not on these events. A missing flag or token is named
 * and does not throw (rule #11). The checkout redirect does not wait on a throw.
 */

const META_GRAPH = 'https://graph.facebook.com/v21.0';

export type SiteMetaEventName = 'InitiateCheckout' | 'Lead';

export type SiteMetaCapiStatus =
  | 'sent'
  | 'flag_off'
  | 'not_configured'
  | 'refused'
  | 'provider_error';

const CHECKOUT_EVENT_ID = /^cs_[A-Za-z0-9_]+$/;
const LEAD_EVENT_ID = /^lead_[a-f0-9]{32}$/;

type Env = Record<string, string | undefined>;

let absenceLogged = false;

export function resetSiteMetaCapiAbsenceForTests(): void {
  absenceLogged = false;
}

export function adsCurrency(value: string | null | undefined): 'CAD' | 'USD' | null {
  const token = value?.trim().toUpperCase();
  if (token === 'CAD' || token === 'USD') return token;
  return null;
}

function eventIdOk(name: SiteMetaEventName, eventId: string): boolean {
  if (name === 'InitiateCheckout') return CHECKOUT_EVENT_ID.test(eventId);
  return LEAD_EVENT_ID.test(eventId);
}

export function metaCapiUserData(ads: AdsCheckoutContext | undefined): Record<string, string> {
  const userData: Record<string, string> = {};
  if (ads?.fbp) userData.fbp = ads.fbp;
  if (ads?.fbc) userData.fbc = ads.fbc;
  if (ads?.clientIp) userData.client_ip_address = ads.clientIp;
  if (ads?.clientUserAgent) userData.client_user_agent = ads.clientUserAgent;
  return userData;
}

export async function sendSiteMetaCapi(input: {
  eventName: SiteMetaEventName;
  eventId: string;
  value?: number;
  currency?: string | null;
  ads?: AdsCheckoutContext;
  env?: Env;
  fetchImpl?: typeof fetch;
}): Promise<SiteMetaCapiStatus> {
  const env = input.env ?? process.env;
  if (env.META_CAPI_ENABLED !== 'true') return 'flag_off';
  if (!eventIdOk(input.eventName, input.eventId)) return 'refused';
  const currency = input.currency == null ? null : adsCurrency(input.currency);
  if (input.eventName === 'InitiateCheckout') {
    if (!currency) return 'refused';
    if (typeof input.value !== 'number' || !Number.isFinite(input.value) || input.value < 0) {
      return 'refused';
    }
  }
  const pixelId = metaPixelIdFromEnv(env);
  const token = env.META_CAPI_ACCESS_TOKEN?.trim();
  if (!pixelId || !token) {
    if (!absenceLogged) {
      absenceLogged = true;
      console.info('analytics: meta capi skipped', { reason: 'not_configured' });
    }
    return 'not_configured';
  }
  const customData: Record<string, unknown> = {};
  if (currency) customData.currency = currency;
  if (typeof input.value === 'number' && Number.isFinite(input.value))
    customData.value = input.value;
  const body = {
    data: [
      {
        event_name: input.eventName,
        event_time: Math.floor(Date.now() / 1000),
        event_id: input.eventId,
        action_source: 'website',
        user_data: metaCapiUserData(input.ads),
        ...(Object.keys(customData).length > 0 ? { custom_data: customData } : {}),
      },
    ],
  };
  try {
    const res = await (input.fetchImpl ?? fetch)(
      `${META_GRAPH}/${pixelId}/events?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(4_000),
      },
    );
    if (!res.ok) {
      console.warn('analytics: meta capi provider_error', {
        event: input.eventName,
        status: res.status,
      });
      return 'provider_error';
    }
    return 'sent';
  } catch (err) {
    console.warn('analytics: meta capi provider_error', {
      event: input.eventName,
      name: err instanceof Error ? err.name : 'unknown',
    });
    return 'provider_error';
  }
}
