// Shared eval primitives for the VIL-143 launch evals (cost+accuracy curve and
// model-per-role matrix). These mirror the patterns the existing single-agent
// evals (run-eval / run-drafter-eval / run-agent-eval) each inline: a
// content-addressed response cache, a lazily-constructed Anthropic client that is
// NEVER built in --cached-only mode, a cached LLM-as-judge, model ids read live
// from the single sources of truth, and a USD cost accumulator. They live in one
// module here because three new runners share them — extracting once beats a third
// copy-paste (CLAUDE.md Simplicity First).
//
// Rule #8: no LLM mocking. The judge and every agent call hit real Claude once,
// then replay from cache. A --cached-only miss FAILS LOUDLY (exit 1) so CI can
// never silently spend.

import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  cacheAwareWorstUsd,
  capEnabled,
  capSdkClient,
  cappedCall,
  installSpendCap,
  isEstimate,
  readCapUsd,
  readLedger,
} from '../../../web/lib/testing/spend-cap.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
import { GENERAL_REFERENCE_TEXTS, renderReferenceTexts } from './judge-references.mjs';
export { GENERAL_REFERENCE_TEXTS, renderReferenceTexts };
export const WORKER_ROOT = join(HERE, '..', '..');
export const REPO_ROOT = join(WORKER_ROOT, '..', '..');
export const CACHE_DIR = join(HERE, '..', 'cache');
const MODEL_TS = join(REPO_ROOT, 'packages', 'agent', 'src', 'model.ts');
const CONTEXT_TS = join(REPO_ROOT, 'apps', 'web', 'lib', 'coach', 'context.ts');

// List prices, USD per 1M tokens. Source: platform.claude.com/docs/en/about-claude/pricing
// (read 2026-10-11). Haiku 5.5 is the ≤100K-token prompt card; no eval prompt is longer.
export const PRICE = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-sonnet-5.5': { input: 2.0, output: 10.0 },
  'claude-sonnet-5-5': { input: 2.0, output: 10.0 },
  'claude-opus-4-8': { input: 15.0, output: 75.0 },
  // Opus 5, matching packages/agent/src/cost.ts (the runtime's own LIST table). It was
  // MISSING while the deep synthesis lane was already spending on it, and `totalUsd`
  // skipped what it could not price — so a live eval run reported $0.0000 and looked
  // free. An unpriced model is now loud (see below) rather than costless.
  'claude-opus-5': { input: 5.0, output: 25.0 },
  'claude-opus-5.5': { input: 4.0, output: 20.0 },
  'claude-opus-5-5': { input: 4.0, output: 20.0 },
  'deepseek/deepseek-v4.1-flash': { input: 0.15, output: 0.6 },
  'google/gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  'google/gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'openai/gpt-5.4-nano': { input: 0.2, output: 1.25 },
  'openai/gpt-5.6-luna': { input: 0.2, output: 1.2 },
  'openai/gpt-6-luna': { input: 0.1, output: 0.5 },
  'openai/gpt-6-sol': { input: 2.0, output: 10.0 },
  'openai/gpt-6.1-sol': { input: 2.0, output: 10.0 },
};

// --- single sources of truth ------------------------------------------------
// Model ids come from packages/agent/src/model.ts, where the codebase centralizes
// them. Reading them rather than hardcoding means a model bump can't silently
// desync the eval.

export async function readModelIds() {
  const src = await readFile(MODEL_TS, 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp(`${name}\\s*=\\s*'([^']+)'`));
    if (!m) throw new Error(`could not parse ${name} from ${MODEL_TS}`);
    return m[1];
  };
  return {
    haiku: grab('HAIKU_MODEL'),
    sonnet: grab('SONNET_MODEL'),
    opus: grab('OPUS_MODEL'),
    judge: grab('JUDGE_MODEL'),
  };
}

let agentModule;

/**
 * @hale/agent as production loads it (the built package, which CI builds before the eval
 * job) — the same seam runtime sends through. Loaded only for a live call, so a
 * --cached-only run never imports it. Not a second `tsImport` of the source: a suite that
 * has already tsImported the web runtime (coach-channel) hangs the tsx loader on it.
 */
export async function loadAgent() {
  agentModule ??= await import('@hale/agent');
  return agentModule;
}

// The bounded memory_slice limits the live coach actually applies, read straight
// from apps/web/lib/coach/context.ts so the eval's "bounded" arm matches prod and
// a limit change re-keys the cache.
export async function readMemoryLimits() {
  const src = await readFile(CONTEXT_TS, 'utf8');
  const fact = src.match(/RELEVANT_FACT_LIMIT\s*=\s*(\d+)/);
  const ep = src.match(/RECENT_EPISODE_LIMIT\s*=\s*(\d+)/);
  if (!fact || !ep) {
    throw new Error(`could not parse memory limits from ${CONTEXT_TS}`);
  }
  return { factLimit: Number(fact[1]), episodeLimit: Number(ep[1]) };
}

/**
 * WHICH MODEL GRADES.
 *
 * `'haiku'` is the default and stays the default: most rubrics in this directory are
 * short, and a cheap judge run over a small corpus is the point of the harness.
 *
 * `'sonnet'` (the name predates the 5.5 move) is for the rubrics that have outgrown it.
 * Measured 2026-08-25 on the activity suites, whose rubric runs to about four thousand
 * characters: Haiku marked a message down for things the rubric states IN SO MANY WORDS
 * are correct — not a harsh reading, the grader not holding the instructions.
 *
 * It reads JUDGE_MODEL, which is NOT the Sonnet tier: these suites run their SUBJECT on
 * Sonnet, and a model grading its own output is not a second opinion. Read out of
 * packages/agent's model.ts rather than pinned here, so a re-tier moves the evals with
 * production instead of leaving them grading against a retired id.
 */
export async function readJudgeModel(tier = 'haiku') {
  const src = await readFile(MODEL_TS, 'utf8');
  const symbol = tier === 'sonnet' ? 'JUDGE_MODEL' : 'HAIKU_MODEL';
  const m = src.match(new RegExp(`${symbol}\\s*=\\s*'([^']+)'`));
  if (!m) throw new Error(`could not parse ${symbol} from ${MODEL_TS}`);
  return m[1];
}

// --- content-addressed cache ------------------------------------------------
// Key = sha256(tag + "\n" + canonical request). Any change to a model id, a
// prompt/skill, or a fixture input mints a new key, so a stale answer is never
// reused; a cache hit makes zero API calls.

