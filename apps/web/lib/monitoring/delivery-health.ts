import { type Database, schema } from '@hale/db';
import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';

/**
 * The `delivery` incident kind — the pageable half of the delivery-truth invariant
 * (the sweep in channel/twilio/delivery-sweep.ts is the truth-writing half).
 *
 * Prod motivation (2026-09-03 audit): 42 of 177 outbound SMS failed at Twilio over
 * 30 days — 8 of them 30034, an A2P/registration refusal that fails EVERY send to
 * its destination class — and nothing paged, because delivery failures only ever
 * landed (when they landed at all) in a table read by pull-based admin pages.
 *
 * Two shapes of incident, in strict order of severity:
 *   - `registration_error` — any 30034-class failure at all. One is already proof
 *     the sender's registration is broken for a whole destination class; there is
 *     no threshold to wait for.
 *   - `failure_rate` — the failed share of attempted sends over the trailing
 *     window crossed the threshold on a sample big enough to mean something.
 *
 * The alert leg follows the webhook-alert/triage machinery, not provider-health's
 * email: a delivery outage is the same "families are not receiving Hale" class as a
 * webhook outage, and it pages the same way — founder SMS, class-only (counts and
 * provider error codes, never a number or a name — rule #1), deduped by an atomic
 * rate_limits claim per incident kind, braked by the 15-minute per-instance
 * founder-SMS floor the boundary alert established (alert.ts).
 *
 * Rule #11 throughout: every path out of `checkDeliveryHealth` is a named outcome.
 */

// ── evaluation ───────────────────────────────────────────────────────────────

/** The trailing window the rate is computed over. */
export const DELIVERY_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The failed share of attempted sends that makes the window an incident. */
export const DELIVERY_RATE_THRESHOLD = 0.25;

/** Below this many attempted sends the rate is noise: one failed text to one
 * landline must not page anybody. */
export const DELIVERY_RATE_MIN_ATTEMPTED = 5;

/** The registration/A2P class: refusals that mean the SENDER is misconfigured for a
 * whole destination class, so every send that way dies until a human fixes the
 * console. 30034 = US A2P 10DLC unregistered long code — the code that burned 8
 * prod sends unseen. A single occurrence pages. */
export const REGISTRATION_ERROR_CODES = new Set(['30034']);

/** What the ledger says about the trailing window: sends that reached the provider
 * (suppressions deliberately excluded — a message Hale CHOSE not to send is not a
 * delivery attempt, the msgsOut-dilution lesson), and the failed slice by code. */
export interface DeliveryStats {
  attempted: number;
  failed: number;
  /** Failed rows grouped by provider error code, biggest first. */
  codes: Array<{ code: string; count: number }>;
}

export type DeliveryIncident =
  | { kind: 'registration_error'; code: string; count: number }
  | { kind: 'failure_rate'; failed: number; attempted: number; codes: DeliveryStats['codes'] };

export type DeliveryIncidentKind = DeliveryIncident['kind'];

export function evaluateDeliveryHealth(stats: DeliveryStats): DeliveryIncident | null {
  const registration = stats.codes.find((c) => REGISTRATION_ERROR_CODES.has(c.code));
  if (registration) {
    return { kind: 'registration_error', code: registration.code, count: registration.count };
  }
  if (
    stats.attempted >= DELIVERY_RATE_MIN_ATTEMPTED &&
    stats.failed / stats.attempted >= DELIVERY_RATE_THRESHOLD
  ) {
    return { kind: 'failure_rate', failed: stats.failed, attempted: stats.attempted, codes: stats.codes };
  }
  return null;
}

/** The channels the sweep confirms delivery for — the only rows the rate may read. */
const RECEIPT_CHANNELS = ['sms', 'whatsapp'] as const;

/** The denominator is sends that REACHED the provider (queued/sent/delivered/failed).
 * Suppressions never enter it, and neither does email (terminal at accept, no
 * receipt loop — a rate over rows that cannot fail would only dilute). */
export async function loadDeliveryStats(database: Database, since: Date): Promise<DeliveryStats> {
  const m = schema.channelMessages;
  const scope = and(
    eq(m.direction, 'out'),
    inArray(m.channel, [...RECEIPT_CHANNELS]),
    gte(m.createdAt, since),
  );

  const [totals] = await database
    .select({
      attempted: sql<number>`count(*) filter (where ${m.status} in ('queued','sent','delivered','failed'))::int`,
      failed: sql<number>`count(*) filter (where ${m.status} = 'failed')::int`,
    })
    .from(m)
    .where(scope);

  const codes = await database
    .select({ code: m.errorCode, count: sql<number>`count(*)::int` })
    .from(m)
    .where(and(scope, eq(m.status, 'failed'), isNotNull(m.errorCode)))
    .groupBy(m.errorCode)
    .orderBy(desc(sql`count(*)`));

  return {
    attempted: totals?.attempted ?? 0,
    failed: totals?.failed ?? 0,
    codes: codes.filter((c): c is { code: string; count: number } => c.code !== null),
  };
}

// ── the page ─────────────────────────────────────────────────────────────────

/** How many error codes the rate page names — enough to diagnose, small enough for
 * one GSM-7 segment whatever the counts. */
const ALERT_TOP_CODES = 2;

/** The founder SMS. Counts and provider error codes only — an error code is Twilio's
 * enum, never a parent's number or words (rule #1). ASCII on purpose: GSM-7, one
 * segment, like every founder SMS this codebase sends. */
