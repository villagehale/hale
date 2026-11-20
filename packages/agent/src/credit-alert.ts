import { tryEstimateCostUsd } from './cost.js';
import type { Usage } from './llm-analytics.js';
import { cacheCreation1hFromUsage } from './prompt-cache.js';

/**
 * Prepaid Anthropic credit remaining. The API does not expose the balance on a
 * normal key, so Hale keeps a running spend ledger (token usage × the one rate
 * table in cost.ts) and subtracts it from ANTHROPIC_CREDIT_START_USD.
 *
 * Ops only: remaining, last-24h spend, a days-left estimate, and days-before
 * expiry warnings. Never a parent text. The #ops posts live in apps/web (and
 * the worker observer); this file is the pure arithmetic and the
 * credit/billing-error classifier those posts share.
 */

export const ANTHROPIC_CREDIT_ALERT_ENABLED_ENV = 'ANTHROPIC_CREDIT_ALERT_ENABLED';
export const ANTHROPIC_CREDIT_START_USD_ENV = 'ANTHROPIC_CREDIT_START_USD';
export const ANTHROPIC_CREDIT_START_AT_ENV = 'ANTHROPIC_CREDIT_START_AT';
export const ANTHROPIC_CREDIT_ALERT_USD_ENV = 'ANTHROPIC_CREDIT_ALERT_USD';
export const ANTHROPIC_CREDIT_EXPIRES_AT_ENV = 'ANTHROPIC_CREDIT_EXPIRES_AT';
export const ANTHROPIC_CREDIT_EXPIRY_WARN_DAYS_ENV = 'ANTHROPIC_CREDIT_EXPIRY_WARN_DAYS';

/** Off unless exactly `true`, untrimmed. A trailing newline stays off. */
export function anthropicCreditAlertEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[ANTHROPIC_CREDIT_ALERT_ENABLED_ENV] === 'true';
}

/** Second #ops post: remaining has dropped below this, after the configurable first. */
export const CREDIT_CRITICAL_USD = 15;

/** First #ops post when ANTHROPIC_CREDIT_ALERT_USD is unset. */
export const CREDIT_ALERT_USD_DEFAULT = 40;

/** Default days-before-expiry #ops warnings (Nov 28 and Dec 2 for a Dec 5 UTC expiry). */
export const CREDIT_EXPIRY_WARN_DAYS_DEFAULT = [7, 3] as const;

/** America/Toronto wall-clock hour for expiry warnings. 10:00 is mid-morning ET. */
export const CREDIT_EXPIRY_WARN_HOUR_ET = 10;
export const CREDIT_EXPIRY_TZ = 'America/Toronto';

const DAY_MS = 86_400_000;

/** Substrings that make a 4xx a prepaid-credit problem. Matched against the
 * provider's own message — Anthropic reports an exhausted balance as a plain 400
 * whose only distinguishing mark is this text. Narrower than provider-health's
 * billing class: "payment" / "billing" also appear on usage-limit copy. */
const CREDIT_MARKERS = ['credit balance is too low', 'purchase credits'];

/** Anthropic's spend-limit 400s (org / workspace). Those are not an empty prepaid
 * balance; provider-health already pages them as usage_limit. */
const USAGE_LIMIT_PREFIXES = [
  'You have reached your specified API usage limits',
  'You have reached your specified workspace API usage limits',
] as const;

export interface CreditConfig {
  startUsd: number;
  startAt: Date;
  alertUsd: number;
  expiresAt: Date | null;
  warnDays: number[];
}

export type CreditConfigResult =
  | { ok: true; config: CreditConfig }
  | { ok: false; reason: 'start_not_configured' };

