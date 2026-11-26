import { type Attribution, parseAttribution } from '@hale/types';
import { type AnalyticsEvent, type EventProperties, buildEvent } from './events';
import { funnelAttributionEnabled } from './funnel-flag';
import { type CaptureOutcome, captureServerEvent, hashFamilyId } from './server-capture';

/**
 * The server half of the web funnel: checkout_started, checkout_completed and the
 * attribution on signup_completed. Dark unless FUNNEL_ATTRIBUTION_ENABLED is exactly
 * `true` (env-only in @hale/flags).
 *
 * A family event is keyed on the hashed family id IdentifyUser uses. A checkout
 * that has no family yet passes `distinctId` (`cs:` plus the Checkout Session id)
 * and no family id. An event with an identifying property is refused whole,
 * not trimmed: the call sites below pass only plan, period and attribution, so a key
 * the privacy gate drops means a caller reached for something it must not send.
 *
 * The sender is injected so tests use a fake. The PostHog sender returns
 * 'not_configured' (logged once per process by captureServerEvent) when the key is unset.
 */

export type FunnelEvent = Extract<
  AnalyticsEvent,
  'checkout_started' | 'checkout_completed' | 'signup_completed'
>;

export interface FunnelCapture {
  readonly event: FunnelEvent;
  readonly distinctId: string;
  readonly properties: EventProperties;
  readonly set?: EventProperties;
  readonly setOnce?: EventProperties;
}

export interface FunnelSender {
  send(capture: FunnelCapture): Promise<CaptureOutcome>;
}

export const posthogFunnelSender: FunnelSender = {
  send: (capture) =>
    captureServerEvent(capture.event, capture.distinctId, capture.properties, {
      ...(capture.set ? { set: capture.set } : {}),
      ...(capture.setOnce ? { setOnce: capture.setOnce } : {}),
    }),
};

export type FunnelOutcome = CaptureOutcome | 'flag_off' | 'refused_identifying';

type Env = Record<string, string | undefined>;

function isSafeDistinctId(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !/[\s@]|:\/\//.test(value);
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/** The gate's output, or the keys it refused. */
function gated(
  event: FunnelEvent,
  raw: Record<string, unknown>,
): { properties: EventProperties } | { refused: string[] } {
  const { properties } = buildEvent(event, raw);
  const refused = Object.entries(raw)
    .filter(([key, value]) => isPrimitive(value) && !(key in properties))
    .map(([key]) => key);
  return refused.length > 0 ? { refused } : { properties };
}

export async function captureFunnelEvent(
  input: {
    event: FunnelEvent;
    familyId?: string;
    /** Checkout person (`cs:` + session id) when there is no family yet. Ignored when familyId is set. */
    distinctId?: string;
    attribution: Attribution;
    properties?: Record<string, unknown>;
    set?: Record<string, unknown>;
    setOnce?: Record<string, unknown>;
  },
  deps: { sender: FunnelSender; env?: Env },
): Promise<FunnelOutcome> {
  if (!funnelAttributionEnabled(deps.env)) return 'flag_off';
  const distinctId = input.familyId ? hashFamilyId(input.familyId) : (input.distinctId ?? null);
  if (!distinctId || !isSafeDistinctId(distinctId)) {
    console.warn('analytics: funnel event refused a distinct id', { event: input.event });
    return 'refused_identifying';
  }
  const main = gated(input.event, {
    ...input.properties,
    ...parseAttribution(input.attribution),
  });
  const set = input.set ? gated(input.event, input.set) : null;
  const setOnce = input.setOnce ? gated(input.event, input.setOnce) : null;
  const refused = [main, set, setOnce].flatMap((part) =>
    part && 'refused' in part ? part.refused : [],
  );
  if (refused.length > 0 || 'refused' in main) {
    console.warn('analytics: funnel event refused an identifying property', {
      event: input.event,
      keys: refused,
    });
    return 'refused_identifying';
  }
  const capture: FunnelCapture = {
    event: input.event,
    distinctId,
    properties: main.properties,
    ...(set && 'properties' in set ? { set: set.properties } : {}),
    ...(setOnce && 'properties' in setOnce ? { setOnce: setOnce.properties } : {}),
  };
  try {
    return await deps.sender.send(capture);
  } catch (err) {
    console.warn('analytics: funnel event failed to send', {
      event: input.event,
      err: err instanceof Error ? err.name : 'unknown',
    });
    return 'provider_error';
  }
}

/**
 * What the SMS door's signup_completed adds with the flag on: the card code the first
 * text carried, and the signup date as a person property. An untagged signup has no
 * code, and it stays absent rather than becoming a string like 'direct'.
 */
export function signupFunnelExtras(
  input: { sourceCode: string | null; now: Date },
  env: Env = process.env,
): { properties: EventProperties; options: { setOnce?: EventProperties } } {
  if (!funnelAttributionEnabled(env)) return { properties: {}, options: {} };
  const code = parseAttribution({ source_code: input.sourceCode }).source_code;
  return {
    properties: code ? { source_code: code } : {},
    options: { setOnce: { signup_date: input.now.toISOString().slice(0, 10) } },
  };
}
