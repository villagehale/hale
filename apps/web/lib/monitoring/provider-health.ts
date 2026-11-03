import { type AgentClient, HAIKU_MODEL } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, lt } from 'drizzle-orm';
import { postOpsSlack } from '~/lib/monitoring/ops-slack';

/**
 * VIL-255 · the LLM-provider health pre-flight, after the 2026-08-01 incident: the
 * Anthropic credit balance ran out silently, all eight families' daily briefs failed
 * at the 12:00Z window and eight infer-memory runs failed at 06:00Z, and it was found
 * by hand hours later. Nothing watched the provider.
 *
 * One cheap call BEFORE each LLM cron's per-family fan-out answers "can we reach the
 * model at all?". An INCIDENT_FAILURES answer aborts the window with a distinct outcome
 * instead of producing N identical per-family failures, and pages the founder once.
 *
 * FAIL-OPEN BY CONSTRUCTION, not by a kill switch. Only the INCIDENT_FAILURES classes abort;
 * every other failure — including anything unexpected thrown inside the probe itself —
 * classifies as `transient` and the window runs as before. So the worst a bug in this
 * file can do is post a useless #ops alert; it can never be the reason a family's brief
 * didn't arrive. That property is why there is no feature flag here to forget to turn
 * on.
 *
 * Privacy (rule #1): an ops alert carries the send WINDOW (an enum), run COUNTS, and
 * the provider's own error text. Never a family, parent, child, or message body.
 */

// ── classification ───────────────────────────────────────────────────────────

/**
 * What the provider said, in the only shapes that change what we do:
 *  - `billing`     the account cannot pay (credit balance exhausted / payment required)
 *  - `auth`        the key is wrong, revoked, or lacks permission
 *  - `usage_limit` the account hit an Anthropic spend limit (org, workspace or monthly tier cap) (VIL-552)
 *  - `quota`       rate limited (429) — real, but usually a burst
 *  - `transient`   everything else: 5xx, overload, network, and anything unrecognised
 *
 * {@link INCIDENT_FAILURES} is the one list of classes that are certain to fail for
 * EVERY family. The abort guard, the chained classifier and the turn-path page loop
 * are all derived from it, so a new incident class is one edit here.
 */
export const INCIDENT_FAILURES = ['billing', 'auth', 'usage_limit'] as const;
export type IncidentFailure = (typeof INCIDENT_FAILURES)[number];
export type ProviderFailureClass = IncidentFailure | 'quota' | 'transient';

export type ProviderHealth =
  | { ok: true }
  | { ok: false; failure: ProviderFailureClass; detail: string };

/** The LLM cron windows this pre-flight guards. */
export type SendWindow =
  | 'nudge_sweep'
  | 'memory_inference'
  | 'registration_verify'
  | 'first_reply_recovery';

/** Substrings that make a 4xx a BILLING problem rather than a bad request. Matched
 * against the provider's own message — Anthropic reports an exhausted balance as a
 * plain 400 whose only distinguishing mark is this text. */
const BILLING_MARKERS = ['credit balance', 'billing', 'purchase credits', 'payment'];

/** Anthropic's three spend-limit refusals (platform.claude.com/docs/en/api/rate-limits,
 * read 2026-11-03): the org limit, the workspace limit, and the monthly tier cap. Provider
 * text and codes, never parent text. The tier cap is told apart from an ordinary 429 by
 * its error_code only. */
const SPEND_LIMIT_REFUSALS = [
  {
    status: 400,
    type: 'invalid_request_error',
    messagePrefix: 'You have reached your specified API usage limits',
  },
  {
    status: 400,
    type: 'invalid_request_error',
    messagePrefix: 'You have reached your specified workspace API usage limits',
  },
  { status: 429, type: 'rate_limit_error', errorCode: 'enforced_spend_limit_reached' },
] as const;

/** A spend-limit refusal only when one frame matches one whole row exactly: numeric
 * status, `error.error.type`, and the exact-case message prefix or `details.error_code`.
 * Read from the structured response body only — never the composed `err.message`, so a
 * wrapper that quotes something cannot classify. Anything looser fails open. */
