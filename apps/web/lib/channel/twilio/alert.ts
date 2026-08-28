import { buildEvent } from '~/lib/analytics/events';

/**
 * VIL-331 — the alarm on the webhook itself.
 *
 * On 2026-08-28 a Supabase host incident made the FIRST database call in
 * routeTwilioInbound throw for every real inbound text for roughly six hours. The
 * uncaught throw became an anonymous fast 500, Twilio logged error 11200, and four
 * parents' messages were dropped. Nothing alerted anybody, because everything Hale can
 * normally use to tell you something — the ledger, the queue, the trail — is written to
 * the database that was down.
 *
 * So both legs here are DATABASE-INDEPENDENT BY CONSTRUCTION: two `fetch` calls to
 * outside services, configured from env alone. No Drizzle import, no pg-boss, no
 * `~/lib/db` — that is the whole point of the module, and the reason it does not reuse
 * `createTwilioTransport` (which resolves config through the all-or-nothing send path)
 * or `captureServerEvent` (whose fetch is not injectable).
 *
 * Privacy (rule #1). The founder SMS carries a route name, an error class, and a
 * digit-scrubbed slice of the error message. The PostHog event carries a route name and
 * an error class and NOTHING ELSE — a message can echo whatever the failing statement
 * was handling, and PostHog is a third party. The scrub is structural rather than a
 * convention: no parameter of this function can carry a parent's text, and any run of 7+
 * digits (a phone number, an E.164 To, an account id) is replaced before the body is
 * built.
 *
 * Rule #11. Neither leg is allowed to quietly do nothing: an absent phone number, an
 * absent credential and a refused request are three DIFFERENT named outcomes, all
 * logged, and both are returned to the caller.
 */

/** The webhooks that can 500 anonymously. One token per route, snake_case so it reads
 * the same in an SMS, a log line and a PostHog property. */
export type TwilioWebhookRoute = 'twilio_inbound' | 'twilio_voice' | 'twilio_status';

export type SmsAlertOutcome =
  | 'sent'
  | 'skipped_not_configured'
  | 'suppressed_rate_limit'
  | 'failed';
export type AnalyticsAlertOutcome = 'sent' | 'skipped_not_configured' | 'failed';

export interface WebhookAlertOutcome {
  readonly sms: SmsAlertOutcome;
  readonly analytics: AnalyticsAlertOutcome;
}

export interface WebhookAlertDeps {
  /** Injected for tests; defaults to the platform fetch. */
  fetch?: typeof fetch;
}

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';
const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * Hale's own brand number — the one parents text — named here rather than read from
 * TWILIO_FROM_NUMBER on purpose: this module's configuration surface is deliberately the
 * two account secrets plus one recipient, the fewest things that can be missing on the
 * day everything else is.
 */
export const ALERT_FROM_NUMBER = '+12892172279';

/** The alert sits on the failure path of a webhook Twilio gives 15s, and the caller
 * still owes Twilio a 500 afterwards — so a hung provider must lose seconds, not the
 * response. */
const ALERT_TIMEOUT_MS = 4_000;

/** Enough of the error to tell a connection refusal from a constraint violation,
 * short enough that the alert stays a text. */
const MESSAGE_MAX = 140;

/** One founder SMS per instance per window: the incident that motivated this fired on
 * every inbound message for six hours. */
const FOUNDER_SMS_MIN_INTERVAL_MS = 15 * 60 * 1_000;

/**
 * Any run of 7+ digits, gone before the message reaches a body. A Postgres error that
 * quotes the row it was writing would otherwise carry a parent's E.164 into a text
 * (rule #1) — this makes that impossible rather than unlikely.
 */
const DIGIT_RUN = /\d{7,}/g;

/** Spent on the ATTEMPT rather than on delivery: an unconfigured or refusing Twilio
 * must not produce a log line per inbound message for six hours either. */
let lastFounderSmsAttemptAt: number | null = null;

