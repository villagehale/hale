#!/usr/bin/env node
// Agent-skill QUALITY eval harness (discovery).
//
// Root CLAUDE.md hard rule #8: no LLM mocking — real Claude responses, cached.
// The @hale/agent skills already have LOOP-MECHANICS tests (a fake client feeding
// a tool call back, the maxSteps stop). Those prove plumbing, NOT quality. This
// harness closes that gap: it exercises the REAL agent against real (cached) Claude
// and gates on CHECKABLE properties + a cached LLM-as-judge.
//
// The suite is calibrated in BOTH directions (real cached model PASSES; a
// --broken known-bad generator FAILS):
//
//   discovery     — web-side village discovery. REPLICATES the exact request shape of
//                   apps/web/lib/village/discover.ts (same prompt apps/worker/prompts/
//                   discovery.md, same SONNET_MODEL, same submit_candidates tool-forced
//                   schema + serialization) — the stale dist / cross-process boundary
//                   makes import impossible, same reasoning as the drafter eval. Gates:
//                   candidates fit the queried stage + area, NO precise-location leak
//                   (rule #1), calibrated confidence honesty, cached Haiku judge for
//                   local-fit (>= 4).
//
// REPLICATE (same discipline as run-village-eval.mjs):
//   - discovery: we REPLICATE the discover.ts request shape (it reaches web-only
//     modules across the process boundary; its model id is read from the worker's
//     SONNET_MODEL, the same constant discover.ts's loadCoachModel reads).
//   - judge: HAIKU_MODEL, read live from src/anthropic/client.ts — no second copy.
//
// Run from the worker package dir (apps/worker), like the other eval scripts:
//   node --env-file=../../.env evals/run-agent-eval.mjs                 # live pass, then caches
//   node --env-file=../../.env evals/run-agent-eval.mjs --broken        # calibration: must FAIL
//   node evals/run-agent-eval.mjs --cached-only                         # CI: replay only, never calls the API
//   node evals/run-agent-eval.mjs --suite=discovery [...]               # restrict to one suite

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { tsImport } from 'tsx/esm/api';
import {
  PRICE as LIST_PRICE,
  judgeLaneFor,
  liveStructuredCall,
} from './lib/harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, '..');
const REPO_ROOT = join(WORKER_ROOT, '..', '..');
const MODEL_TS_PATH = join(REPO_ROOT, 'packages', 'agent', 'src', 'model.ts');
const DISCOVERY_PROMPT_PATH = join(WORKER_ROOT, 'prompts', 'discovery.md');
const AGENT_SRC = join(REPO_ROOT, 'packages', 'agent', 'src', 'index.ts');
const FIXTURE_ROOT = join(HERE, 'fixtures');
const CACHE_DIR = join(HERE, 'cache');

// List prices (USD per 1M tokens), from the harness table.
const PRICE = {
  sonnet: LIST_PRICE['claude-sonnet-5-5'],
  haiku: LIST_PRICE['claude-haiku-5-5'],
  gateway: { input: 0.15, output: 0.6 },
};

const JUDGE_MIN = 4; // 1-5 integer scale, the same bar the other agent evals use

// --- single sources of truth -----------------------------------------------

async function readModelIds() {
  const src = await readFile(MODEL_TS_PATH, 'utf8');
  const sonnet = src.match(/SONNET_MODEL\s*=\s*'([^']+)'/);
  const haiku = src.match(/HAIKU_MODEL\s*=\s*'([^']+)'/);
  if (!sonnet) throw new Error(`could not parse SONNET_MODEL from ${MODEL_TS_PATH}`);
  if (!haiku) throw new Error(`could not parse HAIKU_MODEL from ${MODEL_TS_PATH}`);
  return { discovery: sonnet[1], judge: haiku[1] };
}

async function loadFixtures(dirName) {
  const dir = join(FIXTURE_ROOT, dirName);
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const out = [];
  for (const name of names) {
    out.push(JSON.parse(await readFile(join(dir, name), 'utf8')));
  }
  return out;
}

// --- content-addressed cache ------------------------------------------------
// Key = sha256(tag + "\n" + canonical request). Any change to the model id, the
// prompt/skill, or a fixture input mints a new key, so a stale answer is never
// silently reused; a cache hit makes zero API calls. `tag` separates the suites'
// generator calls from the judge calls.

function cacheKey(tag, payload) {
  return createHash('sha256').update(`${tag}\n${payload}`).digest('hex');
}

async function cacheGet(key) {
  const path = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(path)) return undefined;
  return JSON.parse(await readFile(path, 'utf8'));
}

async function cachePut(key, value) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, `${key}.json`), JSON.stringify(value, null, 2));
}

// A real Anthropic client created lazily, only when a cache miss forces a live
// call. In --cached-only mode it is never constructed and no key is read.
function lazyAnthropic() {
  let client;
  return () => {
    client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return client;
  };
}

