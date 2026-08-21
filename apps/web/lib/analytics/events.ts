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

/**
 * RETIRED with the F14 pivot, and deleted rather than kept as dead names: nothing in
 * apps/web fired them, so there was no call site to protect and no way to reuse one by
 * accident. Their historical rows survive in PostHog, which is where that data lives.
 *
 *   sign_up, preview_submitted  — the pre-pivot marketing funnel; the site owns its own
 *                                 catalog now (apps/site/lib/analytics/events.ts).
 *   waitlist_signup             — same, and the app never had a waitlist form.
 *   onboarding_completed        — the /onboarding wizard is DELETED, not flagged off
 *                                 (lib/onboarding/onboarding-retired.test.ts pins it).
 *                                 intake_started/intake_completed replace it.
 *   party_invite_created        — never a capture; the string is an audit actionTaken
 *                                 (lib/party/store.ts) and stays there.
 *
 * Everything from `first_activity_added` through `plan_upgrade_started` was on the same
 * retirement list and STAYED: the app is demoted to the receipts room (D4/D20), not
 * deleted, and every one of those events still fires from a component on a live route
 * (/plan, /village, /coach, /settings, /family/members). An event whose surface a parent
 * can still reach is instrumentation, not debris.
 */
export type AnalyticsEvent =
  | 'signup_completed'
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
  | 'reminder_sent'
  // F11 · X1 loop metrics (VIL-227): the taxonomy at the A2 dispatch seam. One
  // channel_messages ledger row emits exactly one of the two below — 'sent' maps to
  // loop_message_sent, every other terminal status (failed + each suppression
  // reason) maps to loop_message_failed with `reason` carrying the ledger status.
  | 'loop_message_sent'
  | 'loop_message_failed'
  // The UNDO primitive (reverse-calendar.ts) reversing an executed placement.
  | 'loop_undo'
  // A loop-category CASL email unsubscribe landing — the beta guardrail pages the
  // founder at ANY occurrence (stop-alert.ts).
  | 'loop_stop'
  // F14 · M10 the viral loop (VIL-245). Two coarse steps: a guest answers a host's
  // invite without an account, and a guest follows the one soft line to Hale. Keyed on
  // the INVITE, never on a guest — a party guest is a non-user who agreed to tell a
  // host they were coming, not a person Hale identifies.
  | 'rsvp_submitted'
  | 'rsvp_guest_cta'
  // F14 · the messaging-first funnel's two ends (M2 · lib/channel/intake/machine.ts).
  // A parent who texts the number is greeted (`intake_started`) and, some texts later,
  // has a family (`intake_completed`) — the pair that says whether the ONE way into
  // this product actually works, now that the web wizard is deleted.
  //
  // Both are keyed on the INTAKE SESSION id: a random row id minted before there is an
  // account, so the two steps join into a funnel without a phone number, a name, or a
  // hash of either ever reaching PostHog (hard rule #1). `source_code` on the completed
  // step is the acquisition tag the marketing site set; it is ABSENT when nobody handed
  // out a card, which is its own bucket rather than a code that means "none".
  | 'intake_started'
  | 'intake_completed'
  // The quiet failures — one per seam that can break without anybody being told. Their
  // payloads are assembled by `captureAgentError` from a closed union, never by a call
  // site, so a lane, an enum-valued class and a hashed family id are the only things
  // that can ride on them (lib/analytics/server-capture.ts).
  | 'agent_turn_failed'
  | 'agent_send_failed'
  | 'agent_relay_refused'
  | 'agent_reply_trimmed'
  | 'agent_commitment_failed';

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
