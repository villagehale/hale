import { type Database, schema } from '@hale/db';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import {
  ALERTS_URL,
  credentials,
} from '~/lib/admin/services/twilio';
import { SERVICE_TIMEOUT_MS, notConfigured, type ServiceOutcome, unreachable } from '~/lib/admin/services/outcome';
import { ALERT_FROM_NUMBER } from '~/lib/channel/twilio/alert';
import {
  type LikelyLayer,
  type MonitorAlert,
  type OutboundHealth,
  type TriageClass,
  composeTriageDigest,
  triageAlerts,
} from '~/lib/channel/twilio/triage';

/**
 * VIL-331 · the alert-triage cron: poll Twilio's Monitor Alerts log every ten
 * minutes and turn a burst of webhook failures into ONE founder diagnosis SMS —
 * which class of failure, since when, which layer to suspect, what to check —
 * instead of a page per inbound message or nothing at all.
 *
 * It complements lib/channel/twilio/alert.ts, not replaces it: the boundary alert
 * is the DB-independent floor that fires from inside the failing request; this cron
 * is the richer picture from Twilio's side (it sees 403s and timeouts the route
 * never got to throw on). Both can page in the same incident; both are rate-limited.
 *
 * Cursor + dedupe live in `rate_limits` (the one family-independent store, the
 * choice claimProviderIncident documents) under route 'ops:twilio-triage': a
 * `cursor` row whose window_start IS the newest-reported-alert time, and a `digest`
 * row claimed once per 30-minute window. Zero migration.
 *
 * Decided, not inherited (the provider-health claim chooses claim-failure → no
 * alert): the dedupe store here is the SAME database whose outage is the crash_5xx
 * diagnosis, so a FAILED claim read still pages, braked only by a per-instance
 * 30-minute window, and the degraded store is named in the result
 * (`rateLimitStore: 'unavailable'`). Rule #11 throughout: every path out of this
 * module is a named outcome.
 */

export const TRIAGE_CLAIM_ROUTE = 'ops:twilio-triage';
const CURSOR_IDENTIFIER = 'cursor';
const DIGEST_IDENTIFIER = 'digest';

/** One diagnosis SMS per half hour: long enough not to double-page a single
 * incident the 10-minute cron sees three times, short enough that a NEW wave inside
 * the same hour is still reported. */
export const TRIAGE_DIGEST_WINDOW_MS = 30 * 60_000;

/** With no cursor (first run, or the store is down), only the trailing hour is
 * eligible — an old, already-paged incident must not replay. */
const TRIAGE_LOOKBACK_MS = 60 * 60_000;

/** Digest-claim retention, mirroring provider-health: housekeeping only — the
 * exactly-once property is the unique index, never the sweep. */
const RETENTION_DAYS = 7;

/** The wrapped webhook routes the boundary alert guards — the alerts this cron
 * diagnoses. */
const WEBHOOK_PATH_PREFIX = '/api/channels/twilio/';

/** How far back the outbound probe looks for landed sends. */
const OUTBOUND_WINDOW_MS = 15 * 60_000;

const SMS_TIMEOUT_MS = 4_000;

export type CursorOutcome = 'advanced' | 'unchanged' | 'store_unavailable';

export type TriageRunOutcome =
  | { outcome: 'skipped_not_configured'; missing: string[] }
  | { outcome: 'monitor_unreachable'; detail: string }
  | { outcome: 'no_new_alerts'; ignoredOtherAlerts: number; cursor: CursorOutcome }
  | {
      outcome: 'digest_sent';
      alerts: number;
      class: TriageClass;
      likelyLayer: LikelyLayer;
      evidence: string[];
      rateLimitStore: 'ok' | 'unavailable';
      cursor: CursorOutcome;
    }
  | { outcome: 'suppressed_rate_limit'; source: 'claim' | 'instance_window'; pendingAlerts: number }
  | { outcome: 'digest_send_failed'; alerts: number; class: TriageClass };

export interface TwilioTriageDeps {
  configured(): { ok: true } | { ok: false; missing: string[] };
  fetchAlerts(): Promise<ServiceOutcome<MonitorAlert[]>>;
  loadCursor(database: Database): Promise<Date | null>;
  advanceCursor(database: Database, to: Date): Promise<void>;
  /** True exactly once per digest window — first claimer pages. */
  claimWindow(database: Database, now: Date): Promise<boolean>;
  outboundSentCount(database: Database, since: Date): Promise<number>;
  sendSms(body: string): Promise<'sent' | 'failed' | 'skipped_not_configured'>;
}

/** The per-instance brake for the day the claim store is down — same shape as the
 * boundary alert's window, and like it, spent on the ATTEMPT. */
let lastDigestAttemptAt: number | null = null;

export function resetTriageInstanceWindowForTests(): void {
  lastDigestAttemptAt = null;
}

function isWebhookAlert(alert: MonitorAlert): boolean {
  if (!alert.request_url) {
    return false;
  }
  try {
    return new URL(alert.request_url).pathname.startsWith(WEBHOOK_PATH_PREFIX);
  } catch {
    return false;
  }
}