export function composeDeliveryAlert(incident: DeliveryIncident): string {
  if (incident.kind === 'registration_error') {
    return `Hale: SMS delivery failing. A2P/registration error ${incident.code} on ${incident.count} send(s) in 24h - sender registration broken. Check Twilio Messaging setup.`;
  }
  const top = incident.codes
    .slice(0, ALERT_TOP_CODES)
    .map((c) => `${c.code} x${c.count}`)
    .join(', ');
  const codesPart = top ? ` Codes: ${top}.` : '';
  return `Hale: SMS delivery failing. ${incident.failed} of ${incident.attempted} sends failed in 24h.${codesPart} Check Twilio delivery logs.`;
}

// ── dedupe: the rate_limits claim + the instance floor ───────────────────────

/** The rate_limits `route` delivery-incident claims live under. */
export const DELIVERY_INCIDENT_ROUTE = 'ops:delivery-health';

/** One page per incident KIND per day, mirroring provider-health's incident window:
 * an outage still an outage tomorrow deserves to be said again, and the check runs
 * every ten minutes over a trailing window, so anything shorter would re-page a
 * standing incident all day. */
export const DELIVERY_INCIDENT_WINDOW_HOURS = 24;

/** Claim retention, housekeeping only — exactly-once is the unique index. */
const RETENTION_DAYS = 7;

/** Same atomic-INSERT shape as claimProviderIncident: first claimer of the kind's
 * window pages, everyone else is deduped. */
export async function claimDeliveryIncident(
  database: Database,
  kind: DeliveryIncidentKind,
  now: Date,
): Promise<boolean> {
  const windowMs = DELIVERY_INCIDENT_WINDOW_HOURS * 3_600_000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);

  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, DELIVERY_INCIDENT_ROUTE),
        lt(schema.rateLimits.windowStart, new Date(now.getTime() - RETENTION_DAYS * 86_400_000)),
      ),
    );

  const claimed = await database
    .insert(schema.rateLimits)
    .values({ identifier: kind, route: DELIVERY_INCIDENT_ROUTE, windowStart, count: 1 })
    .onConflictDoNothing({
      target: [schema.rateLimits.identifier, schema.rateLimits.route, schema.rateLimits.windowStart],
    })
    .returning({ id: schema.rateLimits.id });

  return claimed.length > 0;
}

/** The 15-minute per-instance founder-SMS floor (the alert.ts convention), spent on
 * the ATTEMPT: whatever the claims say, one instance never sends founder SMS more
 * often than this. */
const FOUNDER_SMS_MIN_INTERVAL_MS = 15 * 60 * 1000;

let lastDeliverySmsAttemptAt: number | null = null;

/** Test seam: the floor above is module state and would otherwise leak between cases. */
export function resetDeliveryAlertWindowForTests(): void {
  lastDeliverySmsAttemptAt = null;
}

// ── orchestration ────────────────────────────────────────────────────────────

export interface DeliveryHealthDeps {
  loadStats(database: Database, since: Date): Promise<DeliveryStats>;
  claim(database: Database, kind: DeliveryIncidentKind, now: Date): Promise<boolean>;
  sendSms(body: string): Promise<'sent' | 'failed' | 'skipped_not_configured'>;
}

export type DeliveryHealthOutcome =
  | { outcome: 'healthy'; attempted: number; failed: number }
  | { outcome: 'alerted'; kind: DeliveryIncidentKind }
  | { outcome: 'suppressed_dedupe'; kind: DeliveryIncidentKind }
  | { outcome: 'suppressed_instance_window'; kind: DeliveryIncidentKind }
  | { outcome: 'claim_unavailable'; kind: DeliveryIncidentKind }
  | { outcome: 'alert_send_failed'; kind: DeliveryIncidentKind }
  | { outcome: 'skipped_not_configured'; kind: DeliveryIncidentKind };

/**
 * Read the window, page on an incident, at most one SMS per kind per day and never
 * two from one instance inside 15 minutes. Unlike the triage (whose claim store's
 * outage IS its diagnosis), this check's evidence just came FROM the database — a
 * claim store that cannot answer is a named outcome and the page is withheld,
 * because a DB that flapped mid-check must not double-page tomorrow's dedupe away.
 */
export async function checkDeliveryHealth(
  database: Database,
  deps: DeliveryHealthDeps,
  now: Date,
): Promise<DeliveryHealthOutcome> {
  const stats = await deps.loadStats(database, new Date(now.getTime() - DELIVERY_RATE_WINDOW_MS));
  const incident = evaluateDeliveryHealth(stats);
  if (!incident) {
    return { outcome: 'healthy', attempted: stats.attempted, failed: stats.failed };
  }

  // The incident is always logged in full, whether or not a page goes out — the
  // platform log is the trail an ops event gets.
  console.error({ incident }, 'delivery health: incident detected');

  if (
    lastDeliverySmsAttemptAt !== null &&
    now.getTime() - lastDeliverySmsAttemptAt < FOUNDER_SMS_MIN_INTERVAL_MS
  ) {
    return { outcome: 'suppressed_instance_window', kind: incident.kind };
  }

  let won: boolean;
  try {
    won = await deps.claim(database, incident.kind, now);
  } catch (err) {
    console.error('delivery health: incident claim failed — page withheld', {
      err: err instanceof Error ? err.name : 'unknown',
    });
    return { outcome: 'claim_unavailable', kind: incident.kind };
  }
  if (!won) {
    return { outcome: 'suppressed_dedupe', kind: incident.kind };
  }

  lastDeliverySmsAttemptAt = now.getTime();
  const sms = await deps.sendSms(composeDeliveryAlert(incident));
  if (sms === 'sent') {
    return { outcome: 'alerted', kind: incident.kind };
  }
  console.error('delivery health: founder page not delivered', { sms, kind: incident.kind });
  return sms === 'skipped_not_configured'
    ? { outcome: 'skipped_not_configured', kind: incident.kind }
    : { outcome: 'alert_send_failed', kind: incident.kind };
}
