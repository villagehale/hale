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
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
export const WORKER_ROOT = join(HERE, '..', '..');
export const REPO_ROOT = join(WORKER_ROOT, '..', '..');
export const CACHE_DIR = join(HERE, '..', 'cache');
const MODEL_TS = join(REPO_ROOT, 'packages', 'agent', 'src', 'model.ts');
const CONTEXT_TS = join(REPO_ROOT, 'apps', 'web', 'lib', 'coach', 'context.ts');

// List prices, USD per 1M tokens. Source: Anthropic pricing via the claude-api
// skill. The same three tiers the codebase routes across (model.ts).
export const PRICE = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  // Sonnet 5 list price; intro pricing ($2/$10) applies through 2026-08-31, so
  // the entry stays correct once list pricing resumes.
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-opus-4-8': { input: 15.0, output: 75.0 },
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
    sonnet5: grab('SONNET5_MODEL'),
    opus: grab('OPUS_MODEL'),
  };
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

export async function readJudgeModel() {
  const src = await readFile(MODEL_TS, 'utf8');
  const m = src.match(/HAIKU_MODEL\s*=\s*'([^']+)'/);
  if (!m) throw new Error(`could not parse HAIKU_MODEL from ${MODEL_TS}`);
  return m[1];
}

// --- content-addressed cache ------------------------------------------------
// Key = sha256(tag + "\n" + canonical request). Any change to a model id, a
// prompt/skill, or a fixture input mints a new key, so a stale answer is never
// reused; a cache hit makes zero API calls.

export function cacheKey(tag, payload) {
  return createHash('sha256').update(`${tag}\n${payload}`).digest('hex');
}

export async function cacheGet(key) {
  const path = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function cachePut(key, value) {
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

export function totalUsd(cost) {
  let usd = 0;
  for (const [model, b] of Object.entries(cost.byModel)) {
    const p = PRICE[model];
    if (!p) continue;
    usd += (b.input / 1e6) * p.input + (b.output / 1e6) * p.output;
  }
  return usd;
}

// --- lazy client (never built in --cached-only) -----------------------------

export function lazyAnthropic() {
  let client;
  return () => {
    client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
  };
}

function failCachedMiss(tag, key) {
  console.error(
    `cache miss in --cached-only mode (${tag}, key ${key}). Re-run live (with --env-file) to populate, then commit the cache.`,
  );
  process.exit(1);
}

// --- cached one-shot tool-forced JSON call ----------------------------------
// For the structured agents (classify / draft / review-verdict) and the judge:
// a single messages.create with tool_choice forcing one tool. Returns the tool
// input plus measured latency. Replays exactly from cache on a hit.

export async function cachedToolCall(opts) {
  const { tag, model, system, userMessage, toolName, toolSchema, cachedOnly, getClient, cost } =
    opts;
  const canonical = JSON.stringify({ model, system, userMessage, toolName, toolSchema });
  const key = cacheKey(tag, canonical);

  const cached = await cacheGet(key);
  if (cached) return { value: cached.value, latencyMs: cached.latencyMs, cached: true };

  if (cachedOnly) failCachedMiss(tag, key);

  const startedAt = Date.now();
  const response = await getClient().messages.create({
    model,
    max_tokens: opts.maxTokens ?? 1024,
    system,
    tools: [
      {
        name: toolName,
        description: opts.toolDescription ?? 'Return the result.',
        input_schema: toolSchema,
      },
    ],
    tool_choice: { type: 'tool', name: toolName },
    messages: [{ role: 'user', content: userMessage }],
  });
  const latencyMs = Date.now() - startedAt;
  const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === toolName);
  if (!toolUse) throw new Error(`${tag}: model returned no ${toolName} tool call`);
  noteUsage(cost, model, response.usage);
  await cachePut(key, { value: toolUse.input, latencyMs });
  return { value: toolUse.input, latencyMs, cached: false };
}

// --- cached free-text call (for the coach answer arm) -----------------------

export async function cachedTextCall(opts) {
  const { tag, model, system, userMessage, cachedOnly, getClient, cost } = opts;
  const canonical = JSON.stringify({ model, system, userMessage });
  const key = cacheKey(tag, canonical);

  const cached = await cacheGet(key);
  if (cached) {
    return {
      text: cached.text,
      latencyMs: cached.latencyMs,
      inputTokens: cached.inputTokens,
      cached: true,
    };
  }

  if (cachedOnly) failCachedMiss(tag, key);

  const startedAt = Date.now();
  const response = await getClient().messages.create({
    model,
    max_tokens: opts.maxTokens ?? 1024,
    system,
    messages: [{ role: 'user', content: userMessage }],
  });
  const latencyMs = Date.now() - startedAt;
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  noteUsage(cost, model, response.usage);
  const inputTokens =
    response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
  await cachePut(key, { text, latencyMs, inputTokens });
  return { text, latencyMs, inputTokens, cached: false };
}

// --- LLM-as-judge (cached, real haiku) --------------------------------------
// 1-5 integer score against a rubric system prompt. Same schema + bar (>=4) the
// existing agent eval uses, so a launch eval and the per-agent evals agree on
// what "good" means.

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 5 },
    reason: { type: 'string' },
  },
  required: ['score', 'reason'],
};

export function makeJudge(model, judgeSystem, tagPrefix, cachedOnly, getClient, cost) {
  return async function judge(tag, payload) {
    const userMessage = JSON.stringify(payload);
    const key = cacheKey(`${tagPrefix}:judge:${tag}`, `${model}\n${judgeSystem}\n${userMessage}`);
    const cached = await cacheGet(key);
    if (cached) return cached.parsed;
    if (cachedOnly) failCachedMiss(`${tagPrefix}:judge:${tag}`, key);

    const response = await getClient().messages.create({
      model,
      max_tokens: 256,
      system: judgeSystem,
      tools: [{ name: 'score', description: 'Return the score.', input_schema: JUDGE_SCHEMA }],
      tool_choice: { type: 'tool', name: 'score' },
      messages: [{ role: 'user', content: userMessage }],
    });
    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === 'score');
    if (!toolUse) throw new Error(`judge (${tag}) returned no score tool call`);
    noteUsage(cost, model, response.usage);
    await cachePut(key, { parsed: toolUse.input });
    return toolUse.input;
  };
}

export const JUDGE_MIN = 4;

// --- recall check -----------------------------------------------------------
// Fraction of a reference answer's required tokens that appear (case-insensitively)
// in the candidate answer. The reference tokens are derived from the synthetic
// facts, never from model output (rule #7), so this is a real fact-recall metric,
// not a fit-to-output one.

export function recall(answer, mustRecall) {
  if (!mustRecall || mustRecall.length === 0) return 1;
  const hay = answer.toLowerCase();
  const hit = mustRecall.filter((t) => hay.includes(String(t).toLowerCase())).length;
  return hit / mustRecall.length;
}
