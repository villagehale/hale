#!/usr/bin/env node
// Village eval harness (discovery + routine agents).
//
// Root CLAUDE.md hard rule #8: no LLM mocking — real Claude responses, cached.
// The village feature has two agents with very different testability:
//
//   ROUTINE is the novel reasoning — it arranges discovered candidates into a
//   stage-aware weekly proposal. That judgement is open-ended, so (like the
//   drafter) we gate on CHECKABLE properties plus an LLM-as-judge: every
//   proposed item must reference a candidate that was actually provided, must
//   not be drawn from an off-stage candidate, must carry the candidate's
//   confidence through unchanged, and must keep the week light (item-count
//   bound) — then a cached Haiku judge scores stage-fit 1–5.
//
//   DISCOVERY (Fake floor) is pure, deterministic, network-free logic, so it
//   needs no model at all: we run the REAL FakeDiscoveryProvider as the subject
//   and do a reference-recall check (did the curated items a stage/interest
//   query should surface actually surface? are confidence + source honest?).
//   Zero spend, always.
//
// IMPORT vs REPLICATE: same reasoning as run-eval.mjs / run-drafter-eval.mjs.
//   - ROUTINE: src/agents/routine.ts is TypeScript over workspace packages and
//     the committed dist/ is STALE (still references the removed Mastra layer),
//     so we REPLICATE the exact request shape: same prompt file (prompts/
//     routine.md), same model id (SONNET_MODEL, read live from
//     src/anthropic/client.ts), and the same tool-forced JSON schema +
//     serialization that runRoutine uses. The judge model id (HAIKU_MODEL) is
//     also read live from client.ts — no second source of truth for any value.
//   - DISCOVERY: the Fake provider is the unit under test, not a request shape,
//     and copying its SEED table into the harness WOULD be a second source of
//     truth. So we IMPORT the live src/agents/discovery-providers/fake.ts via
//     the tsx loader (the same way `tsx watch` runs the worker), never the
//     stale dist. No API key needed for the discovery half.
//
// Run from the worker package dir (apps/worker), like the other eval scripts:
//   node --env-file=../../.env evals/run-village-eval.mjs                 # live pass, then caches
//   node --env-file=../../.env evals/run-village-eval.mjs --routine=broken # calibration: must FAIL
//   node evals/run-village-eval.mjs --cached-only                         # CI: replay only, never calls the API

import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { tsImport } from 'tsx/esm/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, '..');
const ROUTINE_PROMPT_PATH = join(WORKER_ROOT, 'prompts', 'routine.md');
const CLIENT_PATH = join(WORKER_ROOT, 'src', 'anthropic', 'client.ts');
const FAKE_PROVIDER_PATH = join(WORKER_ROOT, 'src', 'agents', 'discovery-providers', 'fake.ts');
const FIXTURE_DIR = join(HERE, 'fixtures', 'village');
const CACHE_DIR = join(HERE, 'cache');

// List prices (USD per 1M tokens). Source: Anthropic pricing, claude-api skill.
// Sonnet = routine planner; Haiku = judge. (Discovery makes no API call.)
const PRICE = {
  sonnet: { input: 3.0, output: 15.0 },
  haiku: { input: 1.0, output: 5.0 },
};

// Gate threshold for the LLM-as-judge stage-fit score (1–5 integer).
const JUDGE_MIN = 4;

// --- read the single sources of truth from worker source -------------------

async function readModelIds() {
  const src = await readFile(CLIENT_PATH, 'utf8');
  const sonnet = src.match(/SONNET_MODEL\s*=\s*'([^']+)'/);
  const haiku = src.match(/HAIKU_MODEL\s*=\s*'([^']+)'/);
  if (!sonnet) throw new Error(`could not parse SONNET_MODEL from ${CLIENT_PATH}`);
  if (!haiku) throw new Error(`could not parse HAIKU_MODEL from ${CLIENT_PATH}`);
  return { routine: sonnet[1], judge: haiku[1] };
}

