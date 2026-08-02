import { type AgentClient, HAIKU_MODEL } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, lt } from 'drizzle-orm';
import type { Resend } from 'resend';
import { founderAddress } from '~/lib/auth/founder-signal';
import { createResendTransport } from '~/lib/channel/resend-transport';

/**
 * VIL-255 · the LLM-provider health pre-flight, after the 2026-08-01 incident: the
 * Anthropic credit balance ran out silently, all eight families' daily briefs failed
 * at the 12:00Z window and eight infer-memory runs failed at 06:00Z, and it was found
 * by hand hours later. The founder-alert machinery already existed (X1's stop-alert /
 * loop-health-digest); nothing watched the provider.
 *
 * One cheap call BEFORE each LLM cron's per-family fan-out answers "can we reach the
 * model at all?". A billing/auth answer aborts the window with a distinct outcome
 * instead of producing N identical per-family failures, and pages the founder once.
 *
 * FAIL-OPEN BY CONSTRUCTION, not by a kill switch. Only `billing` and `auth` abort;
 * every other failure — including anything unexpected thrown inside the probe itself —
 * classifies as `transient` and the window runs as before. So the worst a bug in this
 * file can do is send a useless email; it can never be the reason a family's brief
 * didn't arrive. That property is why there is no feature flag here to forget to turn
 * on.
 *
 * Privacy (rule #1): an ops alert carries the send WINDOW (an enum), run COUNTS, and
 * the provider's own error text. Never a family, parent, child, or message body.
 */

// ── classification ───────────────────────────────────────────────────────────

/**
 * What the provider said, in the only four shapes that change what we do:
 *  - `billing`   the account cannot pay (credit balance exhausted / payment required)
 *  - `auth`      the key is wrong, revoked, or lacks permission
 *  - `quota`     rate limited (429) — real, but usually a burst
 *  - `transient` everything else: 5xx, overload, network, and anything unrecognised
 */
export type ProviderFailureClass = 'billing' | 'auth' | 'quota' | 'transient';

export type ProviderHealth =
  | { ok: true }
  | { ok: false; failure: ProviderFailureClass; detail: string };

/** The LLM cron windows this pre-flight guards. */
export type SendWindow = 'daily_brief' | 'weekly_plan' | 'nudge_sweep' | 'memory_inference';

/** Substrings that make a 4xx a BILLING problem rather than a bad request. Matched
 * against the provider's own message — Anthropic reports an exhausted balance as a
 * plain 400 whose only distinguishing mark is this text. */
const BILLING_MARKERS = ['credit balance', 'billing', 'purchase credits', 'payment'];

/** The provider's own explanation: the structured `error.message` from the response
 * body when present (the SDK buries it two levels deep), else the SDK's composed
 * message, else whatever was thrown. Used both to classify and to quote in the alert. */
export function providerFailureDetail(err: unknown): string {
  const body = (err as { error?: { error?: { message?: unknown } } } | null)?.error?.error?.message;
  if (typeof body === 'string' && body.length > 0) {
    return body;
  }
  if (err instanceof Error && err.message.length > 0) {
    return err.message;
  }
  return String(err);
}

/**
 * Classify a thrown provider error by its SHAPE — the HTTP status the SDK attaches,
 * plus the response body for the one case status alone cannot separate (an exhausted
 * balance and a malformed request are both 400).
 *
 * Anything unrecognised is `transient` ON PURPOSE: an unknown failure must never be
 * the thing that cancels every family's send.
 */
export function classifyProviderFailure(err: unknown): ProviderFailureClass {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') {
    // APIConnectionError / APIConnectionTimeoutError carry no status, as does anything
    // thrown that is not an SDK error at all.
    return 'transient';
  }
  if (status === 401 || status === 403) {
    return 'auth';
  }
  if (status === 429) {
    return 'quota';
  }
  if (status === 400 || status === 402) {
    const detail = providerFailureDetail(err).toLowerCase();
    return BILLING_MARKERS.some((marker) => detail.includes(marker)) ? 'billing' : 'transient';
  }
  return 'transient';
}