/**
 * The messages with every message-level `cache_control` removed, for hashing (VIL-430).
 * The agent loop puts a rolling breakpoint on its newest tool-result block; that marker
 * changes the bill, not the question, so it must not change a replay key. Lossless:
 * tool-result and other message blocks carry no `cache_control` of their own. System
 * blocks are NOT touched here, so keys that already hash a cached system stay put.
 */
export function withoutMessageCacheMarkers(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!Array.isArray(message?.content)) return message;
    if (!message.content.some((block) => block && 'cache_control' in block)) return message;
    return {
      ...message,
      content: message.content.map((block) => {
        if (!block || !('cache_control' in block)) return block;
        const { cache_control: _marker, ...rest } = block;
        return rest;
      }),
    };
  });
}

export function cacheKey(tag, payload) {
  return createHash('sha256').update(`${tag}\n${payload}`).digest('hex');
}

export async function cacheGet(key) {
  const path = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function cachePut(key, value) {
  // An estimate round answers with stand-ins; none of them may become a recording.
  if (isEstimate()) return;
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${key}.json`), JSON.stringify(value, null, 2));
}

// --- cost accumulator -------------------------------------------------------

export function makeCost() {
  return { liveCalls: 0, byModel: {} };
}

export function noteUsage(cost, model, usage) {
  cost.liveCalls += 1;
  if (!cost.byModel[model]) cost.byModel[model] = { input: 0, output: 0 };
  const bucket = cost.byModel[model];
  bucket.input += usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
  bucket.output += usage.output_tokens;
}

/** Per-MTok list rates for the spend cap. An unpriced model refuses the call. */
export function priceRates(model) {
  const p = PRICE[model];
  if (!p) throw new Error(`spend-cap: no price for ${model}; refusing the call`);
  return p;
}

export function totalUsd(cost) {
  let usd = 0;
  for (const [model, b] of Object.entries(cost.byModel)) {
    const p = PRICE[model];
    if (!p) {
      // NEVER SILENTLY FREE. A model missing from the table used to contribute nothing,
      // so a suite that had moved to a new tier reported a spend of zero while billing
      // normally — the one number an operator reads to decide whether a corpus is
      // affordable, saying the opposite of the truth (rule #11).
      console.warn(
        `eval harness: no price for ${model} (${b.input} in / ${b.output} out tokens) - add it to PRICE; this run's spend is UNDERSTATED`,
      );
      continue;
    }
    usd += (b.input / 1e6) * p.input + (b.output / 1e6) * p.output;
  }
  return usd;
}

const EVAL_LATENCIES = new Map();

export function noteLatency(model, latencyMs) {
  if (!process.env.EVAL_PRINT_TELEMETRY || !Number.isFinite(latencyMs)) return;
  const values = EVAL_LATENCIES.get(model) ?? [];
  values.push(latencyMs);
  EVAL_LATENCIES.set(model, values);
}

if (process.env.EVAL_PRINT_TELEMETRY) {
  process.on('exit', () => {
    for (const [model, values] of EVAL_LATENCIES) {
      const sorted = [...values].sort((a, b) => a - b);
      const percentile = (q) => sorted[Math.ceil(q * sorted.length) - 1];
      console.info(
        `eval latency | model=${model} calls=${values.length} p50=${percentile(0.5)}ms p95=${percentile(0.95)}ms`,
      );
    }
  });
}

// --- lazy client (never built in --cached-only) -----------------------------

/** Prints the ceiling once, before any live call. With neither source set, the cap stays off. */
export function installEvalSpendCap() {
  // --dry projects against a REAL ledger or not at all: with no HALE_SPEND_LEDGER it
  // refuses, rather than quietly reading installSpendCap's /tmp default (an empty ledger
  // that would understate what has been spent).
  if (
    isDryRun() &&
    (!process.env.HALE_SPEND_LEDGER || process.env.HALE_EVAL_LEDGER_DEFAULTED === '1')
  ) {
    throw new Error('eval --dry: no ledger path (HALE_SPEND_LEDGER); refusing to run');
  }
  // installSpendCap quietly defaults the ledger to /tmp; remember that it was not chosen,
  // so the live-call guard below still refuses.
  if (!process.env.HALE_SPEND_LEDGER) process.env.HALE_EVAL_LEDGER_DEFAULTED = '1';
  const cap = installSpendCap(process.argv);
  if (cap !== null) {
    const ledger = readLedger();
    console.info(
      `spend cap $${cap.toFixed(4)} | already spent $${ledger.spentUsd.toFixed(4)} | ${process.env.HALE_SPEND_LEDGER}`,
    );
  }
  return cap;
}

// --- mandatory spend guard + --dry ------------------------------------------
// EVERY live call passes requireSpendGuard first. No ledger path or no --max-usd/HALE_MAX_USD
// means the call is refused BEFORE a client is built or a socket opened — a "does the file
// load" check can never bill. --dry (or HALE_EVAL_DRY=1) makes no network call at all: the
// client is a stub that throws on any use, so a dry run that needs the network fails loudly.

export function isDryRun(argv = process.argv, env = process.env) {
  return argv.includes('--dry') || env.HALE_EVAL_DRY === '1';
}

export function requireSpendGuard(tag = 'eval') {
  if (isDryRun()) {
    throw new Error(`eval --dry: refusing live call ${tag}; dry mode makes no network calls`);
  }
  const ledger = process.env.HALE_SPEND_LEDGER;
  if (!ledger || process.env.HALE_EVAL_LEDGER_DEFAULTED === '1') {
    throw new Error(`spend-guard: no ledger path (HALE_SPEND_LEDGER); refusing live call ${tag}`);
  }
  if (readCapUsd() === null) {
    throw new Error(`spend-guard: no --max-usd / HALE_MAX_USD; refusing live call ${tag}`);
  }
}

/**
 * Input tokens of a request, estimated OFFLINE for --dry (the live guard counts them with
 * countTokens, which is a network call). A rough heuristic, NOT a bound: one token per 3
 * UTF-8 bytes of the JSON-serialised request. It is NOT guaranteed to be at or above the
 * live count (JSON escaping inflates CJK text, while the API also adds tokens of its own
 * for tool definitions and formatting), so the live guard's countTokens figure is the one
 * that decides; a dry projection is an estimate of it.
 */
