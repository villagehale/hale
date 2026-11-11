import { createHmac, randomUUID } from 'node:crypto';
import { tryEstimateCostUsd } from './cost.js';
import { cacheCreation1hFromUsage, cacheHitRate } from './prompt-cache.js';

/**
 * Shared `$ai_generation` property bag for PostHog LLM analytics.
 *
 * Both processes capture through this builder so web and worker cannot drift on
 * the event shape, the cost arithmetic, or the PII redaction. The wrapper that
 * talks to posthog-node stays in each app (worker cannot import from web).
 */

/** The stages the LLM dashboard breaks down by. 'unattributed' is a real bucket, not a default to hide. */
export type HaleStage =
  | 'triage'
  | 'reply_intent'
  | 'memory_infer'
  | 'intake_extract'
  | 'inbound_screen'
  | 'classify_event'
  | 'drafter'
  | 'reviewer'
  | 'discovery'
  | 'coach'
  | 'retention'
  | 'claim_read'
  | 'reminder'
  | 'voice'
  | 'plan'
  | 'activity'
  | 'notice'
  | 'spoken_line'
  | 'onboarding'
  | 'compose'
  | 'group'
  | 'registration'
  | 'unattributed';

export type LlmDeployEnv = 'prod' | 'preview' | 'eval';

export interface LlmTraceContext {
  /** HMAC of the family id, or 'system' for crons. Never a phone number or raw id. */
  distinctId?: string;
  /** agent_runs.id when the call belongs to an agent turn. */
  traceId?: string;
  stage?: HaleStage;
  promptVersion?: string;
  channel?: 'sms' | 'imessage' | 'email' | 'none';
  mode?: string;
  /** prod / preview / eval. Eval harness sets this; otherwise derived from VERCEL_ENV. */
  env?: LlmDeployEnv;
  /** Eval suite name. */
  suite?: string;
  /** Eval case / fixture name. */
  caseName?: string;
  /** True when this generation was replayed from the eval cache. */
  cached?: boolean;
}

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_creation?: { ephemeral_1h_input_tokens?: number | null } | null;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** E.164 and common North-American forms. Digit runs shorter than a phone are left. */
const PHONE = /(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)(?!\d)/g;
const STREET =
  /\b\d{1,5}\s+(?:[A-Za-z0-9.'-]+\s+){0,5}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Crescent|Cres|Terrace|Ter)\.?\b/gi;

/** Redact phones, emails, and street addresses from a string. Names are not stripped
 * (that would be a word list). Applied only to prompt/completion bodies. */
export function redactLlmPii(text: string): string {
  return text.replace(EMAIL, '[email]').replace(PHONE, '[phone]').replace(STREET, '[address]');
}

export function redactLlmPiiDeep<T>(value: T): T {
  if (typeof value === 'string') return redactLlmPii(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactLlmPiiDeep(item)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactLlmPiiDeep(nested);
    }
    return out as T;
  }
  return value;
}

/**
 * HMAC-SHA256 of a family id keyed by POSTHOG_ID_SALT. Null when the salt is unset so a
 * caller can fall back to `system` rather than emit the raw id.
 */
export function hashLlmFamilyId(familyId: string, salt: string | undefined): string | null {
  if (!salt || !familyId) return null;
  return createHmac('sha256', salt).update(familyId).digest('hex');
}

/** Exact `true` (Hale flag posture). Anything else, including unset, is off. */
export function llmContentCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.POSTHOG_LLM_CONTENT_ENABLED === 'true';
}

export function llmDeployEnv(env: NodeJS.ProcessEnv = process.env): LlmDeployEnv {
  if (env.VERCEL_ENV === 'production') return 'prod';
  if (env.VERCEL_ENV === 'preview') return 'preview';
  return 'preview';
}

export function serializeAiInput(params: {
  system?: unknown;
  messages?: unknown;
}): Array<{ role: string; content: unknown }> {
  const input: Array<{ role: string; content: unknown }> = [];
  if (params.system !== undefined) {
    input.push({ role: 'system', content: redactLlmPiiDeep(params.system) });
  }
  if (Array.isArray(params.messages)) {
    for (const message of params.messages) {
      const row = message as { role?: unknown; content?: unknown };
      input.push({
        role: typeof row?.role === 'string' ? row.role : 'user',
        content: redactLlmPiiDeep(row?.content),
      });
    }
  }
  return input;
}

