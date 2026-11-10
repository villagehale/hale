import { createHash } from 'node:crypto';
import { after } from 'next/server';
import { type AnalyticsEvent, buildEvent } from './events';
import { captureSafeException } from './exceptions';
import { productClient } from './posthog-node';

/**
 * Server-side analytics capture for the paths a client hook can't reach.
 * Payloads go through buildEvent, so a cancelled attempt is not a conversion
 * just because a button was pressed.
 *
 * Sent through posthog-node (lib/analytics/posthog-node.ts: flushAt 1, flushInterval 0,
 * and every send awaits its own flush, so a short-lived server action leaks no queue).
 * It reads the SAME key/host as the client provider and routes every payload through
 * the SAME buildEvent redaction chokepoint, so identifying or non-primitive
 * properties can never leave (rule #1).
 *
 * A MISSING KEY IS A NAMED ABSENCE, NOT A SILENT NO-OP (rule #11). Analytics is the one
 * dependency here that is genuinely allowed to be absent — a deploy without a PostHog
 * key must still send a parent their text. So the absence is LOGGED, once per process
 * rather than once per event (a dead key during a cron sweep would otherwise write a
 * line per family), and it is named in the return value rather than folded into the
 * success path.
 */

export type CaptureOutcome = 'sent' | 'not_configured' | 'provider_error';

/** One line per process, not one per event — see the note above. */
let absenceLogged = false;

function keyOrNull(): string | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (key) return key;
  if (!absenceLogged) {
    absenceLogged = true;
    console.warn(
      'analytics: NEXT_PUBLIC_POSTHOG_KEY is not set — no product events will be recorded for the life of this process',
    );
  }
  return null;
}

/** Test seam: the once-per-process latch above would otherwise leak between cases. */
export function resetAnalyticsAbsenceLogForTests(): void {
  absenceLogged = false;
}

export async function captureServerEvent(
  event: AnalyticsEvent,
  distinctId: string,
  properties: Record<string, unknown> = {},
  options: { setOnce?: Record<string, unknown> } = {},
): Promise<CaptureOutcome> {
  const key = keyOrNull();
  if (!key) {
    return 'not_configured';
  }
  const client = productClient();
  if (!client) return 'not_configured';
  const { event: name, properties: safe } = buildEvent(event, properties);
  // `$set_once` goes through the SAME gate: a person property is still a property.
  const setOnce = options.setOnce ? buildEvent(event, options.setOnce).properties : null;
  client.capture({
    distinctId,
    event: name,
    properties: setOnce && Object.keys(setOnce).length > 0 ? { ...safe, $set_once: setOnce } : safe,
  });
  await client.flush();
  return 'sent';
}

// ── Agent error tracking ─────────────────────────────────────────────────────

/**
 * THE FAILURES THAT NEVER REACH AN ERROR PAGE.
 *
 * Hale's worst failures are quiet: a turn deferred back onto the queue, a provider refusal
 * classified and swallowed, a relay socket hung up on, an answer trimmed past the segment
 * budget, a promise the sweep could not keep. Every one is already TYPED at its call site
 * and already logged — but a log line on a serverless function is something you read
 * after a parent complains, and it has no rate to be compared against.
 *
 * WHAT MAY BE SENT is the whole design. The payload is assembled here from a CLOSED
 * DISCRIMINATED UNION: a lane, a failure class the call site already holds as an enum,
 * and a one-way digest of the family id. There is no parameter a caller could put an
 * error message, a phone number, a child's name, or a parent's text into — not "there is
 * a rule against it", but no field of that shape exists. That is why this is a union and
 * not `props: Record<string, unknown>` (rule #1, and the poisoned-fixture test beside it).
 */

/** Which seam broke. One lane per place that can fail without anybody being told. */
export type AgentErrorLane =
  | 'coach'
  | 'transport'
  | 'relay'
  | 'reply_budget'
  | 'commitments'
  | 'reconcile';

export type AgentError =
  /** A coach turn that answered nobody; `reason` is a TurnDeferralReason. */
  | { lane: 'coach'; reason: string; familyId: string }
  /** A provider refusal, already classified permanent-vs-transient by the typed error. */
  | { lane: 'transport'; code: string; retry: 'permanent' | 'transient'; familyId: string | null }
  /** A relay socket refused before it proved whose call it was — usually no family yet. */
  | { lane: 'relay'; reason: string; familyId: string | null }
  /** The model's answer ran past the SMS segment budget and lost its tail. */
  | { lane: 'reply_budget'; overBy: number; familyId: string | null }
  /** A due promise the sweep could not keep this tick. */
  | { lane: 'commitments'; kind: string; familyId: string }
  /** A claim Hale wrote that no row backed; `reason` is a reconcile RefusalReason. */
  | { lane: 'reconcile'; reason: string; familyId: string };