export function estimateInputTokensOffline(request) {
  const { system, messages, tools, output_config } = request;
  const bytes = Buffer.byteLength(JSON.stringify({ system, messages, tools, output_config }));
  return Math.ceil(bytes / 3);
}

/** A client that fails loudly on any use: what --dry hands out instead of a real one. */
export function dryClient(tag = 'eval') {
  const refuse = () => {
    throw new Error(`eval --dry: attempted network call (${tag}); dry mode makes none`);
  };
  return {
    messages: { create: refuse, countTokens: refuse, stream: refuse },
  };
}

/** True when `importMetaUrl` is the script node was started with (not an import). */
export function isMain(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

export function lazyAnthropic(tag = 'eval') {
  let client;
  return () => {
    if (isDryRun()) return dryClient(tag);
    requireSpendGuard(tag);
    client ??= new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      // Native fetch: the SDK's bundled fetch shim breaks on this box's egress proxy.
      fetch: globalThis.fetch,
    });
    return capSdkClient(client, { rates: priceRates, tag });
  };
}

let gatewayAnthropic;

/** Anthropic-compatible Gateway client for eval subjects only. Judges keep their
 * normal Anthropic client so a candidate never grades itself. */
export function evalSubjectClient(getCurrentClient) {
  if (!process.env.EVAL_GATEWAY_MODEL) return getCurrentClient();
  if (isDryRun()) return dryClient('gateway');
  requireSpendGuard('gateway');
  const apiKey = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_KEY ?? process.env.JEV_KEY;
  if (!apiKey) throw new Error('Set AI_GATEWAY_API_KEY, VERCEL_KEY, or JEV_KEY');
  gatewayAnthropic ??= new Anthropic({
    apiKey,
    baseURL: 'https://ai-gateway.vercel.sh',
  });
  return capSdkClient(gatewayAnthropic, { rates: gatewayRates, tag: 'gateway' });
}

/** Gateway model ids are not on the Claude card. An unknown id is priced at the Opus ceiling. */
function gatewayRates(model) {
  return PRICE[model] ?? { input: 15, output: 75 };
}

/** Replace only the subject model. The Gateway's Anthropic-compatible API maps
 * `thinking: disabled`; without it DeepSeek can spend the whole short-copy budget
 * reasoning and return no text. `output_config` remains Claude-specific. */
export function evalSubjectRequest(params) {
  if (!process.env.EVAL_GATEWAY_MODEL) return params;
  const { output_config: _outputConfig, ...request } = params;
  return {
    ...request,
    model: process.env.EVAL_GATEWAY_MODEL,
    thinking: { type: 'disabled' },
  };
}

const SONNET_55_IDS = new Set(['claude-sonnet-5-5', 'claude-sonnet-5.5']);
const OPUS_55_IDS = new Set(['claude-opus-5-5', 'claude-opus-5.5']);

/** Normalize only the breaking request-shape changes of the current Claude 5.5
 * candidates. This is eval-only: production lane routing remains untouched. */
export function evalAnthropicRequest(params, model = params.model) {
  if (!SONNET_55_IDS.has(model) && !OPUS_55_IDS.has(model)) {
    return model === params.model ? params : { ...params, model };
  }

  if (OPUS_55_IDS.has(model) && params.thinking?.type === 'disabled') {
    throw new Error('Claude Opus 5.5 requires adaptive thinking; disabled is not supported');
  }

  const forcedTool = ['tool', 'any'].includes(params.tool_choice?.type);
  return {
    ...params,
    model,
    ...(SONNET_55_IDS.has(model) && params.thinking?.type === 'disabled'
      ? { thinking: { type: 'between_tools' } }
      : {}),
    ...(forcedTool ? { tool_choice: { type: 'auto' } } : {}),
  };
}

export function evalRunTag(tag) {
  return process.env.EVAL_RUN_ID ? `${tag}:run:${process.env.EVAL_RUN_ID}` : tag;
}

function failCachedMiss(tag, key) {
  console.error(
    `cache miss in --cached-only mode (${tag}, key ${key}). Re-run live (with --env-file) to populate, then commit the cache.`,
  );
  process.exit(1);
}

// --- cached one-shot structured call ----------------------------------------
// For the structured agents (classify / draft / review-verdict) and the judge. With a
// `lane` the live call goes through packages/agent's forceToolJson — the production seam,
// so the eval records exactly the request shape, strict schema, re-ask and failure
// guards production sends. Replays exactly from cache on a hit.

/** The seam validates against a Zod schema; the eval grades the raw input itself. */
const ANY_INPUT = z.any();

/**
 * A Claude subject must say which LANE it runs on: on the 5.5 generation an omitted
 * `thinking` is not "no thinking" (Haiku 5.5 thinks by default), so a bare model id
 * records a request production never sends.
 */
function requireLane(tag, model, opts) {
  if (opts.lane || opts.thinking || !model.startsWith('claude-')) return;
  throw new Error(`${tag}: pass the subject's lane (agent.pickLane(task)), not a bare model id`);
}

/**
 * One live structured call through the production seam, for the evals that keep their
 * own cache. Same request shape, strict schema, re-ask and failure guards as runtime.
 */
export async function liveStructuredCall({
  client,
  lane,
  system,
  userMessage,
  toolName,
  toolDescription,
  toolSchema,
  maxTokens,
}) {
  const agent = await loadAgent();
  return agent.forceToolJson({
    client,
    lane,
    system,
    userMessage,
    toolName,
    toolDescription,
    inputJsonSchema: toolSchema,
    schema: ANY_INPUT,
    maxTokens,
  });
}

