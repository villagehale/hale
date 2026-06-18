#!/usr/bin/env node
// Memory Inferencer eval harness (the moat: the longitudinal-memory WRITE path).
//
// Root CLAUDE.md hard rule #8: no LLM mocking — real Claude responses, cached.
// The inferencer's output is the long-term memory every other agent later reads,
// so a wrong fact poisons future drafts. The eval therefore gates on PRECISION,
// not recall: only enum fact_types, every fact at/above the 0.7 floor, every
// fact GROUNDED in the provided input (no invented specifics), no sweeping
// personality facts, and structural validity. The inferencer emits structured
// data, not prose, so there is no tone judge — the rubric is deterministic.
//
// IMPORT vs REPLICATE: identical reasoning to run-drafter-eval.mjs —
// src/agents/memory-inferencer.ts is TypeScript over workspace packages and the
// committed dist/ is stale, so we REPLICATE the exact request shape instead:
// same prompt file (prompts/memory-inferencer.md), same model id (SONNET_MODEL,
// read live from src/anthropic/client.ts), and the same tool-forced JSON schema
// (record_inference) + serialization that src/agents/memory-inferencer.ts uses.
//
// Run from repo root:
//   node --env-file=.env apps/worker/evals/run-memory-eval.mjs              # live pass, then caches
//   node apps/worker/evals/run-memory-eval.mjs --broken                     # calibration: gate rejects it → exits NONZERO
//   node apps/worker/evals/run-memory-eval.mjs --cached-only                # CI: replay only, never calls the API

import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, '..');
const PROMPT_PATH = join(WORKER_ROOT, 'prompts', 'memory-inferencer.md');
const CLIENT_PATH = join(WORKER_ROOT, 'src', 'anthropic', 'client.ts');
const FIXTURE_DIR = join(HERE, 'fixtures', 'memory-inferencer');
const CACHE_DIR = join(HERE, 'cache');

// List prices (USD per 1M tokens). Source: Anthropic pricing, claude-api skill.
const PRICE = { sonnet: { input: 3.0, output: 15.0 } };

// The closed fact_type set — mirrors memoryFactTypeEnum in @hale/db and FACT_TYPES
// in src/agents/memory-inferencer.ts.
const FACT_TYPES = ['preference', 'routine', 'medical', 'logistic', 'relationship', 'voice'];
const CONFIDENCE_FLOOR = 0.7;

// Sweeping/ungrounded language a high-precision inferencer must never assert as a
// fact — broad personality/disposition claims the prompt's "What NOT to infer"
// section forbids outright.
const SWEEPING_PATTERNS = [
  /\bthe family is\b/i,
  /\banxious\b/i,
  /\bpersonality\b/i,
  /\balways\b/i,
  /\bnever\b/i,
  /\bdisorganized\b/i,
  /\boverwhelmed\b/i,
];

// --- read the single source of truth from worker source --------------------

async function readModelId() {
  const src = await readFile(CLIENT_PATH, 'utf8');
  const sonnet = src.match(/SONNET_MODEL\s*=\s*'([^']+)'/);
  if (!sonnet) throw new Error(`could not parse SONNET_MODEL from ${CLIENT_PATH}`);
  return sonnet[1];
}

// The tool-forced JSON schema MUST mirror inferencerOutputJsonSchema in
// src/agents/memory-inferencer.ts.
const INFER_TOOL = 'record_inference';
const INFER_JSON_SCHEMA = {
  type: 'object',
  properties: {
    fact_updates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fact_type: { type: 'string', enum: FACT_TYPES },
          fact_key: { type: 'string' },
          fact_value: {},
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          rationale: { type: 'string' },
        },
        required: ['fact_type', 'fact_key', 'fact_value', 'confidence', 'rationale'],
      },
    },
    episode_summaries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          episode_type: { type: 'string' },
          summary: { type: 'string' },
          occurred_at: { type: 'string' },
          sentiment_score: { type: 'number', minimum: -1, maximum: 1 },
        },
        required: ['episode_type', 'summary', 'occurred_at'],
      },
    },
    pattern_detections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          support: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: ['pattern', 'support', 'confidence'],
      },
    },
    retire_facts: { type: 'array', items: { type: 'string' } },
  },
  required: ['fact_updates', 'episode_summaries', 'pattern_detections', 'retire_facts'],
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

