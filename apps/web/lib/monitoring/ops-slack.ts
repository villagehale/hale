/**
 * Ops pages for service alerts — inbound webhook crashes, delivery
 * health, and the off-Vercel cron dead-man — go to Slack #ops.
 *
 * This is not parent messaging. Linq sends to families do not call here,
 * and this module does not text anyone. The incoming-webhook URL is the whole
 * configuration: no founder phone, no messaging credentials. An absent or non-https URL
 * is a named skip, logged, never a silent success and never an SMS fallback (rule #11).
 *
 * Database-independent on purpose. The page has to leave the instance when the
 * database is what just failed, so this file imports neither Drizzle nor `~/lib/db`.
 */

/** #ops in the hale-p8d7001 workspace. The incoming webhook should be bound to this
 * channel; the payload repeats the id so a webhook that honors `channel` still lands
 * there when `SLACK_OPS_CHANNEL` is unset. */
export const OPS_SLACK_CHANNEL_DEFAULT = 'C0C5XMCAQ56';

const SLACK_TIMEOUT_MS = 4_000;

export type OpsPageOutcome = 'sent' | 'failed' | 'skipped_not_configured';

export function opsSlackChannel(): string {
  return process.env.SLACK_OPS_CHANNEL?.trim() || OPS_SLACK_CHANNEL_DEFAULT;
}

/** Names still missing before a page can leave. An unset or non-https URL is the
 * same gap: nobody is watching, and it must be said. */
export function opsSlackMissing(): string[] {
  const webhookUrl = process.env.OPS_SLACK_WEBHOOK_URL?.trim();
  if (!webhookUrl || !webhookUrl.startsWith('https://')) {
    return ['OPS_SLACK_WEBHOOK_URL'];
  }
  return [];
}

/**
 * Post one ops alert to Slack #ops. Never throws. Does not log the webhook URL
 * (it is a secret) or the body (callers already scrubbed it; a later caller must
 * not grow a leak by this function echoing them).
 */
export async function postOpsSlack(
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpsPageOutcome> {
  const missing = opsSlackMissing();
  if (missing.length > 0) {
    console.error('ops slack: not configured — nobody was paged', { missing });
    return 'skipped_not_configured';
  }
  const webhookUrl = process.env.OPS_SLACK_WEBHOOK_URL?.trim() ?? '';
  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, channel: opsSlackChannel() }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error('ops slack: webhook refused', { status: response.status });
      return 'failed';
    }
    return 'sent';
  } catch (err) {
    console.error('ops slack: webhook threw', {
      err: err instanceof Error ? err.name : 'unknown',
    });
    return 'failed';
  }
}