/** A positive dollar figure, or null when unset / not a number / not above zero. */
export function parseUsd(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function parseStartAt(raw: string | undefined): Date | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** Positive whole days, unique, descending. Unset or empty falls back to 7 then 3. */
export function parseExpiryWarnDays(raw: string | undefined): number[] {
  if (!raw) return [...CREDIT_EXPIRY_WARN_DAYS_DEFAULT];
  const parsed = raw
    .split(/[,\s]+/)
    .map((token) => Number(token))
    .filter((days) => Number.isInteger(days) && days > 0);
  if (parsed.length === 0) return [...CREDIT_EXPIRY_WARN_DAYS_DEFAULT];
  return [...new Set(parsed)].sort((a, b) => b - a);
}

/** Start dollars + start instant are required; the alert threshold defaults to 40.
 * Expiry is optional: unset skips the days-before warnings. */
export function readCreditConfig(
  env: Record<string, string | undefined> = process.env,
): CreditConfigResult {
  const startUsd = parseUsd(env[ANTHROPIC_CREDIT_START_USD_ENV]);
  const startAt = parseStartAt(env[ANTHROPIC_CREDIT_START_AT_ENV]);
  if (startUsd === null || startAt === null) {
    return { ok: false, reason: 'start_not_configured' };
  }
  return {
    ok: true,
    config: {
      startUsd,
      startAt,
      alertUsd: parseUsd(env[ANTHROPIC_CREDIT_ALERT_USD_ENV]) ?? CREDIT_ALERT_USD_DEFAULT,
      expiresAt: parseStartAt(env[ANTHROPIC_CREDIT_EXPIRES_AT_ENV]),
      warnDays: parseExpiryWarnDays(env[ANTHROPIC_CREDIT_EXPIRY_WARN_DAYS_ENV]),
    },
  };
}

export function creditRemainingUsd(startUsd: number, spendUsd: number): number {
  return startUsd - spendUsd;
}

/**
 * Thresholds that each post once per start value: the configured first alert,
 * then $15. Unique, descending, so a jump from well-funded to nearly empty
 * still fires both, higher first.
 */
export function creditAlertThresholds(alertUsd: number): number[] {
  const unique = new Set([alertUsd, CREDIT_CRITICAL_USD]);
  return [...unique].filter((usd) => usd > 0).sort((a, b) => b - a);
}

/** Thresholds remaining has dropped below that have not yet posted. */
export function crossedCreditThresholds(
  remainingUsd: number,
  thresholds: readonly number[],
  alreadyPosted: ReadonlySet<number>,
): number[] {
  return thresholds.filter((usd) => remainingUsd < usd && !alreadyPosted.has(usd));
}

/**
 * Days of credit left at the observed rate. `windowMs` is the period
 * `spendInWindowUsd` was measured over (capped at 24h by the caller). A window
 * shorter than a day is scaled up so two hours of spend is not treated as a
 * day's worth.
 */
export function daysLeftEstimate(
  remainingUsd: number,
  spendInWindowUsd: number,
  windowMs: number,
): number | null {
  if (!(windowMs > 0) || !(spendInWindowUsd > 0)) return null;
  const perDay = spendInWindowUsd / (windowMs / DAY_MS);
  if (!(perDay > 0)) return null;
  return Math.max(0, remainingUsd) / perDay;
}

export interface CreditRemainingAlert {
  remainingUsd: number;
  spendLast24hUsd: number;
  daysLeft: number | null;
  thresholdUsd: number;
  startUsd: number;
  startAt: Date;
}

/** Fixed ops copy. Dollars and dates only — never a family, a key, or provider text. */
export function formatCreditRemainingAlert(input: CreditRemainingAlert): string {
  const remaining = usd(input.remainingUsd);
  const spend = usd(input.spendLast24hUsd);
  const days =
    input.daysLeft === null ? 'unknown (no spend in the window)' : input.daysLeft.toFixed(1);
  return [
    `Hale ops: Anthropic prepaid credit remaining ${remaining} (below ${usd(input.thresholdUsd)}).`,
    '',
    `spend last 24h: ${spend}`,
    `days left at that rate: ${days}`,
    `start: ${usd(input.startUsd)} at ${input.startAt.toISOString()}`,
    '',
    'Switch the Prod ANTHROPIC_API_KEY before parent replies stop.',
  ].join('\n');
}

export interface CreditBillingErrorAlert {
  httpStatus: number | null;
  errorType: string | null;
}

/** Fixed ops copy. HTTP status and error type only — never the provider message
 * (a 4xx can quote the request) and never a key. */
export function formatCreditBillingErrorAlert(input: CreditBillingErrorAlert): string {
  const status = input.httpStatus === null ? 'no HTTP status' : `HTTP ${input.httpStatus}`;
  const type = input.errorType ?? 'no error type';
  return [
    `Hale ops: Anthropic returned a credit/billing error (${status}, ${type}).`,
    '',
    'Prepaid credit may be exhausted. Switch the Prod ANTHROPIC_API_KEY.',
    'Parent replies will fail until it is replaced.',
    '',
    'one #ops post per hour.',
  ].join('\n');
}

export interface CreditExpiryAlert {
  remainingUsd: number;
  expiresAt: Date;
  daysBefore: number;
}

/** Fixed ops copy. Expiry date, remaining dollars, switch to a paid key. */
export function formatCreditExpiryAlert(input: CreditExpiryAlert): string {
  return [
    `Hale ops: Anthropic prepaid credit expires ${input.expiresAt.toISOString()} (${input.daysBefore}-day warning).`,
    '',
    `remaining: ${usd(input.remainingUsd)}`,
    '',
    'Switch Prod to a paid ANTHROPIC_API_KEY before expiry.',
    'Parent replies will stop when the credit expires.',
  ].join('\n');
}

function utcYmd(at: Date): { year: number; month: number; day: number } {
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}

function addUtcDays(
  parts: { year: number; month: number; day: number },
  days: number,
): { year: number; month: number; day: number } {
  const utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return utcYmd(utc);
}

/** Local wall clock minus the instant, in milliseconds. Toronto in November is −5h. */
function timezoneOffsetMs(instant: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant.getTime();
}

function zonedWallClock(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
  const offset = timezoneOffsetMs(guess, timeZone);
  const instant = new Date(guess.getTime() - offset);
  const offsetAt = timezoneOffsetMs(instant, timeZone);
  if (offsetAt !== offset) return new Date(guess.getTime() - offsetAt);
  return instant;
}

/**
 * Mid-morning ET on the UTC calendar date that is `daysBefore` days before
 * expiry's UTC date. For expiry 2026-12-05T00:00:00Z that is Nov 28 and Dec 2
 * at 10:00 America/Toronto.
 */
export function expiryWarningFireAt(expiresAt: Date, daysBefore: number): Date {
  const target = addUtcDays(utcYmd(expiresAt), -daysBefore);
  return zonedWallClock(
    target.year,
    target.month,
    target.day,
    CREDIT_EXPIRY_WARN_HOUR_ET,
    CREDIT_EXPIRY_TZ,
  );
}

/** Warning days whose mid-morning ET fire time has passed and expiry has not. */
export function dueExpiryWarnings(
  expiresAt: Date | null,
  warnDays: readonly number[],
  now: Date,
  alreadyPosted: ReadonlySet<number>,
): number[] {
  if (!expiresAt || !(now.getTime() < expiresAt.getTime())) return [];
  return warnDays.filter(
    (days) =>
      !alreadyPosted.has(days) && now.getTime() >= expiryWarningFireAt(expiresAt, days).getTime(),
  );
}

function usd(value: number): string {
  const sign = value < 0 ? '-' : '';
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export interface AnthropicSpendRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

/**
 * Price one Claude call from its usage. Null when this is not an Anthropic
 * prepaid-credit call (DeepSeek / gateway ids) — those must not eat the ledger.
 * An unlisted Claude id still records, at $0, rather than inventing a rate.
 */
export function spendRowFromUsage(
  model: string,
  usage: Usage | null | undefined,
): AnthropicSpendRow | null {
  if (!model.startsWith('claude-') || !usage) return null;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const costUsd =
    tryEstimateCostUsd(model, {
      inputTokens,
      cacheCreationTokens: cacheWriteTokens,
      cacheCreation1hTokens: cacheCreation1hFromUsage(usage),
      cacheReadTokens,
      outputTokens,
    }) ?? 0;
  return { model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, costUsd };
}

export interface CreditErrorShape {
  httpStatus: number | null;
  errorType: string | null;
}

/** Walk a cause chain the way the coach wraps SDK errors. */
const CAUSE_DEPTH = 5;

/**
 * True when this failure is an exhausted prepaid balance (or a billing_error
 * type), not a usage-limit cap, a 429, or a malformed request. Reads status and
 * error type from the structured body; the message is consulted only for the
 * 400 whose only mark is "credit balance is too low".
 */
export function isAnthropicCreditError(err: unknown): boolean {
  return creditErrorShape(err) !== null;
}

export function creditErrorShape(err: unknown): CreditErrorShape | null {
  let current: unknown = err;
  for (let depth = 0; depth < CAUSE_DEPTH && current != null; depth += 1) {
    const shape = creditErrorShapeOne(current);
    if (shape) return shape;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function creditErrorShapeOne(err: unknown): CreditErrorShape | null {
  if (isUsageLimitFrame(err)) return null;
  const status = readStatus(err);
  const errorType = readErrorType(err);
  if (errorType === 'billing_error') {
    return { httpStatus: status, errorType };
  }
  if (status === 402) {
    return { httpStatus: status, errorType };
  }
  if (status !== 400) return null;
  const detail = providerMessage(err).toLowerCase();
  if (!CREDIT_MARKERS.some((marker) => detail.includes(marker))) return null;
  return { httpStatus: status, errorType };
}

function isUsageLimitFrame(err: unknown): boolean {
  const frame = err as {
    status?: unknown;
    error?: {
      error?: { type?: unknown; message?: unknown; details?: { error_code?: unknown } | null };
    };
  } | null;
  const body = frame?.error?.error;
  if (frame?.status === 429 && body?.details?.error_code === 'enforced_spend_limit_reached') {
    return true;
  }
  if (frame?.status !== 400 || body?.type !== 'invalid_request_error') return false;
  const message = typeof body.message === 'string' ? body.message : '';
  return USAGE_LIMIT_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function readStatus(err: unknown): number | null {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

function readErrorType(err: unknown): string | null {
  const type = (err as { error?: { error?: { type?: unknown } } } | null)?.error?.error?.type;
  return typeof type === 'string' ? type : null;
}

function providerMessage(err: unknown): string {
  const body = (err as { error?: { error?: { message?: unknown } } } | null)?.error?.error?.message;
  if (typeof body === 'string' && body.length > 0) return body;
  if (err instanceof Error && err.message.length > 0) return err.message;
  return String(err);
}
