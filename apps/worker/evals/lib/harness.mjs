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
  // Opus 5, matching packages/agent/src/cost.ts (the runtime's own LIST table). It was
  // MISSING while the deep synthesis lane was already spending on it, and `totalUsd`
  // skipped what it could not price — so a live eval run reported $0.0000 and looked
  // free. An unpriced model is now loud (see below) rather than costless.
  'claude-opus-5': { input: 5.0, output: 25.0 },
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
  // TRUNCATION IS NOT AN ANSWER, and it must never be CACHED as one. A response cut at
  // max_tokens leaves the forced tool call incomplete — usually `input: {}` — which reads
  // downstream as a model that looked and found nothing. The runtime has guarded this for
  // months (pipeline/structured.ts); the harness did not, so on 2026-08-24 the deep eval
  // recorded a `{"slots":[]}` for a fixture whose notes plainly listed four programmes,
  // cached it forever, and reported it as "a real page answered with a shrug".
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      `${tag}: tool call truncated at max_tokens (${opts.maxTokens ?? 1024}) - raise the budget; nothing cached`,
    );
  }
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
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    score: { type: 'integer', minimum: 1, maximum: 5 },
  },
  required: ['reason', 'score'],
};

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
 */
export function makeJudge(model, judgeSystem, tagPrefix, cachedOnly, getClient, cost, options) {
  const samples = options?.samples ?? 1;

  async function draw(tag, userMessage, index) {
    const sampleTag = index === 0 ? `${tagPrefix}:judge:${tag}` : `${tagPrefix}:judge:${tag}#${index}`;
    const key = cacheKey(sampleTag, `${model}\n${judgeSystem}\n${userMessage}`);
    const cached = await cacheGet(key);
    if (cached) return cached.parsed;
    if (cachedOnly) failCachedMiss(sampleTag, key);

    const response = await getClient().messages.create({
      model,
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
      max_tokens: 1024,
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
  }

  return async function judge(tag, payload) {
    const userMessage = JSON.stringify(payload);
    const drawn = [];
    for (let index = 0; index < samples; index += 1) {
      drawn.push(await draw(tag, userMessage, index));
    }
    // One sample returns exactly what it always did - same object, no extra field - so a
    // caller that never opted in cannot tell this function changed.
    if (samples === 1) return drawn[0];
    const ordered = [...drawn].sort((a, b) => a.score - b.score);
    // The median VERDICT, not just the median number: the reason a run prints has to be
    // the argument for the score it printed, or the failure line cites a different draw.
    const median = ordered[Math.floor(samples / 2)];
    return { ...median, samples: ordered.map((verdict) => verdict.score) };
  };
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