// Must match runMemoryInferencer's exact serialization:
// { recent_events, recent_actions, current_memory_snapshot }.
function userMessageFor(fixture) {
  return JSON.stringify({
    recent_events: fixture.input.recentEvents,
    recent_actions: fixture.input.recentActions,
    current_memory_snapshot: fixture.input.currentMemorySnapshot,
  });
}

// --- content-addressed cache ------------------------------------------------
// Key = sha256(model + "\n" + prompt + "\n" + userMessage + "\n" + tag). Any
// change to the model id, the prompt, or a fixture input mints a new key, so a
// stale answer is never silently reused.

function cacheKey(model, prompt, userMessage, tag) {
  return createHash('sha256').update(`${model}\n${prompt}\n${userMessage}\n${tag}`).digest('hex');
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

// --- the real inferencer path (replicated forceToolJson) --------------------

function makeRealInferencer(model, prompt, cachedOnly, cost) {
  let client;
  return async function infer(fixture) {
    const userMessage = userMessageFor(fixture);
    const key = cacheKey(model, prompt, userMessage, 'infer');

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
      max_tokens: 2048,
      system: prompt,
      tools: [
        {
          name: INFER_TOOL,
          description: 'Record the derived facts, episodes, and retirements for this family.',
          input_schema: INFER_JSON_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: INFER_TOOL },
      messages: [{ role: 'user', content: userMessage }],
    });
    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === INFER_TOOL);
    if (!toolUse) throw new Error(`${fixture.id}: model returned no ${INFER_TOOL} tool call`);

    cost.liveCalls += 1;
    cost.sonnetIn += response.usage.input_tokens;
    cost.sonnetOut += response.usage.output_tokens;
    await cachePut(key, { parsed: toolUse.input });
    return toolUse.input;
  };
}

// Deliberately broken stand-in for calibration: emits an ungrounded, sweeping,
// below-floor fact that the precision rubric must reject. Makes no API call and
// reads no cache, so it can never accidentally pass.
function makeBrokenInferencer() {
  return async function infer() {
    return {
      fact_updates: [
        {
          fact_type: 'relationship',
          fact_key: 'family_disposition',
          // Sweeping personality claim + an invented specific (a phone number that
          // is in NO fixture input) — fails both the sweeping and grounding checks.
          fact_value: { trait: 'the family is anxious and disorganized', contact: '416-555-0199' },
          confidence: 0.55,
          rationale: 'vibe',
        },
      ],
      episode_summaries: [],
      pattern_detections: [],
      retire_facts: [],
    };
  };
}

// --- deterministic precision rubric -----------------------------------------

// Specifics a fact must not invent: emails, dollar amounts, phone-like and
// long-digit runs. Each such token in a fact must appear verbatim in the
// serialized input — a cheap grounding check that catches a hallucinated
// number/contact without per-fixture anchors.
function ungroundedSpecifics(text, inputSerialized) {
  const tokens = [
    ...(text.match(/[\w.+-]+@[\w.-]+\.\w+/g) ?? []),
    ...(text.match(/\$\s?\d[\d,]*(?:\.\d{2})?/g) ?? []),
    ...(text.match(/\d{3}[-.\s]\d{3}[-.\s]\d{4}/g) ?? []),
    ...(text.match(/\d{4,}/g) ?? []),
  ];
  return [...new Set(tokens)].filter((t) => !inputSerialized.includes(t));
}

function factText(fact) {
  return `${fact.fact_key} ${JSON.stringify(fact.fact_value)} ${fact.rationale}`;
}