/**
 * Whether a failure class is worth cancelling a send window over. Only the two that
 * are certain to fail for EVERY family and cannot fix themselves: an empty balance and
 * a bad key. A 429 is usually a burst and a 5xx is usually seconds long — cancelling a
 * once-a-week plan over either would cost more than the retries do. A sustained one of
 * those is caught within the hour by the failed-run backstop instead.
 */
export function abortsSendWindow(failure: ProviderFailureClass): boolean {
  return failure === 'billing' || failure === 'auth';
}

// ── the probe ────────────────────────────────────────────────────────────────

/**
 * The smallest thing that still proves the account can reach the model: the cheapest
 * tier, one output token. Not a prompt (rule #2) — the content is never read, the
 * response is discarded, and any single character would do the same job. It carries no
 * authored semantics to version, so it has nothing to sync from Langfuse.
 */
const PROBE_INPUT = '.';

export async function probeProviderHealth(client: AgentClient): Promise<ProviderHealth> {
  try {
    await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 1,
      messages: [{ role: 'user', content: PROBE_INPUT }],
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, failure: classifyProviderFailure(err), detail: providerFailureDetail(err) };
  }
}

// ── incidents ────────────────────────────────────────────────────────────────

export type ProviderIncident =
  | { kind: 'preflight'; window: SendWindow; failure: ProviderFailureClass; detail: string }
  | { kind: 'run_spike'; failed: number; total: number; windowStart: Date; windowEnd: Date };

/**
 * An incident's identity. Keyed on the CAUSE, not the window — one empty balance is one
 * incident whether the digest, the weekly compose, or the nudge sweep noticed it first,
 * so the founder gets one email rather than one per cron.
 */
export function providerIncidentKey(incident: ProviderIncident): string {
  return incident.kind === 'preflight'
    ? `provider_health:${incident.failure}`
    : 'provider_health:run_spike';
}

/**
 * How long one incident stays deduped. A day: an outage that is still an outage
 * tomorrow morning deserves to be said again, and a fixed window keeps the claim a
 * single atomic INSERT. The honest cost of a fixed window is the boundary — an outage
 * that starts just before it rolls produces two emails. Two emails for a real outage is
 * the right side of that trade.
 */
export const PROVIDER_INCIDENT_WINDOW_HOURS = 24;

/** The rate_limits `route` these claims live under. Exported so the weekly founder
 * digest can read the same rows back as the week's incident history. */
export const PROVIDER_INCIDENT_ROUTE = 'ops:provider-health';

/** How long a claim row is kept. Long enough for the weekly founder digest to report
 * the week's incidents from these same rows, short enough that the table stays a
 * handful of rows. Retention is housekeeping only — the claim's exactly-once property
 * comes from the unique index, never from the sweep. */
const PROVIDER_INCIDENT_RETENTION_DAYS = 7;

/**
 * Claim the right to alert about `key` in the current incident window; true exactly
 * once per window, for the caller that got there first.
 *
 * Storage choice: `rate_limits`, not a new table and not `audit_log`. audit_log,
 * channel_messages and email_sends all require a family/user — this is an ops event
 * with neither. rate_limits is the one existing store that is family-independent and
 * whose (identifier, route, window_start) unique index makes "first writer in this
 * window wins" a single atomic statement, so two crons firing in the same minute cannot
 * both email. Zero migration; a retention sweep on write keeps it to a handful of rows.
 */
export async function claimProviderIncident(
  database: Database,
  key: string,
  now: Date,
): Promise<boolean> {
  const windowMs = PROVIDER_INCIDENT_WINDOW_HOURS * 3_600_000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);

  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, PROVIDER_INCIDENT_ROUTE),
        lt(
          schema.rateLimits.windowStart,
          new Date(now.getTime() - PROVIDER_INCIDENT_RETENTION_DAYS * 86_400_000),
        ),
      ),
    );

  const claimed = await database
    .insert(schema.rateLimits)
    .values({ identifier: key, route: PROVIDER_INCIDENT_ROUTE, windowStart, count: 1 })
    .onConflictDoNothing({
      target: [schema.rateLimits.identifier, schema.rateLimits.route, schema.rateLimits.windowStart],
    })
    .returning({ id: schema.rateLimits.id });

  return claimed.length > 0;
}

