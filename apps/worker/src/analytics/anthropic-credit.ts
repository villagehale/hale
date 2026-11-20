import {
  type AnthropicSpendRow,
  anthropicCreditAlertEnabled,
  creditErrorShape,
  formatCreditBillingErrorAlert,
  spendRowFromUsage,
} from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';

/**
 * Worker half of the prepaid-credit ledger and billing-error page. The web
 * process owns the threshold cron; this file is what every worker Anthropic
 * call hits through llm-trace. Slack #ops only — never a parent text.
 */

const ROUTE = 'ops:anthropic-credit';
const BILLING_IDENTIFIER = 'billing_error';
const BILLING_WINDOW_MS = 3_600_000;
const SLACK_TIMEOUT_MS = 4_000;
const OPS_SLACK_CHANNEL_DEFAULT = 'C0C5XMCAQ56';

export function observeAnthropicCall(input: {
  model: string;
  usage?: Parameters<typeof spendRowFromUsage>[1];
  error?: unknown;
}): void {
  if (input.error !== undefined) {
    void pageBillingErrorSafe(input.error);
    return;
  }
  const row = spendRowFromUsage(input.model, input.usage);
  if (!row) return;
  void recordSpendSafe(row);
}

async function recordSpendSafe(row: AnthropicSpendRow): Promise<void> {
  try {
    const { db } = await import('../db.js');
    await insertSpend(db(), row);
  } catch {
    // Spend recording must never fail a model call.
  }
}

export async function insertSpend(
  database: Database,
  row: AnthropicSpendRow,
  occurredAt: Date = new Date(),
): Promise<void> {
  await database.insert(schema.anthropicSpend).values({
    occurredAt,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    costUsd: row.costUsd.toFixed(6),
  });
}

async function pageBillingErrorSafe(err: unknown): Promise<void> {
  try {
    const { db } = await import('../db.js');
    await pageAnthropicBillingError(db(), err);
  } catch {
    // A missed ops page never fails the caller.
  }
}

export type BillingErrorAlert =
  | 'flag_off'
  | 'not_credit_error'
  | 'paged'
  | 'deduped'
  | 'page_not_configured'
  | 'page_not_delivered';

export async function pageAnthropicBillingError(
  database: Database,
  err: unknown,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<BillingErrorAlert> {
  if (!anthropicCreditAlertEnabled(env)) return 'flag_off';
  const shape = creditErrorShape(err);
  if (!shape) return 'not_credit_error';

  const windowStart = new Date(Math.floor(now.getTime() / BILLING_WINDOW_MS) * BILLING_WINDOW_MS);
  const claimed = await database
    .insert(schema.rateLimits)
    .values({ identifier: BILLING_IDENTIFIER, route: ROUTE, windowStart, count: 1 })
    .onConflictDoNothing({
      target: [
        schema.rateLimits.identifier,
        schema.rateLimits.route,
        schema.rateLimits.windowStart,
      ],
    })
    .returning({ id: schema.rateLimits.id });
  if (claimed.length === 0) return 'deduped';

  const page = await postOps(formatCreditBillingErrorAlert(shape), env, fetchImpl);
  if (page === 'sent') return 'paged';
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.identifier, BILLING_IDENTIFIER),
        eq(schema.rateLimits.route, ROUTE),
        eq(schema.rateLimits.windowStart, windowStart),
      ),
    );
  return page === 'skipped_not_configured' ? 'page_not_configured' : 'page_not_delivered';
}

async function postOps(
  text: string,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<'sent' | 'failed' | 'skipped_not_configured'> {
  const webhookUrl = env.OPS_SLACK_WEBHOOK_URL?.trim() ?? '';
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
      body: JSON.stringify({
        text,
        channel: env.SLACK_OPS_CHANNEL?.trim() || OPS_SLACK_CHANNEL_DEFAULT,
      }),
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
