/**
 * The acquisition-funnel event catalog and its privacy gate (hard rule #1).
 *
 * Nothing identifying may reach product analytics. The site is ANONYMOUS: no
 * identify, no autocapture, no session replay, no PostHog cookies (see
 * posthog-provider.tsx). Google Ads is a separate document-head tag for advertising
 * measurement, not this catalog.
 * Every event below is fired by hand from a named call site, and its properties are
 * coarse, non-identifying primitives. `buildEvent` is the single chokepoint every
 * capture goes through: it drops any property whose key looks identifying or whose
 * value is a non-primitive, so an accidental `{ email }` can never leave the client.
 * Pure + exported so the redaction is unit-tested.
 *
 * The funnel is one question — WHICH SOURCE PRODUCED A TEXT — so `source_code` and
 * `locale` are stamped on every event by the provider rather than by each call site;
 * a call site cannot override them (posthog-provider.tsx).
 */

export type AnalyticsEvent =
  // Retired. Kept in the union because the names are DATA — historical rows in
  // PostHog carry them — but nothing fires them any more; a new CTA must not reuse
  // one.
  //   *_cta_signin / _preview — the sign-up funnel F14 deleted.
  //   *_cta_text              — three names for one act (tapping through to the SMS
  //                             composer), which made "how many people texted us"
  //                             a three-query question. Replaced by cta_text_click
  //                             with a `cta_placement` property.
  | 'landing_cta_preview'
  | 'landing_cta_signin'
  | 'faq_cta_signin'
  | 'activities_cta_text'
  | 'answers_cta_text'
  | 'landing_cta_text'
  // Plus/Family waitlist form submitted (coarse event only — never the email).
  | 'waitlist_signup'
  // ── The messaging-first funnel ────────────────────────────────────────────
  // THE conversion: a tap on an `sms:` deep link, anywhere on the site.
  // `cta_placement` names which one (hero, header, faq, a reply chip…), so the
  // whole site is one funnel with a breakdown rather than one event per page.
  // NOTE for dashboards: the hero's placement was renamed mid-week during the
  // 2026-08 ad launch — historical rows carry `hero_chip` where current ones say
  // `hero`, so any query reading the hero's clicks must OR the two values.
  | 'cta_text_click'
  // The desktop path to the same act — the number onto the clipboard, because
  // `sms:` is a silent no-op on a laptop. Counted separately: it is an intention
  // to text later, not a composer that opened.
  | 'copy_number_click'
  // The same conversion through the OTHER pipe: a tap on a wa.me deep link
  // (WhatsApp v1). Separate from cta_text_click because the two funnels light up
  // at different times — the WhatsApp sender ships dark behind its own env var.
  | 'cta_whatsapp_click'
  // Hale's contact card saved (/hale.vcf). The one thing a parent does on the
  // site that changes what every LATER Hale text looks like on their phone.
  | 'save_contact_click'
  // The /text entry page (VIL-240) — which physical spot actually starts
  // conversations. Attribution rides on the provider's `source_code`.
  | 'text_entry_viewed'
  // How far down the landing a reader got: 25/50/75/100, at most once per depth
  // per view. The only signal the page has about whether the scroll earns the
  // CTA at the bottom of it.
  | 'landing_scroll';

/**
 * PostHog's own pageview. Not ours to name, but it goes through the same gate as
 * everything else so the funnel's base properties land on it too — a pageview with
 * no `source_code` is a visit nothing can be attributed to.
 */
export const PAGEVIEW = '$pageview';

/** Everything the site sends: the catalog plus the pageview. */
export type CapturedEvent = AnalyticsEvent | typeof PAGEVIEW;

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
  event: CapturedEvent;
  properties: EventProperties;
}

export function buildEvent(
  event: CapturedEvent,
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
