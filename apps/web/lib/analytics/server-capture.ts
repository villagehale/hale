import { createHash } from 'node:crypto';
import { type AnalyticsEvent, buildEvent } from './events';

/**
 * Server-side analytics capture for the paths a client hook can't reach — the
 * sign-up server action fires signup_completed here on ACTUAL account creation, not
 * on button-intent, so cancelled/failed attempts aren't counted as conversions.
 *
 * Dependency-free: a single POST to PostHog's public capture endpoint (no
 * posthog-node client, no flush lifecycle to leak in a short-lived server action).
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
): Promise<CaptureOutcome> {
  const key = keyOrNull();
  if (!key) {
    return 'not_configured';
  }
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com';
  const { event: name, properties: safe } = buildEvent(event, properties);
  await fetch(`${host}/i/v0/e/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: key,
      event: name,
      distinct_id: distinctId,
      properties: safe,
    }),
  });
  return 'sent';
}

// ── Agent error tracking ─────────────────────────────────────────────────────

/**
 * THE FAILURES THAT NEVER REACH AN ERROR PAGE.
 *
 * Hale's worst failures are quiet: a turn deferred back onto the queue, a Twilio refusal
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
 * A Twilio numeric code, or Twilio's own `'unknown'` when the payload carried none.
 * Nothing else: the provider's `message` field echoes the recipient's number and the
 * body back, and it never leaves lib/channel/twilio/transport.ts.
 */
const TWILIO_CODE = /^(\d{1,6}|unknown)$/;

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
      return TWILIO_CODE.test(error.code) ? error.code : 'unclassified';
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

/**
 * Report a typed agent failure. Fire-and-forget by construction: it NEVER throws, so a
 * call site sitting inside a `catch` mid-send cannot be made worse by reporting. The
 * outcome is returned rather than swallowed, so a caller (and a test) can see which of
 * the three things happened.
 */
export async function captureAgentError(error: AgentError): Promise<CaptureOutcome> {
  const { event, distinctId, properties } = buildAgentErrorPayload(error);
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