function createdAt(alert: MonitorAlert): number | null {
  const at = Date.parse(alert.date_created ?? '');
  return Number.isFinite(at) ? at : null;
}

export async function runTwilioTriage(
  database: Database,
  deps: TwilioTriageDeps,
  now: Date,
): Promise<TriageRunOutcome> {
  const config = deps.configured();
  if (!config.ok) {
    console.error('twilio triage: not configured — nobody is watching the alert log', {
      missing: config.missing,
    });
    return { outcome: 'skipped_not_configured', missing: config.missing };
  }

  let cursor: Date | null = null;
  let cursorStore: 'ok' | 'unavailable' = 'ok';
  try {
    cursor = await deps.loadCursor(database);
  } catch (err) {
    cursorStore = 'unavailable';
    console.error('twilio triage: cursor load failed — degrading to the lookback window', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  const since = Math.max(cursor?.getTime() ?? 0, now.getTime() - TRIAGE_LOOKBACK_MS);

  const fetched = await deps.fetchAlerts();
  if (!fetched.ok) {
    if (fetched.status === 'not_configured') {
      return { outcome: 'skipped_not_configured', missing: [fetched.detail] };
    }
    console.error('twilio triage: Monitor API unreachable — the webhook may be failing unseen', {
      detail: fetched.detail,
    });
    return { outcome: 'monitor_unreachable', detail: fetched.detail };
  }

  const newAlerts = fetched.data.filter((alert) => {
    const at = createdAt(alert);
    return at !== null && at > since;
  });
  const webhookAlerts = newAlerts.filter(isWebhookAlert);
  // biome-ignore lint/style/noNonNullAssertion: newAlerts kept only parseable dates
  const newestAt = newAlerts.length
    ? new Date(Math.max(...newAlerts.map((alert) => createdAt(alert)!)))
    : null;

  const advance = async (): Promise<CursorOutcome> => {
    if (!newestAt) {
      return 'unchanged';
    }
    try {
      await deps.advanceCursor(database, newestAt);
      return 'advanced';
    } catch (err) {
      console.error('twilio triage: cursor advance failed — next run re-reads this window', {
        err: err instanceof Error ? err.name : 'unknown',
      });
      return 'store_unavailable';
    }
  };

  if (webhookAlerts.length === 0) {
    return {
      outcome: 'no_new_alerts',
      ignoredOtherAlerts: newAlerts.length,
      cursor: newAlerts.length ? await advance() : cursorStore === 'ok' ? 'unchanged' : 'store_unavailable',
    };
  }

  const summary = triageAlerts(webhookAlerts);
  let outbound: OutboundHealth = 'unchecked';
  try {
    const sent = await deps.outboundSentCount(database, new Date(now.getTime() - OUTBOUND_WINDOW_MS));
    outbound = sent > 0 ? 'ok' : 'quiet';
  } catch (err) {
    console.error('twilio triage: outbound probe failed — reporting unchecked', {
      err: err instanceof Error ? err.name : 'unknown',
    });
  }
  const body = composeTriageDigest(summary, outbound);

  let rateLimitStore: 'ok' | 'unavailable' = 'ok';
  let won: boolean;
  try {
    won = await deps.claimWindow(database, now);
  } catch (err) {
    // The store that dedupes this page is the database whose outage we may be
    // diagnosing. Decided here (see module doc): page anyway, braked per instance.
    rateLimitStore = 'unavailable';
    console.error('twilio triage: digest claim failed — paging on the instance window', {
      err: err instanceof Error ? err.name : 'unknown',
    });
    won =
      lastDigestAttemptAt === null || now.getTime() - lastDigestAttemptAt >= TRIAGE_DIGEST_WINDOW_MS;
    if (!won) {
      return {
        outcome: 'suppressed_rate_limit',
        source: 'instance_window',
        pendingAlerts: summary.total,
      };
    }
  }
  if (!won) {
    return { outcome: 'suppressed_rate_limit', source: 'claim', pendingAlerts: summary.total };
  }

  lastDigestAttemptAt = now.getTime();
  const sms = await deps.sendSms(body);
  if (sms !== 'sent') {
    console.error('twilio triage: digest SMS not delivered', {
      sms,
      class: summary.dominant.class,
      alerts: summary.total,
    });
    if (sms === 'skipped_not_configured') {
      return { outcome: 'skipped_not_configured', missing: ['FOUNDER_ALERT_PHONE'] };
    }
    return { outcome: 'digest_send_failed', alerts: summary.total, class: summary.dominant.class };
  }

  console.error('twilio triage: founder paged', {
    class: summary.dominant.class,
    likelyLayer: summary.dominant.likelyLayer,
    alerts: summary.total,
    evidence: summary.dominant.evidence,
  });
  return {
    outcome: 'digest_sent',
    alerts: summary.total,
    class: summary.dominant.class,
    likelyLayer: summary.dominant.likelyLayer,
    evidence: summary.dominant.evidence,
    rateLimitStore,
    cursor: await advance(),
  };
}

// ── the rate_limits store ────────────────────────────────────────────────────

export async function loadTriageCursor(database: Database): Promise<Date | null> {
  const rows = await database
    .select({ windowStart: schema.rateLimits.windowStart })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, TRIAGE_CLAIM_ROUTE),
        eq(schema.rateLimits.identifier, CURSOR_IDENTIFIER),
      ),
    )
    .orderBy(desc(schema.rateLimits.windowStart))
    .limit(1);
  return rows[0]?.windowStart ?? null;
}