// The tool-forced JSON schema MUST mirror routineOutputJsonSchema in
// src/agents/routine.ts. The day enum is duplicated here intentionally so a
// divergence between the prompt's day vocabulary and the code surfaces as drift.
const ROUTINE_TOOL = 'submit_routine';
const ROUTINE_DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];
const ROUTINE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    routine: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'string', enum: ROUTINE_DAYS },
          title: { type: 'string' },
          category: { type: 'string' },
          stage_fit_rationale: { type: 'string' },
          candidate_confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['day', 'title', 'category', 'stage_fit_rationale', 'candidate_confidence'],
      },
    },
    rationale: { type: 'string' },
    notes: { type: 'string' },
  },
  required: ['routine', 'rationale', 'notes'],
};

// --- fixtures ---------------------------------------------------------------

async function loadFixtures(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const out = [];
  for (const name of names) {
    out.push(JSON.parse(await readFile(join(dir, name), 'utf8')));
  }
  return out;
}

// Must match runRoutine's exact serialization (src/agents/routine.ts):
// { stage, interests, candidates: [{ title, description, area_coarse,
//   stage_fit, confidence, source }] }.
function routineUserMessageFor(fixture) {
  return JSON.stringify({
    stage: fixture.input.stage,
    interests: fixture.input.interests ?? null,
    candidates: fixture.input.candidates.map((c) => ({
      title: c.title,
      description: c.description,
      area_coarse: c.areaCoarse,
      stage_fit: c.stage,
      confidence: c.confidence,
      source: c.source,
    })),
  });
}

// --- content-addressed cache ------------------------------------------------
// Key = sha256(model + "\n" + prompt + "\n" + userMessage + "\n" + tag). Any
// change to the model id, the prompt, or a fixture input mints a new key, so a
// stale answer is never silently reused. `tag` separates routine vs judge calls.

function cacheKey(model, prompt, userMessage, tag) {
  return createHash('sha256')
    .update(`${model}\n${prompt}\n${userMessage}\n${tag}`)
    .digest('hex');
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

// --- the real routine path (replicated forceToolJson) -----------------------

function makeRealRoutine(model, prompt, cachedOnly, cost) {
  let client;
  return async function plan(fixture) {
    const userMessage = routineUserMessageFor(fixture);
    const key = cacheKey(model, prompt, userMessage, 'routine');

    const cached = await cacheGet(key);
    if (cached) return cached.parsed;

    if (cachedOnly) {
      console.error(
        `cache miss in --cached-only mode: ${fixture.id} (key ${key}). Re-run without --cached-only against the live model to populate the cache, then commit it.`,
      );
      process.exit(1);
    }

    client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: prompt,
      tools: [
        {
          name: ROUTINE_TOOL,
          description: 'Return the structured weekly routine proposal.',
          input_schema: ROUTINE_JSON_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: ROUTINE_TOOL },
      messages: [{ role: 'user', content: userMessage }],
    });
    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === ROUTINE_TOOL);
    if (!toolUse) throw new Error(`${fixture.id}: model returned no ${ROUTINE_TOOL} tool call`);

    cost.liveCalls += 1;
    cost.sonnetIn += response.usage.input_tokens;
    cost.sonnetOut += response.usage.output_tokens;
    await cachePut(key, { parsed: toolUse.input });
    return toolUse.input;
  };
}

// Deliberately broken stand-in for calibration: it invents an off-list activity,
// places an item drawn from no candidate, contradicts the stage, and inflates
// confidence — every routine deterministic check must reject it, driving the
// gate to FAIL. Makes no API call and reads no cache, so it can never pass.
function makeBrokenRoutine() {
  return async function plan() {
    return {
      routine: [
        {
          day: 'monday',
          title: 'Made-up baby skydiving intensive',
          category: 'class',
          stage_fit_rationale: 'invented activity not in the candidate set',
          candidate_confidence: 0.99,
        },
      ],
      rationale: 'constant broken stand-in',
      notes: '',
    };
  };
}

// --- LLM-as-judge (cached, real haiku) --------------------------------------