export async function cachedToolCall(opts) {
  const gatewayModel = opts.gatewayModel ?? process.env.EVAL_GATEWAY_MODEL;
  if (gatewayModel) {
    const runSuffix = process.env.EVAL_RUN_ID ? `:${process.env.EVAL_RUN_ID}` : '';
    return cachedGatewayToolCall({
      ...opts,
      tag: `gateway:${opts.tag}${runSuffix}`,
      model: gatewayModel,
    });
  }
  const { tag, system, userMessage, toolName, toolSchema, cachedOnly, getClient, cost } = opts;
  const model = opts.lane?.model ?? opts.model;
  const maxTokens = opts.maxTokens ?? 1024;
  // The lane's knobs are part of the request, so they are part of the key: a lane whose
  // effort or thinking mode moves must re-record, not replay the old answer. (Arms without
  // a lane keep their historical key.)
  const canonical = JSON.stringify({
    model,
    system,
    userMessage,
    toolName,
    toolSchema,
    ...(opts.lane ? { lane: opts.lane } : {}),
  });
  const key = cacheKey(tag, canonical);

  const cached = await cacheGet(key);
  if (cached) {
    noteLatency(model, cached.latencyMs);
    if (Array.isArray(cost.latencies)) cost.latencies.push(cached.latencyMs);
    return { value: cached.value, latencyMs: cached.latencyMs, cached: true };
  }

  if (cachedOnly) failCachedMiss(tag, key);
  if (isDryRun() && Array.isArray(opts.dryPlan)) {
    // --dry (914): an uncached compose call is PROJECTED, never made and never a throw.
    // Priced as the live guard would: the first uncached call on this plan writes the
    // system-prompt cache; later ones (serial, within the TTL) read it.
    const entry = await dryToolCallPlanEntry({ ...opts, model, maxTokens }, opts.dryPlan);
    opts.dryPlan.push(entry);
    // A worst-case-length stand-in, so a judge fed this reply is priced at its worst too.
    return { value: { text: dryStandInText(maxTokens) }, latencyMs: 0, cached: false, dry: true };
  }
  requireLane(tag, model, opts);

  const startedAt = Date.now();
  let value;
  let usage;
  if (opts.lane) {
    // TRUNCATION, REFUSAL AND A MISSING CALL ARE NOT ANSWERS, and must never be CACHED as
    // one: the seam throws a named StructuredOutputError for each, so nothing is written.
    const agent = await loadAgent();
    const result = await agent.forceToolJson({
      client: getClient(),
      lane: opts.lane,
      system,
      userMessage,
      toolName,
      toolDescription: opts.toolDescription ?? 'Return the result.',
      inputJsonSchema: toolSchema,
      schema: ANY_INPUT,
      maxTokens,
    });
    value = result.value;
    usage = result.usage;
  } else {
    // A candidate arm that sets its own knobs (not a production lane).
    const request = evalAnthropicRequest({
      model,
      max_tokens: maxTokens,
      system,
      tools: [
        {
          name: toolName,
          description: opts.toolDescription ?? 'Return the result.',
          input_schema: toolSchema,
          ...(opts.strictTool ? { strict: true } : {}),
        },
      ],
      tool_choice: opts.toolChoice ?? { type: 'tool', name: toolName },
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
      ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
      messages: [{ role: 'user', content: userMessage }],
    });
    const response = await getClient().messages.create(request);
    if (response.stop_reason === 'max_tokens') {
      throw new Error(`${tag}: tool call truncated at max_tokens (${maxTokens}) - nothing cached`);
    }
    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === toolName);
    if (!toolUse) throw new Error(`${tag}: model returned no ${toolName} tool call`);
    value = toolUse.input;
    usage = response.usage;
  }
  const latencyMs = Date.now() - startedAt;
  noteUsage(cost, model, usage);
  await cachePut(key, { value, latencyMs });
  noteLatency(model, latencyMs);
  if (Array.isArray(cost.latencies)) cost.latencies.push(latencyMs);
  return { value, latencyMs, cached: false };
}

/** A stand-in reply of the most bytes `maxTokens` of output could be (offline estimate). */
export function dryStandInText(maxTokens) {
  return 'x'.repeat(maxTokens * 3);
}

/** --dry plan entry for one uncached tool call: estimate, max output, cache-aware worst case. */
export async function dryToolCallPlanEntry(opts, plan) {
  const { tag, model, maxTokens, system, userMessage, toolName, toolSchema } = opts;
  let request;
  if (opts.lane) {
    const agent = await loadAgent();
    request = agent.structuredRequest({
      lane: opts.lane,
      maxTokens,
      system,
      userMessage,
      toolName,
      toolDescription: opts.toolDescription ?? 'Return the result.',
      inputJsonSchema: toolSchema,
    });
  } else {
    request = {
      model,
      max_tokens: maxTokens,
      system,
      tools: [
        {
          name: toolName,
          description: opts.toolDescription ?? 'Return the result.',
          input_schema: toolSchema,
        },
      ],
      messages: [{ role: 'user', content: userMessage }],
    };
  }
  const inputTokens = estimateInputTokensOffline(request);
  const firstUncached = !plan.some((p) => !p.cached);
  const prefixTokens = firstUncached
    ? 0
    : estimateInputTokensOffline({ system: request.system, tools: request.tools });
  return {
    tag,
    cached: false,
    inputTokens,
    cacheReadTokens: prefixTokens,
    maxTokens,
    worstUsd: cacheAwareWorstUsd(priceRates, request, inputTokens, prefixTokens),
  };
}

// --- cached free-text call (for the coach answer arm) -----------------------

