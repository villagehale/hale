import {
  type AnthropicSpendRow,
  type CreditConfig,
  anthropicCreditAlertEnabled,
  creditAlertThresholds,
  creditErrorShape,
  creditRemainingUsd,
  crossedCreditThresholds,
  daysLeftEstimate,
  dueExpiryWarnings,
  formatCreditBillingErrorAlert,
  formatCreditExpiryAlert,
  formatCreditRemainingAlert,
  readCreditConfig,
  spendRowFromUsage,
} from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { type OpsPageOutcome, postOpsSlack } from '~/lib/monitoring/ops-slack';

/** Fixed window so remaining thresholds dedupe per start value, not per hour. */
const CLAIM_EPOCH = new Date(0);

/**
 * Prepaid Anthropic credit #ops alert. Remaining = ANTHROPIC_CREDIT_START_USD
 * minus anthropic_spend since ANTHROPIC_CREDIT_START_AT. Dark unless
 * ANTHROPIC_CREDIT_ALERT_ENABLED is exactly `true`.
 *
 * Two remaining posts per start value: first below ANTHROPIC_CREDIT_ALERT_USD
 * (default 40), then below $15. Days-before-expiry warnings (default 7 then 3)
 * post once each per ANTHROPIC_CREDIT_EXPIRES_AT, mid-morning ET. A
 * credit/billing error from any Anthropic call pages at once, once per hour.
 * Slack #ops only — never a parent text, never email.
 */

export const ANTHROPIC_CREDIT_ROUTE = 'ops:anthropic-credit';
const BILLING_IDENTIFIER = 'billing_error';
const BILLING_WINDOW_MS = 3_600_000;
const DAY_MS = 86_400_000;

export {
  ANTHROPIC_CREDIT_ALERT_ENABLED_ENV,
  ANTHROPIC_CREDIT_ALERT_USD_ENV,
  ANTHROPIC_CREDIT_EXPIRES_AT_ENV,
  ANTHROPIC_CREDIT_EXPIRY_WARN_DAYS_ENV,
  ANTHROPIC_CREDIT_START_AT_ENV,
  ANTHROPIC_CREDIT_START_USD_ENV,
  anthropicCreditAlertEnabled,
} from '@hale/agent';

export type CreditAlert =
  | 'flag_off'
  | 'start_not_configured'
  | 'below_threshold'
  | 'paged'
  | 'deduped'
  | 'page_not_configured'
  | 'page_not_delivered';

export interface CreditCheckResult {
  alert: CreditAlert;
  remainingUsd: number | null;
  spendUsd: number | null;
  spendLast24hUsd: number | null;
  daysLeft: number | null;
  paged: number[];
  expiryPaged: number[];
}

export type BillingErrorAlert =
  | 'flag_off'
  | 'not_credit_error'
  | 'paged'
  | 'deduped'
  | 'page_not_configured'
  | 'page_not_delivered';

export interface CreditAlertDeps {
  send(text: string): Promise<OpsPageOutcome>;
}

export function defaultCreditAlertDeps(): CreditAlertDeps {
  return { send: (text) => postOpsSlack(text) };
}

function startKey(config: CreditConfig): string {
  return `${config.startUsd}:${config.startAt.toISOString()}`;
}

function remainingIdentifier(config: CreditConfig, thresholdUsd: number): string {
  return `remaining:${startKey(config)}:${thresholdUsd}`;
}

function expiryIdentifier(expiresAt: Date, daysBefore: number): string {
  return `expiry:${expiresAt.toISOString()}:${daysBefore}`;
}

export async function recordAnthropicSpend(
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

async function sumCostUsd(database: Database, since: Date, until: Date | null): Promise<number> {
  const occurred = schema.anthropicSpend.occurredAt;
  const where = until ? and(gte(occurred, since), lt(occurred, until)) : gte(occurred, since);
  const rows = await database
    .select({
      total: sql<string>`coalesce(sum(${schema.anthropicSpend.costUsd}), 0)`,
    })
    .from(schema.anthropicSpend)
    .where(where);
  return Number(rows[0]?.total ?? 0);
}

async function claim(database: Database, identifier: string, windowStart: Date): Promise<boolean> {
  const claimed = await database
    .insert(schema.rateLimits)
    .values({ identifier, route: ANTHROPIC_CREDIT_ROUTE, windowStart, count: 1 })
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

async function release(database: Database, identifier: string, windowStart: Date): Promise<void> {
  await database
    .delete(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.identifier, identifier),
        eq(schema.rateLimits.route, ANTHROPIC_CREDIT_ROUTE),
        eq(schema.rateLimits.windowStart, windowStart),
      ),
    );
}