const JUDGE_SYSTEM = [
  "You are a strict reviewer scoring a single weekly routine that Hale's village",
  'feature proposed for a child at a given family stage (newborn, toddler, child,',
  'or teenager). Score STAGE FIT & PACING on a 1–5 integer scale: 5 = every item',
  "and its rationale clearly suit this stage's developmental needs and rhythm and",
  'the week is appropriately light (not over-scheduled); 1 = items or pacing are',
  'wrong for the stage (e.g. over-scheduled for a newborn, a teen routine that',
  "ignores the teen's autonomy, generic 'good for kids' rationales). Reply with",
  'ONLY a JSON object via the score tool.',
].join(' ');

const JUDGE_TOOL = 'score';
const JUDGE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'integer', minimum: 1, maximum: 5 },
    reason: { type: 'string' },
  },
  required: ['score', 'reason'],
};

function makeJudge(model, cachedOnly, cost) {
  let client;
  return async function judge(fixture, routine) {
    const userMessage = JSON.stringify({
      stage: fixture.input.stage,
      interests: fixture.input.interests ?? null,
      routine,
    });
    const key = cacheKey(model, JUDGE_SYSTEM, userMessage, 'judge');

    const cached = await cacheGet(key);
    if (cached) return cached.parsed;

    if (cachedOnly) {
      console.error(
        `judge cache miss in --cached-only mode: ${fixture.id} (key ${key}). Re-run live to populate, then commit the cache.`,
      );
      process.exit(1);
    }

    client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model,
      max_tokens: 256,
      system: JUDGE_SYSTEM,
      tools: [
        { name: JUDGE_TOOL, description: 'Return the stage-fit score.', input_schema: JUDGE_JSON_SCHEMA },
      ],
      tool_choice: { type: 'tool', name: JUDGE_TOOL },
      messages: [{ role: 'user', content: userMessage }],
    });
    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === JUDGE_TOOL);
    if (!toolUse) throw new Error(`${fixture.id}: judge returned no ${JUDGE_TOOL} tool call`);

    cost.liveCalls += 1;
    cost.haikuIn += response.usage.input_tokens;
    cost.haikuOut += response.usage.output_tokens;
    await cachePut(key, { parsed: toolUse.input });
    return toolUse.input;
  };
}

// --- routine deterministic checks -------------------------------------------

// A small epsilon for the carry-through confidence comparison: the model echoes
// a number, and JSON round-trips can introduce a trailing-digit wobble; an
// exact === would be brittle for a property that is really "same value".
const CONF_EPS = 1e-6;

function checkRoutine(fixture, parsed, judgeScore) {
  const failures = [];
  const e = fixture.expect;
  const items = Array.isArray(parsed.routine) ? parsed.routine : [];

  // Index the provided candidates by title so we can verify provenance and
  // carry-through against the actual input, not against a copy.
  const byTitle = new Map(fixture.input.candidates.map((c) => [c.title, c]));
  const allowed = new Set(e.allowedTitles);
  const forbidden = new Set(e.forbiddenTitles ?? []);

  for (const item of items) {
    if (!allowed.has(item.title)) {
      // Either an invented title (no provided candidate) or a candidate the
      // fixture marks ineligible (e.g. off-stage). Both are provenance failures.
      failures.push(`item '${item.title}' is not an allowed candidate`);
      continue;
    }
    if (forbidden.has(item.title)) {
      failures.push(`item '${item.title}' is forbidden (off-stage candidate placed)`);
    }
    const candidate = byTitle.get(item.title);
    if (candidate && Math.abs(item.candidate_confidence - candidate.confidence) > CONF_EPS) {
      failures.push(
        `item '${item.title}' confidence ${item.candidate_confidence} != candidate ${candidate.confidence} (must carry through unchanged)`,
      );
    }
  }

  // Keep the week light: the prompt asks for "typically 2 to 4 items". minItems
  // guards against an empty/degenerate routine when candidates justify a plan;
  // maxItems guards against over-scheduling.
  if (typeof e.maxItems === 'number' && items.length > e.maxItems) {
    failures.push(`routine has ${items.length} items > maxItems ${e.maxItems} (over-scheduled)`);
  }
  if (typeof e.minItems === 'number' && items.length < e.minItems) {
    failures.push(`routine has ${items.length} items < minItems ${e.minItems}`);
  }

  if (judgeScore !== null && !(judgeScore >= JUDGE_MIN)) {
    failures.push(`stage-fit score ${judgeScore} < ${JUDGE_MIN}`);
  }

  return failures;
}

