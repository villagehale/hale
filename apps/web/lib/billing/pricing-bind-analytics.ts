import type { Attribution } from '@hale/types';
import { checkoutPersonId } from '@hale/types';
import { aliasCheckoutPerson, captureCheckoutEvent } from '~/lib/analytics/checkout-capture';
import { type FunnelCapture, type FunnelSender, captureFunnelEvent } from '~/lib/analytics/funnel';
import { funnelAttributionEnabled } from '~/lib/analytics/funnel-flag';
import { type CaptureOutcome, hashFamilyId } from '~/lib/analytics/server-capture';

/**
 * After a /pricing code verifies. Links the checkout person, and the consented
 * browser id when one was stored, to the hashed family id (`alias` is that
 * family id). Records signup_completed when this bind created the family.
 * Dark unless FUNNEL_ATTRIBUTION_ENABLED is exactly true. A failure here must
 * not undo the bind.
 */

export type PricingBindInput = {
  sessionId: string;
  familyId: string;
  tier: 'plus' | 'family';
  attribution: Attribution;
  analyticsDistinctId: string | null;
  signup: boolean;
  now: Date;
};

const checkoutFunnelSender: FunnelSender = {
  send: (capture: FunnelCapture): Promise<CaptureOutcome> =>
    captureCheckoutEvent(capture.event, capture.distinctId, capture.properties, {
      ...(capture.set ? { set: capture.set } : {}),
      ...(capture.setOnce ? { setOnce: capture.setOnce } : {}),
    }),
};

export async function recordPricingBindAnalytics(
  input: PricingBindInput,
  deps: {
    env?: Record<string, string | undefined>;
    alias?: (distinctId: string, alias: string) => Promise<void>;
    sender?: FunnelSender;
  } = {},
): Promise<void> {
  const env = deps.env ?? process.env;
  if (!funnelAttributionEnabled(env)) return;
  const familyDistinctId = hashFamilyId(input.familyId);
  const alias = deps.alias ?? aliasCheckoutPerson;
  const checkoutId = checkoutPersonId(input.sessionId);
  if (checkoutId) await safeAlias(alias, checkoutId, familyDistinctId);
  if (input.analyticsDistinctId)
    await safeAlias(alias, input.analyticsDistinctId, familyDistinctId);
  if (!input.signup) return;
  await captureFunnelEvent(
    {
      event: 'signup_completed',
      familyId: input.familyId,
      attribution: input.attribution,
      properties: { surface: 'pricing', plan: input.tier },
      setOnce: { signup_date: input.now.toISOString().slice(0, 10) },
    },
    { sender: deps.sender ?? checkoutFunnelSender, env },
  );
}

async function safeAlias(
  alias: (distinctId: string, alias: string) => Promise<void>,
  distinctId: string,
  futureId: string,
): Promise<void> {
  try {
    await alias(distinctId, futureId);
  } catch (err) {
    console.warn('analytics: checkout alias failed', {
      name: err instanceof Error ? err.name : 'unknown',
    });
  }
}
