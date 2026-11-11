/**
 * PostHog `$ai_generation` for the eval harness. Inert without POSTHOG_PROJECT_API_KEY.
 * A PostHog error must never fail or block an eval — cached or live.
 */

import { randomUUID } from 'node:crypto';
import { PostHog } from 'posthog-node';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)(?!\d)/g;
const STREET =
  /\b\d{1,5}\s+(?:[A-Za-z0-9.'-]+\s+){0,5}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Crescent|Cres|Terrace|Ter)\.?\b/gi;

function redact(text) {
  return String(text).replace(EMAIL, '[email]').replace(PHONE, '[phone]').replace(STREET, '[address]');
}

function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out;
  }
  return value;
}

let ph;
function posthog() {
  const key = process.env.POSTHOG_PROJECT_API_KEY;
  if (!key) return null;
  ph ??= new PostHog(key, {
    host: process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
    flushAt: 1,
    flushInterval: 0,
    disableGeoip: true,
    requestTimeout: 4_000,
    fetchRetryCount: 0,
  });
  return ph;
}

function contentOn() {
  return process.env.POSTHOG_LLM_CONTENT_ENABLED === 'true';
}

function captureGeneration(input) {
  try {
    const client = posthog();
    if (!client) return;
    const usage = input.usage ?? {};
    const read = usage.cache_read_input_tokens ?? 0;
    const create = usage.cache_creation_input_tokens ?? 0;
    const tokensIn = usage.input_tokens ?? 0;
    const denom = read + create + tokensIn;
    const props = {
      $ai_provider: 'anthropic',
      $ai_model: input.model ?? 'unknown',
      $ai_latency: (input.latencyMs ?? 0) / 1000,
      $ai_trace_id: input.traceId ?? randomUUID(),
      $ai_span_id: randomUUID(),
      $ai_span_name: input.stage ?? 'unattributed',
      $ai_is_error: Boolean(input.error),
      $ai_cache_reporting_exclusive: true,
      hale_stage: input.stage ?? 'unattributed',
      env: 'eval',
      privacy_mode: !contentOn(),
      cached: Boolean(input.cached),
    };
    if (input.suite) props.hale_eval_suite = input.suite;
    if (input.caseName) props.hale_eval_case = input.caseName;
    if (usage.input_tokens != null) props.$ai_input_tokens = usage.input_tokens;
    if (usage.output_tokens != null) props.$ai_output_tokens = usage.output_tokens;
    if (usage.cache_read_input_tokens != null) props.$ai_cache_read_input_tokens = usage.cache_read_input_tokens;
    if (usage.cache_creation_input_tokens != null) {
      props.$ai_cache_creation_input_tokens = usage.cache_creation_input_tokens;
    }
    if (denom > 0) props.hale_cache_hit_rate = read / denom;
    if (contentOn() && input.request) {
      const aiInput = [];
      if (input.request.system !== undefined) {
        aiInput.push({ role: 'system', content: redactDeep(input.request.system) });
      }
      if (Array.isArray(input.request.messages)) {
        for (const message of input.request.messages) {
          aiInput.push({
            role: message?.role ?? 'user',
            content: redactDeep(message?.content),
          });
        }
      }
      props.$ai_input = aiInput;
    }
    if (contentOn() && input.response) {
      props.$ai_output_choices = [{ role: 'assistant', content: redactDeep(input.response.content ?? '') }];
    }
    client.capture({
      distinctId: 'eval',
      event: '$ai_generation',
      properties: props,
    });
    void client.flush().catch(() => {});
  } catch {
    // Eval must never fail because PostHog is unset or down.
  }
}

/** Fire-and-forget capture for a cached replay that never hits the SDK wrapper. */
export function reportEvalGeneration(input) {
  captureGeneration({ ...input, cached: input.cached !== false });
}

/**
 * Wrap an Anthropic client. Returns the same object when PostHog is unset.
 * Named so the coverage test can see eval construction sites go through tracing.
 */
export function wrapEvalAnthropic(client, ctx = {}) {
  try {
    if (!posthog()) return client;
    const messages = client.messages;
    const wrappedMessages = new Proxy(messages, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'create' && typeof value === 'function') {
          return (params, ...rest) => {
            const started = Date.now();
            const out = value.call(target, params, ...rest);
            if (out && typeof out.then === 'function') {
              out.then(
                (res) =>
                  captureGeneration({
                    ...ctx,
                    model: params?.model,
                    latencyMs: Date.now() - started,
                    usage: res?.usage,
                    request: params,
                    response: res,
                    cached: false,
                  }),
                (err) =>
                  captureGeneration({
                    ...ctx,
                    model: params?.model,
                    latencyMs: Date.now() - started,
                    error: err,
                    request: params,
                    cached: false,
                  }),
              );
            }
            return out;
          };
        }
        if (prop === 'stream' && typeof value === 'function') {
          return (params, ...rest) => {
            const started = Date.now();
            const stream = value.call(target, params, ...rest);
            if (stream && typeof stream.finalMessage === 'function') {
              stream.finalMessage().then(
                (res) =>
                  captureGeneration({
                    ...ctx,
                    model: params?.model,
                    latencyMs: Date.now() - started,
                    usage: res?.usage,
                    request: params,
                    response: res,
                    cached: false,
                  }),
                (err) =>
                  captureGeneration({
                    ...ctx,
                    model: params?.model,
                    latencyMs: Date.now() - started,
                    error: err,
                    request: params,
                    cached: false,
                  }),
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
  } catch {
    return client;
  }
}

export async function flushEvalPosthog() {
  try {
    if (!ph) return;
    await ph.flush();
  } catch {
    // ignore
  }
}

if (!globalThis.__haleEvalPosthogFlush) {
  globalThis.__haleEvalPosthogFlush = true;
  process.on('beforeExit', () => {
    void flushEvalPosthog();
  });
}