export async function cachedTextCall(opts) {
  const gatewayModel = opts.gatewayModel ?? process.env.EVAL_GATEWAY_MODEL;
  if (gatewayModel) {
    const runSuffix = process.env.EVAL_RUN_ID ? `:${process.env.EVAL_RUN_ID}` : '';
    return cachedGatewayTextCall({
      ...opts,
      tag: `gateway:${opts.tag}${runSuffix}`,
      model: gatewayModel,
    });
  }
  const { tag, system, userMessage, cachedOnly, getClient, cost } = opts;
  const model = opts.lane?.model ?? opts.model;
  const canonical = JSON.stringify({
    model,
    system,
    userMessage,
    ...(opts.lane ? { lane: opts.lane } : {}),
  });
  const key = cacheKey(tag, canonical);

  const cached = await cacheGet(key);
  if (cached) {
    noteLatency(model, cached.latencyMs);
    if (Array.isArray(cost.latencies)) cost.latencies.push(cached.latencyMs);
    return {
      text: cached.text,
      latencyMs: cached.latencyMs,
      inputTokens: cached.inputTokens,
      cached: true,
    };
  }

  if (cachedOnly) failCachedMiss(tag, key);
  requireLane(tag, model, opts);

  const laneFields = opts.lane ? (await loadAgent()).laneRequestFields(opts.lane) : null;
  const request = evalAnthropicRequest({
    ...(laneFields ?? { model }),
    max_tokens: opts.maxTokens ?? 1024,
    system,
    ...(!laneFields && opts.thinking ? { thinking: opts.thinking } : {}),
    ...(!laneFields && opts.effort ? { output_config: { effort: opts.effort } } : {}),
    messages: [{ role: 'user', content: userMessage }],
  });
  const startedAt = Date.now();
  const response = await getClient().messages.create(request);
  const latencyMs = Date.now() - startedAt;
  if (response.stop_reason === 'refusal') {
    throw new Error(`${tag}: the model declined (refusal) - nothing cached`);
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  // A BLANK IS NOT A REPLY, and the cache is forever. The tool path above refuses a
  // truncated forced-tool call and the judge refuses a score-less draw; this path refused
  // nothing, and the committed cache carries ten `"text": ""` entries — fixtures graded
  // forever on a message the model never wrote, replayed by --cached-only at no cost and
  // with no warning. The line is production's own: runAgent reports `truncated` exactly
  // when the stop reason is max_tokens AND no text arrived (packages/agent/src/agent.ts),
  // because a stream that already spoke cannot be re-asked — so a cut-off sentence, which
  // the length gates and the judge can both read, is still recorded here.
  if (text.trim() === '') {
    throw new Error(
      `${tag}: the model returned no text (stop_reason ${response.stop_reason}) - nothing cached`,
    );
  }
  noteUsage(cost, model, response.usage);
  const inputTokens =
    response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
  await cachePut(key, { text, latencyMs, inputTokens });
  noteLatency(model, latencyMs);
  if (Array.isArray(cost.latencies)) cost.latencies.push(latencyMs);
  return { text, latencyMs, inputTokens, cached: false };
}

const GATEWAY_ENDPOINT = 'https://ai-gateway.vercel.sh/v1/chat/completions';

function gatewayKey() {
  const key = process.env.AI_GATEWAY_API_KEY ?? process.env.VERCEL_KEY ?? process.env.JEV_KEY;
  if (!key) throw new Error('Set AI_GATEWAY_API_KEY, VERCEL_KEY, or JEV_KEY');
  return key;
}

function gatewayReportedUsd(body) {
  const raw = body?.providerMetadata?.gateway?.cost ?? body?.provider_metadata?.gateway?.cost;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function gatewayUsageMessage(model, peeked) {
  const input = peeked.usage?.prompt_tokens ?? peeked.usage?.input_tokens ?? 0;
  const output = peeked.usage?.completion_tokens ?? peeked.usage?.output_tokens ?? 0;
  if (input > 0 || output > 0) {
    return {
      usage: {
        input_tokens: input,
        output_tokens: output,
        server_tool_use: peeked.usage?.server_tool_use,
      },
    };
  }
  const reported = gatewayReportedUsd(peeked);
  if (reported === null) return { usage: { input_tokens: 0, output_tokens: 0 } };
  return {
    usage: {
      input_tokens: Math.round((reported * 1e6) / gatewayRates(model).input),
      output_tokens: 0,
    },
  };
}

/**
 * A gateway HTTP call under the same ceiling as the Anthropic client. With the cap off
 * this is `send()`. A character count stands in for countTokens, which this endpoint
 * does not offer.
 */
export async function spendCappedFetch({ tag = 'gateway', request, send }) {
  requireSpendGuard(tag);
  if (!capEnabled()) return send();
  const priced = { ...request, max_tokens: request.max_tokens ?? 1024 };
  let sent;
  await cappedCall({
    client: {
      messages: {
        countTokens: async () => ({
          input_tokens: Math.ceil(JSON.stringify(priced).length / 3),
        }),
      },
    },
    request: priced,
    call: async () => {
      sent = await send();
      const peeked = await sent
        .clone()
        .json()
        .catch(() => ({}));
      return gatewayUsageMessage(priced.model, peeked);
    },
    rates: gatewayRates,
    tag,
  });
  if (!sent) {
    throw new Error(
      `${tag}: spend-cap estimate returned no gateway response; use the runner --estimate`,
    );
  }
  return sent;
}

async function gatewayCall(opts, tool) {
  const request = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 1024,
    reasoning: { effort: 'none' },
    providerOptions: { gateway: { sort: 'ttft' } },
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.userMessage },
    ],
    ...(tool
      ? {
          tools: [
            {
              type: 'function',
              function: {
                name: opts.toolName,
                description: opts.toolDescription ?? 'Return the result.',
                parameters: opts.toolSchema,
              },
            },
          ],
          tool_choice: { type: 'function', function: { name: opts.toolName } },
        }
      : {}),
  };
  const key = cacheKey(opts.tag, JSON.stringify(request));
  const cached = await cacheGet(key);
  if (cached) {
    noteLatency(opts.model, cached.latencyMs);
    if (Array.isArray(opts.cost.latencies)) opts.cost.latencies.push(cached.latencyMs);
    return { ...cached, cached: true };
  }
  if (opts.cachedOnly) failCachedMiss(opts.tag, key);

  const startedAt = performance.now();
  const response = await spendCappedFetch({
    tag: opts.tag ?? 'gateway',
    request,
    send: () =>
      fetch(GATEWAY_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${gatewayKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(30_000),
      }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${opts.tag}: Gateway request failed (${response.status})`);
  if (body.choices?.[0]?.finish_reason === 'length') {
    throw new Error(`${opts.tag}: Gateway response truncated at max_tokens`);
  }
  const message = body.choices?.[0]?.message;
  const usage = {
    input_tokens: body.usage?.prompt_tokens ?? body.usage?.input_tokens ?? 0,
    output_tokens: body.usage?.completion_tokens ?? body.usage?.output_tokens ?? 0,
  };
  noteUsage(opts.cost, opts.model, usage);
  const latencyMs = Math.round(performance.now() - startedAt);
  noteLatency(opts.model, latencyMs);
  if (Array.isArray(opts.cost.latencies)) opts.cost.latencies.push(latencyMs);

  if (!tool) {
    const text = message?.content?.trim();
    if (!text) throw new Error(`${opts.tag}: Gateway returned no text`);
    const record = { text, latencyMs };
    await cachePut(key, record);
    return { ...record, cached: false };
  }

  const call = message?.tool_calls?.find((item) => item.function?.name === opts.toolName);
  const raw = call?.function?.arguments ?? message?.content;
  let value;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error(`${opts.tag}: Gateway returned invalid JSON`);
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${opts.tag}: Gateway returned no ${opts.toolName} result`);
  }
  const record = { value, latencyMs };
  await cachePut(key, record);
  return { ...record, cached: false };
}

export function cachedGatewayToolCall(opts) {
  return gatewayCall(opts, true);
}