function isUsageLimitError(err: unknown): boolean {
  const frame = err as {
    status?: unknown;
    error?: {
      error?: { type?: unknown; message?: unknown; details?: { error_code?: unknown } | null };
    };
  } | null;
  const body = frame?.error?.error;
  return SPEND_LIMIT_REFUSALS.some(
    (shape) =>
      frame?.status === shape.status &&
      body?.type === shape.type &&
      ('messagePrefix' in shape
        ? typeof body.message === 'string' && body.message.startsWith(shape.messagePrefix)
        : body.details?.error_code === shape.errorCode),
  );
}

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
  // Before quota: the tier spend cap is a 429 that never clears on its own. Before
  // billing: a usage-limit message that also points at "Plans & Billing" still needs the
  // usage-limit remedy, not a top-up.
  if (isUsageLimitError(err)) {
    return 'usage_limit';
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
 * Whether a failure class is worth cancelling a send window over. Only the
 * {@link INCIDENT_FAILURES}, which are certain to fail for EVERY family and cannot fix
 * themselves: an empty balance, a bad key, a reached usage limit. A 429 is usually a burst and a 5xx is usually seconds long — cancelling a
 * once-a-week plan over either would cost more than the retries do. A sustained one of
 * those is caught within the hour by the failed-run backstop instead.
 */
export function abortsSendWindow(failure: ProviderFailureClass): failure is IncidentFailure {
  return (INCIDENT_FAILURES as readonly string[]).includes(failure);
}

/** How far down a `cause` chain to look. The coach wraps the SDK error once
 * (ChannelTurnFailed); the bound is what makes a cyclic cause terminate. */
const PROVIDER_CAUSE_DEPTH = 5;

/**
 * The incident class of a provider failure, looking through wrappers.
 *
 * {@link classifyProviderFailure} reads the error it is handed. A coach turn
 * wraps that error, and the wrapper has no HTTP status, so the outer frame is
 * `transient` and the 400 credit-balance body sits one `cause` down. The first
 * frame that would abort a send window wins. Quota, a 5xx, and a bug return
 * null: those are not an incident to page.
 */
export function classifyChainedProviderFailure(err: unknown): IncidentFailure | null {
  let current: unknown = err;
  for (
    let depth = 0;
    depth < PROVIDER_CAUSE_DEPTH && current !== null && current !== undefined;
    depth += 1
  ) {
    const failure = classifyProviderFailure(current);
    if (abortsSendWindow(failure)) return failure;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
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
    // No SDK retry: it retries every 429, and the tier spend cap is a 429 that keeps
    // refusing until the 1st — one refused call is the whole answer.
    await client.messages.create(
      {
        model: HAIKU_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: PROBE_INPUT }],
      },
      { maxRetries: 0 },
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, failure: classifyProviderFailure(err), detail: providerFailureDetail(err) };
  }
}

// ── incidents ────────────────────────────────────────────────────────────────

export type ProviderIncident =
  | { kind: 'preflight'; window: SendWindow; failure: ProviderFailureClass; detail: string }
  | { kind: 'run_spike'; failed: number; total: number; windowStart: Date; windowEnd: Date }
  | { kind: 'spend_threshold'; totalUsd: number; thresholdUsd: number };

/**
 * An incident's identity. Keyed on the CAUSE, not the window — one empty balance is one
 * incident whether the weekly compose or the nudge sweep noticed it first, so #ops
 * gets one post rather than one per cron.
 */
export function providerIncidentKey(incident: ProviderIncident): string {
  switch (incident.kind) {
    case 'preflight':
      return `provider_health:${incident.failure}`;
    case 'run_spike':
      return 'provider_health:run_spike';
    case 'spend_threshold':
      return 'provider_health:spend_threshold';
  }
}

