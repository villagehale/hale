#!/usr/bin/env node
// Classifier eval harness (backlog B12).
//
// Root CLAUDE.md hard rule #8: no LLM mocking — real Claude responses, cached.
// This harness calls the REAL classifier request shape against the live model
// once, content-addresses every response to disk, and replays from cache on
// every subsequent run (cache hit = zero API calls = free).
//
// IMPORT vs REPLICATE: src/agents/classifier.ts is TypeScript and depends on
// workspace packages (@hale/types, config, ../anthropic/client). The committed
// apps/worker/dist/ is STALE (it still references the removed Mastra layer:
// ../mastra/model.js and a date-suffixed model id), so importing the compiled
// path would test dead code. We therefore REPLICATE the exact request shape:
// same prompt file (apps/worker/prompts/classifier.md), same tool-forced JSON
// output schema and tool_choice that src/agents/structured.ts uses. The model id
// comes from the classify skill's own pickModel('classify') (@hale/agent source,
// via tsx), so the gate tests the model production classifies with, and the
// autonomy threshold is read from src/orchestrator/index.ts — this harness has
// no second source of truth for any of those values.
//
// Run from repo root:
//   node --env-file=.env apps/worker/evals/run-eval.mjs
//   node --env-file=.env apps/worker/evals/run-eval.mjs --classifier=broken
//   node --env-file=.env apps/worker/evals/run-eval.mjs --include-holdout
//   node apps/worker/evals/run-eval.mjs --cached-only   (CI: replay only, never calls the API)

import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { tsImport } from 'tsx/esm/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = join(HERE, '..');
const PROMPT_PATH = join(WORKER_ROOT, 'prompts', 'classifier.md');
const PACKS_DIR = join(WORKER_ROOT, 'prompts', 'packs');
// Mirror of stagePackFor's wrapping (src/agents/stage-pack.ts): a fixture
// declaring one stage gets that stage's pack appended under the same header
// the runtime uses, so the eval prompt matches production for that stage.
const PACK_HEADER = '## Stage-aware context';
const AGENT_SRC = join(WORKER_ROOT, '..', '..', 'packages', 'agent', 'src', 'index.ts');
const ORCHESTRATOR_PATH = join(WORKER_ROOT, 'src', 'orchestrator', 'index.ts');
const FIXTURE_DIR = join(HERE, 'fixtures', 'classifier');
const HOLDOUT_DIR = join(FIXTURE_DIR, 'holdout');
const CACHE_DIR = join(HERE, 'cache');

// Haiku 4.5 list price (USD per 1M tokens). Source: Anthropic pricing,
// cross-checked via the claude-api skill on 2026-06-12.
const PRICE_PER_MTOK = { input: 1.0, output: 5.0 };

const ACCURACY_BAR = 0.85;
const ROUTING_BAR = 0.85;
const ATTRIBUTION_BAR = 0.85;

// --- read the single sources of truth from worker source -------------------

// The gate must test the model production actually classifies with. runClassifier
// (src/agents/classifier.ts) resolves it via pickModel('classify'), so we call the
// same function from @hale/agent source (via tsx, not the stale committed dist) —
// a TASK_MODEL re-tier is picked up here with no eval edit.
async function readModelId() {
  const { pickModel } = await tsImport(AGENT_SRC, import.meta.url);
  return pickModel('classify');
}

async function readAutonomyThreshold() {
  const src = await readFile(ORCHESTRATOR_PATH, 'utf8');
  const m = src.match(/CONFIDENCE_AUTONOMY_THRESHOLD\s*=\s*([\d.]+)/);
  if (!m) throw new Error(`could not parse CONFIDENCE_AUTONOMY_THRESHOLD from ${ORCHESTRATOR_PATH}`);
  return Number(m[1]);
}

// The tool-forced JSON schema MUST mirror classifierOutputJsonSchema in
// src/agents/classifier.ts. Event-type enum is duplicated here intentionally
// so a divergence between prompt taxonomy and code surfaces as eval drift.
const EVENT_TYPES = [
  'pediatric_appointment_reminder',
  'pediatric_appointment_request',
  'lab_results_ready',
  'pediatric_office_message',
  'vaccine_schedule_update',
  'ei_correspondence',
  'provincial_leave_correspondence',
  'employer_hr_correspondence',
  'tax_credit_eligibility_change',
  'supply_low_signal',
  'subscription_renewal_due',
  'order_confirmation',
  'delivery_update',
  'daycare_application_response',
  'daycare_communication',
  'school_communication',
  'activity_signup_open',
  'milestone_photo_detected',
  'family_share_request',
  'calendar_conflict_detected',
  'family_event_invite',
  'legal_milestone_due',
  'age_stage_milestone_due',
  'sleep_pattern_signal',
  'feeding_pattern_signal',
  'unclassified',
];

const OUTPUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    event_type: { type: 'string', enum: EVENT_TYPES },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    payload: { type: 'object', additionalProperties: true },
    suggested_action: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['autonomous_action', 'surface_only', 'ignore', 'needs_human'],
        },
        actionType: { type: 'string' },
      },
      required: ['kind'],
    },
    concerns_child_id: { type: ['string', 'null'] },
  },
  required: ['event_type', 'confidence', 'rationale', 'payload', 'suggested_action'],
};

const TOOL_NAME = 'classification';

// --- fixtures ---------------------------------------------------------------

async function loadFixtures(dir) {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
  const out = [];
  for (const name of names) {
    const raw = await readFile(join(dir, name), 'utf8');
    out.push(JSON.parse(raw));
  }
  return out;
}

// The user message must match runClassifier's exact serialization shape:
// { signal: { source, raw_content }, family_context_slice }.
function userMessageFor(fixture) {
  return JSON.stringify({
    signal: { source: fixture.input.source, raw_content: fixture.input.rawContent },
    family_context_slice: fixture.input.familyContextSlice ?? null,
  });
}

// A fixture may declare a single `stage`; the harness then injects that
// stage's content pack the way runClassifier does (base prompt + the pack
// under PACK_HEADER). No `stage` = the bare classifier prompt (the
// pre-B17 behaviour, so existing fixtures are byte-identical and stay cached).
async function systemPromptFor(basePrompt, fixture) {
  if (!fixture.stage) return basePrompt;
  const packPath = join(PACKS_DIR, `${fixture.stage}.md`);
  if (!existsSync(packPath)) throw new Error(`${fixture.id}: no pack for stage '${fixture.stage}'`);
  const pack = await readFile(packPath, 'utf8');
  return `${basePrompt}\n\n${PACK_HEADER}\n\n${pack}`;
}

// --- content-addressed cache ------------------------------------------------
// Key = sha256(model + "\n" + promptFileContents + "\n" + userMessage). Any
// change to the model id, the prompt, or a fixture's input produces a new key,
// so stale answers are never silently reused. A present key = no API call.

function cacheKey(model, prompt, userMessage) {
  return createHash('sha256')
    .update(`${model}\n${prompt}\n${userMessage}`)
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

// --- the real classifier path (replicated forceToolJson) --------------------

function makeRealClassifier(model, basePrompt, cachedOnly) {
  let client;
  return async function classify(fixture) {
    const system = await systemPromptFor(basePrompt, fixture);
    const userMessage = userMessageFor(fixture);
    const key = cacheKey(model, system, userMessage);

    const cached = await cacheGet(key);
    if (cached) {
      return { ...cached.parsed, _usage: { input: 0, output: 0 }, _cached: true };
    }

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
      system,
      tools: [
        {
          name: TOOL_NAME,
          description: 'Return the structured classification of the inbound signal.',
          input_schema: OUTPUT_JSON_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: userMessage }],
    });

    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);
    if (!toolUse) throw new Error(`${fixture.id}: model returned no ${TOOL_NAME} tool call`);

    const parsed = toolUse.input;
    const usage = {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    };
    await cachePut(key, { parsed, usage });
    return { ...parsed, _usage: usage, _cached: false };
  };
}

// Deliberately broken stand-in for calibration. Constant high-confidence
// answer that is wrong for nearly every fixture — must drive the gate to fail.
// It makes NO API call and reads NO cache, so it cannot accidentally pass.
function makeBrokenClassifier() {
  return async function classify() {
    return {
      event_type: 'pediatric_appointment_reminder',
      confidence: 0.99,
      rationale: 'constant stand-in',
      payload: {},
      suggested_action: { kind: 'autonomous_action', actionType: 'send_email' },
      _usage: { input: 0, output: 0 },
      _cached: false,
    };
  };
}

// --- scoring ----------------------------------------------------------------

function expectedTypeMatches(fixture, actualType) {
  const e = fixture.expect;
  if (typeof e.eventType === 'string') return actualType === e.eventType;
  if (Array.isArray(e.eventTypeOneOf)) return e.eventTypeOneOf.includes(actualType);
  throw new Error(`${fixture.id}: fixture has neither eventType nor eventTypeOneOf`);
}

function isCalibrationCase(fixture) {
  return typeof fixture.expect.maxConfidence === 'number';
}