const EVENT_BY_LANE: Record<AgentErrorLane, AnalyticsEvent> = {
  coach: 'agent_turn_failed',
  transport: 'agent_send_failed',
  relay: 'agent_relay_refused',
  reply_budget: 'agent_reply_trimmed',
  commitments: 'agent_commitment_failed',
  reconcile: 'agent_claim_refused',
};

/**
 * A snake_case enum token, and nothing else. Every `reason`/`kind` above is declared as
 * a union in this repo, so this only ever fires on a call site that reached for a string
 * it should not have — a message, a body, a name. The deterministic backstop behind the
 * types, in the same spirit as buildEvent's key gate.
 */
const ENUM_TOKEN = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * A provider error code: digits, or the provider's own `'unknown'` when the payload
 * carried none. Nothing else: a provider `message` field can echo the recipient's
 * number and the body, and neither leaves the transport.
 */
const PROVIDER_ERROR_CODE = /^(\d{1,6}|unknown)$/;

function classOf(error: AgentError): string {
  switch (error.lane) {
    case 'coach':
    case 'reconcile':
      return ENUM_TOKEN.test(error.reason) ? error.reason : 'unclassified';
    case 'relay':
      return ENUM_TOKEN.test(error.reason) ? error.reason : 'unclassified';
    case 'commitments':
      return ENUM_TOKEN.test(error.kind) ? error.kind : 'unclassified';
    case 'transport':
      return PROVIDER_ERROR_CODE.test(error.code) ? error.code : 'unclassified';
    case 'reply_budget':
      return 'budget_overflow';
  }
}

/**
 * A family id as a one-way digest. PostHog holds nothing that joins its rows back to a
 * Hale family, and an operator counting failures per household does not need one — they
 * need to know it is the SAME household. sha256 over a 128-bit random uuid is not
 * enumerable, so no salt would be doing work the id's own entropy is not already doing.
 */
export function hashFamilyId(familyId: string): string {
  return createHash('sha256').update(familyId).digest('hex').slice(0, 16);
}

/** The payload, split out from the send so the redaction is asserted as a pure value. */
export function buildAgentErrorPayload(error: AgentError): {
  event: AnalyticsEvent;
  distinctId: string;
  properties: Record<string, string | number>;
} {
  const familyHash = error.familyId === null ? null : hashFamilyId(error.familyId);
  return {
    event: EVENT_BY_LANE[error.lane],
    // The hashed family, or the lane itself where the failure has no family (a relay
    // socket refused before it authorized). Never a placeholder that could collide with
    // a real household.
    distinctId: familyHash ?? `lane:${error.lane}`,
    properties: {
      lane: error.lane,
      error_class: classOf(error),
      ...(familyHash ? { family_hash: familyHash } : {}),
      ...(error.lane === 'transport' ? { retry: error.retry } : {}),
      ...(error.lane === 'reply_budget' ? { over_by: error.overBy } : {}),
    },
  };
}

// ── Inbound routing outcomes ─────────────────────────────────────────────────

/** The two doors a parent's message can arrive through. */
export type InboundDoor = 'sms' | 'email' | 'imessage';

/** Inside the inbound webhook's budget, so a hung PostHog endpoint must fail fast
 * — the same bound the webhook boundary alert puts on its own capture leg
 * (lib/channel/webhook-alert.ts). captureServerEvent's unbounded fetch is fine on a
 * server action; it is not fine here. */
const INBOUND_CAPTURE_TIMEOUT_MS = 4_000;

/**
 * Count one routed inbound message. Both doors call this with their FINAL outcome —
 * every named refusal included — because a refusal that is never counted is
 * indistinguishable from silence (rule #11; the 2026-09-03 audit found 84 formerly-Twilio
 * inbound against 19 ledger rows with nothing saying where the other 65 went).
 *
 * The payload is the door and the outcome enum, nothing else — no sender, no provider
 * id, no body (rule #1). The outcome is backstopped by the same enum-token gate the
 * agent-error payloads use, so a call site that someday reaches for a free string
 * ships 'unclassified' instead of content. Never throws: a counter must not be able
 * to take the webhook down.
 */
