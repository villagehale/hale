/**
 * Ops page from the worker process. Same door as apps/web/lib/monitoring/ops-slack.ts:
 * Slack #ops via OPS_SLACK_WEBHOOK_URL. No founder phone, no SMS. The worker cannot
 * import the web module, so this is the twin the orchestrator calls.
 *
 * Never throws. An absent or non-https URL is a named skip (rule #11).
 */

export const OPS_SLACK_CHANNEL_DEFAULT = 'C0C5XMCAQ56';

const SLACK_TIMEOUT_MS = 4_000;

export type OpsPageOutcome = 'sent' | 'failed' | 'skipped_not_configured';

export function opsSlackChannel(): string {
  return process.env.SLACK_OPS_CHANNEL?.trim() || OPS_SLACK_CHANNEL_DEFAULT;
}

export async function postWorkerOpsSlack(
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OpsPageOutcome> {
  const webhookUrl = process.env.OPS_SLACK_WEBHOOK_URL?.trim() ?? '';
  if (!webhookUrl.startsWith('https://')) {
    console.error('ops slack: not configured — nobody was paged', {
      missing: ['OPS_SLACK_WEBHOOK_URL'],
    });
    return 'skipped_not_configured';
  }
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