// A fixture opts INTO routing-kind scoring by declaring `kind` (a single
// expected suggested_action.kind) or `kindOneOf` (an accepted set, used for
// genuinely ambiguous cases where more than one safe routing is defensible).
// Fixtures without either are not routing-scored — only kinds hand-derived
// from the taxonomy with confidence are gated, so debatable cases stay out.
function isRoutingScored(fixture) {
  return typeof fixture.expect.kind === 'string' || Array.isArray(fixture.expect.kindOneOf);
}

// Routing is correct iff the kind matches AND, for autonomous_action, the
// actionType matches the taxonomy-derived expectation. A right kind with the
// wrong actionType is still a routing miss: the orchestrator routes execution
// by actionType, so an autonomous_action/send_email where reply_to_email was
// expected would still mis-handle the event.
function routingMatches(fixture, suggestion) {
  const e = fixture.expect;
  const actualKind = suggestion?.kind;
  if (typeof e.kind === 'string') {
    if (actualKind !== e.kind) return false;
    if (e.kind === 'autonomous_action') return suggestion.actionType === e.actionType;
    return true;
  }
  return e.kindOneOf.includes(actualKind);
}

function expectedRoutingLabel(fixture) {
  const e = fixture.expect;
  if (typeof e.kind === 'string') {
    return e.kind === 'autonomous_action' ? `${e.kind}/${e.actionType}` : e.kind;
  }
  return e.kindOneOf.join('|');
}

// A fixture opts INTO child-attribution scoring by declaring `concernsChildId`
// (a child id the signal should be attributed to, or null for family-wide /
// undeterminable). Multi-child families are the only case where attribution
// matters, so these fixtures carry a `children` list in their context slice.
function isAttributionScored(fixture) {
  return Object.prototype.hasOwnProperty.call(fixture.expect, 'concernsChildId');
}