export function serializeAiOutput(result: { content?: unknown } | null): Array<{
  role: string;
  content: unknown;
}> {
  return [{ role: 'assistant', content: redactLlmPiiDeep(result?.content ?? '') }];
}

export function buildGenerationProperties(input: {
  ctx: LlmTraceContext;
  model: string;
  latencyMs: number;
  usage?: Usage | null;
  stopReason?: string | null;
  error?: unknown;
  contentEnabled?: boolean;
  request?: { system?: unknown; messages?: unknown } | null;
  response?: { content?: unknown } | null;
  spanId?: string;
}): Record<string, unknown> {
  const { ctx, usage } = input;
  const spanId = input.spanId ?? randomUUID();
  const stage = ctx.stage ?? 'unattributed';
  const env = ctx.env ?? llmDeployEnv();
  const props: Record<string, unknown> = {
    $ai_provider: 'anthropic',
    $ai_model: input.model,
    $ai_latency: input.latencyMs / 1000,
    $ai_trace_id: ctx.traceId ?? randomUUID(),
    $ai_span_id: spanId,
    $ai_span_name: stage,
    $ai_is_error: input.error !== undefined,
    $ai_cache_reporting_exclusive: true,
    hale_stage: stage,
    env,
    privacy_mode: !(input.contentEnabled ?? false),
  };
  if (usage?.input_tokens != null) props.$ai_input_tokens = usage.input_tokens;
  if (usage?.output_tokens != null) props.$ai_output_tokens = usage.output_tokens;
  if (usage?.cache_read_input_tokens != null) {
    props.$ai_cache_read_input_tokens = usage.cache_read_input_tokens;
  }
  if (usage?.cache_creation_input_tokens != null) {
    props.$ai_cache_creation_input_tokens = usage.cache_creation_input_tokens;
  }
  if (usage?.cache_read_input_tokens != null || usage?.cache_creation_input_tokens != null) {
    const rate = cacheHitRate(usage);
    if (rate != null) props.hale_cache_hit_rate = rate;
  }
  const cost = pricedUsd(input.model, usage);
  if (cost != null) {
    props.$ai_input_cost_usd = cost.input;
    props.$ai_output_cost_usd = cost.output;
    props.$ai_total_cost_usd = cost.total;
  }
  if (input.stopReason) props.$ai_stop_reason = input.stopReason;
  if (ctx.promptVersion) props.prompt_version = ctx.promptVersion;
  if (ctx.channel) props.channel = ctx.channel;
  if (ctx.mode) props.mode = ctx.mode;
  if (ctx.suite) props.hale_eval_suite = ctx.suite;
  if (ctx.caseName) props.hale_eval_case = ctx.caseName;
  if (ctx.cached !== undefined) props.cached = ctx.cached;
  if (input.contentEnabled && input.request) {
    props.$ai_input = serializeAiInput(input.request);
  }
  if (input.contentEnabled && input.response) {
    props.$ai_output_choices = serializeAiOutput(input.response);
  }
  if (input.error !== undefined) {
    const err = input.error as { name?: unknown; status?: unknown };
    props.$ai_error = typeof err?.name === 'string' ? err.name : 'Error';
    if (typeof err?.status === 'number') props.$ai_http_status = err.status;
  }
  return props;
}

function pricedUsd(
  model: string,
  usage: Usage | null | undefined,
): { input: number; output: number; total: number } | undefined {
  if (!usage) return undefined;
  const cacheCreation = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const total = tryEstimateCostUsd(model, {
    inputTokens,
    cacheCreationTokens: cacheCreation,
    cacheCreation1hTokens: cacheCreation1hFromUsage(usage),
    cacheReadTokens: cacheRead,
    outputTokens,
  });
  if (total == null) return undefined;
  const output = tryEstimateCostUsd(model, {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens,
  });
  const input = output == null ? total : Math.max(0, total - output);
  return { input, output: output ?? 0, total };
}