// --- discovery reference-recall checks (Fake provider, no API) --------------

function checkDiscovery(fixture, candidates) {
  const failures = [];
  const e = fixture.expect;
  const titles = candidates.map((c) => c.title);
  const titleSet = new Set(titles);

  for (const want of e.expectedTitles ?? []) {
    if (!titleSet.has(want)) failures.push(`expected title not surfaced: '${want}'`);
  }
  for (const banned of e.forbiddenTitles ?? []) {
    if (titleSet.has(banned)) failures.push(`forbidden title surfaced: '${banned}'`);
  }

  // Honesty of the floor's provenance/confidence fields (rule #1 + the
  // provider contract): a curated guess is never asserted with certainty and
  // always carries a coverage note and an echoed coarse area; it never emits a
  // finer (child-pinpointing) location via sourceUrl.
  for (const c of candidates) {
    if (c.source !== 'curated_seed') {
      failures.push(`candidate '${c.title}' source '${c.source}' != 'curated_seed'`);
    }
    if (!(c.confidence > 0 && c.confidence < 1)) {
      failures.push(`candidate '${c.title}' confidence ${c.confidence} not honest (0<c<1)`);
    }
    if (typeof c.coverageNote !== 'string' || c.coverageNote.length === 0) {
      failures.push(`candidate '${c.title}' has empty coverageNote`);
    }
    if (c.areaCoarse !== fixture.input.areaCoarse) {
      failures.push(`candidate '${c.title}' areaCoarse '${c.areaCoarse}' != query '${fixture.input.areaCoarse}'`);
    }
    if (c.sourceUrl !== undefined) {
      failures.push(`candidate '${c.title}' leaked a sourceUrl '${c.sourceUrl}' (rule #1: no finer location)`);
    }
    if (typeof e.allStageFit === 'string' && c.stage !== e.allStageFit) {
      failures.push(`candidate '${c.title}' stage '${c.stage}' != expected '${e.allStageFit}'`);
    }
  }

  // Ranking: each [a, b] pair requires a to appear strictly before b — the
  // floor must rank an interest hit ahead of a stage-typical survivor.
  for (const [a, b] of e.rankedBefore ?? []) {
    const ia = titles.indexOf(a);
    const ib = titles.indexOf(b);
    if (ia < 0 || ib < 0) {
      failures.push(`ranking check needs both '${a}' and '${b}' present`);
    } else if (!(ia < ib)) {
      failures.push(`'${a}' (idx ${ia}) should rank before '${b}' (idx ${ib})`);
    }
  }

  return failures;
}