export function cachedGatewayTextCall(opts) {
  return gatewayCall(opts, false);
}

// --- LLM-as-judge (cached, real haiku) --------------------------------------
// 1-5 integer score against a rubric system prompt. Same schema + bar (>=4) the
// existing agent eval uses, so a launch eval and the per-agent evals agree on
// what "good" means.

/**
 * REASON FIRST, SCORE SECOND — and the order is the point, not a style preference.
 *
 * A forced tool call is emitted in schema order, so `score` first meant the judge picked
 * a number BEFORE it had written a word of analysis, and nothing afterwards could revise
 * it. That is not a hypothesis: a cached verdict on the French fixture argued itself all
 * the way to "The reply is accurate, appropriately shaped... This is a 5, actually" and
 * shipped `score: 2`, because the 2 had already been written. It is also the most likely
 * explanation for the noise the coach-channel eval's header records as unexplained —
 * "across six calibration runs the same reply drew a 5 and a 2 from the same judge" is
 * what scoring blind looks like.
 *
 * With `reason` first the number is conditioned on the argument, which is the whole
 * reason a reason is collected at all.
 *
 * NOTE for anyone changing this: the cache key (see makeJudge) covers the model, the
 * system prompt and the payload — NOT this schema. Editing the shape here does not
 * invalidate existing verdicts, so a re-record has to delete them.
 */
export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    score: { type: 'integer', minimum: 1, maximum: 5 },
  },
  required: ['reason', 'score'],
};

/**
 * Score first, then a short reason. A forced tool call is emitted in schema order, so
 * the number is already on the verdict when a long reason runs out of tokens. The
 * shared schema above stays reason-first. A suite opts into this one.
 */
export function scoreFirstJudgeSchema(maxChars) {
  return {
    type: 'object',
    properties: {
      score: { type: 'integer', minimum: 1, maximum: 5 },
      reason: {
        type: 'string',
        maxLength: maxChars,
        description: `At most ${maxChars} characters. Do not quote the text.`,
      },
    },
    required: ['score', 'reason'],
  };
}

/**
 * HOW MANY TIMES THE JUDGE IS ASKED, when one draw is not a measurement.
 *
 * THREE, and it is the smallest number that HAS a median. A judge is a sampled model and
 * its score is a draw from a distribution, but the gate is a hard floor: one draw in the
 * tail fails the suite on a message every other draw passes. Measured on
 * `activity-deep/cartwheels-live-research`, 2026-08-24 — the same rubric, the same payload,
 * the same message — the committed verdict was 2 and three fresh draws were 4, 4, 5. The
 * message passed every deterministic gate; what failed was the sampling.
 *
 * A gate that fails on variance is a gate nobody can trust, and the two ways out are not
 * equivalent. Lowering the floor would accept genuinely worse messages at every score. A
 * median accepts nothing new: it takes the score the judge gives MOST of the time, so a
 * message that is really a 2 still fails (two draws below the floor is a median below the
 * floor) and a message that is really a 4 stops failing one time in four.
 */
export const JUDGE_SAMPLES_MEDIAN = 3;

/**
 * `samples` defaults to ONE, and sample zero keeps the historical cache key byte for byte,
 * so the twenty-odd suites that take a single verdict replay their committed corpus
 * unchanged and only a suite that opts in pays for the extra draws.
 *
 * `schema` is for a suite whose judge says more than a reason and a score. It replaces
 * JUDGE_SCHEMA for that suite and, unlike it, IS part of the key, so a verdict recorded
 * against one shape is never replayed as another. It still has to end in `score`.
 */
/**
 * IS THIS A VERDICT, OR THE WRECKAGE OF ONE?
 *
 * `cachedToolCall` has refused to cache a forced tool call cut off at `max_tokens` since
 * 2026-08-24, because such a call still arrives well-formed with `input: {}` and reads
 * downstream as a real answer. The judge's own draw never got that guard, and the judge's
 * output IS the gate — so the wreckage voted.
 *
 * `activity-deep/cartwheels-live-research` carried three committed draws of `[{}, 2, 4]`.
 * Sorted by `a.score - b.score`, the empty one compares NaN against everything, the sort
 * leaves it where it lies, and the median lands on the 2: a suite failing on a message
 * that two of its three real draws passed, printed as "judge:2 of /2/4" with the blank
 * where a number should be. The schema puts `reason` before `score` deliberately - a
 * score emitted first is a score reasoned backwards from - and the price of that order is
 * that `score` is the field truncation eats.
 *
 * Read on the way OUT of the cache as well as into it, because the bad draws are already
 * committed. A cached non-verdict is treated as absent: re-drawn live, or reported as the
 * honest cache miss it always was under `--cached-only`.
 */
export function isVerdict(parsed) {
  return typeof parsed?.score === 'number';
}

/**
 * The judge's lane. A judge reads and scores; it does not need to deliberate at length,
 * so a non-Haiku grader runs adaptive at `medium` (Opus 5.5 cannot disable thinking).
 */
function judgeLane(agent, model) {
  return model === agent.HAIKU_MODEL
    ? { model, thinking: 'disabled', effort: 'medium' }
    : { model, thinking: 'adaptive', effort: 'medium' };
}

/** The same judge lane, for the suites that keep a judge of their own. */
export async function judgeLaneFor(model) {
  return judgeLane(await loadAgent(), model);
}

/**
 * Cost of one call in USD from its usage, at list rates (cache reads 0.1x, cache writes
 * 1.25x input). Used for the per-call judge cost log.
 */
export function callUsd(model, usage) {
  const p = priceRates(model);
  const u = usage ?? {};
  return (
    ((u.input_tokens ?? 0) * p.input +
      (u.cache_read_input_tokens ?? 0) * p.input * 0.1 +
      (u.cache_creation_input_tokens ?? 0) * p.input * 1.25 +
      (u.output_tokens ?? 0) * p.output) /
    1e6
  );
}

/**
 * options:
 *   samples      draws per reply (default 1)
 *   aggregate    'min' keeps the lowest draw; default is the median
 *   references   scored reference texts ({facts,text,score,why}[]), appended to the
 *                system prompt (so they are part of the cache key). Pass
 *                [...GENERAL_REFERENCE_TEXTS, ...yourOwn].
 *   logCost      true: print model, tokens and USD for every LIVE judge call
 */
