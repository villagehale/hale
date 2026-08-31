/**
 * VIL-331 · pure triage over Twilio Monitor Alert rows — the diagnosis half of the
 * alert-triage cron. No fetch, no DB, no env: rows in, classification and a founder
 * SMS body out, so every wording and privacy property is tested directly.
 *
 * Classification keys on the only two signals the Alerts list actually carries about
 * a failing webhook: the `httpResponse` status buried in the URL-encoded `alert_text`
 * blob, and the 11200-class `error_code`. Twilio alerts carry no response-time, so
 * "fast 500 vs slow 500" is underivable here — the classes are the three shapes that
 * ARE derivable: the app answered 4xx (rejected us — signature/config), the app
 * answered 5xx (crashed early — the 2026-08-28 Supabase incident shape, likely the
 * DB/connection layer), or nothing answered at all (deploy/network).
 *
 * Privacy (rule #1): `alert_text` and `request_url` can echo a parent's number in
 * request params, so neither is ever quoted. Evidence lines are rebuilt from parsed
 * fields only — error code, HTTP status, the route PATH with its query dropped — and
 * the digest body is composed from the classification alone. ASCII on purpose:
 * GSM-7, one segment, like every founder SMS this codebase sends.
 */

/** The Monitor Alerts list-row shape (`GET monitor.twilio.com/v1/Alerts`), the
 * fields triage reads. Everything optional: this is a third party's payload. */
export interface MonitorAlert {
  sid?: string;
  account_sid?: string;
  alert_text?: string | null;
  api_version?: string;
  date_created?: string;
  date_generated?: string;
  date_updated?: string;
  error_code?: string | number | null;
  log_level?: string;
  more_info?: string;
  request_method?: string | null;
  request_url?: string | null;
  resource_sid?: string | null;
  service_sid?: string | null;
  url?: string;
}

export type TriageClass = 'rejected_4xx' | 'crash_5xx' | 'no_response' | 'unclassified';
export type LikelyLayer =
  | 'signature_or_config'
  | 'db_or_connection'
  | 'deploy_or_network'
  | 'unknown';

export interface AlertTriage {
  class: TriageClass;
  likelyLayer: LikelyLayer;
  /** The status the webhook answered with, when the alert carries one. */
  httpStatus: number | null;
  errorCode: string;
  /** Digit-safe metadata lines for logs and the cron's JSON response — parsed
   * fields only, never a slice of alert_text. */
  evidence: string[];
}

/** The 11200 family: Twilio tried to reach the webhook and got no usable answer. */
const RETRIEVAL_FAILURE_CODES = new Set(['11200', '11205', '11206']);

function parsedAlertText(alert: MonitorAlert): URLSearchParams {
  try {
    return new URLSearchParams(alert.alert_text ?? '');
  } catch {
    return new URLSearchParams();
  }
}

/** The route path with the query string structurally dropped (a query can carry a
 * parent's From/To); null when there is no parseable URL. */
function requestPath(alert: MonitorAlert): string | null {
  if (!alert.request_url) {
    return null;
  }
  try {
    return new URL(alert.request_url).pathname;
  } catch {
    return null;
  }
}

export function classifyAlert(alert: MonitorAlert): AlertTriage {
  const text = parsedAlertText(alert);
  const rawStatus = text.get('httpResponse');
  const httpStatus = rawStatus && /^\d{3}$/.test(rawStatus) ? Number(rawStatus) : null;
  const errorCode = String(alert.error_code ?? text.get('ErrorCode') ?? 'unknown');

  let klass: TriageClass;
  let likelyLayer: LikelyLayer;
  if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500) {
    klass = 'rejected_4xx';
    likelyLayer = 'signature_or_config';
  } else if (httpStatus !== null && httpStatus >= 500) {
    klass = 'crash_5xx';
    likelyLayer = 'db_or_connection';
  } else if (RETRIEVAL_FAILURE_CODES.has(errorCode)) {
    klass = 'no_response';
    likelyLayer = 'deploy_or_network';
  } else {
    // Rule #11 in classifier form: a shape this file has never seen gets its own
    // name, never folded into a class that would send the founder chasing the
    // wrong layer.
    klass = 'unclassified';
    likelyLayer = 'unknown';
  }

  const path = requestPath(alert);
  const evidence = [
    `error_code=${errorCode}`,
    ...(httpStatus !== null ? [`httpResponse=${httpStatus}`] : []),
    ...(path ? [`url=${path}`] : []),
    ...(alert.date_created ? [`at=${alert.date_created}`] : []),
  ];
  return { class: klass, likelyLayer, httpStatus, errorCode, evidence };
}

