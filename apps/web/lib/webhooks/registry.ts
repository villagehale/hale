import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IngestedEventPayload } from '@hale/tools-contracts';

/**
 * Inbound integration provider adapter pattern.
 *
 * Every inbound webhook provider is one `ProviderAdapter` registry entry. The
 * route, signature verification, and family resolution all dispatch through the
 * registry — there are no per-provider switch statements scattered across the
 * webhook layer anymore. Adding a real provider later is a single registry
 * entry, not edits in three files.
 *
 * An adapter answers three provider-specific questions:
 *   1. verify(signature, rawBody) — is this request authentic? Returns a
 *      VerifyResult. A NOT-yet-live provider returns `not_configured` so the
 *      route answers 501 (known-but-not-live) and NEVER processes the payload.
 *   2. extractExternalId(payload) — which external account does this signal
 *      belong to? Used to bind the event to a family via the integrations row.
 *   3. toIngestedEvent(familyId, payload) — shape the verified, family-bound
 *      payload into the events.ingested contract the worker consumes.
 *
 * The verify-then-process ordering is structural: the route calls verify first
 * and only continues to extractExternalId/toIngestedEvent on `verified`. A
 * scaffold (not-yet-live) provider can never reach ingestion.
 */

export type WebhookVerifyResult =
  | { status: 'verified' }
  | { status: 'not_configured'; reason: string }
  | { status: 'invalid'; reason: string };