export async function captureInboundRouted(
  door: InboundDoor,
  outcome: string,
): Promise<CaptureOutcome> {
  const key = keyOrNull();
  if (!key) {
    return 'not_configured';
  }
  const client = productClient();
  if (!client) return 'not_configured';
  const { event, properties } = buildEvent('inbound_routed', {
    door,
    outcome: ENUM_TOKEN.test(outcome) ? outcome : 'unclassified',
  });
  try {
    client.capture({
      // The door itself, mirroring `lane:` — an inbound refusal often has no
      // resolved person, and the ones that do must not be joined back to one.
      distinctId: `door:${door}`,
      event,
      properties,
    });
    // posthog-node's own requestTimeout (4s, posthog-node.ts) bounds this inside the
    // webhook budget; the race is a second bound in case a flush never settles.
    await Promise.race([
      client.flush(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout')), INBOUND_CAPTURE_TIMEOUT_MS).unref?.(),
      ),
    ]);
    return 'sent';
  } catch (err) {
    console.warn('analytics: inbound routing count failed to send', {
      door,
      err: err instanceof Error ? err.name : 'unknown',
    });
    return 'provider_error';
  }
}

/**
 * Report a typed agent failure. Fire-and-forget by construction: it NEVER throws, so a
 * call site sitting inside a `catch` mid-send cannot be made worse by reporting. The
 * outcome is returned rather than swallowed, so a caller (and a test) can see which of
 * the three things happened.
 */
export async function captureAgentError(error: AgentError): Promise<CaptureOutcome> {
  const { event, distinctId, properties } = buildAgentErrorPayload(error);
  // The same failure, also as an $exception in error tracking (dark until
  // POSTHOG_PROJECT_API_KEY is set). Class + lane only — a synthetic error named for the
  // failure class, so the stack is this reporter's, never the parent's message.
  const synthetic = new Error('redacted');
  synthetic.name = `AgentError_${error.lane}`;
  void captureSafeException(synthetic, distinctId, {
    hale_surface: 'agent',
    stage: error.lane,
    code: String(properties.error_class),
  });
  try {
    return await captureServerEvent(event, distinctId, properties);
  } catch (err) {
    // The ONE place this module swallows, and the reason it is safe only here: an error
    // REPORTER that throws turns every quiet failure into a loud one, and every call
    // site is already inside a failure path. Named, never silent.
    console.warn('analytics: agent error report failed to send', {
      lane: error.lane,
      err: err instanceof Error ? err.name : 'unknown',
    });
    return 'provider_error';
  }
}

// ── Portal surface events ────────────────────────────────────────────────────

export type PortalEvent = Extract<
  AnalyticsEvent,
  | 'portal_gmail_connected'
  | 'portal_calendar_connected'
  | 'portal_export_requested'
  | 'portal_delete_requested'
  | 'portal_family_edited'
  | 'portal_passport_viewed'
>;

/** Where in the portal the action happened. A closed enum — the event's only property. */
export type PortalSurface = 'settings' | 'connected' | 'family' | 'passport' | 'rights_api';

/**
 * One portal action, keyed on the HASHED family id (the same id the portal identifies
 * as), carrying `surface` and nothing else. Never throws; a route calls it inside
 * `after()` so the response never waits on PostHog.
 */
export async function capturePortalEvent(
  event: PortalEvent,
  familyId: string,
  surface: PortalSurface,
): Promise<CaptureOutcome> {
  try {
    return await captureServerEvent(event, hashFamilyId(familyId), { surface });
  } catch (err) {
    console.warn('analytics: portal event failed to send', {
      event,
      err: err instanceof Error ? err.name : 'unknown',
    });
    return 'provider_error';
  }
}

/**
 * Schedule {@link capturePortalEvent} after the response. `after()` throws outside a
 * request scope (a unit test calling the handler directly); there the capture simply runs
 * detached. Either way the response never waits on PostHog, and nothing throws.
 */
export function capturePortalEventAfter(
  event: PortalEvent,
  familyId: string,
  surface: PortalSurface,
): void {
  const run = () => capturePortalEvent(event, familyId, surface);
  try {
    after(run);
  } catch {
    void run();
  }
}