async function postedThresholds(database: Database, config: CreditConfig): Promise<Set<number>> {
  const prefix = `remaining:${startKey(config)}:`;
  const rows = await database
    .select({ identifier: schema.rateLimits.identifier })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, ANTHROPIC_CREDIT_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
      ),
    );
  const posted = new Set<number>();
  for (const row of rows) {
    if (!row.identifier.startsWith(prefix)) continue;
    const usd = Number(row.identifier.slice(prefix.length));
    if (Number.isFinite(usd)) posted.add(usd);
  }
  return posted;
}

async function postedExpiryDays(database: Database, expiresAt: Date): Promise<Set<number>> {
  const prefix = `expiry:${expiresAt.toISOString()}:`;
  const rows = await database
    .select({ identifier: schema.rateLimits.identifier })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.route, ANTHROPIC_CREDIT_ROUTE),
        eq(schema.rateLimits.windowStart, CLAIM_EPOCH),
      ),
    );
  const posted = new Set<number>();
  for (const row of rows) {
    if (!row.identifier.startsWith(prefix)) continue;
    const days = Number(row.identifier.slice(prefix.length));
    if (Number.isInteger(days) && days > 0) posted.add(days);
  }
  return posted;
}

function emptyCheck(alert: CreditAlert): CreditCheckResult {
  return {
    alert,
    remainingUsd: null,
    spendUsd: null,
    spendLast24hUsd: null,
    daysLeft: null,
    paged: [],
    expiryPaged: [],
  };
}

function pageAlert(outcome: OpsPageOutcome): CreditAlert {
  if (outcome === 'sent') return 'paged';
  if (outcome === 'skipped_not_configured') return 'page_not_configured';
  return 'page_not_delivered';
}

/**
 * Sum the ledger since start, page #ops for each newly crossed remaining
 * threshold and each due expiry warning. Flag off / missing start are named
 * skips (rule #11). Never throws into a parent turn — callers on the drain catch.
 */