function noteUsage(cost, tier, usage) {
  cost.liveCalls += 1;
  if (tier === 'sonnet') {
    cost.sonnetIn += usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
    cost.sonnetOut += usage.output_tokens;
  } else if (tier === 'haiku') {
    cost.haikuIn += usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
    cost.haikuOut += usage.output_tokens;
  } else {
    cost.gatewayIn += usage.input_tokens + (usage.cache_creation_input_tokens ?? 0);
    cost.gatewayOut += usage.output_tokens;
  }
}

// --- LLM-as-judge (cached, real haiku) --------------------------------------

const JUDGE_TOOL = 'score';
const JUDGE_JSON_SCHEMA = {
  type: 'object',
  // Reason BEFORE score: a score emitted first is a score reasoned backwards from.
  properties: {
    reason: { type: 'string' },
    score: { type: 'integer', minimum: 1, maximum: 5 },
  },
  required: ['reason', 'score'],
};

function makeJudge(model, judgeSystem, tag, cachedOnly, getClient, cost) {
  return async function judge(payload) {
    const userMessage = JSON.stringify(payload);
    const key = cacheKey(`${tag}:judge`, `${model}\n${judgeSystem}\n${userMessage}`);

    const cached = await cacheGet(key);
    if (cached) return cached.parsed;

    if (cachedOnly) {
      console.error(
        `judge cache miss in --cached-only mode (${tag}, key ${key}). Re-run live to populate, then commit the cache.`,
      );
      process.exit(1);
    }

    const response = await liveStructuredCall({
      client: getClient(),
      lane: await judgeLaneFor(model),
      system: judgeSystem,
      userMessage,
      toolName: JUDGE_TOOL,
      toolDescription: 'Return the score.',
      toolSchema: JUDGE_JSON_SCHEMA,
      maxTokens: 1024,
    });
    noteUsage(cost, 'haiku', response.usage);
    await cachePut(key, { parsed: response.value });
    return response.value;
  };
}

// --- shared hallucination check ---------------------------------------------
// An email / dollar / long-digit token that appears in the answer but NOT in any
// of the grounded strings the tools/fixture handed the agent is a fabricated
// specific. Cheap, deterministic, high-signal.

function ungroundedSpecifics(text, grounded) {
  const hay = grounded.join(' ');
  const tokens = [
    ...(text.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []),
    ...(text.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) ?? []),
    ...(text.match(/\d{4,}/g) ?? []),
  ];
  return [...new Set(tokens)].filter((t) => !hay.includes(t));
}

function containsAny(haystackLower, tokens) {
  return (tokens ?? []).filter((t) => haystackLower.includes(t.toLowerCase()));
}

// ===========================================================================
// SUITE 3: discovery (replicated discover.ts request shape)
// ===========================================================================

const DISCOVERY_TOOL = 'submit_candidates';
// MUST mirror candidatesJsonSchema in apps/web/lib/village/discover.ts.
const DISCOVERY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          sourceUrl: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          coverageNote: { type: 'string' },
        },
        required: ['title', 'description', 'confidence', 'coverageNote'],
      },
    },
  },
  required: ['candidates'],
};
const DISCOVERY_LIMIT = 8; // matches discover.ts DEFAULT_LIMIT

const DISCOVERY_JUDGE_SYSTEM = [
  "You are a strict reviewer scoring ONE list of local activity candidates Hale's",
  'discovery agent proposed for a child at a given family stage in a coarse area',
  '(an FSA / neighbourhood / municipality — never a precise address). Score LOCAL',
  'FIT & HONESTY on a 1-5 integer scale. A 5: every candidate suits the stage and',
  'is the kind of honest, broadly-true local option a thoughtful parent would',
  'recommend, with calibrated confidence (a generic "there is probably a library"',
  'is NOT asserted as a verified, scheduled class). A LOW score: candidates out of',
  'stage, fabricated specifics (made-up class times, prices, instructors), or',
  'over-confident filler. Reply with ONLY the score tool.',
].join(' ');

function discoveryUserMessageFor(fixture) {
  // MUST match discoverForFamily's serialization in discover.ts.
  return JSON.stringify({
    area_coarse: fixture.input.areaCoarse,
    stage: fixture.input.stage,
    interests: fixture.input.interests,
    limit: DISCOVERY_LIMIT,
  });
}