// --- main -------------------------------------------------------------------

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--routine='));
  const mode = arg ? arg.split('=')[1] : 'real';
  const cachedOnly = process.argv.includes('--cached-only');

  const { routine: routineModel, judge: judgeModel } = await readModelIds();
  const routinePrompt = await readFile(ROUTINE_PROMPT_PATH, 'utf8');
  const fixtures = await loadFixtures(FIXTURE_DIR);
  const routineFixtures = fixtures.filter((f) => f.kind === 'routine');
  const discoveryFixtures = fixtures.filter((f) => f.kind === 'discovery');

  // The discovery subject is the REAL Fake provider, imported live from source.
  const fakeMod = await tsImport(FAKE_PROVIDER_PATH, import.meta.url);
  const fakeProvider = new fakeMod.FakeDiscoveryProvider();

  const cost = { liveCalls: 0, sonnetIn: 0, sonnetOut: 0, haikuIn: 0, haikuOut: 0 };
  const plan =
    mode === 'broken' ? makeBrokenRoutine() : makeRealRoutine(routineModel, routinePrompt, cachedOnly, cost);
  const judge = makeJudge(judgeModel, cachedOnly, cost);

  console.log(
    `village-eval | mode=${mode}${cachedOnly ? ' (cached-only)' : ''} | routine=${routineModel} | judge=${judgeModel} | discovery-provider=${fakeProvider.name}`,
  );
  console.log(
    `fixtures: ${routineFixtures.length} routine + ${discoveryFixtures.length} discovery | judge_min=${JUDGE_MIN} | cache: evals/cache/`,
  );
  console.log('');

  const failed = [];

  console.log('--- discovery (FakeDiscoveryProvider, no API) ---');
  for (const fixture of discoveryFixtures) {
    const candidates = await fakeProvider.discover({
      areaCoarse: fixture.input.areaCoarse,
      stage: fixture.input.stage,
      interests: fixture.input.interests,
      limit: fixture.input.limit,
    });
    const failures = checkDiscovery(fixture, candidates);
    if (failures.length) {
      failed.push({ id: fixture.id, failures });
      console.log(`  FAIL ${fixture.id}`);
      for (const f of failures) console.log(`       - ${f}`);
    } else {
      console.log(`  pass ${fixture.id} (${candidates.length} candidates)`);
    }
  }

  console.log('');
  console.log('--- routine (replicated runRoutine request, cached) ---');
  for (const fixture of routineFixtures) {
    const parsed = await plan(fixture);
    const items = Array.isArray(parsed.routine) ? parsed.routine : [];
    // The judge scores stage fit, which only makes sense for a non-empty,
    // on-list routine. Broken mode is a pure deterministic calibration — its
    // invented, off-stage, inflated item already fails, so we never spend a
    // live judge call there.
    const score = mode === 'broken' || items.length === 0 ? null : (await judge(fixture, parsed.routine)).score;
    const failures = checkRoutine(fixture, parsed, score);
    if (failures.length) {
      failed.push({ id: fixture.id, failures });
      console.log(`  FAIL ${fixture.id}`);
      for (const f of failures) console.log(`       - ${f}`);
    } else {
      console.log(`  pass ${fixture.id}${score === null ? '' : ` (stage-fit ${score})`}`);
    }
  }

  const estUsd =
    (cost.sonnetIn / 1e6) * PRICE.sonnet.input +
    (cost.sonnetOut / 1e6) * PRICE.sonnet.output +
    (cost.haikuIn / 1e6) * PRICE.haiku.input +
    (cost.haikuOut / 1e6) * PRICE.haiku.output;

  console.log('');
  console.log('--- cost ---');
  console.log(`live API calls this run: ${cost.liveCalls}`);
  console.log(
    `tokens: sonnet in=${cost.sonnetIn} out=${cost.sonnetOut} | haiku in=${cost.haikuIn} out=${cost.haikuOut}`,
  );
  console.log(`estimated cost this run: $${estUsd.toFixed(4)} USD`);

  // Calibration contract: the REAL (cached) model must pass every fixture; the
  // BROKEN stand-in must fail at least one (it fails its routine fixtures by
  // construction). Discovery is deterministic and passes in every mode.
  const allPass = failed.length === 0;
  const expectPass = mode !== 'broken';

  console.log('');
  console.log('--- gate ---');
  console.log(`fixtures failing checks: ${failed.length}/${routineFixtures.length + discoveryFixtures.length}`);
  if (expectPass) {
    console.log(`overall (real): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
    process.exit(allPass ? 0 : 1);
  } else {
    // In broken mode, FAILING is the success condition — calibration proves the
    // gate has teeth. Exit 0 iff the broken routine was correctly rejected.
    const calibrated = !allPass;
    console.log(
      `broken-mode calibration (must fail at least one): ${calibrated ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`,
    );
    process.exit(calibrated ? 0 : 1);
  }
}

main().catch((err) => {
  console.error('village eval harness error:', err);
  process.exit(2);
});
