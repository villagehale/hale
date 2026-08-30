import type { AdminErrorRow } from '../queries/errors';
import { SERVICE_TIMEOUT_MS, notConfigured, type ServiceOutcome, unreachable } from './outcome';

/**
 * Twilio's own error log (the 11200 class the webhook alarm writes into),
 * merged beside the DB-side failures. Read-only, one page.
 *
 * Privacy: alert_text can echo request params (a To number, an account sid), so
 * any run of 7+ digits is scrubbed before the row exists — the same structural
 * rule lib/channel/twilio/alert.ts applies on the way out.
 */
const ALERTS_URL = 'https://monitor.twilio.com/v1/Alerts?LogLevel=error&PageSize=50';

export function scrubDigits(text: string): string {
  return text.replace(/\d{7,}/g, '[digits]');
}

function credentials(): { user: string; pass: string } | null {
  const { TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } =
    process.env;
  if (TWILIO_API_KEY_SID && TWILIO_API_KEY_SECRET) {
    return { user: TWILIO_API_KEY_SID, pass: TWILIO_API_KEY_SECRET };
  }
  if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
    return { user: TWILIO_ACCOUNT_SID, pass: TWILIO_AUTH_TOKEN };
  }
  return null;
}

interface TwilioAlert {
  date_created?: string;
  error_code?: string | number | null;
  alert_text?: string | null;
  request_url?: string | null;
}

export async function fetchTwilioAlerts(
  fetchImpl: typeof fetch = fetch,
): Promise<ServiceOutcome<AdminErrorRow[]>> {
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
    const body = (await res.json()) as { alerts?: TwilioAlert[] };
    const rows = (body.alerts ?? []).map(
      (alert): AdminErrorRow => ({
        at: alert.date_created ?? '',
        source: 'twilio',
        code: String(alert.error_code ?? 'unknown'),
        summary: scrubDigits(alert.alert_text || alert.request_url || 'alert'),
      }),
    );
    return { ok: true, data: rows };
  } catch (error) {
    return unreachable(error instanceof Error ? error.name : 'fetch failed');
  }
}
