import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type HaleStage,
  type LlmTraceContext,
  anthropicCreditAlertEnabled,
  buildGenerationProperties,
  hashLlmFamilyId,
  llmContentCaptureEnabled,
} from '@hale/agent';
import type { PostHog } from 'posthog-node';
import { observeAnthropicCall } from './anthropic-credit.js';
import { projectClient } from './posthog.js';

/**
 * LLM analytics for every Anthropic call.
 *
 * Every worker client is built by src/anthropic/client.ts, and that factory hands it
 * through {@link traceAnthropic}. With POSTHOG_PROJECT_API_KEY unset and the prepaid
 * credit alert off, the client is returned UNTOUCHED — the same object, no proxy, no
 * timer — which is the inert path the tests pin. With the key set, `messages.create`
 * and `messages.stream` report one `$ai_generation` per call: model, tokens, cache,
 * cost, latency, stage, hashed family. The credit observer also wraps when
 * ANTHROPIC_CREDIT_ALERT_ENABLED is exactly `true`, even without PostHog.
 *
 * Content ($ai_input / $ai_output_choices) is behind POSTHOG_LLM_CONTENT_ENABLED (exact
 * `true`, default off). When on, phones, emails, and street addresses are redacted first.
 * The family id is HMAC-SHA256'd with POSTHOG_ID_SALT; without a salt the distinct id is
 * `system`, never the raw id.
 *
 * Why not `@posthog/ai`'s wrapper: it requires `@anthropic-ai/sdk >= 0.112`, and Hale pins
 * 0.41. The event shape here is PostHog's documented LLM-analytics schema.
 */

export type { HaleStage, LlmTraceContext };

const storage = new AsyncLocalStorage<LlmTraceContext>();

/** Run `fn` with a trace context; nested calls inherit and override field by field. */
export function withLlmContext<T>(ctx: LlmTraceContext, fn: () => T): T {
  return storage.run({ ...storage.getStore(), ...ctx }, fn);
}

/** Hashed family id for distinct_id, or empty when the salt is unset. */
export function llmFamilyContext(familyId: string): Pick<LlmTraceContext, 'distinctId'> {
  const distinctId = hashLlmFamilyId(familyId, process.env.POSTHOG_ID_SALT);
  return distinctId ? { distinctId } : {};
}

export { buildGenerationProperties };

function afterCall(
  posthog: PostHog | null,
  ctx: LlmTraceContext,
  model: string,
  started: number,
  result: { usage?: unknown; stop_reason?: string | null; content?: unknown } | null,
  error: unknown | undefined,
  request: { model?: string; system?: unknown; messages?: unknown } | null,
): void {
  observeAnthropicCall(
    error !== undefined
      ? { model, error }
      : { model, usage: (result?.usage as never) ?? undefined },
  );
  if (posthog) report(posthog, ctx, model, started, result, error, request);
}

function report(
  client: PostHog,
  ctx: LlmTraceContext,
  model: string,
  started: number,
  result: { usage?: unknown; stop_reason?: string | null; content?: unknown } | null,
  error?: unknown,
  request?: { model?: string; system?: unknown; messages?: unknown } | null,
): void {
  try {
    client.capture({
      distinctId: ctx.distinctId ?? 'system',
      event: '$ai_generation',
      properties: buildGenerationProperties({
        ctx,
        model,
        latencyMs: Date.now() - started,
        usage: (result?.usage as never) ?? null,
        stopReason: result?.stop_reason ?? null,
        error,
        contentEnabled: llmContentCaptureEnabled() && !ctx.omitContent,
        request: request ?? null,
        response: result,
      }),
    });
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
 * Wrap an Anthropic client's `messages.create` / `messages.stream` with LLM-analytics
 * tracing and the prepaid-credit spend observer. Returns `client` itself, unwrapped,
 * when POSTHOG_PROJECT_API_KEY is unset and ANTHROPIC_CREDIT_ALERT_ENABLED is not
 * exactly `true`.
 */
export function traceAnthropic<C extends { messages: MessagesLike }>(
  client: C,
  base: LlmTraceContext = {},
  posthog: PostHog | null = projectClient(),
): C {
  if (!posthog && !anthropicCreditAlertEnabled()) return client;
  const messages = client.messages;
  const ctxNow = (): LlmTraceContext => ({ ...base, ...storage.getStore() });

  const wrappedMessages = new Proxy(messages, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'create' && typeof value === 'function') {
        return (
          params: { model?: string; system?: unknown; messages?: unknown },
          ...rest: unknown[]
        ) => {
          const ctx = ctxNow();
          const started = Date.now();
          const model = params?.model ?? 'unknown';
          const out = (value as (...a: unknown[]) => unknown).call(target, params, ...rest);
          if (out && typeof (out as Promise<unknown>).then === 'function') {
            (out as Promise<unknown>).then(
              (res) => afterCall(posthog, ctx, model, started, res as never, undefined, params),
              (err) => afterCall(posthog, ctx, model, started, null, err, params),
            );
          }
          return out;
        };
      }
      if (prop === 'stream' && typeof value === 'function') {
        return (
          params: { model?: string; system?: unknown; messages?: unknown },
          ...rest: unknown[]
        ) => {
          const ctx = ctxNow();
          const started = Date.now();
          const model = params?.model ?? 'unknown';
          const stream = (value as (...a: unknown[]) => unknown).call(target, params, ...rest) as {
            finalMessage?: () => Promise<unknown>;
          };
          if (stream && typeof stream.finalMessage === 'function') {
            stream.finalMessage().then(
              (res) => afterCall(posthog, ctx, model, started, res as never, undefined, params),
              (err) => afterCall(posthog, ctx, model, started, null, err, params),
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