/** The cursor is a rate_limits row whose window_start IS the newest reported alert
 * time. Insert-then-sweep keeps at least one row at all times. */
export async function advanceTriageCursor(database: Database, to: Date): Promise<void> {
  await database
    .insert(schema.rateLimits)
    .values({ identifier: CURSOR_IDENTIFIER, route: TRIAGE_CLAIM_ROUTE, windowStart: to, count: 0 })
    .onConflictDoNothing({
      target: [schema.rateLimits.identifier, schema.rateLimits.route, schema.rateLimits.windowStart],
    })
    .returning({ id: schema.rateLimits.id });
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, TRIAGE_CLAIM_ROUTE),
        eq(schema.rateLimits.identifier, CURSOR_IDENTIFIER),
        lt(schema.rateLimits.windowStart, to),
      ),
    );
}

/** First claimer of the 30-minute window pages; everyone else is
 * suppressed_rate_limit. Same atomic-INSERT shape as claimProviderIncident, scoped
 * to the digest identifier so the sweep can never eat the cursor row. */
export async function claimTriageDigestWindow(database: Database, now: Date): Promise<boolean> {
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, TRIAGE_CLAIM_ROUTE),
        eq(schema.rateLimits.identifier, DIGEST_IDENTIFIER),
        lt(schema.rateLimits.windowStart, new Date(now.getTime() - RETENTION_DAYS * 86_400_000)),
      ),
    );
  const windowStart = new Date(
    Math.floor(now.getTime() / TRIAGE_DIGEST_WINDOW_MS) * TRIAGE_DIGEST_WINDOW_MS,
  );
  const claimed = await database
    .insert(schema.rateLimits)
    .values({ identifier: DIGEST_IDENTIFIER, route: TRIAGE_CLAIM_ROUTE, windowStart, count: 1 })
    .onConflictDoNothing({
      target: [schema.rateLimits.identifier, schema.rateLimits.route, schema.rateLimits.windowStart],
    })
    .returning({ id: schema.rateLimits.id });
  return claimed.length > 0;
}

// ── default deps ─────────────────────────────────────────────────────────────

/** The SMS leg mirrors lib/channel/twilio/alert.ts: raw Messages.json POST from the
 * brand number, env-only config, timeout, named refusal. */
async function sendTriageSms(
  body: string,
  fetchImpl: typeof fetch,
): Promise<'sent' | 'failed' | 'skipped_not_configured'> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const to = process.env.FOUNDER_ALERT_PHONE?.trim();
  if (!accountSid || !authToken || !to) {
    return 'skipped_not_configured';
  }
  const form = new URLSearchParams({ To: to, From: ALERT_FROM_NUMBER, Body: body });
  try {
    const response = await fetchImpl(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
        signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      console.error('twilio triage: SMS refused', { status: response.status });
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error('twilio triage: SMS threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
    return 'failed';
  }
}

/** The raw Monitor Alerts read — same URL, creds precedence and rule-#11 union as
 * the admin portal's fetchTwilioAlerts, but keeping the fields triage classifies on
 * (that one maps rows down to the display shape). */
async function fetchMonitorAlerts(fetchImpl: typeof fetch): Promise<ServiceOutcome<MonitorAlert[]>> {
  const creds = credentials();
  if (!creds) {
    return notConfigured('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set');
  }
  try {
    const res = await fetchImpl(ALERTS_URL, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    });
    if (!res.ok) {
      return unreachable(`Twilio answered ${res.status}`);
    }
    const body = (await res.json()) as { alerts?: MonitorAlert[] };
    return { ok: true, data: body.alerts ?? [] };
  } catch (error) {
    return unreachable(error instanceof Error ? error.name : 'fetch failed');
  }
}

export function defaultTwilioTriageDeps(fetchImpl: typeof fetch = fetch): TwilioTriageDeps {
  return {
    configured() {
      const missing = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'FOUNDER_ALERT_PHONE'].filter(
        (name) => !process.env[name]?.trim(),
      );
      return missing.length === 0 ? { ok: true } : { ok: false, missing };
    },
    fetchAlerts: () => fetchMonitorAlerts(fetchImpl),
    loadCursor: loadTriageCursor,
    advanceCursor: advanceTriageCursor,
    claimWindow: claimTriageDigestWindow,
    async outboundSentCount(database, sinceAt) {
      const m = schema.channelMessages;
      const rows = await database
        .select({ n: sql<number>`count(*)::int` })
        .from(m)
        .where(
          sql`${m.direction} = 'out' and ${m.status} in ('sent', 'delivered') and ${m.createdAt} >= ${sinceAt}`,
        );
      return rows[0]?.n ?? 0;
    },
    sendSms: (body) => sendTriageSms(body, fetchImpl),
  };
}
