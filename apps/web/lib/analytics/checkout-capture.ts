import type { PostHog } from 'posthog-node';
import { hasLinkShape } from '~/lib/format/link-shape';
import { type AnalyticsEvent, buildEvent } from './events';
import { productClient, projectClient } from './posthog-node';

/**
 * PostHog for the /pricing checkout, which has no family yet.
 *
 * Product events stay on NEXT_PUBLIC_POSTHOG_KEY so they land in the same
 * project as the marketing site. POSTHOG_PROJECT_API_KEY is only the fallback
 * when that key is unset — it is the tracing project, and these events do not
 * go there while the product key exists. Callers gate on FUNNEL_ATTRIBUTION_ENABLED
 * before they get here, so a dark flag never constructs a client.
 */

export type CheckoutCaptureOutcome = 'sent' | 'not_configured' | 'provider_error';

let absenceLogged = false;

type AliasClient = {
  alias?: (data: { distinctId: string; alias: string }) => void;
  capture: (data: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }) => void;
  flush: () => Promise<unknown>;
};

export function checkoutAnalyticsClient(): PostHog | null {
  if (process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim()) return productClient();
  if (process.env.POSTHOG_PROJECT_API_KEY?.trim()) return projectClient();
  if (!absenceLogged) {
    absenceLogged = true;
    console.warn(
      'analytics: no PostHog key for checkout events — NEXT_PUBLIC_POSTHOG_KEY and POSTHOG_PROJECT_API_KEY are unset',
    );
  }
  return null;
}

export function resetCheckoutAnalyticsAbsenceForTests(): void {
  absenceLogged = false;
}

export async function captureCheckoutEvent(
  event: AnalyticsEvent,
  distinctId: string,
  properties: Record<string, unknown> = {},
  options: { set?: Record<string, unknown>; setOnce?: Record<string, unknown> } = {},
): Promise<CheckoutCaptureOutcome> {
  const client = checkoutAnalyticsClient();
  if (!client) return 'not_configured';
  const safe = buildEvent(event, properties).properties;
  const set = options.set ? buildEvent(event, options.set).properties : null;
  const setOnce = options.setOnce ? buildEvent(event, options.setOnce).properties : null;
  const stamped: Record<string, unknown> = { ...safe, $geoip_disable: true };
  if (set && Object.keys(set).length > 0) stamped.$set = set;
  if (setOnce && Object.keys(setOnce).length > 0) stamped.$set_once = setOnce;
  try {
    client.capture({ distinctId, event, properties: stamped });
    await client.flush();
    return 'sent';
  } catch (err) {
    console.warn('analytics: checkout event failed', {
      event,
      name: err instanceof Error ? err.name : 'unknown',
    });
    return 'provider_error';
  }
}

/**
 * Links `distinctId` (the id the events already used) to `alias` (the id to use
 * from here on). Same argument order as posthog-js `alias(alias, original)` and
 * posthog-node's example: distinctId is the current person, alias is the future id.
 */
export async function aliasCheckoutPerson(distinctId: string, alias: string): Promise<void> {
  if (!distinctId || !alias || distinctId === alias) return;
  if (!isAliasId(distinctId) || !isAliasId(alias)) {
    console.warn('analytics: checkout alias refused');
    return;
  }
  const client = checkoutAnalyticsClient();
  if (!client) return;
  const aliasing = client as unknown as AliasClient;
  if (typeof aliasing.alias === 'function') {
    aliasing.alias({ distinctId, alias });
  } else {
    aliasing.capture({
      distinctId,
      event: '$create_alias',
      properties: { distinct_id: distinctId, alias, $geoip_disable: true },
    });
  }
  await client.flush();
}

function isAliasId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 200 &&
    !/\s/.test(value) &&
    !value.includes('@') &&
    !hasLinkShape(value)
  );
}
