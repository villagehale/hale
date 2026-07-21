/**
 * The product-analytics event catalog and its privacy gate (hard rule #1).
 *
 * Hale handles children's data, so analytics MUST never carry PII or any
 * child/teen content. Events are restricted to the key-loop steps below and
 * their properties to coarse, non-identifying primitives (booleans, counts,
 * enum-like kinds). `buildEvent` is the single chokepoint every capture call
 * goes through: it drops any property whose key looks identifying or whose value
 * is a non-primitive, so an accidental `{ name }` or `{ message }` can never
 * leave the client. Pure + exported so the redaction is unit-tested.
 */

export type AnalyticsEvent =
  | 'waitlist_signup'
  | 'sign_up'
  | 'preview_submitted'
  | 'signup_completed'
  | 'onboarding_completed'
  | 'first_activity_added'
  | 'first_ask'
  | 'first_invite'
  | 'add_to_week'
  | 'endorse'
  | 'share'
  | 'ask_hale'
  | 'village_save'
  | 'plan_notify_requested'
  | 'plan_upgrade_started'
  // F11 · The Sunday Loop (VIL-218 · B2): one weekly_plan message enqueued to a
  // parent. Coarse props only (item/pending counts + category) — feeds X1.
  | 'loop_plan_sent'
  // F11 · reminders (VIL-223 · D1): one reminder message (a T-1h ping or a batched
  // T-24h evening) enqueued to a parent. Coarse props only (offset enum + event count).
  | 'reminder_sent';

/** A coarse, non-identifying property value. No objects, no arrays — only primitives. */
export type EventProperty = string | number | boolean;
export type EventProperties = Record<string, EventProperty>;

/**
 * Property-key fragments that signal personal or child/teen data. A property
 * whose key contains any of these is dropped before the event is sent — defence
 * in depth behind the typed call sites, so a future careless caller still can't
 * leak PII.
 */
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
  'question',
  'answer',
  'note',
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

/**
 * Build a sanitized event: keep only coarse primitive properties whose key is
 * not identifying. Anything else is silently dropped — the event still fires
 * (we want the count), just without the offending property.
 */
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
