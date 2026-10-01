import { buildEvent } from '~/lib/analytics/events';
import { type OpsPageOutcome, postOpsSlack } from '~/lib/monitoring/ops-slack';

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
 * The page goes to Slack #ops (`postOpsSlack`). It does not text a founder phone.
 * Parent-facing Twilio and Linq sends are a different door and are not this module.
 *
 * Privacy (rule #1). The Slack page carries a route name and an error class only.
 * The PostHog event carries a route name and an error class and NOTHING ELSE — a
 * message can echo whatever the failing statement was handling, and PostHog is a third
 * party. The scrub is structural rather than a convention: no parameter of this
 * function can carry a parent's text, and the error message is never placed in the page.
 *
 * Rule #11. Neither leg is allowed to quietly do nothing: an absent Slack webhook and a
 * refused request are named outcomes, logged, and both are returned to the caller.
 */

/** The webhooks that can 500 anonymously. One token per route, snake_case so it reads
 * the same in an SMS, a log line and a PostHog property. The union is EVERY inbound
 * provider door, not just Twilio's: the boundary belongs to the seam type (a webhook
 * that can throw before its first ledger write), and a door this type cannot name is
 * a door the invariant cannot cover — which is exactly how the email route shipped
 * without it (audit P1-5a; webhook-boundary.test.ts holds the inventory). */
export type WebhookRoute =
  | 'twilio_inbound'
  | 'twilio_status'
  | 'email_inbound'
  | 'linq_inbound';

export type AnalyticsAlertOutcome = 'sent' | 'skipped_not_configured' | 'failed';

export interface WebhookAlertOutcome {
  readonly page: OpsPageOutcome | 'suppressed_rate_limit';
  readonly analytics: AnalyticsAlertOutcome;
}

export interface WebhookAlertDeps {
  /** Injected for tests; defaults to the platform fetch. */
  fetch?: typeof fetch;
}

const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/** The alert sits on the failure path of a webhook Twilio gives 15s, and the caller
 * still owes Twilio a 500 afterwards — so a hung provider must lose seconds, not the
 * response. */
const ALERT_TIMEOUT_MS = 4_000;

/** One founder page per instance per window: the incident that motivated this fired on
 * every inbound message for six hours. */
const FOUNDER_PAGE_MIN_INTERVAL_MS = 15 * 60 * 1_000;

/** Spent on the ATTEMPT rather than on delivery: an unconfigured or refusing Slack
 * webhook must not produce a log line per inbound message for six hours either. */
let lastFounderPageAttemptAt: number | null = null;

/** Test seam: the window above is module state and would otherwise leak between cases. */
export function resetWebhookAlertWindowForTests(): void {
  lastFounderPageAttemptAt = null;
}

function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

async function sendFounderPage(
  route: WebhookRoute,
  error: unknown,
  doFetch: typeof fetch,
): Promise<WebhookAlertOutcome['page']> {
  const now = Date.now();
  if (
    lastFounderPageAttemptAt !== null &&
    now - lastFounderPageAttemptAt < FOUNDER_PAGE_MIN_INTERVAL_MS
  ) {
    return 'suppressed_rate_limit';
  }
  lastFounderPageAttemptAt = now;

  // Route + error CLASS only, never the message: a DB error string can embed a
  // parent's own words ("insert failed for ...: is Nora ok?"), and no scrub of
  // free text is airtight (416-555-1234 slips a digit-run filter). The full
  // message goes to console.error at the boundary; the class is enough to page.
  const text = `Hale ALERT: ${route} threw - ${errorClass(error)}. Details in logs + PostHog.`;
  const page = await postOpsSlack(text, doFetch);
  if (page !== 'sent') {
    console.error('webhook alert: founder page not delivered', { route, page });
  }
  return page;
}

async function captureFailure(
  route: WebhookRoute,
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
 * Page ops in Slack and record the failure. Never throws; both legs run in parallel
 * and each reports what it did. Does not send SMS.
 */
export async function webhookFailureAlert(
  input: { route: WebhookRoute; error: unknown },
  deps: WebhookAlertDeps = {},
): Promise<WebhookAlertOutcome> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const [page, analytics] = await Promise.all([
    sendFounderPage(input.route, input.error, doFetch),
    captureFailure(input.route, input.error, doFetch),
  ]);
  return { page, analytics };
}

/**
 * The route boundary for every inbound provider webhook — the one layer allowed to
 * catch (rule #8), and the reason it lives here rather than being copied into the
 * route shells.
 *
 * The answer STAYS a 500. Twilio's SmsFallbackUrl retries on a 5xx and on nothing else,
 * and svix (the email door) retries on any non-2xx — so softening this into a 200 would
 * trade a visible failure for a permanently lost message on either door, exactly the
 * leads the incident cost. The alert is AWAITED rather than deferred to after(): the
 * response is already a failure, and a serverless instance that freezes the moment it
 * responds would drop the only signal anyone gets.
 */
export async function withWebhookFailureAlert(
  route: WebhookRoute,
  handle: () => Promise<Response>,
  deps: WebhookAlertDeps = {},
): Promise<Response> {
  try {
    return await handle();
  } catch (err) {
    console.error('channel webhook threw', { route, err });
    await webhookFailureAlert({ route, error: err }, deps);
    return new Response('webhook failed', { status: 500 });
  }
}
