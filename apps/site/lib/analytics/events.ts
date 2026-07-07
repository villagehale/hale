/**
 * The landing event catalog and its privacy gate (hard rule #1).
 *
 * Nothing identifying may reach product analytics. Events are restricted to the
 * funnel CTAs below and their properties to coarse, non-identifying primitives.
 * `buildEvent` is the single chokepoint every capture goes through: it drops any
 * property whose key looks identifying or whose value is a non-primitive, so an
 * accidental `{ email }` can never leave the client. Pure + exported so the
 * redaction is unit-tested.
 */

export type AnalyticsEvent =
  | 'landing_cta_preview'
  | 'landing_cta_signin'
  // Conversion CTAs on the SEO/AEO content pages — so the funnel can attribute a
  // sign-in intent to the page that earned it (which content actually converts).
  | 'faq_cta_signin'
  | 'activities_cta_signin'
  // Plus/Family waitlist form submitted (coarse event only — never the email).
  | 'waitlist_signup';

/** A coarse, non-identifying property value. No objects, no arrays — only primitives. */
export type EventProperty = string | number | boolean;
export type EventProperties = Record<string, EventProperty>;

const FORBIDDEN_KEY_FRAGMENTS = [
  'name',
  'email',
  'phone',
  'address',
  'dob',
  'birth',
  'child',
  'teen',
  'message',
  'content',
  'body',
  'text',
  'location',
  'lat',
  'lng',
  'postal',
  'ip',
  'token',
] as const;

function isForbiddenKey(key: string): boolean {
  const lower = key.toLowerCase();
  return FORBIDDEN_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

function isCoarseValue(value: unknown): value is EventProperty {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

export interface BuiltEvent {
  event: AnalyticsEvent;
  properties: EventProperties;
}

export function buildEvent(
  event: AnalyticsEvent,
  properties: Record<string, unknown> = {},
): BuiltEvent {
  const safe: EventProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    if (isForbiddenKey(key)) continue;
    if (!isCoarseValue(value)) continue;
    safe[key] = value;
  }
  return { event, properties: safe };
}