/** Test seam: the window above is module state and would otherwise leak between cases. */
export function resetWebhookAlertWindowForTests(): void {
  lastFounderSmsAttemptAt = null;
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function errorSummary(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = raw.replace(DIGIT_RUN, '[redacted]').replace(/\s+/g, ' ').trim();
  return scrubbed.length > MESSAGE_MAX ? `${scrubbed.slice(0, MESSAGE_MAX)}…` : scrubbed;
}

async function sendFounderSms(
  route: TwilioWebhookRoute,
  error: unknown,
  doFetch: typeof fetch,
): Promise<SmsAlertOutcome> {
  const now = Date.now();
  if (
    lastFounderSmsAttemptAt !== null &&
    now - lastFounderSmsAttemptAt < FOUNDER_SMS_MIN_INTERVAL_MS
  ) {
    return 'suppressed_rate_limit';
  }
  lastFounderSmsAttemptAt = now;

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const to = process.env.FOUNDER_ALERT_PHONE?.trim();
  if (!accountSid || !authToken || !to) {
    const missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'FOUNDER_ALERT_PHONE'].filter(
      (name) => !process.env[name]?.trim(),
    );
    console.error('webhook alert: founder SMS not configured — nobody was paged', {
      route,
      missing,
    });
    return 'skipped_not_configured';
  }

  const form = new URLSearchParams({
    To: to,
    From: ALERT_FROM_NUMBER,
    Body: `Hale ALERT · ${route} threw\n${errorClass(error)}: ${errorSummary(error)}`,
  });

  try {
    const response = await doFetch(`${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error('webhook alert: founder SMS refused', { route, status: response.status });
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    // The one place this module swallows, for the same reason captureAgentError does: a
    // REPORTER that throws replaces a diagnosable failure with an undiagnosable one, and
    // it is called from inside a catch. Named in the return value, never silent.
    console.error('webhook alert: founder SMS threw', {
      route,
      err: err instanceof Error ? err.name : 'unknown',
    });
    return 'failed';
  }
}

async function captureFailure(
  route: TwilioWebhookRoute,
  error: unknown,
  doFetch: typeof fetch,
): Promise<AnalyticsAlertOutcome> {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) {
    console.error(
      'webhook alert: NEXT_PUBLIC_POSTHOG_KEY is not set — the failure was not recorded',
      {
        route,
      },
    );
    return 'skipped_not_configured';
  }
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST;
  // Through the same redaction chokepoint every other capture uses, so a property added
  // here later cannot leave with an identifying key.
  const { event, properties } = buildEvent('webhook_route_failed', {
    route,
    error_class: errorClass(error),
  });

  try {
    const response = await doFetch(`${host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        event,
        // The route itself, mirroring `lane:` in server-capture.ts: this failure has no
        // family — often it broke before it could read one.
        distinct_id: `route:${route}`,
        properties,
      }),
      signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error('webhook alert: capture refused', { route, status: response.status });
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error('webhook alert: capture threw', {
      route,
      err: err instanceof Error ? err.name : 'unknown',
    });
    return 'failed';
  }
}

/**
 * Page the founder and record the failure. Never throws; both legs run in parallel and
 * each reports what it did.
 */
export async function webhookFailureAlert(
  input: { route: TwilioWebhookRoute; error: unknown },
  deps: WebhookAlertDeps = {},
): Promise<WebhookAlertOutcome> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const [sms, analytics] = await Promise.all([
    sendFounderSms(input.route, input.error, doFetch),
    captureFailure(input.route, input.error, doFetch),
  ]);
  return { sms, analytics };
}

/**
 * The route boundary for every Twilio webhook — the one layer allowed to catch (rule
 * #8), and the reason it lives here rather than being copied into three route shells.
 *
 * The answer STAYS a 500. Twilio's SmsFallbackUrl retries on a 5xx and on nothing else,
 * so softening this into a 200 would trade a visible failure for a permanently lost
 * message — exactly the leads the incident cost. The alert is AWAITED rather than
 * deferred to after(): the response is already a failure, and a serverless instance that
 * freezes the moment it responds would drop the only signal anyone gets.
 */
export async function withWebhookFailureAlert(
  route: TwilioWebhookRoute,
  handle: () => Promise<Response>,
  deps: WebhookAlertDeps = {},
): Promise<Response> {
  try {
    return await handle();
  } catch (err) {
    console.error('twilio webhook threw', { route, err });
    await webhookFailureAlert({ route, error: err }, deps);
    return new Response('webhook failed', { status: 500 });
  }
}