export async function checkAnthropicCredit(
  database: Database,
  deps: CreditAlertDeps = defaultCreditAlertDeps(),
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<CreditCheckResult> {
  if (!anthropicCreditAlertEnabled(env)) return emptyCheck('flag_off');

  const parsed = readCreditConfig(env);
  if (!parsed.ok) {
    console.error(
      'Anthropic credit alert: ANTHROPIC_CREDIT_START_USD / ANTHROPIC_CREDIT_START_AT are not set — nobody is paged',
    );
    return emptyCheck('start_not_configured');
  }

  const { config } = parsed;
  const since = config.startAt;
  const spendUsd = await sumCostUsd(database, since, null);
  const remainingUsd = creditRemainingUsd(config.startUsd, spendUsd);
  const windowStart = new Date(Math.max(since.getTime(), now.getTime() - DAY_MS));
  const spendLast24hUsd = await sumCostUsd(database, windowStart, now);
  const windowMs = Math.max(1, now.getTime() - windowStart.getTime());
  const daysLeft = daysLeftEstimate(remainingUsd, spendLast24hUsd, windowMs);
  const thresholds = creditAlertThresholds(config.alertUsd);
  const already = await postedThresholds(database, config);
  const crossed = crossedCreditThresholds(remainingUsd, thresholds, already);
  const alreadyExpiry = config.expiresAt
    ? await postedExpiryDays(database, config.expiresAt)
    : new Set<number>();
  const dueExpiry = dueExpiryWarnings(config.expiresAt, config.warnDays, now, alreadyExpiry);

  const snapshot = {
    remainingUsd,
    spendUsd,
    spendLast24hUsd,
    daysLeft,
  };
  const paged: number[] = [];
  const expiryPaged: number[] = [];
  let lastPage: OpsPageOutcome | null = null;

  for (const thresholdUsd of crossed) {
    const identifier = remainingIdentifier(config, thresholdUsd);
    let won: boolean;
    try {
      won = await claim(database, identifier, CLAIM_EPOCH);
    } catch (err) {
      console.error('Anthropic credit alert: claim failed', {
        err: err instanceof Error ? err.name : 'unknown',
      });
      return { alert: 'page_not_delivered', ...snapshot, paged, expiryPaged };
    }
    if (!won) continue;

    const text = formatCreditRemainingAlert({
      remainingUsd,
      spendLast24hUsd,
      daysLeft,
      thresholdUsd,
      startUsd: config.startUsd,
      startAt: config.startAt,
    });
    lastPage = await deps.send(text);
    if (lastPage === 'sent') {
      paged.push(thresholdUsd);
      continue;
    }
    await release(database, identifier, CLAIM_EPOCH);
    console.error('Anthropic credit alert: ops page not delivered', {
      page: lastPage,
      thresholdUsd,
    });
  }

  if (config.expiresAt) {
    for (const daysBefore of dueExpiry) {
      const identifier = expiryIdentifier(config.expiresAt, daysBefore);
      let won: boolean;
      try {
        won = await claim(database, identifier, CLAIM_EPOCH);
      } catch (err) {
        console.error('Anthropic credit expiry alert: claim failed', {
          err: err instanceof Error ? err.name : 'unknown',
        });
        return { alert: 'page_not_delivered', ...snapshot, paged, expiryPaged };
      }
      if (!won) continue;

      const text = formatCreditExpiryAlert({
        remainingUsd,
        expiresAt: config.expiresAt,
        daysBefore,
      });
      lastPage = await deps.send(text);
      if (lastPage === 'sent') {
        expiryPaged.push(daysBefore);
        continue;
      }
      await release(database, identifier, CLAIM_EPOCH);
      console.error('Anthropic credit expiry alert: ops page not delivered', {
        page: lastPage,
        daysBefore,
      });
    }
  }

  if (paged.length > 0 || expiryPaged.length > 0) {
    return { alert: 'paged', ...snapshot, paged, expiryPaged };
  }
  if (lastPage !== null && lastPage !== 'sent') {
    return { alert: pageAlert(lastPage), ...snapshot, paged: [], expiryPaged: [] };
  }
  return {
    alert: already.size > 0 || alreadyExpiry.size > 0 ? 'deduped' : 'below_threshold',
    ...snapshot,
    paged: [],
    expiryPaged: [],
  };
}

function billingWindowStart(now: Date): Date {
  return new Date(Math.floor(now.getTime() / BILLING_WINDOW_MS) * BILLING_WINDOW_MS);
}

/**
 * Page #ops at once when an Anthropic call is a credit/billing error. Deduped
 * per hour. Best-effort: never throws into the model call.
 */
export async function pageAnthropicBillingError(
  database: Database,
  err: unknown,
  deps: CreditAlertDeps = defaultCreditAlertDeps(),
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<BillingErrorAlert> {
  if (!anthropicCreditAlertEnabled(env)) return 'flag_off';
  const shape = creditErrorShape(err);
  if (!shape) return 'not_credit_error';

  const windowStart = billingWindowStart(now);
  let won: boolean;
  try {
    won = await claim(database, BILLING_IDENTIFIER, windowStart);
  } catch (claimErr) {
    console.error('Anthropic credit billing alert: claim failed', {
      err: claimErr instanceof Error ? claimErr.name : 'unknown',
    });
    return 'page_not_delivered';
  }
  if (!won) return 'deduped';

  const text = formatCreditBillingErrorAlert(shape);
  const page = await deps.send(text);
  if (page === 'sent') return 'paged';
  await release(database, BILLING_IDENTIFIER, windowStart);
  console.error('Anthropic credit billing alert: ops page not delivered', { page });
  return page === 'skipped_not_configured' ? 'page_not_configured' : 'page_not_delivered';
}

/**
 * Fire-and-forget observer for every Anthropic call the llm-trace wrapper sees.
 * Recording spend is independent of the alert flag so history exists when it
 * turns on; paging is not.
 */
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
    const { db } = await import('~/lib/db');
    await recordAnthropicSpend(db(), row);
  } catch {
    // Tracing / spend recording must never fail a model call.
  }
}

async function pageBillingErrorSafe(err: unknown): Promise<void> {
  try {
    const { db } = await import('~/lib/db');
    await pageAnthropicBillingError(db(), err);
  } catch {
    // A missed ops page is logged by the pager; never fail the caller.
  }
}
