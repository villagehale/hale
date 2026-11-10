import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { PostHog } from 'posthog-node';
import { projectClient } from './posthog.js';

/**
 * LLM analytics for every Anthropic call, in PRIVACY MODE (hard rule #1).
 *
 * Every worker client is built by src/anthropic/client.ts, and that factory hands it
 * through {@link traceAnthropic}. With POSTHOG_PROJECT_API_KEY unset the client is
 * returned UNTOUCHED — the same object, no proxy, no timer — which is the inert path the
 * tests pin. With the key set, `messages.create` and `messages.stream` report one
 * `$ai_generation` per call: model, token counts, latency, stage, trace id, error class.
 *
 * WHAT IS NEVER SENT: `$ai_input`, `$ai_output_choices`, the system prompt, tool
 * arguments, or an error message. They are not stripped after the fact; the builder below
 * has no field they could ride in (llm-trace.test.ts asserts their absence on the wire).
 *
 * Why not `@posthog/ai`'s wrapper: it requires `@anthropic-ai/sdk >= 0.112`, and Hale pins
 * 0.41. The event shape here is the one PostHog's LLM dashboards read.
 */

/** The stages the LLM dashboard breaks down by. 'unattributed' is a real bucket, not a default to hide. */
export type HaleStage =
  | 'triage'
  | 'reply_intent'
  | 'memory_infer'
  | 'intake_extract'
  | 'inbound_screen'
  | 'classify_event'
  | 'reviewer'
  | 'discovery'
  | 'coach'
  | 'retention'
  | 'unattributed';

export interface LlmTraceContext {
  /** Hashed family id, or 'system' for crons. Never a phone number or raw id. */
  distinctId?: string;
  /** agent_runs.id when the call belongs to an agent turn. */
  traceId?: string;
  stage?: HaleStage;
  promptVersion?: string;
  channel?: 'sms' | 'imessage' | 'email' | 'none';
  mode?: string;
}

const storage = new AsyncLocalStorage<LlmTraceContext>();

/** Run `fn` with a trace context; nested calls inherit and override field by field. */
export function withLlmContext<T>(ctx: LlmTraceContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...ctx }, fn);
}

interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** The whole `$ai_generation` property bag. Pure + exported so the privacy shape is asserted directly. */
export function buildGenerationProperties(input: {
  ctx: LlmTraceContext;
  model: string;
  latencyMs: number;
  usage?: Usage | null;
  stopReason?: string | null;
  error?: unknown;
}): Record<string, string | number | boolean> {
  const { ctx, usage } = input;
  const props: Record<string, string | number | boolean> = {
    $ai_provider: 'anthropic',
    $ai_model: input.model,
    $ai_latency: input.latencyMs / 1000,
    $ai_trace_id: ctx.traceId ?? randomUUID(),
    $ai_is_error: input.error !== undefined,
    hale_stage: ctx.stage ?? 'unattributed',
    privacy_mode: true,
  };
  if (usage?.input_tokens != null) props.$ai_input_tokens = usage.input_tokens;
  if (usage?.output_tokens != null) props.$ai_output_tokens = usage.output_tokens;
  if (usage?.cache_read_input_tokens != null)
    props.$ai_cache_read_input_tokens = usage.cache_read_input_tokens;
  if (usage?.cache_creation_input_tokens != null)
    props.$ai_cache_creation_input_tokens = usage.cache_creation_input_tokens;
  if (input.stopReason) props.$ai_stop_reason = input.stopReason;
  if (ctx.promptVersion) props.prompt_version = ctx.promptVersion;
  if (ctx.channel) props.channel = ctx.channel;
  if (ctx.mode) props.mode = ctx.mode;
  if (input.error !== undefined) {
    // The class and the HTTP status only. An SDK error message can quote the request.
    const err = input.error as { name?: unknown; status?: unknown };
    props.$ai_error = typeof err?.name === 'string' ? err.name : 'Error';
    if (typeof err?.status === 'number') props.$ai_http_status = err.status;
  }
  return props;
}

function report(
  client: PostHog,
  ctx: LlmTraceContext,
  model: string,
  started: number,
  result: { usage?: Usage | null; stop_reason?: string | null } | null,
  error?: unknown,
): void {
  try {
    client.capture({
      distinctId: ctx.distinctId ?? 'system',
      event: '$ai_generation',
      properties: buildGenerationProperties({
        ctx,
        model,
        latencyMs: Date.now() - started,
        usage: result?.usage ?? null,
        stopReason: result?.stop_reason ?? null,
        error,
      }),
    });
    // flushAt: 1 already sends; the explicit flush is not awaited so the parent's
    // turn never waits on PostHog. Routes flush again in `after()`.
    void client.flush().catch(() => {});
  } catch {
    // Tracing must never fail a model call.
  }
}

interface MessagesLike {
  create: (...args: never[]) => unknown;
  stream?: (...args: never[]) => unknown;
}

/**
 * Wrap an Anthropic client's `messages.create` / `messages.stream` with privacy-mode
 * tracing. Returns `client` itself, unwrapped, when POSTHOG_PROJECT_API_KEY is unset.
 */
export function traceAnthropic<C extends { messages: MessagesLike }>(
  client: C,
  base: LlmTraceContext = {},
  posthog: PostHog | null = projectClient(),
): C {
  if (!posthog) return client;
  const ph = posthog;
  const messages = client.messages;
  const ctxNow = (): LlmTraceContext => ({ ...base, ...storage.getStore() });

  const wrappedMessages = new Proxy(messages, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'create' && typeof value === 'function') {
        return (params: { model?: string }, ...rest: unknown[]) => {
          const ctx = ctxNow();
          const started = Date.now();
          const model = params?.model ?? 'unknown';
          const out = (value as (...a: unknown[]) => unknown).call(target, params, ...rest);
          // Observe without changing what the caller holds (an APIPromise stays one).
          if (out && typeof (out as Promise<unknown>).then === 'function') {
            (out as Promise<unknown>).then(
              (res) => {
                // A `stream: true` create resolves to a Stream with no usage; still counted.
                report(ph, ctx, model, started, res as never);
              },
              (err) => report(ph, ctx, model, started, null, err),
            );
          }
          return out;
        };
      }
      if (prop === 'stream' && typeof value === 'function') {
        return (params: { model?: string }, ...rest: unknown[]) => {
          const ctx = ctxNow();
          const started = Date.now();
          const model = params?.model ?? 'unknown';
          const stream = (value as (...a: unknown[]) => unknown).call(target, params, ...rest) as {
            finalMessage?: () => Promise<unknown>;
          };
          if (stream && typeof stream.finalMessage === 'function') {
            stream.finalMessage().then(
              (res) => report(ph, ctx, model, started, res as never),
              (err) => report(ph, ctx, model, started, null, err),
            );
          }
          return stream;
        };
      }
      return value;
    },
  });

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'messages') return wrappedMessages;
      return Reflect.get(target, prop, receiver);
    },
  });
}