/**
 * How long one incident stays deduped. A day: an outage that is still an outage
 * tomorrow morning deserves to be said again, and a fixed window keeps the claim a
 * single atomic INSERT. The honest cost of a fixed window is the boundary — an outage
 * that starts just before it rolls produces two posts. Two posts for a real outage is
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
      target: [
        schema.rateLimits.identifier,
        schema.rateLimits.route,
        schema.rateLimits.windowStart,
      ],
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
  nudge_sweep: "this hour's nudge sweep did not run.",
  memory_inference: "last night's memory inference did not run.",
  registration_verify: "this week's registration re-verify sweep did not run.",
  first_reply_recovery: 'new parents whose first text got no reply are still waiting for one.',
};

const WINDOW_LABEL: Record<SendWindow, string> = {
  nudge_sweep: 'nudge sweep',
  memory_inference: 'memory inference',
  registration_verify: 'registration re-verify',
  first_reply_recovery: 'first-reply recovery',
};

const FAILURE_EXPLANATION: Record<ProviderFailureClass, string> = {
  billing: 'the account cannot pay — an exhausted credit balance or a declined payment.',
  auth: 'the API key is rejected — wrong, revoked, or missing a permission.',
  usage_limit:
    'the account hit an Anthropic spend limit (org, workspace or monthly tier cap); every call is refused until it is raised or resets.',
  quota: 'rate limited.',
  transient: 'a temporary provider fault.',
};

const FAILURE_REMEDY: Record<ProviderFailureClass, string> = {
  billing: 'top up at console.anthropic.com → Plans & Billing, then re-run the window.',
  auth: 'check ANTHROPIC_API_KEY in the Vercel production environment, then re-run the window.',
  usage_limit:
    'raise the org or workspace spend limit in the Anthropic console (Limits) — for the monthly tier cap, move up a tier — or wait for the reset time the provider names above; then re-run the window.',
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
        `raised ${at.toISOString()}. one #ops post per incident per ${PROVIDER_INCIDENT_WINDOW_HOURS}h.`,
      ].join('\n'),
    };
  }

  if (incident.kind === 'spend_threshold') {
    const total = `$${incident.totalUsd.toFixed(2)}`;
    const threshold = `$${incident.thresholdUsd.toFixed(2)}`;
    const month = at.toISOString().slice(0, 7);
    return {
      subject: `Hale ops: Anthropic spend ${total} this month reached the ${threshold} alert`,
      text: [
        `agent_runs recorded ${total} of Anthropic spend in ${month} (UTC), at or above the ${threshold} alert.`,
        '',
        'what this is',
        '  the sum of agent_runs.cost_usd only. Lanes that write no cost row, the',
        '  pre-flight probes and eval/dev spend are not in it, so the console total is higher.',
        '',
        'what to do',
        "  check the console usage page and this month's agent_runs by agent; raise",
        '  ANTHROPIC_SPEND_ALERT_USD if this spend is expected.',
        '',
        `raised ${at.toISOString()}. one #ops post per incident per ${PROVIDER_INCIDENT_WINDOW_HOURS}h.`,
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
      `one #ops post per incident per ${PROVIDER_INCIDENT_WINDOW_HOURS}h — every other cron that`,
      'hits the same wall in that time stays quiet.',
    ].join('\n'),
  };
}

export interface ProviderAlertSender {
  /** True when Slack #ops accepted the page. */
  send(subject: string, text: string): Promise<boolean>;
}

/** The provider incident goes to Slack #ops. No founder email. */
export function createProviderAlertSender(): ProviderAlertSender {
  return {
    async send(subject, text) {
      const outcome = await postOpsSlack(`${subject}\n${text}`);
      return outcome === 'sent';
    },
  };
}

// ── orchestration ────────────────────────────────────────────────────────────

export interface ProviderHealthDeps {
  probe(client: AgentClient): Promise<ProviderHealth>;
  claim(database: Database, key: string, now: Date): Promise<boolean>;
  sender: ProviderAlertSender;
}

/** The two ports raising an incident uses. A full {@link ProviderHealthDeps} satisfies it. */
export type ProviderIncidentDeps = Pick<ProviderHealthDeps, 'claim' | 'sender'>;

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
  deps: ProviderIncidentDeps,
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
  // Always logged, whether or not the post lands — the platform log is the trail an
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
