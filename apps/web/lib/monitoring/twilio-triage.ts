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
import { escalateDigestSendFailure } from './provider-health';

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

/** How many Monitor pages one run may follow back toward the cursor (PageSize=50, so
 * 250 alerts). A burst of alerts about something ELSE — a 30007 carrier-filter storm
 * fills a page in minutes — must not be able to push webhook failures off page one
 * and out of sight; an UNBOUNDED follow would let that same storm hold the cron open
 * instead, so the scan stops here and says so. */
const MAX_ALERT_PAGES = 5;

export type CursorOutcome = 'advanced' | 'unchanged' | 'store_unavailable';

/** Whether the poll read back to the cursor, or the page cap cut it short with older
 * alerts still unread — a truncated scan can never be reported as "nothing happened". */
export type ScanCoverage = 'complete' | 'truncated_scan';

/** One poll of the Monitor log: the alerts actually read, and whether anything was
 * left behind them. */
export interface AlertScan {
  alerts: MonitorAlert[];
  truncated: boolean;
}

export type TriageRunOutcome =
  | { outcome: 'skipped_not_configured'; missing: string[] }
  | { outcome: 'monitor_unreachable'; detail: string }
  | {
      outcome: 'no_new_alerts';
      ignoredOtherAlerts: number;
      scan: ScanCoverage;
      cursor: CursorOutcome;
    }
  | {
      outcome: 'digest_sent';
      alerts: number;
      class: TriageClass;
      likelyLayer: LikelyLayer;
      evidence: string[];
      rateLimitStore: 'ok' | 'unavailable';
      scan: ScanCoverage;
      cursor: CursorOutcome;
    }
  | { outcome: 'suppressed_rate_limit'; source: 'claim' | 'instance_window'; pendingAlerts: number }
  | { outcome: 'digest_send_failed'; alerts: number; class: TriageClass };

export interface TwilioTriageDeps {
  configured(): { ok: true } | { ok: false; missing: string[] };
  /** Reads the Monitor log back to `since`, newest page first. */
  fetchAlerts(since: Date): Promise<ServiceOutcome<AlertScan>>;
  loadCursor(database: Database): Promise<Date | null>;
  advanceCursor(database: Database, to: Date): Promise<void>;
  /** True exactly once per digest window — first claimer pages. */
  claimWindow(database: Database, now: Date): Promise<boolean>;
  outboundSentCount(database: Database, since: Date): Promise<number>;
  sendSms(body: string): Promise<'sent' | 'failed' | 'skipped_not_configured'>;
  /** Escalate a failed digest SMS through the ops seam (provider-health incident →
   * founder EMAIL — deliberately the other transport, since the thing that just
   * failed is a founder SMS). Required (rule #11): a page that died as a console
   * line is the 2026-09-03 audit's exact finding. */
  escalateDigestFailure(database: Database, reason: string, now: Date): Promise<void>;
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

  const fetched = await deps.fetchAlerts(new Date(since));
  if (!fetched.ok) {
    if (fetched.status === 'not_configured') {
      return { outcome: 'skipped_not_configured', missing: [fetched.detail] };
    }
    console.error('twilio triage: Monitor API unreachable — the webhook may be failing unseen', {
      detail: fetched.detail,
    });
    return { outcome: 'monitor_unreachable', detail: fetched.detail };
  }

  const scan: ScanCoverage = fetched.data.truncated ? 'truncated_scan' : 'complete';
  if (fetched.data.truncated) {
    console.error('twilio triage: scan hit the page cap — older alerts went unread this run', {
      scanned: fetched.data.alerts.length,
    });
  }

  const newAlerts = fetched.data.alerts.filter((alert) => {
    const at = createdAt(alert);
    return at !== null && at > since;
  });
  const webhookAlerts = newAlerts.filter(isWebhookAlert);
  const newTimestamps = newAlerts
    .map((alert) => createdAt(alert))
    .filter((at): at is number => at !== null);
  // The cursor claims "everything up to here has been reported". A truncated scan may
  // only claim as far as the OLDEST alert it actually read: advancing to the newest
  // would step the cursor over the unread pages behind it, and those alerts — the
  // webhook failure a carrier-error burst pushed off page one — would never be seen.
  const cursorTarget = newTimestamps.length
    ? new Date(fetched.data.truncated ? Math.min(...newTimestamps) : Math.max(...newTimestamps))
    : null;

  const advance = async (): Promise<CursorOutcome> => {
    if (!cursorTarget) {
      return 'unchanged';
    }
    try {
      await deps.advanceCursor(database, cursorTarget);
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
      scan,
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
    // Escalated over the OTHER transport (founder email via the provider-health
    // seam): the failed page said webhooks are failing, and the failure of the page
    // itself must not end as a console line in a response nobody reads.
    await deps.escalateDigestFailure(database, 'provider_error', now);
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
    scan,
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
 * brand number, env-only config, timeout, named refusal. Exported as the shared
 * founder ops-SMS sender — delivery-health pages through this same leg rather than
 * growing a third copy. */
export async function sendFounderOpsSms(
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
      console.error('founder ops SMS refused', { status: response.status });
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error('founder ops SMS threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
    return 'failed';
  }
}

/** The raw Monitor Alerts read — same creds precedence and rule-#11 union as the
 * admin portal's fetchTwilioAlerts, but keeping the fields triage classifies on (that
 * one maps rows down to the display shape) and, unlike it, reading past page one.
 *
 * Twilio answers newest-first and links older pages with `meta.next_page_url`, so the
 * scan follows that link until it reaches an alert `since` already covers — one page
 * on a quiet poll, more only while alerts are actually piling up — or MAX_ALERT_PAGES
 * cuts it short, which is reported as `truncated` rather than passed off as the whole
 * story. */
export async function fetchMonitorAlerts(
  fetchImpl: typeof fetch,
  since: Date,
): Promise<ServiceOutcome<AlertScan>> {
  const creds = credentials();
  if (!creds) {
    return notConfigured('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set');
  }
  const headers = {
    Authorization: `Basic ${Buffer.from(`${creds.user}:${creds.pass}`).toString('base64')}`,
  };
  const alerts: MonitorAlert[] = [];
  let next: string | null = ALERTS_URL;
  try {
    for (let page = 0; page < MAX_ALERT_PAGES && next !== null; page += 1) {
      const res = await fetchImpl(next, { headers, signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS) });
      if (!res.ok) {
        return unreachable(`Twilio answered ${res.status}`);
      }
      const body = (await res.json()) as {
        alerts?: MonitorAlert[];
        meta?: { next_page_url?: string | null };
      };
      const rows = body.alerts ?? [];
      alerts.push(...rows);
      const reachedCursor = rows.some((alert) => {
        const at = createdAt(alert);
        return at !== null && at <= since.getTime();
      });
      if (reachedCursor) {
        return { ok: true, data: { alerts, truncated: false } };
      }
      next = body.meta?.next_page_url ?? null;
    }
    return { ok: true, data: { alerts, truncated: next !== null } };
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
    fetchAlerts: (since) => fetchMonitorAlerts(fetchImpl, since),
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
    sendSms: (body) => sendFounderOpsSms(body, fetchImpl),
    escalateDigestFailure: async (database, reason, now) => {
      await escalateDigestSendFailure(database, 'twilio_triage', reason, undefined, now);
    },
  };
}