/** A verdict cut off at the judge's output cap. A judge error that stops the run. */
export class JudgeTruncatedError extends Error {}

export function makeJudge(model, judgeSystemBase, tagPrefix, cachedOnly, getClient, cost, options) {
  const samples = options?.samples ?? 1;
  // maxOutputTokens: a hard cap on the verdict, so the spend guard's per-call worst case
  // (input + max_tokens of output) is small. The cap bounds thinking AND verdict together,
  // so a capped judge runs on its tier's thinking-off lane and the cap only has to clear
  // the verdict itself. A verdict that still hits it is a JudgeTruncatedError: never a
  // pass, never cached, never quietly re-asked.
  const verdictCap = options?.maxOutputTokens;
  if (verdictCap !== undefined && !(Number.isInteger(verdictCap) && verdictCap > 0)) {
    throw new Error(`makeJudge: maxOutputTokens must be a positive integer, got ${verdictCap}`);
  }
  // --dry: every draw is listed here (cached or not, and the guard's worst case for an
  // uncached one) instead of being made. Read it after the run with judge.plan.
  const plan = [];
  const judgeSystem = judgeSystemBase + renderReferenceTexts(options?.references);
  const logCall = (sampleTag, usage) => {
    if (!options?.logCost) return;
    console.log(
      `judge-cost | ${sampleTag} | model=${model} in=${usage?.input_tokens ?? 0} cacheR=${usage?.cache_read_input_tokens ?? 0} cacheW=${usage?.cache_creation_input_tokens ?? 0} out=${usage?.output_tokens ?? 0} | $${callUsd(model, usage).toFixed(5)}`,
    );
  };

  async function draw(tag, userMessage, index) {
    const sampleTag =
      index === 0 ? `${tagPrefix}:judge:${tag}` : `${tagPrefix}:judge:${tag}#${index}`;
    const schema = options?.toolSchema ?? options?.schema ?? JUDGE_SCHEMA;
    const agentForLane = verdictCap ? await loadAgent() : null;
    const baseLane = agentForLane ? judgeLane(agentForLane, model) : null;
    const cappedLane = agentForLane ? (agentForLane.withoutThinking(baseLane) ?? baseLane) : null;
    // A capped judge on a different lane (Sonnet: thinking off) is a different judge, so
    // its verdicts key apart from the thinking ones. Same lane (Haiku): key unchanged.
    const laneKey =
      cappedLane && JSON.stringify(cappedLane) !== JSON.stringify(baseLane)
        ? `\nlane:${JSON.stringify(cappedLane)}`
        : '';
    const key = cacheKey(
      sampleTag,
      `${model}\n${judgeSystem}\n${userMessage}${options?.schema ? `\n${JSON.stringify(options.schema)}` : ''}${laneKey}`,
    );
    const cached = await cacheGet(key);
    if (cached && isVerdict(cached.parsed)) {
      if (isDryRun()) plan.push({ tag: sampleTag, cached: true, score: cached.parsed.score });
      return cached.parsed;
    }
    if (isDryRun()) {
      // No network: price the request the live guard would see, with an offline count.
      const agent = await loadAgent();
      const lane = cappedLane ?? judgeLane(agent, model);
      const maxTokens = verdictCap ?? (model === agent.HAIKU_MODEL ? 4096 : 8192);
      const request = agent.structuredRequest({
        lane,
        maxTokens,
        system: judgeSystem,
        userMessage,
        toolName: 'score',
        toolDescription: 'Return the score.',
        inputJsonSchema: schema,
      });
      const inputTokens = estimateInputTokensOffline(request);
      // Cache-aware, like the live guard: the first uncached draw writes the system-prompt
      // cache (full write rate); later ones, run back to back within the TTL, read it.
      const firstUncached = !plan.some((p) => !p.cached);
      const prefixTokens = firstUncached
        ? 0
        : estimateInputTokensOffline({ system: request.system, tools: request.tools });
      const worstUsd = cacheAwareWorstUsd(priceRates, request, inputTokens, prefixTokens);
      plan.push({
        tag: sampleTag,
        cached: false,
        inputTokens,
        cacheReadTokens: prefixTokens,
        maxTokens,
        worstUsd,
      });
      return { dry: true, score: Number.NaN, reason: '(dry: not scored)' };
    }
    if (cachedOnly) failCachedMiss(sampleTag, key);

    // A score-first suite keeps a draw whose reason was cut off. That path reads the
    // tool call itself: forceToolJson refuses a max_tokens stop before the score can
    // be kept, and a cap that already booked the call must not be counted again.
    if (options?.keepTruncatedScore === true) {
      const response = await getClient().messages.create({
        model,
        max_tokens: options?.maxTokens ?? 4096,
        system: judgeSystem,
        tools: [{ name: 'score', description: 'Return the score.', input_schema: schema }],
        tool_choice: { type: 'tool', name: 'score' },
        messages: [{ role: 'user', content: userMessage }],
      });
      const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === 'score');
      if (!toolUse) throw new Error(`judge (${sampleTag}) returned no score tool call`);
      if (!isVerdict(toolUse.input)) {
        throw new Error(
          `judge (${sampleTag}) came back truncated - no score on the verdict; nothing cached`,
        );
      }
      if (!response.capBooked) noteUsage(cost, model, response.usage);
      logCall(sampleTag, response.usage);
      await cachePut(key, { parsed: toolUse.input });
      return toolUse.input;
    }

    const agent = await loadAgent();
    let result;
    try {
      result = await agent.forceToolJson({
        client: getClient(),
        lane: cappedLane ?? judgeLane(agent, model),
        // 1024, not 256. At 256 a judge writing a thorough reason ran out of tokens
        // MID-STRING, and because Anthropic does not hard-enforce a tool's input schema
        // the partial call still arrived as a well-formed object — `{ score: 2 }` with the
        // `reason` the schema marks required simply absent. Nothing here validated it, so
        // a truncated verdict was cached and replayed as a real one, and a per-fixture
        // floor then failed CI on a score with no argument attached to inspect. That is
        // the "one low score came back with no reason at all" the coach-channel eval's own
        // header records as unexplained; this is the explanation. The key does not include
        // max_tokens, so raising it leaves every cached verdict valid and only affects
        // calls that are actually made.
        // 4096, and the ceiling has now been raised twice by the same failure. At 256 a
        // thorough judge ran out MID-STRING; at 1024 the deep lane's four-slot fixture did
        // the same, live, on 2026-08-24 — its surviving draws argue for 2800+ characters
        // before they reach a number. `reason` comes BEFORE `score` on purpose (a score
        // emitted first is a score reasoned backwards from), which makes `score` precisely
        // the field a truncation eats, so the budget has to clear the longest honest
        // argument rather than the average one. The key does not include max_tokens, so
        // raising it leaves every committed verdict valid and only touches calls actually
        // made — and `isVerdict` above means a draw that still runs out is loud, not a zero.
        // On the 5.5 generation a non-Haiku judge thinks first (Opus 5.5 cannot turn it
        // off), and `max_tokens` caps the thinking too, so it gets twice the room.
        maxTokens: verdictCap ?? (model === agent.HAIKU_MODEL ? 4096 : 8192),
        system: judgeSystem,
        userMessage,
        toolName: 'score',
        toolDescription: 'Return the score.',
        inputJsonSchema: schema,
        schema: ANY_INPUT,
      });
    } catch (err) {
      if (err?.outcome === 'truncated' && verdictCap) {
        throw new JudgeTruncatedError(
          `judge error (${sampleTag}): verdict hit the max_tokens cap (${verdictCap}); not a pass, nothing cached, run stopped`,
        );
      }
      if (err?.outcome === 'truncated') {
        throw new Error(
          `judge (${sampleTag}) came back truncated - no score on the verdict; nothing cached`,
        );
      }
      throw err;
    }
    if (!isVerdict(result.value)) {
      throw new Error(`judge (${sampleTag}) returned no score; nothing cached`);
    }
    noteUsage(cost, model, result.usage);
    logCall(sampleTag, result.usage);
    await cachePut(key, { parsed: result.value });
    return result.value;
  }

  // STRICTLY ONE DRAW AT A TIME, enforced here rather than trusted to callers: every draw
  // of this judge (across concurrent judge() calls too) waits for the previous one to
  // settle. The cache-aware spend guard relies on it - a parallel draw could write the
  // prompt cache a second time before the guard saw the first write.
  let queue = Promise.resolve();
  const serialDraw = (tag, userMessage, index) => {
    const run = queue.then(() => draw(tag, userMessage, index));
    queue = run.catch(() => {});
    return run;
  };

  async function judge(tag, payload) {
    const userMessage = JSON.stringify(payload);
    const drawn = [];
    for (let index = 0; index < samples; index += 1) {
      drawn.push(await serialDraw(tag, userMessage, index));
    }
    if (drawn.some((verdict) => verdict.dry)) {
      return { dry: true, score: Number.NaN, reason: '(dry)', samples: drawn.map((v) => v.score) };
    }
    // One sample returns exactly what it always did - same object, no extra field - so a
    // caller that never opted in cannot tell this function changed.
    if (samples === 1) return drawn[0];
    const ordered = [...drawn].sort((a, b) => a.score - b.score);
    // `aggregate: 'min'` keeps the LOWEST draw (and its reason): a suite that would rather
    // see an inconsistent judge than let one lucky pass through opts into it.
    if (options?.aggregate === 'min') {
      // Every draw's score AND reason (914), in draw order, not only the lowest one's.
      return {
        ...ordered[0],
        samples: drawn.map((verdict) => verdict.score),
        draws: drawn.map((verdict) => ({ score: verdict.score, reason: verdict.reason })),
      };
    }
    // The median VERDICT, not just the median number: the reason a run prints has to be
    // the argument for the score it printed, or the failure line cites a different draw.
    const median = ordered[Math.floor(samples / 2)];
    return { ...median, samples: ordered.map((verdict) => verdict.score) };
  }
  judge.plan = plan;
  return judge;
}