export interface ProviderAdapter {
  /** The integration_provider enum value this adapter serves. */
  readonly provider: string;
  /**
   * Authenticate the request. Returns:
   *   - 'verified'        the signature is valid; the route may process it.
   *   - 'not_configured'  the leg isn't live (no secret/OAuth yet) → route 501.
   *   - 'invalid'         configured but the signature failed → route 401.
   */
  verify(signature: string | null, rawBody: string): WebhookVerifyResult;
  /**
   * Pull the stable external identifier from the webhook body — the same value
   * stored on the integration at connect time. Returns null when the payload
   * carries no usable identifier (or is malformed).
   */
  extractExternalId(payload: unknown): string | null;
  /** Shape a verified, family-bound payload into the events.ingested contract. */
  toIngestedEvent(familyId: string, payload: Record<string, unknown>): IngestedEventPayload;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Default ingestion shape shared by signal providers: the verified payload
 * flows verbatim into events.ingested under the provider's source name. A
 * provider with a richer mapping can override `toIngestedEvent`.
 */
function defaultToIngestedEvent(
  provider: string,
  familyId: string,
  payload: Record<string, unknown>,
): IngestedEventPayload {
  return {
    family_id: familyId,
    source: provider,
    payload,
    received_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Live signal providers (gmail / gcal / outlook / twilio).
//
// These are the agent-pipeline signal legs: a verified, family-bound webhook
// flows to events.ingested. Their per-provider verification mirrors the prior
// signatures.ts behaviour — until each provider's secret/OAuth client id is
// provisioned, verify returns `not_configured` (route 501) rather than
// accepting unsigned traffic. In non-production with no signature header we
// allow the request through for local testing (verified) — unchanged.
// ─────────────────────────────────────────────────────────────────────────────

function isDevUnsigned(signature: string | null): boolean {
  return process.env.NODE_ENV !== 'production' && !signature;
}

function googleAdapter(provider: string, extract: (p: Record<string, unknown>) => string | null): ProviderAdapter {
  return {
    provider,
    verify(signature) {
      if (isDevUnsigned(signature)) return { status: 'verified' };
      // Google Pub/Sub push uses an OIDC JWT — verify via the audience claim
      // against our webhook URL. Wired in M1.5. Until GOOGLE_OAUTH_CLIENT_ID is
      // provisioned the leg is not live.
      if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
        return { status: 'not_configured', reason: 'GOOGLE_OAUTH_CLIENT_ID not configured' };
      }
      if (!signature) return { status: 'invalid', reason: 'missing signature header' };
      return { status: 'verified' };
    },
    extractExternalId(payload) {
      return isRecord(payload) ? extract(payload) : null;
    },
    toIngestedEvent(familyId, payload) {
      return defaultToIngestedEvent(provider, familyId, payload);
    },
  };
}

const gmailAdapter = googleAdapter('gmail', (payload) =>
  // Gmail push delivers the mailbox address inside the Pub/Sub message.
  readString(payload.emailAddress),
);

const gcalAdapter = googleAdapter('gcal', (payload) =>
  // Google Calendar push echoes the watch channel id.
  readString(payload.channelId) ?? readString(payload.resourceId),
);

const outlookAdapter: ProviderAdapter = {
  provider: 'outlook',
  verify(signature) {
    if (isDevUnsigned(signature)) return { status: 'verified' };
    // Microsoft Graph webhooks use a validation token then HMAC. Wired in M1.5.
    if (!process.env.MICROSOFT_OAUTH_CLIENT_ID) {
      return { status: 'not_configured', reason: 'MICROSOFT_OAUTH_CLIENT_ID not configured' };
    }
    if (!signature) return { status: 'invalid', reason: 'missing signature header' };
    return { status: 'verified' };
  },
  extractExternalId(payload) {
    // Microsoft Graph change notifications carry the subscription id.
    return isRecord(payload) ? readString(payload.subscriptionId) : null;
  },
  toIngestedEvent(familyId, payload) {
    return defaultToIngestedEvent('outlook', familyId, payload);
  },
};

const twilioAdapter: ProviderAdapter = {
  provider: 'twilio',
  verify(signature) {
    if (isDevUnsigned(signature)) return { status: 'verified' };
    // Twilio: HMAC-SHA1 over URL + sorted form params. Wired with SMS feature.
    if (!process.env.TWILIO_AUTH_TOKEN) {
      return { status: 'not_configured', reason: 'TWILIO_AUTH_TOKEN not configured' };
    }
    if (!signature) return { status: 'invalid', reason: 'missing signature header' };
    return { status: 'verified' };
  },
  extractExternalId(payload) {
    return isRecord(payload) ? readString(payload.AccountSid) : null;
  },
  toIngestedEvent(familyId, payload) {
    return defaultToIngestedEvent('twilio', familyId, payload);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Stripe (Connect signal leg).
//
// NOTE: this is the Stripe Connect signal adapter (events.ingested for a
// connected account), kept on the registry alongside the others. Stripe BILLING
// (plan_tier transitions) is a DIFFERENT contract handled out-of-band in
// stripe-billing.ts and short-circuited in the route before registry dispatch.
// Like the others, the Connect leg verifies HMAC-SHA256 only once
// STRIPE_WEBHOOK_SECRET is provisioned.
// ─────────────────────────────────────────────────────────────────────────────

const stripeAdapter: ProviderAdapter = {
  provider: 'stripe',
  verify(signature, rawBody) {
    if (isDevUnsigned(signature)) return { status: 'verified' };
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      return { status: 'not_configured', reason: 'STRIPE_WEBHOOK_SECRET not configured' };
    }
    if (!signature) return { status: 'invalid', reason: 'missing signature header' };
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const provided = signature.replace(/^v1=/, '');
    if (!safeEqual(expected, provided)) {
      return { status: 'invalid', reason: 'stripe signature mismatch' };
    }
    return { status: 'verified' };
  },
  extractExternalId(payload) {
    // Stripe Connect events name the connected account.
    return isRecord(payload) ? readString(payload.account) : null;
  },
  toIngestedEvent(familyId, payload) {
    return defaultToIngestedEvent('stripe', familyId, payload);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Scaffold providers — KNOWN but NOT LIVE.
//
// Each scaffold is a registry entry whose verify() returns `not_configured`
// (route 501) and whose ingestion path is therefore never reached. This mirrors
// the Stripe-billing 501 pattern: we surface a known provider loudly rather than
// 404-ing it, signalling "we recognise this leg, it just isn't wired yet". The
// per-provider comment block names exactly what the real leg needs so wiring it
// later is a small, well-shaped change: drop in the verify scheme, the
// extractExternalId field, and flip verify off `not_configured`.
// ─────────────────────────────────────────────────────────────────────────────

interface ScaffoldSpec {
  readonly provider: string;
  /** Env var whose presence flips the leg from not_configured to live. */
  readonly secretEnvVar: string;
  /** Human reason surfaced in the 501 body. */
  readonly reason: string;
  /** The external-id field the real leg will read (documented, not yet read). */
  readonly externalIdField: string;
}

function scaffoldAdapter(spec: ScaffoldSpec): ProviderAdapter {
  return {
    provider: spec.provider,
    verify() {
      // Scaffold: the leg is not live. We refuse to process unconditionally —
      // even a well-formed signed request — until `secretEnvVar` exists and the
      // real verify scheme is implemented. The route turns this into a 501.
      return { status: 'not_configured', reason: spec.reason };
    },
    extractExternalId(payload) {
      // Documented for the real leg; unused while not_configured (verify gates
      // the route before this is ever called).
      return isRecord(payload) ? readString(payload[spec.externalIdField]) : null;
    },
    toIngestedEvent(familyId, payload) {
      return defaultToIngestedEvent(spec.provider, familyId, payload);
    },
  };
}

// ── DAYCARE: Brightwheel ──────────────────────────────────────────────────────
// REAL LEG NEEDS:
//   API/OAuth      Brightwheel partner API + OAuth2 (no public self-serve
//                  webhook product today — partner onboarding required).
//   Webhook        Brightwheel posts activity events (check-in/out, naps,
//   contract       photos, incident reports) to a registered endpoint with an
//                  HMAC signature over the raw body keyed by a per-account
//                  webhook secret → BRIGHTWHEEL_WEBHOOK_SECRET.
//   external-id    Body carries `student_id` (and `room_id`); the integration is
//                  bound at connect time on the child's Brightwheel student id.
const brightwheelAdapter = scaffoldAdapter({
  provider: 'brightwheel',
  secretEnvVar: 'BRIGHTWHEEL_WEBHOOK_SECRET',
  reason: 'brightwheel daycare leg not live (partner API + webhook secret pending)',
  externalIdField: 'student_id',
});

// ── DAYCARE: HiMama (now Lillio) ──────────────────────────────────────────────
// REAL LEG NEEDS:
//   API/OAuth      HiMama/Lillio API access (partner program); OAuth2 per
//                  daycare account.
//   Webhook        Activity/daily-report events POSTed to our endpoint, signed
//   contract       HMAC over the raw body keyed by HIMAMA_WEBHOOK_SECRET.
//   external-id    Body carries `child_id`; integration bound on the child's
//                  HiMama child id at connect time.
const himamaAdapter = scaffoldAdapter({
  provider: 'himama',
  secretEnvVar: 'HIMAMA_WEBHOOK_SECRET',
  reason: 'himama daycare leg not live (partner API + webhook secret pending)',
  externalIdField: 'child_id',
});

// ── SCHOOL: Google Classroom ──────────────────────────────────────────────────
// REAL LEG NEEDS:
//   API/OAuth      Google Classroom API via Google Cloud OAuth2 with the
//                  classroom.* scopes (shares GOOGLE_OAUTH_CLIENT_ID but adds
//                  Classroom scopes + Pub/Sub registrations).
//   Webhook        Classroom push notifications are delivered through Google
//   contract       Cloud Pub/Sub (OIDC-JWT signed), same transport as Gmail/
//                  Calendar push — verify the JWT audience against our endpoint.
//   external-id    Pub/Sub message names the `courseId` the registration watches;
//                  integration bound on courseId (one row per watched course).
const googleClassroomAdapter = scaffoldAdapter({
  provider: 'google_classroom',
  secretEnvVar: 'GOOGLE_OAUTH_CLIENT_ID',
  reason: 'google_classroom school leg not live (Classroom scopes + Pub/Sub registration pending)',
  externalIdField: 'courseId',
});

// ─────────────────────────────────────────────────────────────────────────────
// Registry — the single dispatch point.
// ─────────────────────────────────────────────────────────────────────────────

const ADAPTERS: readonly ProviderAdapter[] = [
  gmailAdapter,
  gcalAdapter,
  outlookAdapter,
  stripeAdapter,
  twilioAdapter,
  brightwheelAdapter,
  himamaAdapter,
  googleClassroomAdapter,
];

const REGISTRY: ReadonlyMap<string, ProviderAdapter> = new Map(
  ADAPTERS.map((adapter) => [adapter.provider, adapter]),
);

/** Provider keys the route recognises. Unknown → 404; known → dispatch. */
export const SUPPORTED_PROVIDERS = ADAPTERS.map((a) => a.provider) as readonly string[];

/** Returns the adapter for a provider, or null when the provider is unknown. */
export function getAdapter(provider: string): ProviderAdapter | null {
  return REGISTRY.get(provider) ?? null;
}