/** The class an incident key names, for reporting: 'provider_health:billing' → 'billing'. */
export function providerIncidentKind(key: string): string {
  return key.startsWith('provider_health:') ? key.slice('provider_health:'.length) : key;
}

// ── the alert ────────────────────────────────────────────────────────────────

const WINDOW_HEADLINE: Record<SendWindow, string> = {
  daily_brief: "this morning's briefs did not send.",
  weekly_plan: "this hour's weekly-plan compose did not run.",
  nudge_sweep: "this hour's nudge sweep did not run.",
  memory_inference: "last night's memory inference did not run.",
};

const WINDOW_LABEL: Record<SendWindow, string> = {
  daily_brief: 'daily brief',
  weekly_plan: 'weekly plan',
  nudge_sweep: 'nudge sweep',
  memory_inference: 'memory inference',
};

const FAILURE_EXPLANATION: Record<ProviderFailureClass, string> = {
  billing: 'the account cannot pay — an exhausted credit balance or a declined payment.',
  auth: 'the API key is rejected — wrong, revoked, or missing a permission.',
  quota: 'rate limited.',
  transient: 'a temporary provider fault.',
};

const FAILURE_REMEDY: Record<ProviderFailureClass, string> = {
  billing: 'top up at console.anthropic.com → Plans & Billing, then re-run the window.',
  auth: 'check ANTHROPIC_API_KEY in the Vercel production environment, then re-run the window.',
  quota: 'no action if it clears on its own; raise the rate limit if it does not.',
  transient: 'no action — the next window retries.',
};

/** The alert body. Pure, so the wording is tested directly. Quiet-operator order: what
 * did not happen, why, what Hale did about it, what you do next. */
export function formatProviderAlert(
  incident: ProviderIncident,
  at: Date,
): { subject: string; text: string } {
  if (incident.kind === 'run_spike') {
    return {
      subject: `Hale ops: ${incident.failed} of ${incident.total} agent runs failed in the last hour`,
      text: [
        `${incident.failed} of ${incident.total} agent runs failed in the window that just closed.`,
        '',
        'window',
        `  ${incident.windowStart.toISOString()} → ${incident.windowEnd.toISOString()}`,
        '',
        'what this is',
        '  the backstop, not the pre-flight: the provider answered the health check, so',
        '  this is something the check cannot see — a bad deploy, a skill/prompt change,',
        '  a tool failure, or a provider fault that started mid-window.',
        '',
        'what to do',
        '  read the failed runs in agent_runs for this window and the Langfuse traces',
        '  they carry.',
        '',
        `raised ${at.toISOString()}. one email per incident per ${PROVIDER_INCIDENT_WINDOW_HOURS}h.`,
      ].join('\n'),
    };
  }

  return {
    subject: `Hale ops: ${WINDOW_LABEL[incident.window]} did not send — Anthropic ${incident.failure}`,
    text: [
      WINDOW_HEADLINE[incident.window],
      '',
      'why',
      `  the pre-flight check against Anthropic failed at ${at.toISOString()}.`,
      `  classification: ${incident.failure} — ${FAILURE_EXPLANATION[incident.failure]}`,
      `  the provider said: ${incident.detail}`,
      '',
      'what Hale did',
      '  aborted the window before composing anything, so no family got a half-brief and',
      '  no per-family spend was attempted. Nothing was sent; nothing was charged.',
      '',
      'what to do',
      `  ${FAILURE_REMEDY[incident.failure]}`,
      '',
      `one email per incident per ${PROVIDER_INCIDENT_WINDOW_HOURS}h — every other cron that`,
      'hits the same wall in that time stays quiet.',
    ].join('\n'),
  };
}

const DEFAULT_FROM = 'Hale <aloha@villagehale.com>';

export interface ProviderAlertSender {
  /** True when the provider accepted the alert; false when skipped (no founder address
   * configured, or no Resend key and no injected client). */
  send(subject: string, text: string): Promise<boolean>;
}

/** Mirrors the X1 stop-alert / loop-health-digest sender exactly: same aloha@ identity,
 * same injectable client, same best-effort contract. */