// Attribution is correct iff the returned id matches (null === null, or the
// exact child id). A returned id that is not in the fixture's `children` list is
// always a miss — the orchestrator would drop it to null, so the model should too.
function attributionMatches(fixture, returned) {
  const expected = fixture.expect.concernsChildId;
  const value = returned ?? null;
  return value === expected;
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith('--classifier='));
  const mode = arg ? arg.split('=')[1] : 'real';
  const includeHoldout = process.argv.includes('--include-holdout');
  const cachedOnly = process.argv.includes('--cached-only');

  const model = await readModelId();
  const prompt = await readFile(PROMPT_PATH, 'utf8');
  const threshold = await readAutonomyThreshold();

  const scored = await loadFixtures(FIXTURE_DIR);
  const holdout = includeHoldout ? await loadFixtures(HOLDOUT_DIR) : [];
  const fixtures = [...scored, ...holdout];

  const classify =
    mode === 'broken' ? makeBrokenClassifier() : makeRealClassifier(model, prompt, cachedOnly);

  console.log(
    `classifier-eval | mode=${mode}${cachedOnly ? ' (cached-only)' : ''} | model=${model} | autonomy_threshold=${threshold}`,
  );
  console.log(
    `fixtures: ${scored.length} scored${includeHoldout ? ` + ${holdout.length} holdout` : ''} | cache: evals/cache/`,
  );

  let correct = 0;
  let typeScoredCount = 0;
  let routingCorrect = 0;
  let routingScoredCount = 0;
  let attributionCorrect = 0;
  let attributionScoredCount = 0;
  let liveCalls = 0;
  let totalIn = 0;
  let totalOut = 0;
  const typeMisses = [];
  const routingMisses = [];
  const attributionMisses = [];
  const calibrationFails = [];

  for (const fixture of fixtures) {
    const result = await classify(fixture);
    if (!result._cached && mode === 'real') {
      liveCalls += 1;
      totalIn += result._usage.input;
      totalOut += result._usage.output;
    }

    // Accuracy is scored on every non-pure-calibration fixture. Calibration
    // cases with eventTypeOneOf also contribute (a member-of check), so a
    // wildly wrong type on an ambiguous case still counts against accuracy.
    typeScoredCount += 1;
    const typeOk = expectedTypeMatches(fixture, result.event_type);
    if (typeOk) correct += 1;
    else typeMisses.push({ id: fixture.id, expectedKind: fixture.expect.eventType ?? 'one-of' });

    if (isRoutingScored(fixture)) {
      routingScoredCount += 1;
      if (routingMatches(fixture, result.suggested_action)) routingCorrect += 1;
      else {
        const got = result.suggested_action;
        routingMisses.push({
          id: fixture.id,
          expected: expectedRoutingLabel(fixture),
          got: got?.kind === 'autonomous_action' ? `${got.kind}/${got.actionType}` : got?.kind,
        });
      }
    }

    if (isAttributionScored(fixture)) {
      attributionScoredCount += 1;
      if (attributionMatches(fixture, result.concerns_child_id)) attributionCorrect += 1;
      else
        attributionMisses.push({
          id: fixture.id,
          expected: fixture.expect.concernsChildId ?? 'null',
          got: result.concerns_child_id ?? 'null',
        });
    }

    if (isCalibrationCase(fixture)) {
      const cap = fixture.expect.maxConfidence;
      if (!(result.confidence < cap)) {
        calibrationFails.push({
          id: fixture.id,
          confidence: result.confidence,
          cap,
        });
      }
    }
  }

  const accuracy = correct / typeScoredCount;
  const routingAccuracy = routingScoredCount > 0 ? routingCorrect / routingScoredCount : 1;
  const attributionAccuracy =
    attributionScoredCount > 0 ? attributionCorrect / attributionScoredCount : 1;

  console.log('');
  console.log('--- results ---');
  console.log(`event_type accuracy: ${(accuracy * 100).toFixed(1)}% (${correct}/${typeScoredCount})`);
  if (typeMisses.length) {
    console.log(`type misses (${typeMisses.length}):`);
    for (const m of typeMisses) console.log(`  - ${m.id} (expected ${m.expectedKind})`);
  } else {
    console.log('type misses: none');
  }

  console.log(
    `routing-kind accuracy: ${(routingAccuracy * 100).toFixed(1)}% (${routingCorrect}/${routingScoredCount})`,
  );
  if (routingMisses.length) {
    console.log(`routing misses (${routingMisses.length}):`);
    for (const m of routingMisses) console.log(`  - ${m.id}: expected ${m.expected}, got ${m.got}`);
  } else {
    console.log('routing misses: none');
  }

  console.log(
    `child-attribution accuracy: ${(attributionAccuracy * 100).toFixed(1)}% (${attributionCorrect}/${attributionScoredCount})`,
  );
  if (attributionMisses.length) {
    console.log(`attribution misses (${attributionMisses.length}):`);
    for (const m of attributionMisses) {
      console.log(`  - ${m.id}: expected ${m.expected}, got ${m.got}`);
    }
  } else {
    console.log('attribution misses: none');
  }

  const calibrationCases = fixtures.filter(isCalibrationCase).length;
  console.log(`calibration cases: ${calibrationCases} (must stay confidence < ${threshold})`);
  if (calibrationFails.length) {
    console.log(`calibration FAILURES (${calibrationFails.length}):`);
    for (const c of calibrationFails) {
      console.log(`  - ${c.id}: confidence ${c.confidence} >= cap ${c.cap}`);
    }
  } else {
    console.log('calibration failures: none');
  }

  const estUsd = (totalIn / 1e6) * PRICE_PER_MTOK.input + (totalOut / 1e6) * PRICE_PER_MTOK.output;
  console.log('');
  console.log('--- cost ---');
  console.log(`live API calls this run: ${liveCalls}`);
  console.log(`tokens: input=${totalIn} output=${totalOut} total=${totalIn + totalOut}`);
  console.log(`estimated cost this run: $${estUsd.toFixed(4)} USD`);

  const accuracyPass = accuracy >= ACCURACY_BAR;
  const routingPass = routingAccuracy >= ROUTING_BAR;
  const attributionPass = attributionAccuracy >= ATTRIBUTION_BAR;
  const calibrationPass = calibrationFails.length === 0;
  const pass = accuracyPass && routingPass && attributionPass && calibrationPass;

  console.log('');
  console.log('--- gate ---');
  console.log(`event_type accuracy >= ${ACCURACY_BAR * 100}%: ${accuracyPass ? 'PASS' : 'FAIL'}`);
  console.log(`routing-kind accuracy >= ${ROUTING_BAR * 100}%: ${routingPass ? 'PASS' : 'FAIL'}`);
  console.log(
    `child-attribution accuracy >= ${ATTRIBUTION_BAR * 100}%: ${attributionPass ? 'PASS' : 'FAIL'}`,
  );
  console.log(`all calibration cases below threshold: ${calibrationPass ? 'PASS' : 'FAIL'}`);
  console.log(`overall: ${pass ? 'PASS (exit 0)' : 'FAIL (exit 1)'}`);

  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error('eval harness error:', err);
  process.exit(2);
});