/** Ties resolve to the worst news first. */
const SEVERITY: TriageClass[] = ['crash_5xx', 'no_response', 'rejected_4xx', 'unclassified'];

export interface TriageSummary {
  total: number;
  counts: Record<TriageClass, number>;
  /** A representative triage of the dominant class — majority, severity on ties. */
  dominant: AlertTriage;
  earliest: Date | null;
}

export function triageAlerts(alerts: MonitorAlert[]): TriageSummary {
  const triaged = alerts.map(classifyAlert);
  const counts: Record<TriageClass, number> = {
    rejected_4xx: 0,
    crash_5xx: 0,
    no_response: 0,
    unclassified: 0,
  };
  for (const t of triaged) {
    counts[t.class] += 1;
  }
  const dominantClass = SEVERITY.reduce((best, klass) =>
    counts[klass] > counts[best] ? klass : best,
  );
  // biome-ignore lint/style/noNonNullAssertion: counts[dominantClass] > 0 whenever alerts is non-empty
  const dominant = triaged.find((t) => t.class === dominantClass)!;

  let earliest: Date | null = null;
  for (const alert of alerts) {
    const at = Date.parse(alert.date_created ?? '');
    if (Number.isFinite(at) && (earliest === null || at < earliest.getTime())) {
      earliest = new Date(at);
    }
  }
  return { total: alerts.length, counts, dominant, earliest };
}

/** What the DB-side outbound probe saw: sends landing (`ok`), none attempted in the
 * window (`quiet` — health unproven, not claimed), or the probe itself failed
 * (`unchecked` — the DB being down IS the crash_5xx hypothesis). */
export type OutboundHealth = 'ok' | 'quiet' | 'unchecked';

const OUTBOUND_LINE: Record<OutboundHealth, string> = {
  ok: 'Outbound OK.',
  quiet: 'Outbound quiet.',
  unchecked: 'Outbound unchecked.',
};

function sinceLabel(earliest: Date | null): string {
  return earliest ? `since ${earliest.toISOString().slice(11, 16)}Z` : 'just now';
}

/**
 * The founder diagnosis SMS. Counts, times, codes and layer names only — the body is
 * built from the classification, so nothing a parent typed can reach it.
 */
export function composeTriageDigest(summary: TriageSummary, outbound: OutboundHealth): string {
  const { dominant, total, earliest } = summary;
  const head = `Hale: inbound webhook failing. ${total} alerts ${sinceLabel(earliest)}.`;
  const ob = OUTBOUND_LINE[outbound];
  switch (dominant.class) {
    case 'crash_5xx':
      return `${head} HTTP ${dominant.httpStatus} = early crash, likely DB/connection. ${ob} Check Supabase status+connections.`;
    case 'rejected_4xx':
      return `${head} HTTP ${dominant.httpStatus} = rejected, likely signature/config. ${ob} Check Twilio webhook URL+auth.`;
    case 'no_response':
      return `${head} No response (${dominant.errorCode}) = unreachable, likely deploy/network. ${ob} Check Vercel deploy.`;
    case 'unclassified':
      return `Hale: ${total} Twilio webhook error alerts ${sinceLabel(earliest)}, shape unknown. ${ob} Check Twilio Monitor console.`;
  }
}

/** GSM-7 basic set only (every char one septet — extension chars are refused rather
 * than counted double, so length IS the septet count), and within one 160-septet
 * segment. */
const GSM7_BASIC_SAFE = /^[A-Za-z0-9 @$_!"#%&'()*+,\-./:;<=>?\n]*$/;

export function gsm7SingleSegment(body: string): boolean {
  return GSM7_BASIC_SAFE.test(body) && body.length <= 160;
}