/** --dry summary of a judge's plan: what would be scored and the guard's worst case. */
export function summarizeJudgePlan(plan, { spentUsd, capUsd }) {
  const uncached = plan.filter((p) => !p.cached);
  const worstTotalUsd = uncached.reduce((sum, p) => sum + p.worstUsd, 0);
  return {
    draws: plan.length,
    cached: plan.length - uncached.length,
    uncached: uncached.length,
    worstPerCallUsd: uncached.length ? Math.max(...uncached.map((p) => p.worstUsd)) : 0,
    worstTotalUsd,
    projectedLedgerUsd: spentUsd + worstTotalUsd,
    fitsCap: spentUsd + worstTotalUsd <= capUsd,
  };
}

/** --dry summary across compose (subject-model) and judge plans: subtotals + grand total. */
export function summarizeDryPlan({ compose = [], judge = [] }, { spentUsd, capUsd }) {
  const part = (plan) => {
    const uncached = plan.filter((p) => !p.cached);
    return {
      calls: plan.length,
      cached: plan.length - uncached.length,
      uncached: uncached.length,
      worstUsd: uncached.reduce((sum, p) => sum + p.worstUsd, 0),
    };
  };
  const c = part(compose);
  const j = part(judge);
  const worstTotalUsd = c.worstUsd + j.worstUsd;
  return {
    compose: c,
    judge: j,
    worstTotalUsd,
    projectedLedgerUsd: spentUsd + worstTotalUsd,
    fitsCap: spentUsd + worstTotalUsd <= capUsd,
  };
}

/** One line per judge draw: `draw N: score S - reason`. */
export function formatDraws(draws) {
  return (draws ?? []).map((d, i) => `draw ${i + 1}: ${d.score} - ${d.reason}`);
}

export const JUDGE_MIN = 4;

// --- recall check -----------------------------------------------------------
// Fraction of a reference answer's required tokens that appear (case-insensitively)
// in the candidate answer. The reference tokens are derived from the synthetic
// facts, never from model output (rule #7), so this is a real fact-recall metric,
// not a fit-to-output one.
//
// An entry may be an ARRAY of surface forms for one and the same required token —
// satisfied when ANY of them appears. That is for facts whose stored notation is
// not the notation a person uses out loud (a bedtime stored as '19:30' that a coach
// says as '7:30pm'): both are a correct recall of one fact, so demanding a literal
// the answer has no natural reason to contain measures phrasing, not memory.

export function recall(answer, mustRecall) {
  if (!mustRecall || mustRecall.length === 0) return 1;
  const hay = answer.toLowerCase();
  const hit = mustRecall.filter((t) =>
    (Array.isArray(t) ? t : [t]).some((form) => hay.includes(String(form).toLowerCase())),
  ).length;
  return hit / mustRecall.length;
}