async function realDiscovery(lane, prompt, fixture, cachedOnly, getClient, cost) {
  const model = lane.model;
  const userMessage = discoveryUserMessageFor(fixture);
  const key = cacheKey('discovery:agent', `${model}\n${prompt}\n${userMessage}`);

  const cached = await cacheGet(key);
  if (cached) return cached.parsed;

  if (cachedOnly) {
    console.error(
      `discovery cache miss in --cached-only mode: ${fixture.id} (key ${key}). Re-run live to populate, then commit the cache.`,
    );
    process.exit(1);
  }

  // Through the shared structured seam, on the converse lane discover.ts reads. NOT what
  // apps/web/lib/village/discover.ts sends today: it forces tool_choice, which Sonnet 5.5
  // rejects with a 400, and moving it onto this seam is VIL-423's (see the PR body).
  const response = await liveStructuredCall({
    client: getClient(),
    lane,
    system: prompt,
    userMessage,
    toolName: DISCOVERY_TOOL,
    toolDescription: 'Return the structured local activity candidates.',
    toolSchema: DISCOVERY_JSON_SCHEMA,
    maxTokens: 4096,
  });
  noteUsage(cost, 'sonnet', response.usage);
  await cachePut(key, { parsed: response.value });
  return response.value;
}

// Deterministic broken stand-in: an out-of-stage candidate, fabricated specifics
// (a precise street address + phone + price), an over-confident generic. Every
// deterministic check must reject it. No API call, no cache read.
function brokenDiscovery() {
  return {
    candidates: [
      {
        title: 'Teen driver-prep bootcamp',
        description: 'Driving lessons every Tuesday 6pm at 123 Main Street, call 4165550000, $499.',
        confidence: 0.99,
        coverageNote: 'definitely happening',
      },
    ],
  };
}

function checkDiscovery(fixture, parsed, judgeScore) {
  const failures = [];
  const e = fixture.expect;
  const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];

  if (candidates.length === 0) {
    // An empty list is honest IF the fixture allows it; otherwise it's a miss.
    if (!e.allowEmpty) failures.push('no candidates returned');
    return failures;
  }
  if (candidates.length > DISCOVERY_LIMIT) {
    failures.push(`returned ${candidates.length} candidates > limit ${DISCOVERY_LIMIT}`);
  }

  const blob = candidates
    .map((c) => `${c.title} ${c.description} ${c.coverageNote ?? ''}`)
    .join(' ');
  const lowerBlob = blob.toLowerCase();

  // Stage fit: no wrong-stage vocabulary anywhere in the list.
  for (const tok of containsAny(lowerBlob, e.forbiddenStageTokens)) {
    failures.push(`wrong-stage token for ${fixture.input.stage}: ${JSON.stringify(tok)}`);
  }

  // Privacy (rule #1): no precise-location leak. A street address, a 5/6-char
  // Canadian full postal code (vs the coarse FSA prefix), or any forbidden
  // location token fabricates/pinpoints a finer location than the coarse area.
  const streetAddr = blob.match(
    /\b\d{1,5}\s+[A-Z][A-Za-z]+\s+(St|Street|Ave|Avenue|Rd|Road|Blvd|Dr|Drive|Way|Cres|Crescent)\b/,
  );
  if (streetAddr) failures.push(`precise street address leaked (rule #1): ${streetAddr[0]}`);
  const fullPostal = blob.match(/\b[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d\b/);
  if (fullPostal) failures.push(`full postal code leaked (rule #1): ${fullPostal[0]}`);
  for (const tok of containsAny(lowerBlob, e.forbiddenLocationTokens)) {
    failures.push(`forbidden precise-location token (rule #1): ${JSON.stringify(tok)}`);
  }

  // Calibrated honesty: discover.ts has no per-candidate grounding URL/listing in
  // its input, so no candidate may assert near-certainty. Confidence must be a
  // valid probability and must not be pinned at 1 (over-confident filler), and at
  // least one candidate must be below the over-confidence ceiling (the list can't
  // be uniformly maxed out).
  for (const c of candidates) {
    if (!(typeof c.confidence === 'number' && c.confidence > 0 && c.confidence <= 1)) {
      failures.push(`candidate '${c.title}' confidence ${c.confidence} not a valid probability`);
    }
    if (c.confidence >= e.maxConfidence) {
      failures.push(
        `candidate '${c.title}' confidence ${c.confidence} >= ${e.maxConfidence} (over-confident; nothing here is grounded)`,
      );
    }
    if (typeof c.coverageNote !== 'string' || c.coverageNote.trim().length === 0) {
      failures.push(`candidate '${c.title}' has empty coverageNote (honesty contract)`);
    }
  }

  // No fabricated contact specifics: a phone-like or price token is ungrounded —
  // discover.ts gets NO listing, so any such specific is invented.
  const ungrounded = ungroundedSpecifics(blob, [discoveryUserMessageFor(fixture)]);
  if (ungrounded.length) failures.push(`ungrounded specifics: ${ungrounded.join(', ')}`);

  if (judgeScore !== null && !(judgeScore >= JUDGE_MIN)) {
    failures.push(`local-fit score ${judgeScore} < ${JUDGE_MIN}`);
  }
  return failures;
}

