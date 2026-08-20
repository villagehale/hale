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
  // Retired with the sign-up funnel F14 deleted. Kept in the union because the
  // names are DATA — historical rows in PostHog carry them — but nothing fires
  // them any more; a new CTA must not reuse one.
  | 'landing_cta_preview'
  | 'landing_cta_signin'
  | 'faq_cta_signin'
  // Conversion CTAs on the SEO/AEO content pages — so the funnel can attribute a
  // texting intent to the page that earned it (which content actually converts).
  // They sit on an sms:/mailto: href: there is no sign-in at the end of them, and
  // the *_cta_signin names they replace made every dashboard read the funnel wrong.
  | 'activities_cta_text'
  | 'answers_cta_text'
  // Plus/Family waitlist form submitted (coarse event only — never the email).
  | 'waitlist_signup'
  // The /text entry page (VIL-240), carrying the QR card's venue code as `source`
  // — which physical spot actually starts conversations.
  | 'text_entry_viewed'
  // The chief-of-staff landing's only conversion: tapping through to the SMS
  // composer. Property-free like the other landing CTAs — the href it sits on is
  // an sms: deep link, so the safest thing to send alongside it is nothing.
  | 'landing_cta_text';

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