export function createProviderAlertSender(client?: Resend): ProviderAlertSender {
  return {
    async send(subject, text) {
      const to = founderAddress();
      if (!to) {
        return false;
      }
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey && !client) {
        return false;
      }
      const transport = createResendTransport({ apiKey, client });
      const from = process.env.WELCOME_FROM ?? DEFAULT_FROM;
      const { error } = await transport.send({ from, to, subject, text });
      return !error;
    },
  };
}

// ── orchestration ────────────────────────────────────────────────────────────

export interface ProviderHealthDeps {
  probe(client: AgentClient): Promise<ProviderHealth>;
  claim(database: Database, key: string, now: Date): Promise<boolean>;
  sender: ProviderAlertSender;
}

export function defaultProviderHealthDeps(): ProviderHealthDeps {
  return {
    probe: probeProviderHealth,
    claim: claimProviderIncident,
    sender: createProviderAlertSender(),
  };
}

export interface ProviderAlertOutcome {
  alerted: boolean;
  /** True when another cron already alerted about this incident in the window. */
  deduped: boolean;
}

/**
 * Page the founder about `incident`, at most once per incident window. Best-effort by
 * contract: a failure to send an alert is logged, never thrown — the caller is already
 * handling an outage and must not acquire a second one.
 */
export async function raiseProviderIncident(
  database: Database,
  incident: ProviderIncident,
  deps: ProviderHealthDeps,
  now: Date,
): Promise<ProviderAlertOutcome> {
  const key = providerIncidentKey(incident);
  let won: boolean;
  try {
    won = await deps.claim(database, key, now);
  } catch (err) {
    logAlertFailure('provider incident claim failed', err);
    return { alerted: false, deduped: false };
  }
  if (!won) {
    return { alerted: false, deduped: true };
  }

  const { subject, text } = formatProviderAlert(incident, now);
  // Always logged, whether or not the email lands — the platform log is the trail an
  // ops event gets (audit_log is family-scoped by schema and this event has no family).
  console.error({ incident: { ...incident, key } }, subject);
  try {
    return { alerted: await deps.sender.send(subject, text), deduped: false };
  } catch (err) {
    logAlertFailure('provider incident alert failed', err);
    return { alerted: false, deduped: false };
  }
}

function logAlertFailure(what: string, err: unknown): void {
  console.error(what, { message: err instanceof Error ? err.message : 'unknown error' });
}

/** Why a window was cancelled — the shape each cron reports back in its own result, so
 * the run's JSON says what did not happen and why instead of an empty success. */
export interface ProviderAbort {
  failure: ProviderFailureClass;
  detail: string;
  alerted: boolean;
}

/** What a cron reports when its window was cancelled: the cause, plus how many families
 * it would have run — so an aborted run is legible as a skipped batch rather than an
 * empty one. */
export interface AbortedWindow extends ProviderAbort {
  skipped: number;
}

export type ProviderPreflightResult =
  /** `health` is null when the cron had no LLM client this run, so nothing was probed. */
  | { proceed: true; health: ProviderHealth | null }
  /** The provider certainly cannot serve ANY family this window. */
  | { proceed: false; abort: ProviderAbort };

/**
 * The one call each LLM cron makes before its per-family fan-out. `client` is null for
 * the crons whose model stage is optional (a kill switch, or no key): there is nothing
 * to probe and nothing to protect, so the run proceeds untouched.
 */
export async function providerPreflight(
  database: Database,
  window: SendWindow,
  client: AgentClient | null,
  now: Date = new Date(),
  deps: ProviderHealthDeps = defaultProviderHealthDeps(),
): Promise<ProviderPreflightResult> {
  if (!client) {
    return { proceed: true, health: null };
  }

  const health = await deps.probe(client);
  if (health.ok || !abortsSendWindow(health.failure)) {
    return { proceed: true, health };
  }

  const { alerted } = await raiseProviderIncident(
    database,
    { kind: 'preflight', window, failure: health.failure, detail: health.detail },
    deps,
    now,
  );
  return { proceed: false, abort: { failure: health.failure, detail: health.detail, alerted } };
}