async function runDiscoverySuite(opts) {
  const { broken, cachedOnly, getClient, cost, judge, discoveryLane } = opts;
  const fixtures = await loadFixtures('agent-discovery');
  const prompt = await readFile(DISCOVERY_PROMPT_PATH, 'utf8');
  const results = [];

  console.log('--- discovery (replicated discover.ts request, cached) ---');
  for (const fixture of fixtures) {
    const parsed = broken
      ? brokenDiscovery()
      : await realDiscovery(discoveryLane, prompt, fixture, cachedOnly, getClient, cost);
    const score = broken ? null : (await judge(discoveryJudgePayload(fixture, parsed))).score;
    const failures = checkDiscovery(fixture, parsed, score);
    record(results, fixture, failures, score);
  }
  return results;
}

function discoveryJudgePayload(fixture, parsed) {
  return {
    area_coarse: fixture.input.areaCoarse,
    stage: fixture.input.stage,
    interests: fixture.input.interests,
    candidates: parsed.candidates ?? [],
  };
}

// --- shared result printing -------------------------------------------------

function record(results, fixture, failures, score) {
  if (failures.length) {
    results.push({ id: fixture.id, failures });
    console.log(`  FAIL ${fixture.id}`);
    for (const f of failures) console.log(`       - ${f}`);
  } else {
    results.push({ id: fixture.id, failures: [] });
    console.log(`  pass ${fixture.id}${score === null ? '' : ` (judge ${score})`}`);
  }
}

// --- main -------------------------------------------------------------------

async function main() {
  const broken = process.argv.includes('--broken');
  const cachedOnly = process.argv.includes('--cached-only');
  const suiteArg = process.argv.find((a) => a.startsWith('--suite='));
  const only = suiteArg ? suiteArg.split('=')[1] : null;

  const agent = await tsImport(AGENT_SRC, import.meta.url);

  const { judge: judgeModel } = await readModelIds();
  // discover.ts reads its model from the converse lane (lib/coach/model.ts).
  const discoveryLane = agent.pickLane('converse');
  const discoveryModel = discoveryLane.model;
  const getClient = lazyAnthropic();
  const cost = {
    liveCalls: 0,
    sonnetIn: 0,
    sonnetOut: 0,
    haikuIn: 0,
    haikuOut: 0,
    gatewayIn: 0,
    gatewayOut: 0,
  };

  const discoveryJudge = makeJudge(
    judgeModel,
    DISCOVERY_JUDGE_SYSTEM,
    'discovery',
    cachedOnly,
    getClient,
    cost,
  );

  console.log(
    `agent-eval | mode=${broken ? 'broken' : 'real'}${cachedOnly ? ' (cached-only)' : ''} | discovery=${discoveryModel} | judge=${judgeModel}`,
  );
  console.log(`judge_min=${JUDGE_MIN} | cache: evals/cache/`);
  console.log('');

  const all = [];
  const suites = [
    [
      'discovery',
      () =>
        runDiscoverySuite({
          broken,
          cachedOnly,
          getClient,
          cost,
          judge: discoveryJudge,
          discoveryLane,
        }),
    ],
  ];

  let total = 0;
  for (const [name, run] of suites) {
    if (only && name !== only) continue;
    const results = await run();
    total += results.length;
    all.push(...results.filter((r) => r.failures.length));
    console.log('');
  }

  const estUsd =
    (cost.sonnetIn / 1e6) * PRICE.sonnet.input +
    (cost.sonnetOut / 1e6) * PRICE.sonnet.output +
    (cost.haikuIn / 1e6) * PRICE.haiku.input +
    (cost.haikuOut / 1e6) * PRICE.haiku.output +
    (cost.gatewayIn / 1e6) * PRICE.gateway.input +
    (cost.gatewayOut / 1e6) * PRICE.gateway.output;

  console.log('--- cost ---');
  console.log(`live API calls this run: ${cost.liveCalls}`);
  console.log(
    `tokens: sonnet in=${cost.sonnetIn} out=${cost.sonnetOut} | haiku in=${cost.haikuIn} out=${cost.haikuOut} | gateway in=${cost.gatewayIn} out=${cost.gatewayOut}`,
  );
  console.log(`estimated cost this run: $${estUsd.toFixed(4)} USD`);

  const allPass = all.length === 0;
  console.log('');
  console.log('--- gate ---');
  console.log(`fixtures failing checks: ${all.length}/${total}`);
  if (!broken) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  }
  // Broken mode: FAILING is the success condition — calibration proves teeth.
  const calibrated = !allPass;
  console.log(
    `broken-mode calibration (must fail at least one): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
  );
  process.exit(calibrated ? 0 : 1);
}

main().catch((err) => {
  console.error('agent eval harness error:', err);
  process.exit(2);
});