function checkFixture(fixture, output) {
  const failures = [];
  const e = fixture.expect;
  const inputSerialized = JSON.stringify(fixture.input);

  // Structural validity: the four required arrays must be present.
  for (const arr of ['fact_updates', 'episode_summaries', 'pattern_detections', 'retire_facts']) {
    if (!Array.isArray(output[arr])) failures.push(`missing/invalid array '${arr}'`);
  }
  const facts = Array.isArray(output.fact_updates) ? output.fact_updates : [];

  if (e.requireAtLeastOneFact && facts.length === 0) {
    failures.push('expected at least one grounded fact, got none');
  }
  if (typeof e.maxFacts === 'number' && facts.length > e.maxFacts) {
    failures.push(`emitted ${facts.length} facts > maxFacts ${e.maxFacts}`);
  }

  // At least one of the fixture's grounding terms must appear across the facts —
  // proves the facts are about THIS family's actual signals, not generic.
  if (facts.length > 0 && Array.isArray(e.groundingTerms) && e.groundingTerms.length) {
    const allText = facts.map(factText).join(' ').toLowerCase();
    const hit = e.groundingTerms.some((t) => allText.includes(String(t).toLowerCase()));
    if (!hit) failures.push(`no grounding term present in facts (expected one of: ${e.groundingTerms.join(', ')})`);
  }

  for (const fact of facts) {
    if (!FACT_TYPES.includes(fact.fact_type)) {
      failures.push(`fact_type '${fact.fact_type}' not in enum`);
    }
    if (Array.isArray(e.factTypeAllowlist) && !e.factTypeAllowlist.includes(fact.fact_type)) {
      failures.push(`fact_type '${fact.fact_type}' not in fixture allowlist`);
    }
    if (typeof fact.confidence !== 'number' || fact.confidence < CONFIDENCE_FLOOR) {
      failures.push(`fact '${fact.fact_key}' confidence ${fact.confidence} < floor ${CONFIDENCE_FLOOR}`);
    }
    const text = factText(fact);
    if (e.forbidSweeping !== false) {
      for (const pat of SWEEPING_PATTERNS) {
        const m = text.match(pat);
        if (m) failures.push(`fact '${fact.fact_key}' is sweeping/ungrounded: ${JSON.stringify(m[0])}`);
      }
    }
    const ungrounded = ungroundedSpecifics(text, inputSerialized);
    if (ungrounded.length) failures.push(`fact '${fact.fact_key}' invents specifics: ${ungrounded.join(', ')}`);
  }

  return failures;
}

// --- main -------------------------------------------------------------------

async function main() {
  const mode = process.argv.includes('--broken') ? 'broken' : 'real';
  const cachedOnly = process.argv.includes('--cached-only');

  const model = await readModelId();
  const prompt = await readFile(PROMPT_PATH, 'utf8');
  const fixtures = await loadFixtures(FIXTURE_DIR);

  const cost = { liveCalls: 0, sonnetIn: 0, sonnetOut: 0 };
  const infer =
    mode === 'broken' ? makeBrokenInferencer() : makeRealInferencer(model, prompt, cachedOnly, cost);

  console.log(
    `memory-eval | mode=${mode}${cachedOnly ? ' (cached-only)' : ''} | inferencer=${model}`,
  );
  console.log(`fixtures: ${fixtures.length} | confidence_floor=${CONFIDENCE_FLOOR} | cache: evals/cache/`);
  console.log('');

  const failedFixtures = [];
  for (const fixture of fixtures) {
    const output = await infer(fixture);
    const failures = checkFixture(fixture, output);
    if (failures.length) {
      failedFixtures.push({ id: fixture.id, failures });
      console.log(`  FAIL ${fixture.id}`);
      for (const f of failures) console.log(`       - ${f}`);
    } else {
      const n = Array.isArray(output.fact_updates) ? output.fact_updates.length : 0;
      console.log(`  pass ${fixture.id} (${n} fact${n === 1 ? '' : 's'})`);
    }
  }

  const estUsd = (cost.sonnetIn / 1e6) * PRICE.sonnet.input + (cost.sonnetOut / 1e6) * PRICE.sonnet.output;

  console.log('');
  console.log('--- cost ---');
  console.log(`live API calls this run: ${cost.liveCalls}`);
  console.log(`tokens: sonnet in=${cost.sonnetIn} out=${cost.sonnetOut}`);
  console.log(`estimated cost this run: $${estUsd.toFixed(4)} USD`);

  // ONE gate, run against whichever inferencer `mode` selected: every fixture
  // must pass the precision rubric to exit 0. Calibration is the contract that
  // this gate has teeth — the real (cached) inferencer exits 0; the --broken
  // stand-in (sweeping, below-floor, ungrounded) is rejected and exits NONZERO.
  const allPass = failedFixtures.length === 0;

  console.log('');
  console.log('--- gate ---');
  console.log(`fixtures failing checks: ${failedFixtures.length}/${fixtures.length}`);
  console.log(`overall (${mode}): ${allPass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);
  if (mode === 'broken' && allPass) {
    // A broken inferencer that slipped the gate means the rubric is toothless —
    // surface that as a hard failure, not a silent pass.
    console.error('CALIBRATION BROKEN: the deliberately-bad inferencer passed the gate.');
    process.exit(1);
  }
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error('memory eval harness error:', err);
  process.exit(2);
});
